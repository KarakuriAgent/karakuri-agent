import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { GuardedAppraisal } from '../src/life/appraisal.js';
import { openLifeDatabase } from '../src/life/db.js';
import type { IEmbeddingProvider } from '../src/life/embeddings.js';
import { SqliteEpisodeStore } from '../src/life/episodes.js';
import { SqliteExperienceLogStore } from '../src/life/experience-log.js';
import { SqliteProspectStore } from '../src/life/prospects.js';
import { buoyancyForAge, reembedAllEpisodes, rederiveKwEventIndexes, Reprocessor } from '../src/life/reprocess.js';
import { EpisodeRetrievalService } from '../src/life/retrieval.js';
import type { NormalizedEvent } from '../src/life/types.js';

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

async function createEnv() {
  const dataDir = join(process.cwd(), '.test-artifacts', `karakuri-reprocess-${randomUUID()}`);
  await mkdir(dataDir, { recursive: true });
  temporaryDirectories.push(dataDir);
  const db = openLifeDatabase({ dataDir });
  cleanups.push(() => {
    if (db.open) {
      db.close();
    }
  });
  return {
    db,
    experienceLogStore: new SqliteExperienceLogStore({ db }),
    episodeStore: new SqliteEpisodeStore({ db }),
  };
}

/** 決定論のモック appraisal: サリエンスのある world_event を oneshot エピソードにする */
const mockAppraise = async (event: NormalizedEvent): Promise<GuardedAppraisal | null> => {
  const payload = event.payload as Record<string, unknown> | null;
  const summary = typeof payload?.summary === 'string' ? payload.summary : null;
  if (summary == null) {
    return null;
  }
  return {
    deltas: { valence: 0.1, energy: 0, hunger: 0, social: 0 },
    sleep: 'no_change',
    salience: 'medium',
    relationCandidates: [],
    prospectCandidates: [],
    segmentation: [{
      target: 'action',
      decision: 'oneshot',
      final_body: `再解釈: ${summary}`,
      final_importance: 'medium',
    }],
    rejections: [],
  };
};

async function seedEvents(store: SqliteExperienceLogStore): Promise<void> {
  await store.append({
    receivedAt: new Date('2026-06-01T10:00:00.000Z'),
    channel: 'kw:bot-1',
    kind: 'world_event',
    payload: { summary: '映画館でBさんと映画を観た' },
  });
  await store.append({
    receivedAt: new Date('2026-06-02T10:00:00.000Z'),
    channel: 'kw:bot-1',
    kind: 'world_event',
    payload: { summary: '広場で将棋を指した' },
  });
  // summary なし = モック appraisal がスキップする（記銘なし）
  await store.append({
    receivedAt: new Date('2026-06-03T10:00:00.000Z'),
    channel: 'kw:bot-1',
    kind: 'unknown',
    payload: { other: 'noise' },
  });
}

describe('Reprocessor.reprocessEpisodes', () => {
  it('rebuilds episodes from the experience log with the new processor version', async () => {
    const env = await createEnv();
    await seedEvents(env.experienceLogStore);
    // 旧処理系による「未熟な」エピソード
    await env.episodeStore.insert({
      occurredAt: '2026-06-01T10:00:00.000Z',
      channel: 'kw:bot-1',
      body: 'ノード14-14で conversation_start を実行した',
      importance: 0.2,
      participants: [],
      provenance: [1],
      procVersion: 'appraisal-v0/old',
    });

    const reprocessor = new Reprocessor({
      experienceLogStore: env.experienceLogStore,
      episodeStore: env.episodeStore,
      appraise: mockAppraise,
      procVersion: 'appraisal-v2/new',
      now: () => new Date('2026-07-05T00:00:00.000Z'),
    });
    const result = await reprocessor.reprocessEpisodes('2026-06-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z');

    expect(result.deletedEpisodes).toBe(1);
    expect(result.replayedEvents).toBe(3);
    expect(result.createdEpisodes).toBe(2);

    const episodes = await env.episodeStore.listByPeriod('2026-06-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z');
    expect(episodes).toHaveLength(2);
    expect(episodes.every((episode) => episode.procVersion === 'appraisal-v2/new')).toBe(true);
    expect(episodes[0]!.body).toContain('映画館');
    // 浮力は経過時間から決定論で再計算される
    expect(episodes[0]!.buoyancy).toBeLessThan(1);
    const ageDays = (new Date('2026-07-05T00:00:00.000Z').getTime() - new Date('2026-06-01T10:00:00.000Z').getTime()) / 86_400_000;
    expect(episodes[0]!.buoyancy).toBeCloseTo(buoyancyForAge(ageDays), 3);
  });

  it('is re-entrant: running the same range twice does not duplicate episodes', async () => {
    const env = await createEnv();
    await seedEvents(env.experienceLogStore);
    const reprocessor = new Reprocessor({
      experienceLogStore: env.experienceLogStore,
      episodeStore: env.episodeStore,
      appraise: mockAppraise,
      procVersion: 'appraisal-v2/new',
      now: () => new Date('2026-07-05T00:00:00.000Z'),
    });

    const first = await reprocessor.reprocessEpisodes('2026-06-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z');
    const second = await reprocessor.reprocessEpisodes('2026-06-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z');

    expect(first.createdEpisodes).toBe(2);
    expect(second.deletedEpisodes).toBe(2);
    expect(second.createdEpisodes).toBe(2);
    expect(await env.episodeStore.count()).toBe(2);

    // 決定論部分の同一性: モック LLM で同一入力 → 同一本文
    const episodes = await env.episodeStore.listByPeriod('2026-06-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z');
    expect(episodes.map((episode) => episode.body).sort()).toEqual([
      '再解釈: 広場で将棋を指した',
      '再解釈: 映画館でBさんと映画を観た',
    ].sort());
  });

  it('preserves path-dependent state (prospects.status) across reprocessing', async () => {
    const env = await createEnv();
    await seedEvents(env.experienceLogStore);
    const prospectStore = new SqliteProspectStore({ db: env.db });
    const prospectId = await prospectStore.insert({ kind: 'promise', body: 'Bさんと映画を観る', provenance: [1], procVersion: 'v1' });
    await prospectStore.updateStatus(prospectId, 'fulfilled');

    const reprocessor = new Reprocessor({
      experienceLogStore: env.experienceLogStore,
      episodeStore: env.episodeStore,
      appraise: mockAppraise,
      procVersion: 'appraisal-v2/new',
    });
    await reprocessor.reprocessEpisodes('2026-06-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z');

    // fulfilled が open に戻らない（Reprocessor は prospects に触れない）
    expect((await prospectStore.getById(prospectId))?.status).toBe('fulfilled');
  });

  it('skips failed appraisals and continues (at-most-once with recovery later)', async () => {
    const env = await createEnv();
    await seedEvents(env.experienceLogStore);
    let calls = 0;
    const reprocessor = new Reprocessor({
      experienceLogStore: env.experienceLogStore,
      episodeStore: env.episodeStore,
      appraise: async (event) => {
        calls += 1;
        if (calls === 1) {
          throw new Error('llm down');
        }
        return mockAppraise(event);
      },
      procVersion: 'appraisal-v2/new',
    });

    const result = await reprocessor.reprocessEpisodes('2026-06-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z');
    expect(result.appraisalFailures).toBe(1);
    expect(result.createdEpisodes).toBe(1);
  });

  it('does not destroy live drafts on channels outside the replayed range', async () => {
    const env = await createEnv();
    await seedEvents(env.experienceLogStore); // kw:bot-1 のイベントのみ
    // リプレイ対象チャネル（kw:bot-1）の古いドラフトと、対象外チャネル（kw:bot-2）で進行中のドラフト
    await env.episodeStore.upsertDraft({
      channel: 'kw:bot-1',
      threadKey: 'action',
      startedAt: '2026-06-01T09:00:00.000Z',
      lastEventAt: '2026-06-01T09:30:00.000Z',
      beats: [{ at: '2026-06-01T09:00:00.000Z', text: '古い処理系のドラフト' }],
      participants: [],
      emotions: [0.1],
      provenance: [1],
    });
    await env.episodeStore.upsertDraft({
      channel: 'kw:bot-2',
      threadKey: 'conversation:kw:agent:agent-b',
      startedAt: '2026-07-05T09:00:00.000Z',
      lastEventAt: '2026-07-05T09:55:00.000Z',
      beats: [{ at: '2026-07-05T09:00:00.000Z', text: 'Bさんと話し始めた' }],
      participants: ['kw:agent:agent-b'],
      emotions: [0.2],
      provenance: [99],
    });

    const reprocessor = new Reprocessor({
      experienceLogStore: env.experienceLogStore,
      episodeStore: env.episodeStore,
      appraise: mockAppraise,
      procVersion: 'appraisal-v2/new',
      now: () => new Date('2026-07-05T10:00:00.000Z'),
    });
    const result = await reprocessor.reprocessEpisodes('2026-06-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z');

    // 対象チャネルのドラフトだけが破棄され、対象外チャネルの生きたドラフトは残る
    expect(result.clearedDrafts).toBe(1);
    const drafts = await env.episodeStore.listDrafts();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.channel).toBe('kw:bot-2');
    expect(drafts[0]!.beats[0]!.text).toBe('Bさんと話し始めた');
    // 対象外チャネルのドラフトが「中断された体験」として episode 化されてもいない
    const strayEpisodes = (await env.episodeStore.listRecent(10))
      .filter((episode) => episode.channel === 'kw:bot-2');
    expect(strayEpisodes).toHaveLength(0);
  });

  it('preserves live drafts started after the range even on replayed channels', async () => {
    const env = await createEnv();
    await seedEvents(env.experienceLogStore); // kw:bot-1 の 6 月のイベント
    // 同じチャネル（kw:bot-1）で「いま」進行中のドラフト。過去期間（6 月）の
    // reprocess に巻き込まれてはいけない（ハザードはチャネルではなく時間軸）
    await env.episodeStore.upsertDraft({
      channel: 'kw:bot-1',
      threadKey: 'conversation:kw:agent:agent-b',
      startedAt: '2026-07-05T09:00:00.000Z',
      lastEventAt: '2026-07-05T09:55:00.000Z',
      beats: [{ at: '2026-07-05T09:00:00.000Z', text: 'Bさんと話し始めた' }],
      participants: ['kw:agent:agent-b'],
      emotions: [0.2],
      provenance: [99],
    });

    const reprocessor = new Reprocessor({
      experienceLogStore: env.experienceLogStore,
      episodeStore: env.episodeStore,
      appraise: mockAppraise,
      procVersion: 'appraisal-v2/new',
      now: () => new Date('2026-07-05T10:00:00.000Z'),
    });
    const result = await reprocessor.reprocessEpisodes('2026-06-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z');

    // 生きたドラフトはビートを失わずそのまま残る（強制 close もされない）
    expect(result.clearedDrafts).toBe(0);
    const drafts = await env.episodeStore.listDrafts();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.channel).toBe('kw:bot-1');
    expect(drafts[0]!.startedAt).toBe('2026-07-05T09:00:00.000Z');
    expect(drafts[0]!.beats).toEqual([{ at: '2026-07-05T09:00:00.000Z', text: 'Bさんと話し始めた' }]);
    // リプレイのエピソードは通常どおり再構築されている
    const episodes = await env.episodeStore.listByPeriod('2026-06-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z');
    expect(episodes).toHaveLength(2);
  });

  it('preserves drafts straddling the range end and accepts offset-form ISO boundaries', async () => {
    const env = await createEnv();
    await seedEvents(env.experienceLogStore); // kw:bot-1 の 6 月のイベント
    // 範囲内に始まり範囲終端を越えて続くドラフト: 範囲外のビートを失わないよう退避される
    await env.episodeStore.upsertDraft({
      channel: 'kw:bot-1',
      threadKey: 'conversation:kw:agent:agent-b',
      startedAt: '2026-06-30T22:00:00.000Z',
      lastEventAt: '2026-07-01T02:00:00.000Z',
      beats: [
        { at: '2026-06-30T22:00:00.000Z', text: '夜にBさんと話し始めた' },
        { at: '2026-07-01T02:00:00.000Z', text: '日付が変わっても話し込んだ' },
      ],
      participants: ['kw:agent:agent-b'],
      emotions: [0.2, 0.1],
      provenance: [98, 99],
    });

    const reprocessor = new Reprocessor({
      experienceLogStore: env.experienceLogStore,
      episodeStore: env.episodeStore,
      appraise: mockAppraise,
      procVersion: 'appraisal-v2/new',
      now: () => new Date('2026-07-05T10:00:00.000Z'),
    });
    // 境界はオフセット形式の ISO でも正しく比較される（内部で UTC ISO へ正規化）
    await reprocessor.reprocessEpisodes('2026-06-01T09:00:00+09:00', '2026-07-01T08:59:59.999+09:00');

    const drafts = await env.episodeStore.listDrafts();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.beats).toHaveLength(2);
    expect(drafts[0]!.beats[1]!.text).toBe('日付が変わっても話し込んだ');
  });

  it('protects finalized episodes straddling the range end (no deletion, no truncated duplicate)', async () => {
    const env = await createEnv();
    // 範囲内に始まり範囲終端を越えて続いた会話（イベント 2 件、確定済みエピソード 1 件）
    const inRangeEventId = await env.experienceLogStore.append({
      receivedAt: new Date('2026-06-30T23:00:00.000Z'),
      channel: 'kw:bot-1',
      kind: 'conversation',
      payload: { summary: '夜にBさんと話し始めた' },
    });
    const outOfRangeEventId = await env.experienceLogStore.append({
      receivedAt: new Date('2026-07-01T02:00:00.000Z'),
      channel: 'kw:bot-1',
      kind: 'conversation',
      payload: { summary: '日付が変わっても話し込んだ' },
    });
    // 範囲内で完結する通常イベント（こちらはリプレイで再構築される）
    await env.experienceLogStore.append({
      receivedAt: new Date('2026-06-15T10:00:00.000Z'),
      channel: 'kw:bot-1',
      kind: 'world_event',
      payload: { summary: '広場で将棋を指した' },
    });
    const straddlingEpisodeId = await env.episodeStore.insert({
      occurredAt: '2026-06-30T23:00:00.000Z',
      channel: 'kw:bot-1',
      body: '夜にBさんと話し始め、日付が変わっても話し込んだ。',
      importance: 0.6,
      participants: ['kw:agent:agent-b'],
      provenance: [inRangeEventId, outOfRangeEventId],
      procVersion: 'appraisal-v0/old',
    });

    const reprocessor = new Reprocessor({
      experienceLogStore: env.experienceLogStore,
      episodeStore: env.episodeStore,
      appraise: mockAppraise,
      procVersion: 'appraisal-v2/new',
      now: () => new Date('2026-07-05T00:00:00.000Z'),
    });
    const result = await reprocessor.reprocessEpisodes('2026-06-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z');

    // 跨ぎエピソードは削除されず（末尾ビートを失わない）、その範囲内イベントも
    // リプレイされない（切り詰められた重複エピソードを作らない）
    expect(result.protectedEpisodes).toBe(1);
    expect(result.deletedEpisodes).toBe(0);
    expect(result.skippedEvents).toBe(1);
    expect(result.replayedEvents).toBe(1);
    const straddling = await env.episodeStore.getById(straddlingEpisodeId);
    expect(straddling).not.toBeNull();
    expect(straddling!.body).toContain('日付が変わっても話し込んだ');
    const all = await env.episodeStore.listRecent(10);
    // 重なりイベントから切り詰められた重複エピソード（再解釈）は作られない
    expect(all.some((episode) => episode.body.includes('再解釈: 夜にBさんと話し始めた'))).toBe(false);
    expect(all.some((episode) => episode.body.includes('再解釈: 広場で将棋を指した'))).toBe(true);
  });

  it('does not replay in-range events of a finalized episode that started before the range', async () => {
    const env = await createEnv();
    // 範囲開始前に始まり範囲内へ食い込んで終わった会話（確定済み）
    const beforeRangeEventId = await env.experienceLogStore.append({
      receivedAt: new Date('2026-06-30T23:00:00.000Z'),
      channel: 'kw:bot-1',
      kind: 'conversation',
      payload: { summary: '夜にBさんと話し始めた' },
    });
    const inRangeEventId = await env.experienceLogStore.append({
      receivedAt: new Date('2026-07-01T02:00:00.000Z'),
      channel: 'kw:bot-1',
      kind: 'conversation',
      payload: { summary: '日付が変わっても話し込んだ' },
    });
    await env.episodeStore.insert({
      occurredAt: '2026-06-30T23:00:00.000Z',
      channel: 'kw:bot-1',
      body: '夜にBさんと話し始め、日付が変わっても話し込んだ。',
      importance: 0.6,
      participants: ['kw:agent:agent-b'],
      provenance: [beforeRangeEventId, inRangeEventId],
      procVersion: 'appraisal-v0/old',
    });

    const reprocessor = new Reprocessor({
      experienceLogStore: env.experienceLogStore,
      episodeStore: env.episodeStore,
      appraise: mockAppraise,
      procVersion: 'appraisal-v2/new',
      now: () => new Date('2026-08-01T00:00:00.000Z'),
    });
    const result = await reprocessor.reprocessEpisodes('2026-07-01T00:00:00.000Z', '2026-07-31T23:59:59.999Z');

    // 範囲外開始のエピソードは削除対象外のまま、範囲内イベントもリプレイされず
    // 部分エピソードが重複生成されない
    expect(result.deletedEpisodes).toBe(0);
    expect(result.protectedEpisodes).toBe(1);
    expect(result.skippedEvents).toBe(1);
    expect(result.createdEpisodes).toBe(0);
    const all = await env.episodeStore.listRecent(10);
    expect(all).toHaveLength(1);
  });

  it('does not re-segment overlap events of a preserved straddling draft (no duplicate episode)', async () => {
    const env = await createEnv();
    const overlapEventId = await env.experienceLogStore.append({
      receivedAt: new Date('2026-06-30T22:00:00.000Z'),
      channel: 'kw:bot-1',
      kind: 'conversation',
      payload: { summary: '夜にBさんと話し始めた' },
    });
    // 範囲と重なったまま「いま」も開いている生きたドラフト
    await env.episodeStore.upsertDraft({
      channel: 'kw:bot-1',
      threadKey: 'conversation:kw:agent:agent-b',
      startedAt: '2026-06-30T22:00:00.000Z',
      lastEventAt: '2026-07-01T02:00:00.000Z',
      beats: [
        { at: '2026-06-30T22:00:00.000Z', text: '夜にBさんと話し始めた' },
        { at: '2026-07-01T02:00:00.000Z', text: '日付が変わっても話し込んだ' },
      ],
      participants: ['kw:agent:agent-b'],
      emotions: [0.2, 0.1],
      provenance: [overlapEventId, 999],
    });

    const reprocessor = new Reprocessor({
      experienceLogStore: env.experienceLogStore,
      episodeStore: env.episodeStore,
      appraise: mockAppraise,
      procVersion: 'appraisal-v2/new',
      now: () => new Date('2026-07-05T00:00:00.000Z'),
    });
    const result = await reprocessor.reprocessEpisodes('2026-06-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z');

    // 重なりイベントはスキップされ、切り詰められた重複エピソードは作られない。
    // ドラフトはビートを失わずそのまま残る
    expect(result.skippedEvents).toBe(1);
    expect(result.createdEpisodes).toBe(0);
    const drafts = await env.episodeStore.listDrafts();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.beats).toHaveLength(2);
    expect(await env.episodeStore.listRecent(10)).toHaveLength(0);
  });

  it('restores preserved drafts even when the replay fails midway', async () => {
    const env = await createEnv();
    await seedEvents(env.experienceLogStore); // kw:bot-1 の 6 月のイベント
    await env.episodeStore.upsertDraft({
      channel: 'kw:bot-1',
      threadKey: 'conversation:kw:agent:agent-b',
      startedAt: '2026-07-05T09:00:00.000Z',
      lastEventAt: '2026-07-05T09:55:00.000Z',
      beats: [{ at: '2026-07-05T09:00:00.000Z', text: 'Bさんと話し始めた' }],
      participants: ['kw:agent:agent-b'],
      emotions: [0.2],
      provenance: [99],
    });

    // リプレイの読み出しが途中で落ちる（保存ドラフトはメモリ上にしかない状況）
    const failingStore: typeof env.experienceLogStore = Object.create(env.experienceLogStore);
    failingStore.listBetween = async () => {
      throw new Error('storage failure during replay');
    };
    const reprocessor = new Reprocessor({
      experienceLogStore: failingStore,
      episodeStore: env.episodeStore,
      appraise: mockAppraise,
      procVersion: 'appraisal-v2/new',
      now: () => new Date('2026-07-05T10:00:00.000Z'),
    });
    await expect(
      reprocessor.reprocessEpisodes('2026-06-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z'),
    ).rejects.toThrow('storage failure during replay');

    // 失敗しても退避したドラフトは復元されている
    const drafts = await env.episodeStore.listDrafts();
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.beats).toEqual([{ at: '2026-07-05T09:00:00.000Z', text: 'Bさんと話し始めた' }]);
  });

  it('replays ranges larger than one batch via paging (delete → full replay invariant)', async () => {
    const env = await createEnv();
    const total = 1_005; // REPLAY_BATCH_SIZE(1000) を超える
    const insert = env.db.prepare(
      'INSERT INTO experience_log (received_at, channel, kind, actor, payload) VALUES (?, ?, ?, NULL, ?)',
    );
    const seedAll = env.db.transaction(() => {
      for (let index = 0; index < total; index += 1) {
        const minute = String(index % 60).padStart(2, '0');
        const hour = String(Math.floor(index / 60) % 24).padStart(2, '0');
        const day = String(1 + Math.floor(index / 1440)).padStart(2, '0');
        insert.run(
          `2026-06-${day}T${hour}:${minute}:00.000Z`,
          'kw:bot-1',
          'world_event',
          JSON.stringify({ summary: `出来事${index}` }),
        );
      }
    });
    seedAll();

    const reprocessor = new Reprocessor({
      experienceLogStore: env.experienceLogStore,
      episodeStore: env.episodeStore,
      appraise: mockAppraise,
      procVersion: 'appraisal-v2/new',
      now: () => new Date('2026-07-05T00:00:00.000Z'),
    });
    const result = await reprocessor.reprocessEpisodes('2026-06-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z');

    // 削除は全件・リプレイが 1 バッチで切れると差分ぶんのデータ消失になる
    expect(result.replayedEvents).toBe(total);
    expect(result.createdEpisodes).toBe(total);
  }, 30_000);

  it('retrieval works across mixed proc_versions', async () => {
    const env = await createEnv();
    await env.episodeStore.insert({
      occurredAt: '2026-05-01T00:00:00.000Z',
      channel: 'kw:bot-1',
      body: '古い処理系の記憶。映画館の話。',
      importance: 0.5,
      participants: [],
      provenance: [],
      procVersion: 'appraisal-v0/old',
    });
    await env.episodeStore.insert({
      occurredAt: '2026-06-01T00:00:00.000Z',
      channel: 'kw:bot-1',
      body: '新しい処理系の記憶。映画館の話。',
      importance: 0.5,
      participants: [],
      provenance: [],
      procVersion: 'appraisal-v2/new',
    });

    const retrieval = new EpisodeRetrievalService({ episodeStore: env.episodeStore });
    const results = await retrieval.search({ text: '映画館', now: new Date('2026-07-01T00:00:00.000Z'), limit: 5 });
    expect(results).toHaveLength(2);
  });
});

describe('rederiveKwEventIndexes (kind)', () => {
  it('retroactively applies improved kind mapping without touching the payload', async () => {
    const env = await createEnv();
    await env.experienceLogStore.append({
      receivedAt: new Date('2026-06-01T10:00:00.000Z'),
      channel: 'kw:bot-1',
      kind: 'unknown',
      payload: { notification: { kind: 'brand_new_event_type', summary: 'x' } },
    });

    const result = rederiveKwEventIndexes(env.db, '2026-06-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z', {
      kindMapper: (rawKind) => (rawKind === 'brand_new_event_type' ? 'world_event' : 'unknown'),
    });
    expect(result.kinds).toBe(1);

    const records = await env.experienceLogStore.getRecent(1);
    expect(records[0]!.kind).toBe('world_event');
    expect(JSON.parse(records[0]!.payload)).toEqual({ notification: { kind: 'brand_new_event_type', summary: 'x' } });

    // append-only トリガーは復元されている
    expect(() => env.db.prepare("UPDATE experience_log SET kind = 'tampered'").run()).toThrow(/append-only/);
  });
});

describe('rederiveKwEventIndexes (actor)', () => {
  it('retroactively applies improved actor extraction without touching the payload', async () => {
    const env = await createEnv();
    // 旧抽出ルールでは actor を取れなかったイベント（actor は NULL のまま記録済み）
    await env.experienceLogStore.append({
      receivedAt: new Date('2026-06-01T10:00:00.000Z'),
      channel: 'kw:bot-1',
      kind: 'conversation',
      payload: { notification: { kind: 'conversation_start', payload: { speaker: { name: 'Bさん' } } } },
    });

    const result = rederiveKwEventIndexes(env.db, '2026-06-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z');
    expect(result.actors).toBe(1);

    const records = await env.experienceLogStore.getRecent(1);
    expect(records[0]!.actor).toBe('kw:npc:Bさん');
    expect(JSON.parse(records[0]!.payload)).toEqual({
      notification: { kind: 'conversation_start', payload: { speaker: { name: 'Bさん' } } },
    });

    // 再実行は冪等（差分なし）
    expect(rederiveKwEventIndexes(env.db, '2026-06-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z').actors).toBe(0);
    // append-only トリガーは復元されている
    expect(() => env.db.prepare("UPDATE experience_log SET actor = 'tampered'").run()).toThrow(/append-only/);
  });

  it('preserves recorded actors when the current extractor cannot derive one (kind と同じ方針)', async () => {
    const env = await createEnv();
    await env.experienceLogStore.append({
      receivedAt: new Date('2026-06-01T10:00:00.000Z'),
      channel: 'kw:bot-1',
      kind: 'conversation',
      actor: 'kw:npc:Bさん', // 旧抽出器が記録済みの actor
      payload: { notification: { kind: 'conversation_start', payload: { legacy_speaker: 'Bさん' } } },
    });

    // 現行抽出器がこの旧ペイロード形状を扱えなくても、索引を NULL で潰さない
    const result = rederiveKwEventIndexes(env.db, '2026-06-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z', {
      actorExtractor: () => undefined,
    });
    expect(result.actors).toBe(0);
    const records = await env.experienceLogStore.getRecent(1);
    expect(records[0]!.actor).toBe('kw:npc:Bさん');
  });
});

describe('rederiveKwEventIndexes', () => {
  it('rederives kind and actor in a single pass with the trigger restored', async () => {
    const env = await createEnv();
    await env.experienceLogStore.append({
      receivedAt: new Date('2026-06-01T10:00:00.000Z'),
      channel: 'kw:bot-1',
      kind: 'unknown',
      payload: { notification: { kind: 'brand_new_event_type', payload: { speaker: { name: 'Bさん' } } } },
    });

    const result = rederiveKwEventIndexes(env.db, '2026-06-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z', {
      kindMapper: (rawKind) => (rawKind === 'brand_new_event_type' ? 'world_event' : 'unknown'),
    });
    expect(result).toEqual({ kinds: 1, actors: 1 });

    const records = await env.experienceLogStore.getRecent(1);
    expect(records[0]!.kind).toBe('world_event');
    expect(records[0]!.actor).toBe('kw:npc:Bさん');
    // 再実行は冪等（差分なし）
    expect(rederiveKwEventIndexes(env.db, '2026-06-01T00:00:00.000Z', '2026-06-30T23:59:59.999Z', {
      kindMapper: (rawKind) => (rawKind === 'brand_new_event_type' ? 'world_event' : 'unknown'),
    })).toEqual({ kinds: 0, actors: 0 });
    // append-only トリガーは復元されている
    expect(() => env.db.prepare("UPDATE experience_log SET kind = 'tampered'").run()).toThrow(/append-only/);
  });
});

describe('reembedAllEpisodes', () => {
  function makeProvider(dimensions: number): IEmbeddingProvider {
    return {
      modelName: `test-embedding-${dimensions}`,
      embedText: async (text: string) => Array.from({ length: dimensions }, (_, index) => (text.length + index) % 7),
    };
  }

  it('rebuilds the vec table for a new model / dimension count', async () => {
    const env = await createEnv();
    const id1 = await env.episodeStore.insert({
      occurredAt: '2026-06-01T00:00:00.000Z',
      channel: 'kw:bot-1',
      body: '映画館でBさんと映画を観た。',
      importance: 0.5,
      participants: [],
      provenance: [],
      procVersion: 'v1',
    });

    const first = await reembedAllEpisodes(env.db, makeProvider(4), 4);
    expect(first.result).toEqual({ queued: 1, indexed: 1 });
    expect(first.index.getEmbedding(id1)).toHaveLength(4);

    // 次元数変更 → vec テーブル作り直しで全再埋め込み
    const second = await reembedAllEpisodes(env.db, makeProvider(8), 8);
    expect(second.result).toEqual({ queued: 1, indexed: 1 });
    expect(second.index.isAvailable()).toBe(true);
    expect(second.index.getEmbedding(id1)).toHaveLength(8);
  });

  it('recovers dead-lettered rows and is not stopped by adjacent permanently-failing episodes', async () => {
    const env = await createEnv();
    const poisonedIds: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      poisonedIds.push(await env.episodeStore.insert({
        occurredAt: '2026-06-01T00:00:00.000Z',
        channel: 'kw:bot-1',
        body: `毒入り${index}`,
        importance: 0.5,
        participants: [],
        provenance: [],
        procVersion: 'v1',
      }));
    }
    const healthyId = await env.episodeStore.insert({
      occurredAt: '2026-06-02T00:00:00.000Z',
      channel: 'kw:bot-1',
      body: '健全なエピソード。',
      importance: 0.5,
      participants: [],
      provenance: [],
      procVersion: 'v1',
    });
    // 通常運用で dead-letter 化した状態を再現（attempts が上限超過）
    for (const id of poisonedIds) {
      env.db.prepare('INSERT INTO episode_embedding_pending (episode_id, attempts) VALUES (?, 99)').run(id);
    }
    const provider: IEmbeddingProvider = {
      modelName: 'test-embedding-4',
      embedText: async (text: string) => {
        if (text.startsWith('毒入り')) {
          throw new Error('this specific content always fails');
        }
        return [text.length, 1, 2, 3];
      },
    };

    // 全パスは 1 件ずつ試す: 隣接する恒久失敗（id 順で先頭 3 件）で止まらず、
    // dead-letter だった行も再試行される（失敗分は attempts 0 で pending に戻る）
    const { index, result } = await reembedAllEpisodes(env.db, provider, 4);
    expect(result).toEqual({ queued: 4, indexed: 1 });
    expect(index.getEmbedding(healthyId)).not.toBeNull();
    const pendingRows = env.db.prepare('SELECT episode_id, attempts FROM episode_embedding_pending ORDER BY episode_id ASC')
      .all() as Array<{ episode_id: number; attempts: number }>;
    expect(pendingRows.map((row) => row.episode_id)).toEqual(poisonedIds);
    expect(pendingRows.every((row) => row.attempts === 0)).toBe(true);
  });
});
