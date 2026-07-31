import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SqliteEpisodeStore, buildFtsMatchQuery, type NewEpisode } from '../src/life/episodes.js';

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

async function createStore(): Promise<SqliteEpisodeStore> {
  const dataDir = join(process.cwd(), '.test-artifacts', `karakuri-episodes-${randomUUID()}`);
  await mkdir(dataDir, { recursive: true });
  temporaryDirectories.push(dataDir);
  const store = new SqliteEpisodeStore({ dataDir });
  stores.push(store);
  return store;
}

function makeEpisode(overrides: Partial<NewEpisode> = {}): NewEpisode {
  return {
    occurredAt: '2026-07-05T03:00:00.000Z',
    channel: 'kw:bot-1',
    body: '映画館でBさんを誘ったが返事がなかった。少し寂しかった。',
    importance: 0.7,
    participants: ['kw:agent:agent-b'],
    provenance: [1, 2, 3],
    procVersion: 'appraisal-v1/test',
    ...overrides,
  };
}

describe('SqliteEpisodeStore', () => {
  it('inserts and reads back episodes', async () => {
    const store = await createStore();
    const id = await store.insert(makeEpisode());

    const episode = await store.getById(id);
    expect(episode).toMatchObject({
      id,
      body: '映画館でBさんを誘ったが返事がなかった。少し寂しかった。',
      importance: 0.7,
      buoyancy: 1,
      participants: ['kw:agent:agent-b'],
      provenance: [1, 2, 3],
    });
  });

  it('searches Japanese text via FTS trigram (kept in sync by triggers)', async () => {
    const store = await createStore();
    await store.insert(makeEpisode());
    await store.insert(makeEpisode({ body: '広場でCさんと将棋を指して勝った。うれしかった。' }));

    const results = await store.searchText('映画館', 10);
    expect(results).toHaveLength(1);
    expect(results[0]!.episode.body).toContain('映画館');
  });

  it('falls back to LIKE for queries shorter than 3 characters', async () => {
    const store = await createStore();
    await store.insert(makeEpisode());

    // trigram は 2 文字クエリに構造的にマッチしないため LIKE フォールバックが効く
    const results = await store.searchText('映画', 10);
    expect(results).toHaveLength(1);
  });

  it('updates buoyancy with clamping', async () => {
    const store = await createStore();
    const id = await store.insert(makeEpisode());
    await store.updateBuoyancy(id, 0.4);
    expect((await store.getById(id))?.buoyancy).toBeCloseTo(0.4);
    await store.updateBuoyancy(id, -1);
    expect((await store.getById(id))?.buoyancy).toBe(0);
  });

  it('escapes FTS query syntax from user input', () => {
    expect(buildFtsMatchQuery('映画館 OR "x"')).toBe('"映画館" OR "OR" OR """x"""');
  });

  it('persists and retrieves drafts', async () => {
    const store = await createStore();
    await store.upsertDraft({
      channel: 'kw:bot-1',
      threadKey: 'action',
      startedAt: '2026-07-05T03:00:00.000Z',
      lastEventAt: '2026-07-05T03:30:00.000Z',
      beats: [{ at: '2026-07-05T03:00:00.000Z', text: '映画館へ向かった' }],
      participants: [],
      emotions: [0.1],
      provenance: [1],
    });

    const draft = await store.getDraft('kw:bot-1', 'action');
    expect(draft?.beats).toHaveLength(1);

    await store.upsertDraft({
      channel: 'kw:bot-1',
      threadKey: 'action',
      startedAt: '2026-07-05T03:00:00.000Z',
      lastEventAt: '2026-07-05T04:00:00.000Z',
      beats: [
        { at: '2026-07-05T03:00:00.000Z', text: '映画館へ向かった' },
        { at: '2026-07-05T04:00:00.000Z', text: '映画を観はじめた' },
      ],
      participants: ['kw:agent:agent-b'],
      emotions: [0.1, 0.2],
      provenance: [1, 2],
    });
    const updated = await store.getDraft('kw:bot-1', 'action');
    expect(updated?.beats).toHaveLength(2);
    expect(updated?.startedAt).toBe('2026-07-05T03:00:00.000Z');

    await store.deleteDraft('kw:bot-1', 'action');
    expect(await store.getDraft('kw:bot-1', 'action')).toBeNull();
  });
});
