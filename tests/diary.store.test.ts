import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SqliteDiaryStore } from '../src/memory/diary-store.js';

const temporaryDirectories: string[] = [];
const stores: SqliteDiaryStore[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createStore() {
  const dataDir = join(process.cwd(), '.test-artifacts', `karakuri-diary-store-${randomUUID()}`);
  await mkdir(dataDir, { recursive: true });
  temporaryDirectories.push(dataDir);
  const store = new SqliteDiaryStore({ dataDir, timezone: 'UTC' });
  stores.push(store);
  return { dataDir, store };
}

async function runStartupImportInSeparateProcess(dataDir: string): Promise<void> {
  const tsxCliPath = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const diaryStoreModuleUrl = pathToFileURL(
    join(process.cwd(), 'src', 'memory', 'diary-store.ts'),
  ).href;
  const child = spawn(
    process.execPath,
    [
      tsxCliPath,
      '--eval',
      `
        import { SqliteDiaryStore } from ${JSON.stringify(diaryStoreModuleUrl)};

        const store = new SqliteDiaryStore({ dataDir: ${JSON.stringify(dataDir)}, timezone: 'UTC' });
        store.close().catch((error) => {
          console.error(error);
          process.exitCode = 1;
        });
      `,
    ],
    { cwd: process.cwd(), stdio: 'pipe' },
  );

  await new Promise<void>((resolve, reject) => {
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Startup import process failed with code ${code}: ${stderr}`));
    });
  });
}

describe('SqliteDiaryStore', () => {
  it('returns null when a diary entry does not exist', async () => {
    const { store } = await createStore();

    await expect(store.readDiary('2025-01-10')).resolves.toBeNull();
  });

  it('rejects malformed date strings', async () => {
    const { store } = await createStore();

    await expect(store.readDiary('not-a-date')).rejects.toThrow('expected format YYYY-MM-DD');
    await expect(store.writeDiary('2025/01/10', 'note')).rejects.toThrow('expected format YYYY-MM-DD');
    await expect(store.replaceDiary('2025/01/10', 'note')).rejects.toThrow('expected format YYYY-MM-DD');
    await expect(store.deleteDiary('2025/01/10')).rejects.toThrow('expected format YYYY-MM-DD');
  });

  it('skips writing an empty string', async () => {
    const { store } = await createStore();

    await store.writeDiary('2025-01-10', '');

    await expect(store.readDiary('2025-01-10')).resolves.toBeNull();
  });

  it('returns an empty array when days is zero or negative', async () => {
    const { store } = await createStore();
    await store.writeDiary('2025-01-10', 'note');

    await expect(store.getRecentDiaries(0)).resolves.toEqual([]);
    await expect(store.getRecentDiaries(-1)).resolves.toEqual([]);
  });

  it('can be closed multiple times without error', async () => {
    const { store } = await createStore();

    await store.close();
    await expect(store.close()).resolves.toBeUndefined();
  });

  it('writes and reads a diary entry', async () => {
    const { store } = await createStore();

    await store.writeDiary('2025-01-10', 'First note');

    await expect(store.readDiary('2025-01-10')).resolves.toBe('First note');
  });

  it('joins multiple entries from the same day in insertion order', async () => {
    const { store } = await createStore();

    await store.writeDiary('2025-01-10', 'First note');
    await store.writeDiary('2025-01-10', 'Second note');

    await expect(store.readDiary('2025-01-10')).resolves.toBe('First note\n\nSecond note');
  });

  it('replaces all diary entries for the same date', async () => {
    const { store } = await createStore();

    await store.writeDiary('2025-01-10', 'First note');
    await store.writeDiary('2025-01-10', 'Second note');
    await store.replaceDiary('2025-01-10', 'Replacement note');

    await expect(store.readDiary('2025-01-10')).resolves.toBe('Replacement note');
  });

  it('deletes all diary entries when replaceDiary receives empty content', async () => {
    const { store } = await createStore();

    await store.writeDiary('2025-01-10', 'First note');
    await store.replaceDiary('2025-01-10', '   ');

    await expect(store.readDiary('2025-01-10')).resolves.toBeNull();
  });

  it('deletes diary entries and reports whether anything changed', async () => {
    const { store } = await createStore();

    await store.writeDiary('2025-01-10', 'First note');

    await expect(store.deleteDiary('2025-01-10')).resolves.toBe(true);
    await expect(store.readDiary('2025-01-10')).resolves.toBeNull();
    await expect(store.deleteDiary('2025-01-10')).resolves.toBe(false);
  });

  it('skips empty content and trims stored entries', async () => {
    const { store } = await createStore();

    await store.writeDiary('2025-01-10', '   ');
    await store.writeDiary('2025-01-10', '  Trimmed note  ');

    await expect(store.readDiary('2025-01-10')).resolves.toBe('Trimmed note');
    await expect(store.listDiaryDates()).resolves.toEqual(['2025-01-10']);
  });

  it('returns recent diaries within the calendar window and excludes future dates', async () => {
    const { store } = await createStore();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-10T12:00:00Z'));

    await store.writeDiary('2025-01-07', 'outside window');
    await store.writeDiary('2025-01-08', 'day one');
    await store.writeDiary('2025-01-10', 'day three first');
    await store.writeDiary('2025-01-10', 'day three second');
    await store.writeDiary('2025-01-11', 'future note');

    await expect(store.getRecentDiaries(3)).resolves.toEqual([
      { date: '2025-01-08', content: 'day one' },
      { date: '2025-01-10', content: 'day three first\n\nday three second' },
    ]);
  });

  it('lists saved diary dates in ascending order', async () => {
    const { store } = await createStore();

    await store.writeDiary('2025-01-12', 'later');
    await store.writeDiary('2025-01-10', 'earlier');
    await store.writeDiary('2025-01-11', 'middle');

    await expect(store.listDiaryDates()).resolves.toEqual([
      '2025-01-10',
      '2025-01-11',
      '2025-01-12',
    ]);
  });

  it('persists entries across close and reopen', async () => {
    const { dataDir, store } = await createStore();

    await store.writeDiary('2025-01-10', 'Persistent note');
    await store.close();
    stores.splice(stores.indexOf(store), 1);

    const reopened = new SqliteDiaryStore({ dataDir, timezone: 'UTC' });
    stores.push(reopened);

    await expect(reopened.readDiary('2025-01-10')).resolves.toBe('Persistent note');
  });

  it('skips reading legacy files that were already imported on later startups', async () => {
    const { dataDir, store } = await createStore();
    const legacyDiaryDir = join(dataDir, 'memory', 'diary');
    const legacyFilePath = join(legacyDiaryDir, '2025-01-10.md');
    await mkdir(legacyDiaryDir, { recursive: true });
    await writeFile(legacyFilePath, 'Legacy note\n', 'utf8');

    await store.close();
    stores.splice(stores.indexOf(store), 1);

    const imported = new SqliteDiaryStore({ dataDir, timezone: 'UTC' });
    stores.push(imported);
    await expect(imported.readDiary('2025-01-10')).resolves.toBe('Legacy note');

    await imported.close();
    stores.splice(stores.indexOf(imported), 1);
    await chmod(legacyFilePath, 0o000);

    const reopened = new SqliteDiaryStore({ dataDir, timezone: 'UTC' });
    stores.push(reopened);
    await expect(reopened.readDiary('2025-01-10')).resolves.toBe('Legacy note');
  });

  it('imports legacy file-based diary entries once on startup', async () => {
    const { dataDir, store } = await createStore();
    const legacyDiaryDir = join(dataDir, 'memory', 'diary');
    await mkdir(legacyDiaryDir, { recursive: true });
    await writeFile(join(legacyDiaryDir, '2025-01-10.md'), 'Legacy note\n', 'utf8');

    await store.close();
    stores.splice(stores.indexOf(store), 1);

    const imported = new SqliteDiaryStore({ dataDir, timezone: 'UTC' });
    stores.push(imported);
    await expect(imported.readDiary('2025-01-10')).resolves.toBe('Legacy note');
    await expect(imported.listDiaryDates()).resolves.toEqual(['2025-01-10']);

    await imported.close();
    stores.splice(stores.indexOf(imported), 1);

    const reopened = new SqliteDiaryStore({ dataDir, timezone: 'UTC' });
    stores.push(reopened);
    await expect(reopened.readDiary('2025-01-10')).resolves.toBe('Legacy note');
    await expect(reopened.listDiaryDates()).resolves.toEqual(['2025-01-10']);
  });

  it('imports legacy content even when sqlite already has the same date', async () => {
    const { dataDir, store } = await createStore();
    const legacyDiaryDir = join(dataDir, 'memory', 'diary');
    await mkdir(legacyDiaryDir, { recursive: true });

    await store.writeDiary('2025-01-10', 'SQLite note');
    await writeFile(join(legacyDiaryDir, '2025-01-10.md'), 'Legacy note\n', 'utf8');
    await store.close();
    stores.splice(stores.indexOf(store), 1);

    const imported = new SqliteDiaryStore({ dataDir, timezone: 'UTC' });
    stores.push(imported);
    await expect(imported.readDiary('2025-01-10')).resolves.toBe('SQLite note\n\nLegacy note');

    await imported.close();
    stores.splice(stores.indexOf(imported), 1);

    const reopened = new SqliteDiaryStore({ dataDir, timezone: 'UTC' });
    stores.push(reopened);
    await expect(reopened.readDiary('2025-01-10')).resolves.toBe('SQLite note\n\nLegacy note');
  });

  it('ignores date-named legacy directories during startup import', async () => {
    const { dataDir, store } = await createStore();
    const legacyDiaryDir = join(dataDir, 'memory', 'diary');
    await mkdir(join(legacyDiaryDir, '2025-01-10.md'), { recursive: true });
    await writeFile(join(legacyDiaryDir, '2025-01-11.md'), 'Legacy note\n', 'utf8');

    await store.close();
    stores.splice(stores.indexOf(store), 1);

    const reopened = new SqliteDiaryStore({ dataDir, timezone: 'UTC' });
    stores.push(reopened);

    await expect(reopened.readDiary('2025-01-11')).resolves.toBe('Legacy note');
    await expect(reopened.readDiary('2025-01-10')).resolves.toBeNull();
    await expect(reopened.listDiaryDates()).resolves.toEqual(['2025-01-11']);
  });

  it('handles concurrent legacy imports without duplicate entries or startup failures', async () => {
    const { dataDir, store } = await createStore();
    const legacyDiaryDir = join(dataDir, 'memory', 'diary');
    await mkdir(legacyDiaryDir, { recursive: true });
    await writeFile(join(legacyDiaryDir, '2025-01-10.md'), 'Legacy note\n', 'utf8');

    await store.close();
    stores.splice(stores.indexOf(store), 1);

    await expect(
      Promise.all([
        runStartupImportInSeparateProcess(dataDir),
        runStartupImportInSeparateProcess(dataDir),
      ]),
    ).resolves.toBeDefined();

    const reopened = new SqliteDiaryStore({ dataDir, timezone: 'UTC' });
    stores.push(reopened);

    await expect(reopened.readDiary('2025-01-10')).resolves.toBe('Legacy note');
    await expect(reopened.listDiaryDates()).resolves.toEqual(['2025-01-10']);
  });
});
