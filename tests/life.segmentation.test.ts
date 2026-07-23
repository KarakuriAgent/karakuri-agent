import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { GuardedAppraisal } from '../src/life/appraisal.js';
import { SqliteEpisodeStore } from '../src/life/episodes.js';
import { SegmentationEngine } from '../src/life/segmentation.js';
import type { NormalizedEvent } from '../src/life/types.js';

const temporaryDirectories: string[] = [];
const stores: SqliteEpisodeStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createEngine(options: { maxBeats?: number; maxDraftHours?: number; onFinalized?: (id: number, body: string) => void } = {}) {
  const dataDir = join(process.cwd(), '.test-artifacts', `karakuri-segmentation-${randomUUID()}`);
  await mkdir(dataDir, { recursive: true });
  temporaryDirectories.push(dataDir);
  const store = new SqliteEpisodeStore({ dataDir });
  stores.push(store);
  const engine = new SegmentationEngine({
    episodeStore: store,
    procVersion: 'appraisal-v1/test',
    ...(options.maxBeats != null ? { maxBeats: options.maxBeats } : {}),
    ...(options.maxDraftHours != null ? { maxDraftHours: options.maxDraftHours } : {}),
    ...(options.onFinalized != null ? { onEpisodeFinalized: options.onFinalized } : {}),
  });
  return { store, engine };
}

function makeGuarded(overrides: Partial<GuardedAppraisal> = {}): GuardedAppraisal {
  return {
    deltas: { valence: 0, energy: 0, hunger: 0, social: 0 },
    sleep: 'no_change',
    salience: 'low',
    beliefConflict: false,
    relationCandidates: [],
    prospectCandidates: [],
    segmentation: [],
    rejections: [],
    ...overrides,
  };
}

function makeEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    receivedAt: new Date('2026-07-05T03:00:00.000Z'),
    channel: 'kw:bot-1',
    kind: 'world_event',
    payload: { notification: { kind: 'action_progress' } },
    ...overrides,
  };
}

describe('SegmentationEngine', () => {
  it('does nothing on a calm tick (gating works)', async () => {
    const { store, engine } = await createEngine();
    await engine.handleEvent({ event: makeEvent(), guarded: makeGuarded() });

    expect(await store.count()).toBe(0);
    expect(await store.listDrafts()).toHaveLength(0);
  });

  it('bundles multiple events into one episode via open → continue → close', async () => {
    const { store, engine } = await createEngine();

    await engine.handleEvent({
      event: makeEvent({ receivedAt: new Date('2026-07-05T03:00:00.000Z') }),
      eventId: 10,
      guarded: makeGuarded({
        deltas: { valence: 0.1, energy: 0, hunger: 0, social: 0 },
        segmentation: [{ target: 'action', decision: 'open', beat: '映画館へ向かった' }],
      }),
    });
    await engine.handleEvent({
      event: makeEvent({ receivedAt: new Date('2026-07-05T04:00:00.000Z') }),
      eventId: 11,
      guarded: makeGuarded({
        segmentation: [{ target: 'action', decision: 'continue', beat: '映画を観はじめた' }],
      }),
    });
    await engine.handleEvent({
      event: makeEvent({ receivedAt: new Date('2026-07-05T05:00:00.000Z') }),
      eventId: 12,
      guarded: makeGuarded({
        deltas: { valence: 0.3, energy: 0, hunger: 0, social: 0 },
        segmentation: [{
          target: 'action',
          decision: 'close',
          final_body: '映画館でBさんと映画を観た。とても楽しかった。',
          final_importance: 'high',
        }],
      }),
    });

    expect(await store.count()).toBe(1);
    const episodes = await store.listRecent(1);
    expect(episodes[0]).toMatchObject({
      body: '映画館でBさんと映画を観た。とても楽しかった。',
      occurredAt: '2026-07-05T03:00:00.000Z',
      provenance: [10, 11, 12],
    });
    expect(episodes[0]!.importance).toBeGreaterThanOrEqual(0.9);
    expect(await store.listDrafts()).toHaveLength(0);
  });

  it('handles close_and_open in a single event', async () => {
    const { store, engine } = await createEngine();
    await engine.handleEvent({
      event: makeEvent(),
      guarded: makeGuarded({
        segmentation: [{ target: 'action', decision: 'open', beat: '広場を散歩していた' }],
      }),
    });
    await engine.handleEvent({
      event: makeEvent({ receivedAt: new Date('2026-07-05T04:00:00.000Z') }),
      guarded: makeGuarded({
        segmentation: [{
          target: 'action',
          decision: 'close_and_open',
          beat: '映画館に入った',
          final_body: '広場をぶらぶら散歩した。',
          final_importance: 'low',
        }],
      }),
    });

    expect(await store.count()).toBe(1);
    const drafts = await store.listDrafts();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.beats[0]!.text).toBe('映画館に入った');
  });

  it('creates a oneshot episode directly', async () => {
    const finalized: number[] = [];
    const { store, engine } = await createEngine({ onFinalized: (id) => finalized.push(id) });
    await engine.handleEvent({
      event: makeEvent({ actor: 'kw:agent:agent-b' }),
      eventId: 42,
      guarded: makeGuarded({
        salience: 'high',
        segmentation: [{
          target: 'action',
          decision: 'oneshot',
          final_body: 'Bさんから突然プレゼントをもらった。驚いた。',
          final_importance: 'high',
        }],
      }),
    });

    const episodes = await store.listRecent(1);
    expect(episodes[0]).toMatchObject({
      body: 'Bさんから突然プレゼントをもらった。驚いた。',
      participants: ['kw:agent:agent-b'],
      provenance: [42],
    });
    expect(finalized).toHaveLength(1);
  });

  it('force-closes at the max beat count (guardrail)', async () => {
    const { store, engine } = await createEngine({ maxBeats: 3 });
    for (let i = 0; i < 3; i += 1) {
      await engine.handleEvent({
        event: makeEvent({ receivedAt: new Date(`2026-07-05T0${3 + i}:00:00.000Z`) }),
        guarded: makeGuarded({
          segmentation: [{
            target: 'action',
            decision: i === 0 ? 'open' : 'continue',
            beat: `ビート${i + 1}`,
          }],
        }),
      });
    }

    // LLM が close を返さなくても最大ビート数で強制 close される
    expect(await store.listDrafts()).toHaveLength(0);
    expect(await store.count()).toBe(1);
    const episodes = await store.listRecent(1);
    expect(episodes[0]!.body).toContain('ビート1');
    expect(episodes[0]!.body).toContain('ビート3');
  });

  it('force-closes at the max duration (guardrail)', async () => {
    const { store, engine } = await createEngine({ maxDraftHours: 2 });
    await engine.handleEvent({
      event: makeEvent({ receivedAt: new Date('2026-07-05T03:00:00.000Z') }),
      guarded: makeGuarded({
        segmentation: [{ target: 'action', decision: 'open', beat: '長い作業を始めた' }],
      }),
    });
    await engine.handleEvent({
      event: makeEvent({ receivedAt: new Date('2026-07-05T06:00:00.000Z') }),
      guarded: makeGuarded(),
    });

    expect(await store.listDrafts()).toHaveLength(0);
    expect(await store.count()).toBe(1);
  });

  it('closes the conversation draft on a conversation_end event (front rule, no LLM decision needed)', async () => {
    const { store, engine } = await createEngine();
    await engine.handleEvent({
      event: makeEvent({ actor: 'kw:agent:agent-b', kind: 'conversation' }),
      guarded: makeGuarded({
        segmentation: [{ target: 'conversation', decision: 'open', beat: 'Bさんと立ち話を始めた' }],
      }),
    });
    expect(await store.listDrafts()).toHaveLength(1);

    await engine.handleEvent({
      event: makeEvent({
        actor: 'kw:agent:agent-b',
        kind: 'world_event',
        payload: { notification: { kind: 'conversation_end' } },
        receivedAt: new Date('2026-07-05T04:00:00.000Z'),
      }),
      guarded: makeGuarded(),
    });

    expect(await store.listDrafts()).toHaveLength(0);
    expect(await store.count()).toBe(1);
  });

  it('closes all channel drafts when falling asleep (front rule)', async () => {
    const { store, engine } = await createEngine();
    await engine.handleEvent({
      event: makeEvent(),
      guarded: makeGuarded({
        segmentation: [{ target: 'action', decision: 'open', beat: '夜の散歩をしていた' }],
      }),
    });
    await engine.handleEvent({
      event: makeEvent({ receivedAt: new Date('2026-07-05T04:00:00.000Z') }),
      guarded: makeGuarded({ sleep: 'fell_asleep' }),
    });

    expect(await store.listDrafts()).toHaveLength(0);
    expect(await store.count()).toBe(1);
  });

  it('keeps parallel action and conversation drafts (interruption)', async () => {
    const { store, engine } = await createEngine();
    await engine.handleEvent({
      event: makeEvent(),
      guarded: makeGuarded({
        segmentation: [{ target: 'action', decision: 'open', beat: '映画を観ていた' }],
      }),
    });
    await engine.handleEvent({
      event: makeEvent({ actor: 'kw:agent:agent-c', kind: 'conversation' }),
      guarded: makeGuarded({
        segmentation: [{ target: 'conversation', decision: 'open', beat: 'Cさんに話しかけられた' }],
      }),
    });

    const drafts = await store.listDrafts();
    expect(drafts).toHaveLength(2);
    expect(drafts.map((draft) => draft.threadKey).sort()).toEqual(['action', 'conversation:kw:agent:agent-c']);
  });

  it('recovers stale drafts as interrupted experiences (crash recovery)', async () => {
    const { store, engine } = await createEngine({ maxDraftHours: 2 });
    await store.upsertDraft({
      channel: 'kw:bot-1',
      threadKey: 'action',
      startedAt: '2026-07-05T00:00:00.000Z',
      lastEventAt: '2026-07-05T00:30:00.000Z',
      beats: [{ at: '2026-07-05T00:00:00.000Z', text: '何かをしていた' }],
      participants: [],
      emotions: [0],
      provenance: [],
    });

    const closed = await engine.recoverStaleDrafts(new Date('2026-07-05T10:00:00.000Z'));
    expect(closed).toBe(1);
    const episodes = await store.listRecent(1);
    expect(episodes[0]!.body).toContain('途切れた');
  });

  it('rescues continue decisions for nonexistent drafts by opening one', async () => {
    const { store, engine } = await createEngine();
    await engine.handleEvent({
      event: makeEvent(),
      guarded: makeGuarded({
        segmentation: [{ target: 'action', decision: 'continue', beat: '気づいたら夢中で作業していた' }],
      }),
    });
    expect(await store.listDrafts()).toHaveLength(1);
  });

  it('carries importance labels observed mid-draft into the finalized episode (#100)', async () => {
    const { store, engine } = await createEngine();

    // open 時に medium が観測される（従来は close 以外のラベルは捨てられていた）
    await engine.handleEvent({
      event: makeEvent({ receivedAt: new Date('2026-07-05T03:00:00.000Z') }),
      guarded: makeGuarded({
        segmentation: [{ target: 'action', decision: 'open', beat: '友達と偶然会った', final_importance: 'medium' }],
      }),
    });
    // close にはラベルなし・感情もフラット
    await engine.handleEvent({
      event: makeEvent({ receivedAt: new Date('2026-07-05T04:00:00.000Z') }),
      guarded: makeGuarded({
        segmentation: [{ target: 'action', decision: 'close', final_body: '友達と偶然会って少し話した。' }],
      }),
    });

    const episodes = await store.listRecent(1);
    expect(episodes[0]!.importance).toBeCloseTo(0.6, 5);
  });

  it('uses appraisal salience as an importance floor (#100)', async () => {
    const { store, engine } = await createEngine();

    await engine.handleEvent({
      event: makeEvent(),
      guarded: makeGuarded({
        salience: 'medium',
        segmentation: [{ target: 'action', decision: 'open', beat: '珍しい出来事に遭遇した' }],
      }),
    });
    await engine.handleEvent({
      event: makeEvent({ receivedAt: new Date('2026-07-05T04:00:00.000Z') }),
      guarded: makeGuarded({
        salience: 'none',
        segmentation: [{ target: 'action', decision: 'close', final_body: '珍しい出来事があった。' }],
      }),
    });

    const episodes = await store.listRecent(1);
    expect(episodes[0]!.importance).toBeCloseTo(0.6, 5);
  });

  it('falls back to the beat text for oneshot decisions without final_body (#100)', async () => {
    const { store, engine } = await createEngine();
    await engine.handleEvent({
      event: makeEvent(),
      guarded: makeGuarded({
        segmentation: [{ target: 'action', decision: 'oneshot', beat: '虹を見た', final_importance: 'medium' }],
      }),
    });

    expect(await store.count()).toBe(1);
    const episodes = await store.listRecent(1);
    expect(episodes[0]).toMatchObject({ body: '虹を見た' });
    expect(episodes[0]!.importance).toBeCloseTo(0.6, 5);
  });

  it('demotes close decisions for nonexistent drafts to a oneshot when final_body exists (#100)', async () => {
    const { store, engine } = await createEngine();
    await engine.handleEvent({
      event: makeEvent(),
      guarded: makeGuarded({
        segmentation: [{
          target: 'action',
          decision: 'close',
          final_body: '長い散歩を終えて帰宅した。',
          final_importance: 'medium',
        }],
      }),
    });

    expect(await store.count()).toBe(1);
    const episodes = await store.listRecent(1);
    expect(episodes[0]).toMatchObject({ body: '長い散歩を終えて帰宅した。' });
    expect(episodes[0]!.importance).toBeCloseTo(0.6, 5);
  });

  it('still rejects close decisions for nonexistent drafts without final_body', async () => {
    const { store, engine } = await createEngine();
    await engine.handleEvent({
      event: makeEvent(),
      guarded: makeGuarded({
        segmentation: [{ target: 'action', decision: 'close' }],
      }),
    });

    expect(await store.count()).toBe(0);
  });

  it('does not double-record when a front rule already closed the thread in the same event (#100)', async () => {
    const { store, engine } = await createEngine();

    // 会話ドラフトを開く
    await engine.handleEvent({
      event: makeEvent({ actor: 'npc-1', payload: { notification: { kind: 'conversation_message' } } }),
      guarded: makeGuarded({
        segmentation: [{ target: 'conversation', decision: 'open', beat: 'npc-1 と話し始めた' }],
      }),
    });

    // conversation_end イベント: 前段ルールが forceClose し、同一イベントの
    // LLM close 判定（final_body あり）は oneshot へ降格してはならない
    await engine.handleEvent({
      event: makeEvent({
        actor: 'npc-1',
        receivedAt: new Date('2026-07-05T04:00:00.000Z'),
        payload: { notification: { kind: 'conversation_ended' } },
      }),
      guarded: makeGuarded({
        segmentation: [{
          target: 'conversation',
          decision: 'close',
          final_body: 'npc-1 との会話を終えた。',
        }],
      }),
    });

    expect(await store.count()).toBe(1);
  });

  it('does not leak the closing importance label into the next draft on close_and_open (#100)', async () => {
    const { store, engine } = await createEngine();

    await engine.handleEvent({
      event: makeEvent(),
      guarded: makeGuarded({
        segmentation: [{ target: 'action', decision: 'open', beat: '大事な出来事があった' }],
      }),
    });
    await engine.handleEvent({
      event: makeEvent({ receivedAt: new Date('2026-07-05T04:00:00.000Z') }),
      guarded: makeGuarded({
        segmentation: [{
          target: 'action',
          decision: 'close_and_open',
          beat: '次の行動へ移った',
          final_body: '大事な出来事を締めくくった。',
          final_importance: 'high',
        }],
      }),
    });
    // 2 本目のドラフトを平凡なまま閉じる
    await engine.handleEvent({
      event: makeEvent({ receivedAt: new Date('2026-07-05T05:00:00.000Z') }),
      guarded: makeGuarded({
        segmentation: [{ target: 'action', decision: 'close', final_body: '特に何もなかった。' }],
      }),
    });

    const episodes = await store.listRecent(2);
    const closedFirst = episodes.find((episode) => episode.body === '大事な出来事を締めくくった。');
    const closedSecond = episodes.find((episode) => episode.body === '特に何もなかった。');
    expect(closedFirst!.importance).toBeCloseTo(0.9, 5);
    // high ラベルが次のエピソードへ漏れない（salience low 由来の 0.3 のまま）
    expect(closedSecond!.importance).toBeCloseTo(0.3, 5);
  });
});
