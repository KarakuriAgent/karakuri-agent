import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { openLifeDatabase } from '../src/life/db.js';
import { EpisodeEmbeddingIndex, type IEmbeddingProvider } from '../src/life/embeddings.js';
import { SqliteEpisodeStore, type NewEpisode } from '../src/life/episodes.js';
import { bigramJaccard, cosineSimilarity, EpisodeRetrievalService, formatEpisodesForPrompt } from '../src/life/retrieval.js';

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
  const dataDir = join(process.cwd(), '.test-artifacts', `karakuri-retrieval-${randomUUID()}`);
  await mkdir(dataDir, { recursive: true });
  temporaryDirectories.push(dataDir);
  const db = openLifeDatabase({ dataDir });
  cleanups.push(() => {
    if (db.open) {
      db.close();
    }
  });
  const store = new SqliteEpisodeStore({ db });
  return { db, store };
}

function makeEpisode(overrides: Partial<NewEpisode> = {}): NewEpisode {
  return {
    occurredAt: '2026-07-01T03:00:00.000Z',
    channel: 'kw:bot-1',
    body: '広場を散歩した。',
    importance: 0.3,
    participants: [],
    provenance: [],
    procVersion: 'test',
    ...overrides,
  };
}

const NOW = new Date('2026-07-05T03:00:00.000Z');

describe('EpisodeRetrievalService', () => {
  it('finds episodes by text match', async () => {
    const { store } = await createEnv();
    await store.insert(makeEpisode({ body: '映画館でBさんと映画を観た。楽しかった。' }));
    await store.insert(makeEpisode({ body: '雨の中を歩いて帰った。' }));

    const service = new EpisodeRetrievalService({ episodeStore: store });
    const results = await service.search({ text: '映画館', now: NOW, limit: 3 });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.episode.body).toContain('映画館');
  });

  it('boosts episodes involving the current counterpart (social context)', async () => {
    const { store } = await createEnv();
    await store.insert(makeEpisode({ body: '朝食にパンを食べた。', occurredAt: '2026-07-04T00:00:00.000Z' }));
    await store.insert(makeEpisode({
      body: 'Bさんと将棋を指した。',
      occurredAt: '2026-07-03T00:00:00.000Z',
      participants: ['kw:agent:agent-b'],
    }));

    const service = new EpisodeRetrievalService({ episodeStore: store });
    const results = await service.search({ participants: ['kw:agent:agent-b'], now: NOW, limit: 2 });

    expect(results[0]!.episode.participants).toContain('kw:agent:agent-b');
  });

  it('ranks buoyant important episodes above sunken ones', async () => {
    const { store } = await createEnv();
    const importantId = await store.insert(makeEpisode({ body: '初めてからくり町に来た日のこと。', importance: 1.0 }));
    const sunkenId = await store.insert(makeEpisode({ body: 'ただ道を歩いた日のこと。', importance: 1.0 }));
    await store.updateBuoyancy(sunkenId, 0.05);

    const service = new EpisodeRetrievalService({ episodeStore: store });
    const results = await service.search({ now: NOW, limit: 2 });

    expect(results[0]!.episode.id).toBe(importantId);
  });

  it('suppresses near-duplicate results via MMR', async () => {
    const { store } = await createEnv();
    await store.insert(makeEpisode({ body: '映画館でBさんを誘ったが返事がなかった。', importance: 0.8 }));
    await store.insert(makeEpisode({ body: '映画館でBさんを誘ったが返事がなかった。また誘った。', importance: 0.8 }));
    await store.insert(makeEpisode({ body: '食堂で新しい定食を食べた。おいしかった。', importance: 0.5 }));

    const service = new EpisodeRetrievalService({ episodeStore: store, mmrLambda: 0.5 });
    const results = await service.search({ text: '映画館', now: NOW, limit: 2 });

    // 上位 2 件がほぼ同一の記憶で埋まらない
    const bodies = results.map((result) => result.episode.body);
    expect(new Set(bodies).size).toBe(bodies.length);
    const similarity = bigramJaccard(bodies[0] ?? '', bodies[1] ?? '');
    expect(similarity).toBeLessThan(0.8);
  });

  it('returns empty results without episodes', async () => {
    const { store } = await createEnv();
    const service = new EpisodeRetrievalService({ episodeStore: store });
    expect(await service.search({ text: '映画', now: NOW })).toEqual([]);
  });

  it('formats episodes for prompt injection with local-day dates', () => {
    const formatted = formatEpisodesForPrompt([
      {
        episode: {
          id: 1,
          // JST では 7/1 深夜（UTC 暦日ではなくローカル日で表示されることを固定する）
          occurredAt: '2026-06-30T16:30:00.000Z',
          channel: 'kw:bot-1',
          body: '映画館でBさんと映画を観た。',
          importance: 0.7,
          buoyancy: 1,
          emotion: null,
          participants: [],
          provenance: [],
          procVersion: 'test',
        },
        score: 1,
      },
    ], 'Asia/Tokyo');
    expect(formatted).toBe('- [2026-07-01] 映画館でBさんと映画を観た。');
  });
});

describe('similarity helpers', () => {
  it('cosineSimilarity works on simple vectors', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('bigramJaccard detects near-duplicates', () => {
    expect(bigramJaccard('映画館でBさんを誘った', '映画館でBさんを誘った')).toBe(1);
    expect(bigramJaccard('映画館でBさんを誘った', '食堂で定食を食べた')).toBeLessThan(0.2);
  });
});

describe('EpisodeEmbeddingIndex', () => {
  function makeProvider(overrides: Partial<IEmbeddingProvider> = {}): IEmbeddingProvider {
    return {
      modelName: 'test-embedding',
      embedText: async (text: string) => {
        // 決定論的な擬似埋め込み（先頭文字コードベース）
        const code = text.codePointAt(0) ?? 0;
        return [Math.sin(code), Math.cos(code), 0.5, 0.25];
      },
      ...overrides,
    };
  }

  it('indexes and searches embeddings', async () => {
    const { db, store } = await createEnv();
    const id = await store.insert(makeEpisode({ body: '映画館でBさんと映画を観た。' }));
    const index = new EpisodeEmbeddingIndex({ db, provider: makeProvider(), dimensions: 4 });
    expect(index.isAvailable()).toBe(true);

    expect(await index.indexEpisode(id, '映画館でBさんと映画を観た。')).toBe(true);
    const results = await index.searchSimilar('映画館', 3);
    expect(results).toHaveLength(1);
    expect(results[0]!.episodeId).toBe(id);
    expect(index.getEmbedding(id)).toHaveLength(4);
  });

  it('queues failed embeddings and backfills them later', async () => {
    const { db, store } = await createEnv();
    const id = await store.insert(makeEpisode());
    let failing = true;
    const provider = makeProvider({
      embedText: async (text: string) => {
        if (failing) {
          throw new Error('embedding API down');
        }
        return [text.length, 1, 2, 3];
      },
    });
    const index = new EpisodeEmbeddingIndex({ db, provider, dimensions: 4 });

    // 失敗してもエピソード確定はブロックされない（false + pending 行き）
    expect(await index.indexEpisode(id, 'テスト')).toBe(false);
    expect(await index.pendingCount()).toBe(1);

    // API 復旧後に backfill される
    failing = false;
    expect(await index.backfillPending()).toBe(1);
    expect(await index.pendingCount()).toBe(0);
    expect(index.getEmbedding(id)).not.toBeNull();
  });

  it('a permanently failing item does not starve later pending items (no head-of-line blocking)', async () => {
    const { db, store } = await createEnv();
    const poisonedId = await store.insert(makeEpisode({ body: '毒入り' }));
    const healthyId = await store.insert(makeEpisode({ body: '健全なエピソード' }));
    const provider = makeProvider({
      embedText: async (text: string) => {
        if (text === '毒入り') {
          throw new Error('this specific content always fails');
        }
        return [text.length, 1, 2, 3];
      },
    });
    const index = new EpisodeEmbeddingIndex({ db, provider, dimensions: 4 });
    // 両方を pending に積む（episode_id 順で毒入りが先頭に来る）
    db.prepare('INSERT OR IGNORE INTO episode_embedding_pending (episode_id) VALUES (?)').run(poisonedId);
    db.prepare('INSERT OR IGNORE INTO episode_embedding_pending (episode_id) VALUES (?)').run(healthyId);

    // 毒入りが先頭にいても後続の pending は埋められる
    const indexed = await index.backfillPending();
    expect(indexed).toBe(1);
    expect(await index.pendingCount()).toBe(1); // 毒入りだけ残る
    expect(index.getEmbedding(healthyId)).not.toBeNull();
  });

  it('deprioritizes failing rows so adjacent poisoned items cannot starve the queue', async () => {
    const { db, store } = await createEnv();
    // 恒久失敗が連続失敗の打ち切り閾値（3）以上先頭に並ぶ、飢餓の再発ケース
    const poisonedIds: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      poisonedIds.push(await store.insert(makeEpisode({ body: `毒入り${index}` })));
    }
    const healthyId = await store.insert(makeEpisode({ body: '健全なエピソード' }));
    const provider = makeProvider({
      embedText: async (text: string) => {
        if (text.startsWith('毒入り')) {
          throw new Error('this specific content always fails');
        }
        return [text.length, 1, 2, 3];
      },
    });
    const index = new EpisodeEmbeddingIndex({ db, provider, dimensions: 4 });
    for (const id of [...poisonedIds, healthyId]) {
      db.prepare('INSERT OR IGNORE INTO episode_embedding_pending (episode_id) VALUES (?)').run(id);
    }

    // 失敗した行は attempts 昇順の選択で自然に後回しになり、次の実行で後続が埋まる
    let totalIndexed = 0;
    for (let run = 0; run < 10 && totalIndexed === 0; run += 1) {
      totalIndexed += await index.backfillPending();
    }
    expect(totalIndexed).toBe(1);
    expect(index.getEmbedding(healthyId)).not.toBeNull();
    // 恒久失敗行は pending に残る（上限到達で dead-letter 化。回収は M7 の --reembed）
    expect(await index.pendingCount()).toBe(3);
  });

  it('excludes dead-lettered rows (attempts at the cap) from backfill selection', async () => {
    const { db, store } = await createEnv();
    const deadId = await store.insert(makeEpisode({ body: '恒久失敗' }));
    const embedText = vi.fn(async (text: string) => [text.length, 1, 2, 3]);
    const index = new EpisodeEmbeddingIndex({ db, provider: makeProvider({ embedText }), dimensions: 4 });
    db.prepare('INSERT INTO episode_embedding_pending (episode_id, attempts) VALUES (?, 99)').run(deadId);

    // dead-letter 行には API コールすら発生しない
    expect(await index.backfillPending()).toBe(0);
    expect(embedText).not.toHaveBeenCalled();
    expect(await index.pendingCount()).toBe(1);
  });

  it('stops the batch after consecutive failures (API-wide outage)', async () => {
    const { db, store } = await createEnv();
    const ids: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      ids.push(await store.insert(makeEpisode({ body: `出来事${index}` })));
    }
    let attempts = 0;
    const provider = makeProvider({
      embedText: async () => {
        attempts += 1;
        throw new Error('embedding API down');
      },
    });
    const index = new EpisodeEmbeddingIndex({ db, provider, dimensions: 4 });
    for (const id of ids) {
      db.prepare('INSERT OR IGNORE INTO episode_embedding_pending (episode_id) VALUES (?)').run(id);
    }

    attempts = 0;
    expect(await index.backfillPending()).toBe(0);
    // 全滅時は連続失敗の上限で打ち切る（pending 全件を無駄撃ちしない）
    expect(attempts).toBe(3);
    expect(await index.pendingCount()).toBe(5);
  });

  it('disables vector search when dimensions change (until M7 re-embedding)', async () => {
    const { db } = await createEnv();
    const first = new EpisodeEmbeddingIndex({ db, provider: makeProvider(), dimensions: 4 });
    expect(first.isAvailable()).toBe(true);

    const second = new EpisodeEmbeddingIndex({ db, provider: makeProvider(), dimensions: 8 });
    expect(second.isAvailable()).toBe(false);
  });
});
