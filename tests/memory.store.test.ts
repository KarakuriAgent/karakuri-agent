import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FileMemoryStore } from '../src/memory/store.js';

const temporaryDirectories: string[] = [];
const stores: FileMemoryStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createStore() {
  const dataDir = await mkdtemp(join(tmpdir(), 'karakuri-memory-'));
  temporaryDirectories.push(dataDir);
  const store = new FileMemoryStore({ dataDir, timezone: 'UTC' });
  stores.push(store);
  return { dataDir, store };
}

function toDateString(date: Date): string {
  const y = String(date.getUTCFullYear());
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

describe('FileMemoryStore', () => {
  it('returns an empty string when core memory does not exist yet', async () => {
    const { store } = await createStore();

    await expect(store.readCoreMemory()).resolves.toBe('');
  });

  it('appends core memory without dropping concurrent writes', async () => {
    const { store } = await createStore();

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        store.writeCoreMemory(`entry ${index}`, 'append'),
      ),
    );

    const content = await store.readCoreMemory();
    for (let index = 0; index < 8; index += 1) {
      expect(content).toContain(`entry ${index}`);
    }
  });

  it('keeps cached diary dates sorted and returns defensive copies', async () => {
    const { store } = await createStore();

    await expect(store.listDiaryDates()).resolves.toEqual([]);

    await store.writeDiary('2025-01-02', 'newer note');
    await store.writeDiary('2025-01-01', 'older note');

    const diaryDates = await store.listDiaryDates();
    expect(diaryDates).toEqual(['2025-01-01', '2025-01-02']);

    diaryDates.push('2099-01-01');

    await expect(store.listDiaryDates()).resolves.toEqual(['2025-01-01', '2025-01-02']);
  });

  it('stores diary entries and returns recent diary dates in reverse chronological order', async () => {
    const { store } = await createStore();

    const today = new Date();
    const todayStr = toDateString(today);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = toDateString(yesterday);

    await store.writeDiary(yesterdayStr, 'older note');
    await store.writeDiary(todayStr, 'newer note');
    await store.writeDiary(todayStr, 'follow-up note');

    await expect(store.listDiaryDates()).resolves.toEqual([yesterdayStr, todayStr].sort());

    const diary = await store.readDiary(todayStr);
    expect(diary).toContain('newer note');
    expect(diary).toContain('follow-up note');

    const recent = await store.getRecentDiaries(2);
    expect(recent).toEqual([
      {
        date: yesterdayStr,
        content: expect.stringContaining('older note'),
      },
      {
        date: todayStr,
        content: expect.stringContaining('newer note'),
      },
    ]);
  });

  it('excludes diary entries older than the calendar window', async () => {
    const { store } = await createStore();

    await store.writeDiary('2020-01-01', 'ancient note');

    const recent = await store.getRecentDiaries(3);
    expect(recent).toEqual([]);

    await expect(store.listDiaryDates()).resolves.toEqual(['2020-01-01']);
  });

  it('excludes future-dated diary entries from recent diaries', async () => {
    const { store } = await createStore();

    const today = new Date();
    const todayStr = toDateString(today);
    await store.writeDiary(todayStr, 'today note');
    await store.writeDiary('2099-01-01', 'future note');

    const recent = await store.getRecentDiaries(3);
    expect(recent).toHaveLength(1);
    expect(recent[0]!.date).toBe(todayStr);
    expect(recent[0]!.content).toContain('today note');
  });

  it('reloads core memory and invalidates diary cache after external edits', async () => {
    const { dataDir, store } = await createStore();
    const corePath = join(dataDir, 'memory', 'core', 'memory.md');
    const diaryPath = join(dataDir, 'memory', 'diary', '2025-01-01.md');

    await store.writeCoreMemory('before', 'append');
    await store.writeDiary('2025-01-01', 'first');

    await expect(store.readCoreMemory()).resolves.toContain('before');
    await expect(store.readDiary('2025-01-01')).resolves.toContain('first');

    await writeFile(corePath, 'after\n', 'utf8');
    await writeFile(diaryPath, 'external\n', 'utf8');

    await vi.waitFor(async () => {
      await expect(store.readCoreMemory()).resolves.toBe('after\n');
      await expect(store.readDiary('2025-01-01')).resolves.toBe('external\n');
    }, { timeout: 1_500 });
  });
});
