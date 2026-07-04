import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { clampBeliefConfidence, SINGLE_SOURCE_CONFIDENCE_CAP, SqliteBeliefStore } from '../src/life/beliefs.js';
import { SqliteNarrativeStore } from '../src/life/narratives.js';

const temporaryDirectories: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

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

async function createDataDir(): Promise<string> {
  const dataDir = join(process.cwd(), '.test-artifacts', `karakuri-beliefs-${randomUUID()}`);
  await mkdir(dataDir, { recursive: true });
  temporaryDirectories.push(dataDir);
  return dataDir;
}

describe('SqliteBeliefStore', () => {
  it('caps single-source beliefs at low confidence (contamination guard)', async () => {
    const dataDir = await createDataDir();
    const store = new SqliteBeliefStore({ dataDir });
    cleanups.push(() => store.close());

    const id = await store.insert({
      kind: 'person_fact',
      subject: 'kw:agent:agent-b',
      body: 'Bさんは映画が好きだ',
      confidence: 0.95,
      provenance: [1],
      procVersion: 'test',
    });
    expect((await store.getById(id))?.confidence).toBe(SINGLE_SOURCE_CONFIDENCE_CAP);

    const multiId = await store.insert({
      kind: 'person_fact',
      subject: 'kw:agent:agent-b',
      body: 'Bさんは夜型だ',
      confidence: 0.95,
      provenance: [1, 2, 3],
      procVersion: 'test',
    });
    expect((await store.getById(multiId))?.confidence).toBe(0.95);
    expect(clampBeliefConfidence(2, 5)).toBe(1);
  });

  it('revises beliefs keeping the supersedes chain (改訂、上書きしない)', async () => {
    const dataDir = await createDataDir();
    const store = new SqliteBeliefStore({ dataDir });
    cleanups.push(() => store.close());

    const originalId = await store.insert({
      kind: 'person_fact',
      subject: 'kw:agent:agent-b',
      body: 'Bさんは苦手だ',
      confidence: 0.5,
      provenance: [1, 2],
      procVersion: 'test',
    });
    const revisedId = await store.revise(originalId, {
      body: 'Bさんは苦手だと思っていたが、考えを改めた。今は良い友人だ',
      confidence: 0.8,
      procVersion: 'test-v2',
    });

    expect(revisedId).not.toBeNull();
    const original = await store.getById(originalId);
    expect(original?.active).toBe(false);
    const revised = await store.getById(revisedId!);
    expect(revised?.supersedes).toBe(originalId);
    expect(revised?.active).toBe(true);

    const chain = await store.getRevisionChain(revisedId!);
    expect(chain.map((belief) => belief.id)).toEqual([revisedId, originalId]);

    const active = await store.listActive({ subject: 'kw:agent:agent-b' });
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(revisedId);
  });

  it('filters listActive by kind', async () => {
    const dataDir = await createDataDir();
    const store = new SqliteBeliefStore({ dataDir });
    cleanups.push(() => store.close());

    await store.insert({ kind: 'self', body: 'わたしは夜の散歩が好きだ', confidence: 0.7, provenance: [1, 2], procVersion: 'test' });
    await store.insert({ kind: 'world_fact', body: '星空座のチケットは1800円だ', confidence: 0.8, provenance: [1, 2], procVersion: 'test' });

    const selfBeliefs = await store.listActive({ kind: 'self' });
    expect(selfBeliefs).toHaveLength(1);
    expect(selfBeliefs[0]!.body).toContain('散歩');
  });
});

describe('SqliteNarrativeStore', () => {
  it('inserts diaries and lists them by period', async () => {
    const dataDir = await createDataDir();
    const store = new SqliteNarrativeStore({ dataDir });
    cleanups.push(() => store.close());

    await store.insert({
      kind: 'diary',
      periodStart: '2026-07-05',
      periodEnd: '2026-07-05',
      body: '今日は映画館でBさんと映画を観た。楽しかった。',
      provenance: [1, 2],
      procVersion: 'test',
    });
    const diaries = await store.listByPeriod('diary', '2026-07-01', '2026-07-07');
    expect(diaries).toHaveLength(1);
  });

  it('revises themes with a revision counter (改訂)', async () => {
    const dataDir = await createDataDir();
    const store = new SqliteNarrativeStore({ dataDir });
    cleanups.push(() => store.close());

    const firstId = await store.insert({
      kind: 'theme',
      periodStart: '2026-06-29',
      periodEnd: '2026-07-05',
      body: '最近Bさんとよく出かける',
      provenance: [1],
      procVersion: 'test',
    });
    const secondId = await store.insert({
      kind: 'theme',
      periodStart: '2026-07-06',
      periodEnd: '2026-07-12',
      body: 'Bさんとの外出が週の楽しみになっている',
      provenance: [2],
      procVersion: 'test',
      supersedes: firstId,
    });

    const first = await store.getById(firstId);
    expect(first?.active).toBe(false);
    const second = await store.getById(secondId);
    expect(second?.revision).toBe(2);
    expect(second?.supersedes).toBe(firstId);

    const active = await store.listActive('theme', 10);
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(secondId);
  });

  it('searches narratives via FTS with LIKE fallback for short queries', async () => {
    const dataDir = await createDataDir();
    const store = new SqliteNarrativeStore({ dataDir });
    cleanups.push(() => store.close());

    await store.insert({
      kind: 'chapter',
      periodStart: '2026-05-01',
      periodEnd: '2026-06-30',
      body: 'からくり町に来たばかりの頃。映画館に通い始めた。',
      provenance: [1],
      procVersion: 'test',
    });

    expect(await store.searchText('映画館', 5)).toHaveLength(1);
    expect(await store.searchText('映画', 5)).toHaveLength(1);
    expect(await store.searchText('存在しない話題語句', 5)).toHaveLength(0);
  });
});
