import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FileWatcher } from '../src/utils/file-watcher.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'karakuri-watcher-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('FileWatcher', () => {
  it('invokes the callback when a matching file changes', async () => {
    const directory = await createDirectory();
    const filePath = join(directory, 'target.txt');
    await writeFile(filePath, 'before', 'utf8');

    const watcher = new FileWatcher();
    const callback = vi.fn(async () => undefined);
    watcher.watch(directory, callback, { filenameFilter: /^target\.txt$/, debounceMs: 20 });

    await writeFile(filePath, 'after', 'utf8');

    await vi.waitFor(() => {
      expect(callback).toHaveBeenCalledTimes(1);
    }, { timeout: 1_000 });

    await watcher.close();
  });

  it('debounces repeated events into a single callback', async () => {
    const directory = await createDirectory();
    const filePath = join(directory, 'target.txt');
    await writeFile(filePath, 'before', 'utf8');

    const watcher = new FileWatcher();
    const callback = vi.fn(async () => undefined);
    watcher.watch(directory, callback, { filenameFilter: /^target\.txt$/, debounceMs: 50 });

    await writeFile(filePath, '1', 'utf8');
    await writeFile(filePath, '2', 'utf8');
    await writeFile(filePath, '3', 'utf8');

    await vi.waitFor(() => {
      expect(callback).toHaveBeenCalledTimes(1);
    }, { timeout: 1_000 });

    await watcher.close();
  });

  it('runs a follow-up callback after a new event arrives during a prior reload', async () => {
    const directory = await createDirectory();
    const filePath = join(directory, 'target.txt');
    await writeFile(filePath, 'before', 'utf8');

    const watcher = new FileWatcher();
    let release!: () => void;
    const firstRun = new Promise<void>((resolve) => {
      release = resolve;
    });
    let callCount = 0;
    const callback = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        await firstRun;
      }
    });
    watcher.watch(directory, callback, { filenameFilter: /^target\.txt$/, debounceMs: 10 });

    await writeFile(filePath, '1', 'utf8');
    await vi.waitFor(() => {
      expect(callback).toHaveBeenCalledTimes(1);
    }, { timeout: 1_000 });

    await writeFile(filePath, '2', 'utf8');
    release();

    await vi.waitFor(() => {
      expect(callback).toHaveBeenCalledTimes(2);
    }, { timeout: 1_000 });

    await watcher.close();
  });

  it('stops watching after unsubscribe', async () => {
    const directory = await createDirectory();
    const filePath = join(directory, 'target.txt');
    await writeFile(filePath, 'before', 'utf8');

    const watcher = new FileWatcher();
    const callback = vi.fn(async () => undefined);
    const disposable = watcher.watch(directory, callback, { filenameFilter: /^target\.txt$/, debounceMs: 20 });
    disposable.unsubscribe();

    await writeFile(filePath, 'after', 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(callback).not.toHaveBeenCalled();
    await watcher.close();
  });
});
