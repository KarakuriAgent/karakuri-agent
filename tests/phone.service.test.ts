import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { IAgent } from '../src/agent/core.js';
import { openLifeDatabase } from '../src/life/db.js';
import {
  buildSendIntentSection,
  describeSnsElapsed,
  describeUnreadWaiting,
  PhoneService,
  pickNudgeTarget,
  pickShareTarget,
} from '../src/phone/service.js';
import { SqlitePhoneUnreadStore, type PhoneThreadState } from '../src/phone/unread-store.js';
import { SnsRateLimiter } from '../src/sns/rate-limiter.js';
import type { ISnsWriteActivityCounter } from '../src/sns/types.js';

const temporaryDirectories: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createUnreadStore(): Promise<SqlitePhoneUnreadStore> {
  const dataDir = join(process.cwd(), '.test-artifacts', `karakuri-phone-${randomUUID()}`);
  await mkdir(dataDir, { recursive: true });
  temporaryDirectories.push(dataDir);
  const db = openLifeDatabase({ dataDir });
  cleanups.push(() => {
    if (db.open) {
      db.close();
    }
  });
  return new SqlitePhoneUnreadStore({ db });
}

function makeAgent(response = 'わかった、あとでね'): IAgent & { handleMessage: ReturnType<typeof vi.fn> } {
  return {
    handleMessage: vi.fn(async () => response),
    summarizeSession: vi.fn(async () => ''),
  } as unknown as IAgent & { handleMessage: ReturnType<typeof vi.fn> };
}

const COMMANDS = { checkPhone: 'check_phone', browseSns: 'browse_sns', postSns: 'post_sns' };

describe('SqlitePhoneUnreadStore', () => {
  it('groups pending messages by thread in arrival order and marks them processed', async () => {
    const store = await createUnreadStore();
    await store.enqueue({ source: 'discord', threadId: 't1', body: 'こんにちは', authorId: 'u1', authorName: 'Yamashita', receivedAt: new Date('2026-07-06T10:00:00Z') });
    await store.enqueue({ source: 'discord', threadId: 't2', body: 'やあ', authorId: 'u2', authorName: 'B', receivedAt: new Date('2026-07-06T10:01:00Z') });
    await store.enqueue({ source: 'discord', threadId: 't1', body: '見てる？', authorId: 'u1', authorName: 'Yamashita', receivedAt: new Date('2026-07-06T10:02:00Z') });

    expect(await store.countPending()).toBe(3);
    const threads = await store.listPendingThreads(5);
    expect(threads.map((thread) => thread.threadId)).toEqual(['t1', 't2']);
    expect(threads[0]!.messages.map((message) => message.body)).toEqual(['こんにちは', '見てる？']);

    await store.markProcessed(threads[0]!.messages.map((message) => message.id), new Date());
    expect(await store.countPending()).toBe(1);
    expect((await store.listPendingThreads(5)).map((thread) => thread.threadId)).toEqual(['t2']);
  });

  it('limits the number of threads returned', async () => {
    const store = await createUnreadStore();
    for (let i = 0; i < 4; i += 1) {
      await store.enqueue({ source: 'discord', threadId: `t${i}`, body: `msg${i}`, receivedAt: new Date() });
    }
    expect((await store.listPendingThreads(2)).map((thread) => thread.threadId)).toEqual(['t0', 't1']);
  });

  it('tracks per-thread conversation state (incoming via enqueue, outgoing via noteOutgoing)', async () => {
    const store = await createUnreadStore();
    await store.enqueue({ source: 'discord', threadId: 't1', body: 'こんにちは', authorId: 'u1', authorName: 'Yamashita', receivedAt: new Date('2026-07-10T00:00:00Z') });
    await store.enqueue({ source: 'discord', threadId: 't1', body: 'みてる?', authorId: 'u1', authorName: 'Yamashita', receivedAt: new Date('2026-07-10T02:00:00Z') });

    let states = await store.listThreadStates();
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ threadId: 't1', counterpartId: 'u1', counterpartName: 'Yamashita' });
    expect(states[0]!.lastIncomingAt?.toISOString()).toBe('2026-07-10T02:00:00.000Z');
    expect(states[0]!.lastOutgoingAt).toBeNull();

    await store.noteOutgoing('t1', new Date('2026-07-10T03:00:00Z'));
    await store.noteOutgoing('t1', new Date('2026-07-10T05:00:00Z'), { proactive: true, nudge: true });
    states = await store.listThreadStates();
    expect(states[0]!.lastOutgoingAt?.toISOString()).toBe('2026-07-10T05:00:00.000Z');
    expect(states[0]!.lastProactiveAt?.toISOString()).toBe('2026-07-10T05:00:00.000Z');
    expect(states[0]!.lastNudgeAt?.toISOString()).toBe('2026-07-10T05:00:00.000Z');

    expect(await store.countProactiveSince(new Date('2026-07-10T04:00:00Z'))).toBe(1);
    expect(await store.countProactiveSince(new Date('2026-07-10T06:00:00Z'))).toBe(0);
  });

  it('returns the oldest pending received_at and null when nothing is pending', async () => {
    const store = await createUnreadStore();
    expect(await store.oldestPendingReceivedAt()).toBeNull();

    await store.enqueue({ source: 'discord', threadId: 't1', body: '古い', receivedAt: new Date('2026-07-06T10:00:00Z') });
    await store.enqueue({ source: 'discord', threadId: 't1', body: '新しい', receivedAt: new Date('2026-07-06T12:00:00Z') });
    expect((await store.oldestPendingReceivedAt())?.toISOString()).toBe('2026-07-06T10:00:00.000Z');

    const threads = await store.listPendingThreads(5);
    await store.markProcessed(threads[0]!.messages.map((message) => message.id), new Date());
    expect(await store.oldestPendingReceivedAt()).toBeNull();
  });
});

describe('PhoneService', () => {
  it('resolves configured command names only', () => {
    const service = new PhoneService({
      agent: makeAgent(),
      commands: { checkPhone: 'check_phone' },
      unreadStore: { countPending: async () => 0 } as never,
    });
    expect(service.resolveKind('check_phone')).toBe('check_phone');
    expect(service.resolveKind('browse_sns')).toBeNull();
    expect(service.resolveKind('move')).toBeNull();
  });

  it('check_phone replies to unread threads with the thread session and marks them processed', async () => {
    const store = await createUnreadStore();
    await store.enqueue({ source: 'discord', threadId: 'thread-1', body: '今日ひま？', authorId: 'u1', authorName: 'Yamashita', receivedAt: new Date() });
    await store.enqueue({ source: 'discord', threadId: 'thread-1', body: '映画いこうよ', authorId: 'u1', authorName: 'Yamashita', receivedAt: new Date() });

    const agent = makeAgent('いいね、いこう！');
    const postReply = vi.fn(async () => undefined);
    const service = new PhoneService({
      agent,
      commands: COMMANDS,
      unreadStore: store,
      postReply,
    });

    await service.run('check_phone');

    expect(agent.handleMessage).toHaveBeenCalledTimes(1);
    const [sessionId, userMessage, userName, options] = agent.handleMessage.mock.calls[0]!;
    expect(sessionId).toBe('thread-1');
    expect(userMessage).toContain('今日ひま？');
    expect(userMessage).toContain('映画いこうよ');
    expect(userName).toBe('Yamashita');
    expect(options.userId).toBe('u1');
    expect(postReply).toHaveBeenCalledWith('thread-1', 'いいね、いこう！');
    expect(await store.countPending()).toBe(0);
  });

  it('check_phone splits a thread into per-author runs with correct attribution and arrival times (M8 review fix)', async () => {
    const store = await createUnreadStore();
    await store.enqueue({ source: 'discord', threadId: 't1', body: 'こんにちは', authorId: 'u1', authorName: 'Yamashita', receivedAt: new Date('2026-07-06T10:00:00Z') });
    await store.enqueue({ source: 'discord', threadId: 't1', body: '横から失礼', authorId: 'u2', authorName: 'B', receivedAt: new Date('2026-07-06T10:01:00Z') });
    await store.enqueue({ source: 'discord', threadId: 't1', body: 'もう一言', authorId: 'u2', authorName: 'B', receivedAt: new Date('2026-07-06T10:02:00Z') });

    const agent = makeAgent('返信');
    const postReply = vi.fn(async () => undefined);
    const service = new PhoneService({ agent, commands: COMMANDS, unreadStore: store, postReply });

    await service.run('check_phone');

    expect(agent.handleMessage).toHaveBeenCalledTimes(2);
    const firstCall = agent.handleMessage.mock.calls[0]!;
    expect(firstCall[1]).toBe('こんにちは');
    expect(firstCall[2]).toBe('Yamashita');
    expect(firstCall[3]).toMatchObject({ userId: 'u1' });
    expect(firstCall[3].arrivedAt.toISOString()).toBe('2026-07-06T10:00:00.000Z');
    const secondCall = agent.handleMessage.mock.calls[1]!;
    expect(secondCall[1]).toBe('横から失礼\n\nもう一言');
    expect(secondCall[2]).toBe('B');
    expect(secondCall[3]).toMatchObject({ userId: 'u2' });
    expect(secondCall[3].arrivedAt.toISOString()).toBe('2026-07-06T10:01:00.000Z');
    expect(postReply).toHaveBeenCalledTimes(2);
    expect(await store.countPending()).toBe(0);
  });

  it('check_phone prefixes unread bodies with arrival time and notes the sent reply (#111)', async () => {
    const store = await createUnreadStore();
    await store.enqueue({
      source: 'discord',
      threadId: 't1',
      authorName: 'Yamashita',
      body: 'まだ行ってないの？',
      receivedAt: new Date('2026-07-17T08:12:00.000Z'),
    });
    const agent = makeAgent('明日の朝イチで行くよ');
    const postReply = vi.fn(async () => undefined);
    const service = new PhoneService({
      agent,
      commands: COMMANDS,
      unreadStore: store,
      postReply,
      timezone: 'Asia/Tokyo',
    });

    await service.run('check_phone');

    const [, userMessage, , options] = agent.handleMessage.mock.calls[0]!;
    expect(String(userMessage)).toBe('[07-17 17:12] まだ行ってないの？');
    expect(String(options.extraSystemPrompt)).toContain('arrival time');
    // 送信本文の要点が台帳に残る
    const state = (await store.listThreadStates()).find((s) => s.threadId === 't1');
    expect(state?.lastOutgoingText).toBe('明日の朝イチで行くよ');
  });

  it('check_phone leaves messages unread when no reply poster is configured (M8 review fix)', async () => {
    const store = await createUnreadStore();
    await store.enqueue({ source: 'discord', threadId: 't1', body: 'hi', receivedAt: new Date() });
    const agent = makeAgent();
    const service = new PhoneService({ agent, commands: COMMANDS, unreadStore: store });

    await service.run('check_phone');

    expect(agent.handleMessage).not.toHaveBeenCalled();
    expect(await store.countPending()).toBe(1);
  });

  it('check_phone reports the generated reply when posting fails (already marked read)', async () => {
    const store = await createUnreadStore();
    await store.enqueue({ source: 'discord', threadId: 't1', body: 'hi', authorName: 'Yamashita', receivedAt: new Date() });
    const agent = makeAgent('大事な返信テキスト');
    const postReply = vi.fn(async () => {
      throw new Error('discord down');
    });
    const postMessage = vi.fn(async () => undefined);
    const service = new PhoneService({
      agent,
      commands: COMMANDS,
      unreadStore: store,
      postReply,
      messageSink: { postMessage },
      reportChannelId: 'report',
    });

    await service.run('check_phone');

    // 二重返信防止のため既読化は維持される
    expect(await store.countPending()).toBe(0);
    // 生成済みの返信本文が report に残り、運用で回収できる
    expect(postMessage).toHaveBeenCalledWith('report', expect.stringContaining('大事な返信テキスト'));
    expect(postMessage).toHaveBeenCalledWith('report', expect.stringContaining('投稿に失敗'));
  });

  it('check_phone serializes with a shared thread mutex', async () => {
    const store = await createUnreadStore();
    await store.enqueue({ source: 'discord', threadId: 't1', body: 'hi', receivedAt: new Date() });
    const { KeyedMutex } = await import('../src/utils/mutex.js');
    const threadMutex = new KeyedMutex();
    const order: string[] = [];
    const agent = makeAgent();
    agent.handleMessage.mockImplementation(async () => {
      order.push('phone');
      return '返信';
    });
    const postReply = vi.fn(async () => undefined);
    const service = new PhoneService({ agent, commands: COMMANDS, unreadStore: store, postReply, threadMutex });

    // bot 側の即時処理が同じスレッドロックを握っている間、check_phone は待つ
    let releaseBot: () => void = () => undefined;
    const botHold = threadMutex.runExclusive('t1', async () => {
      order.push('bot-start');
      await new Promise<void>((resolve) => {
        releaseBot = resolve;
      });
      order.push('bot-end');
    });
    const phoneRun = service.run('check_phone');
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseBot();
    await Promise.all([botHold, phoneRun]);

    expect(order).toEqual(['bot-start', 'bot-end', 'phone']);
  });

  it('check_phone caps LLM turns per window and leaves the rest unread', async () => {
    const store = await createUnreadStore();
    // 1 スレッドに発言者が交互に 3 run + 別スレッド 1 run = 計 4 run
    await store.enqueue({ source: 'discord', threadId: 't1', body: 'a', authorId: 'u1', receivedAt: new Date() });
    await store.enqueue({ source: 'discord', threadId: 't1', body: 'b', authorId: 'u2', receivedAt: new Date() });
    await store.enqueue({ source: 'discord', threadId: 't1', body: 'c', authorId: 'u1', receivedAt: new Date() });
    await store.enqueue({ source: 'discord', threadId: 't2', body: 'd', authorId: 'u3', receivedAt: new Date() });

    const agent = makeAgent('返信');
    const postReply = vi.fn(async () => undefined);
    const service = new PhoneService({
      agent,
      commands: COMMANDS,
      unreadStore: store,
      postReply,
      maxTurnsPerCheck: 2,
    });

    await service.run('check_phone');

    expect(agent.handleMessage).toHaveBeenCalledTimes(2);
    // 予算切れの run（t1 の 3 本目と t2）は未読のまま残る
    expect(await store.countPending()).toBe(2);
  });

  it('check_phone leaves other threads unread when one fails', async () => {
    const store = await createUnreadStore();
    await store.enqueue({ source: 'discord', threadId: 'bad', body: 'x', receivedAt: new Date() });
    await store.enqueue({ source: 'discord', threadId: 'good', body: 'y', authorName: 'B', receivedAt: new Date() });

    const agent = makeAgent();
    agent.handleMessage.mockImplementation(async (sessionId: string) => {
      if (sessionId === 'bad') {
        throw new Error('llm down');
      }
      return '返信';
    });
    const postReply = vi.fn(async () => undefined);
    const service = new PhoneService({ agent, commands: COMMANDS, unreadStore: store, postReply });

    await service.run('check_phone');

    expect(postReply).toHaveBeenCalledWith('good', '返信');
    // 失敗スレッドは未読のまま残る（次の check_phone で再処理される）
    expect(await store.countPending()).toBe(1);
  });

  it('onWorldCommand dispatches asynchronously and drain waits for completion', async () => {
    const store = await createUnreadStore();
    await store.enqueue({ source: 'discord', threadId: 't1', body: 'hi', receivedAt: new Date() });
    const agent = makeAgent('reply');
    const postReply = vi.fn(async () => undefined);
    const service = new PhoneService({ agent, commands: COMMANDS, unreadStore: store, postReply });

    service.onWorldCommand('check_phone');
    service.onWorldCommand('move');
    await service.drain();

    expect(agent.handleMessage).toHaveBeenCalledTimes(1);
    expect(await store.countPending()).toBe(0);
  });

  it('buildStatusSection includes sender and gist for discord unreads (#111)', async () => {
    const store = await createUnreadStore();
    await store.enqueue({ source: 'discord', threadId: 't1', authorName: 'Yamashita', body: 'まだ行ってないの？笑', receivedAt: new Date() });
    const service = new PhoneService({
      agent: makeAgent(),
      commands: COMMANDS,
      unreadStore: store,
    });

    const section = await service.buildStatusSection();
    expect(section).toContain('<phone-status>');
    expect(section).toContain('チャット未読: 1 件');
    expect(section).toContain('Yamashita「まだ行ってないの？笑」');
  });

  it('buildStatusSection keeps non-discord unread bodies out and strips angle brackets (#111)', async () => {
    const store = await createUnreadStore();
    await store.enqueue({ source: 'sns', threadId: 's1', body: '外部の本文', receivedAt: new Date() });
    await store.enqueue({ source: 'discord', threadId: 't1', authorName: 'Yamashita', body: '<attack>タグ入り</attack>', receivedAt: new Date() });
    const service = new PhoneService({
      agent: makeAgent(),
      commands: COMMANDS,
      unreadStore: store,
    });

    const section = await service.buildStatusSection();
    expect(section).toContain('チャット未読: 2 件');
    expect(section).not.toContain('外部の本文');
    expect(section).not.toContain('<attack>');
    expect(section).toContain('attackタグ入り/attack');
  });

  it('buildStatusSection surfaces the latest outgoing reply gist (#111)', async () => {
    const store = await createUnreadStore();
    await store.enqueue({ source: 'discord', threadId: 't1', authorName: 'Yamashita', body: '行った？', receivedAt: new Date() });
    const service = new PhoneService({
      agent: makeAgent(),
      commands: COMMANDS,
      unreadStore: store,
    });
    await store.markProcessed([1], new Date());
    await store.noteOutgoing('t1', new Date(), { text: '明日の朝イチで行くよ' });

    const section = await service.buildStatusSection();
    expect(section).toContain('直近のやり取り: Yamashitaに「明日の朝イチで行くよ」と返信した');
  });

  it('buildStatusSection returns null when check_phone is not configured', async () => {
    const store = await createUnreadStore();
    const service = new PhoneService({ agent: makeAgent(), commands: {}, unreadStore: store });
    expect(await service.buildStatusSection()).toBeNull();
  });

  it('buildStatusSection describes how long the oldest unread has been waiting and how to reply', async () => {
    // 件数だけの提示では check_phone がほぼ選ばれなかった（実機 631 提示で 2 回）
    const store = await createUnreadStore();
    await store.enqueue({ source: 'discord', threadId: 't1', body: '本文', receivedAt: new Date('2026-07-12T00:00:00.000Z') });
    const service = new PhoneService({
      agent: makeAgent(),
      commands: COMMANDS,
      unreadStore: store,
      now: () => new Date('2026-07-12T12:00:00.000Z'),
    });

    const section = await service.buildStatusSection();
    expect(section).toContain('半日近く待たせている');
    expect(section).toContain('返信するには check_phone を選ぶ');
  });

  it('describes unread waiting time with threshold-based wording', () => {
    const now = new Date('2026-07-12T12:00:00.000Z');
    expect(describeUnreadWaiting(new Date('2026-07-12T11:30:00.000Z'), now)).toBe('届いたばかり');
    expect(describeUnreadWaiting(new Date('2026-07-12T07:00:00.000Z'), now)).toBe('数時間待たせている');
    expect(describeUnreadWaiting(new Date('2026-07-12T00:00:00.000Z'), now)).toBe('半日近く待たせている');
    expect(describeUnreadWaiting(new Date('2026-07-10T00:00:00.000Z'), now)).toBe('丸一日以上待たせている');
  });

  it('oldestPendingReceivedAt returns null when check_phone is not configured', async () => {
    const store = await createUnreadStore();
    await store.enqueue({ source: 'discord', threadId: 't1', body: '本文', receivedAt: new Date() });
    const service = new PhoneService({ agent: makeAgent(), commands: {}, unreadStore: store });
    expect(await service.oldestPendingReceivedAt()).toBeNull();
  });

  it('describes SNS elapsed time with threshold-based wording, not raw minutes (#109)', () => {
    const now = new Date('2026-07-12T12:00:00.000Z');
    expect(describeSnsElapsed(new Date('2026-07-12T11:30:00.000Z'), now)).toBe('さっき通知を確認したばかり');
    expect(describeSnsElapsed(new Date('2026-07-12T06:00:00.000Z'), now)).toBe('数時間ほど通知を見ていない');
    expect(describeSnsElapsed(new Date('2026-07-11T22:00:00.000Z'), now)).toBe('半日ほど通知を見ていない');
    // 実機で観測された 2,739 分（約 46 時間）相当
    expect(describeSnsElapsed(new Date('2026-07-10T14:00:00.000Z'), now)).toBe('丸一日以上通知を見ていない');
  });

  it('post_sns skips the LLM turn when the post budget is exhausted', async () => {
    const store = await createUnreadStore();
    const agent = makeAgent();
    const counter: ISnsWriteActivityCounter = {
      countWriteActionsSince: async () => ({ count: 99, earliestAt: '2026-07-06T00:00:00.000Z' }),
      getLastWriteActionAt: async () => null,
    };
    const limiter = new SnsRateLimiter({
      limits: { postPerHour: 1, postPerDay: 1, postMinIntervalMinutes: 0, replyPerHour: 1, likePerHour: 1, repostPerHour: 1 },
      fetchIntervals: { notificationsMinutes: 0, timelineMinutes: 0, trendsMinutes: 0 },
      counter,
      timezone: 'Asia/Tokyo',
    });
    const service = new PhoneService({
      agent,
      commands: COMMANDS,
      unreadStore: store,
      snsProviders: new Map([['mastodon', {} as never]]),
      rateLimiters: new Map([['mastodon', limiter]]),
    });

    await service.run('post_sns');
    expect(agent.handleMessage).not.toHaveBeenCalled();
  });

  it('browse_sns runs a system turn with the provider skill and timeline material', async () => {
    const store = await createUnreadStore();
    const agent = makeAgent('SNS_IDLE');
    const snsProvider = {
      getTimeline: vi.fn(async () => [{
        id: 'p1',
        text: '今日はいい天気',
        authorId: 'a1',
        authorName: 'Alice',
        authorHandle: 'alice',
        createdAt: '2026-07-06T00:00:00.000Z',
        url: 'https://example.com/p1',
        visibility: 'public',
        repostCount: 0,
        likeCount: 2,
        replyCount: 0,
      }]),
    };
    const service = new PhoneService({
      agent,
      commands: COMMANDS,
      unreadStore: store,
      snsProviders: new Map([['mastodon', snsProvider as never]]),
    });

    await service.run('browse_sns');

    expect(agent.handleMessage).toHaveBeenCalledTimes(1);
    const [sessionId, userMessage, , options] = agent.handleMessage.mock.calls[0]!;
    expect(String(sessionId)).toContain('phone-browse_sns-mastodon');
    expect(userMessage).toContain('今日はいい天気');
    expect(options).toMatchObject({ userId: 'system', ephemeral: true, autoLoadSnsSkill: 'mastodon' });
    expect(options.skillActivityInstructions).toContain('SNS を眺める');
  });
});

describe('send_message target selection (M9 #110)', () => {
  const T = (iso: string): Date => new Date(iso);
  const makeState = (overrides: Partial<PhoneThreadState>): PhoneThreadState => ({
    threadId: 't1',
    counterpartId: 'u1',
    counterpartName: 'Yamashita',
    lastIncomingAt: null,
    lastOutgoingAt: null,
    lastProactiveAt: null,
    lastNudgeAt: null,
    lastOutgoingText: null,
    ...overrides,
  });

  it('picks the longest-waiting nudge target with cooldowns', () => {
    const now = T('2026-07-10T20:00:00Z');
    // 12h 未満は候補外
    expect(pickNudgeTarget([makeState({ lastIncomingAt: T('2026-07-10T00:00:00Z'), lastOutgoingAt: T('2026-07-10T10:00:00Z') })], now)).toBeNull();
    // 相手の返信が最後（自分が待たせている側）は候補外
    expect(pickNudgeTarget([makeState({ lastIncomingAt: T('2026-07-10T06:00:00Z'), lastOutgoingAt: T('2026-07-10T00:00:00Z') })], now)).toBeNull();
    // 着信実績が無い相手は候補外
    expect(pickNudgeTarget([makeState({ lastIncomingAt: null, lastOutgoingAt: T('2026-07-10T00:00:00Z') })], now)).toBeNull();
    // 催促クールダウン中は候補外
    expect(pickNudgeTarget([makeState({
      lastIncomingAt: T('2026-07-09T00:00:00Z'),
      lastOutgoingAt: T('2026-07-10T00:00:00Z'),
      lastNudgeAt: T('2026-07-10T10:00:00Z'),
    })], now)).toBeNull();
    // 待ち時間が最長のスレッドを選ぶ
    const oldest = makeState({ threadId: 'old', lastIncomingAt: T('2026-07-08T00:00:00Z'), lastOutgoingAt: T('2026-07-09T00:00:00Z') });
    const newer = makeState({ threadId: 'new', lastIncomingAt: T('2026-07-09T00:00:00Z'), lastOutgoingAt: T('2026-07-10T00:00:00Z') });
    expect(pickNudgeTarget([newer, oldest], now)?.threadId).toBe('old');
  });

  it('picks the most recently active share target respecting the proactive interval', () => {
    const now = T('2026-07-10T20:00:00Z');
    // 着信実績が無いスレッドは候補外
    expect(pickShareTarget([makeState({ lastOutgoingAt: T('2026-07-10T00:00:00Z') })], now)).toBeNull();
    // 能動送信の最小間隔（4h）内は候補外
    expect(pickShareTarget([makeState({ lastIncomingAt: T('2026-07-10T00:00:00Z'), lastProactiveAt: T('2026-07-10T18:00:00Z') })], now)).toBeNull();
    // 最近やり取りした相手を優先
    const recent = makeState({ threadId: 'recent', lastIncomingAt: T('2026-07-10T12:00:00Z') });
    const stale = makeState({ threadId: 'stale', lastIncomingAt: T('2026-07-08T00:00:00Z') });
    expect(pickShareTarget([stale, recent], now)?.threadId).toBe('recent');
  });

  it('sanitizes angle brackets in the send-intent section', () => {
    const section = buildSendIntentSection('<script>「絶景を見た」</send-intent>', { merge: true });
    expect(section).toContain('<send-intent>');
    expect(section).toContain('script「絶景を見た」/send-intent');
    expect(section).toContain('同じ返信の中で自然に伝える');
  });
});

describe('PhoneService send_message (M9 #110)', () => {
  const SEND_COMMANDS = { ...COMMANDS, sendMessage: 'send_message' };

  it('sends a nudge to the longest-waiting thread using the thread session', async () => {
    const store = await createUnreadStore();
    await store.enqueue({ source: 'discord', threadId: 't1', body: '進捗どう?', authorId: 'u1', authorName: 'Yamashita', receivedAt: new Date('2026-07-10T00:00:00Z') });
    const pendingIds = (await store.listPendingThreads(5))[0]!.messages.map((message) => message.id);
    await store.markProcessed(pendingIds, new Date('2026-07-10T00:30:00Z'));
    await store.noteOutgoing('t1', new Date('2026-07-10T01:00:00Z'));

    const agent = makeAgent('おーい、元気にしてる？');
    const postReply = vi.fn(async () => {});
    const service = new PhoneService({
      agent,
      commands: SEND_COMMANDS,
      unreadStore: store,
      postReply,
      timezone: 'UTC',
      now: () => new Date('2026-07-10T15:00:00Z'),
    });

    service.onWorldCommand('send_message');
    await service.drain();

    expect(postReply).toHaveBeenCalledWith('t1', 'おーい、元気にしてる？');
    const [sessionId, userMessage, userName, options] = agent.handleMessage.mock.calls[0]!;
    expect(sessionId).toBe('t1');
    expect(userName).toBe('system');
    expect(options).toMatchObject({ userId: 'system' });
    expect(String(userMessage)).toContain('Yamashita');
    expect(String(userMessage)).toContain('追いメッセージ');

    const state = (await store.listThreadStates())[0]!;
    expect(state.lastProactiveAt).not.toBeNull();
    expect(state.lastNudgeAt).not.toBeNull();
  });

  it('merges the share intent into a pending unread reply (single message)', async () => {
    const store = await createUnreadStore();
    await store.enqueue({ source: 'discord', threadId: 't1', body: '最近どう?', authorId: 'u1', authorName: 'Yamashita', receivedAt: new Date('2026-07-10T09:00:00Z') });

    const agent = makeAgent('返事おそくなった！実は今日、展望台に行ってきたんだ');
    const postReply = vi.fn(async () => {});
    const service = new PhoneService({
      agent,
      commands: SEND_COMMANDS,
      unreadStore: store,
      postReply,
      timezone: 'UTC',
      episodeSource: { latestSalientSince: async () => ({ body: '展望台から絶景を見た' }) },
      now: () => new Date('2026-07-10T12:00:00Z'),
    });

    service.onWorldCommand('send_message');
    await service.drain();

    expect(agent.handleMessage).toHaveBeenCalledTimes(1);
    const [, userMessage, , options] = agent.handleMessage.mock.calls[0]!;
    expect(String(userMessage)).toContain('最近どう?');
    expect(String(options.extraSystemPrompt)).toContain('<send-intent>');
    expect(String(options.extraSystemPrompt)).toContain('展望台から絶景を見た');
    expect(postReply).toHaveBeenCalledTimes(1);
    expect(await store.countPending()).toBe(0);

    const state = (await store.listThreadStates())[0]!;
    expect(state.lastProactiveAt).not.toBeNull();
    expect(state.lastNudgeAt).toBeNull();
  });

  it('skips when nothing is eligible and during quiet hours', async () => {
    // 対象なし
    const emptyStore = await createUnreadStore();
    const idleAgent = makeAgent();
    const idlePost = vi.fn(async () => {});
    const idleService = new PhoneService({
      agent: idleAgent,
      commands: SEND_COMMANDS,
      unreadStore: emptyStore,
      postReply: idlePost,
      timezone: 'UTC',
      now: () => new Date('2026-07-10T15:00:00Z'),
    });
    idleService.onWorldCommand('send_message');
    await idleService.drain();
    expect(idlePost).not.toHaveBeenCalled();
    expect(idleAgent.handleMessage).not.toHaveBeenCalled();

    // 深夜（催促可能な相手がいても送らない）
    const store = await createUnreadStore();
    await store.enqueue({ source: 'discord', threadId: 't1', body: 'やあ', authorId: 'u1', authorName: 'Yamashita', receivedAt: new Date('2026-07-09T00:00:00Z') });
    const ids = (await store.listPendingThreads(5))[0]!.messages.map((message) => message.id);
    await store.markProcessed(ids, new Date());
    await store.noteOutgoing('t1', new Date('2026-07-09T01:00:00Z'));
    const nightPost = vi.fn(async () => {});
    const nightAgent = makeAgent();
    const nightService = new PhoneService({
      agent: nightAgent,
      commands: SEND_COMMANDS,
      unreadStore: store,
      postReply: nightPost,
      timezone: 'UTC',
      now: () => new Date('2026-07-10T03:00:00Z'),
    });
    nightService.onWorldCommand('send_message');
    await nightService.drain();
    expect(nightPost).not.toHaveBeenCalled();
  });

  it('respects the rolling 24h proactive thread cap', async () => {
    const store = await createUnreadStore();
    for (const thread of ['a', 'b', 'c']) {
      await store.noteOutgoing(thread, new Date('2026-07-10T10:00:00Z'), { proactive: true });
    }
    await store.enqueue({ source: 'discord', threadId: 't1', body: 'やあ', authorId: 'u1', authorName: 'Yamashita', receivedAt: new Date('2026-07-09T00:00:00Z') });
    const ids = (await store.listPendingThreads(5))[0]!.messages.map((message) => message.id);
    await store.markProcessed(ids, new Date());
    await store.noteOutgoing('t1', new Date('2026-07-09T01:00:00Z'));

    const agent = makeAgent();
    const postReply = vi.fn(async () => {});
    const service = new PhoneService({
      agent,
      commands: SEND_COMMANDS,
      unreadStore: store,
      postReply,
      timezone: 'UTC',
      now: () => new Date('2026-07-10T15:00:00Z'),
    });
    service.onWorldCommand('send_message');
    await service.drain();
    expect(postReply).not.toHaveBeenCalled();
  });

  it('proactiveMessagingStatus exposes eligible counterparts only when configured', async () => {
    const store = await createUnreadStore();
    await store.enqueue({ source: 'discord', threadId: 't1', body: 'やあ', authorId: 'u1', authorName: 'Yamashita', receivedAt: new Date('2026-07-09T00:00:00Z') });
    const ids = (await store.listPendingThreads(5))[0]!.messages.map((message) => message.id);
    await store.markProcessed(ids, new Date());
    await store.noteOutgoing('t1', new Date('2026-07-09T01:00:00Z'));

    const unconfigured = new PhoneService({
      agent: makeAgent(),
      commands: COMMANDS,
      unreadStore: store,
      timezone: 'UTC',
      now: () => new Date('2026-07-10T15:00:00Z'),
    });
    expect(await unconfigured.proactiveMessagingStatus()).toEqual({
      awaitingReplyCounterpart: null,
      sharePersonalCounterpart: null,
    });

    const configured = new PhoneService({
      agent: makeAgent(),
      commands: { ...COMMANDS, sendMessage: 'send_message' },
      unreadStore: store,
      timezone: 'UTC',
      now: () => new Date('2026-07-10T15:00:00Z'),
    });
    expect(await configured.proactiveMessagingStatus()).toEqual({
      awaitingReplyCounterpart: 'Yamashita',
      sharePersonalCounterpart: 'Yamashita',
    });
  });
});
