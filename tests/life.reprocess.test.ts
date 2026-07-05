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
import { buoyancyForAge, reembedAllEpisodes, rederiveKwEventKinds, Reprocessor } from '../src/life/reprocess.js';
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

describe('rederiveKwEventKinds', () => {
  it('retroactively applies improved kind mapping without touching the payload', async () => {
    const env = await createEnv();
    await env.experienceLogStore.append({
      receivedAt: new Date('2026-06-01T10:00:00.000Z'),
      channel: 'kw:bot-1',
      kind: 'unknown',
      payload: { notification: { kind: 'brand_new_event_type', summary: 'x' } },
    });

    const updated = rederiveKwEventKinds(
      env.db,
      '2026-06-01T00:00:00.000Z',
      '2026-06-30T23:59:59.999Z',
      (rawKind) => (rawKind === 'brand_new_event_type' ? 'world_event' : 'unknown'),
    );
    expect(updated).toBe(1);

    const records = await env.experienceLogStore.getRecent(1);
    expect(records[0]!.kind).toBe('world_event');
    expect(JSON.parse(records[0]!.payload)).toEqual({ notification: { kind: 'brand_new_event_type', summary: 'x' } });

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
});
