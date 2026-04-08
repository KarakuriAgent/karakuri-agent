import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
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
  const dataDir = join(process.cwd(), '.test-artifacts', `karakuri-memory-${randomUUID()}`);
  await mkdir(dataDir, { recursive: true });
  temporaryDirectories.push(dataDir);
  const store = new FileMemoryStore({ dataDir });
  stores.push(store);
  return { dataDir, store };
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

  it('overwrites the full core memory content', async () => {
    const { store } = await createStore();

    await store.writeCoreMemory('before', 'append');
    await store.writeCoreMemory('after', 'overwrite');

    await expect(store.readCoreMemory()).resolves.toBe('after\n');
  });

  it('clears core memory on empty overwrite', async () => {
    const { store } = await createStore();

    await store.writeCoreMemory('before', 'append');
    await store.writeCoreMemory('', 'overwrite');

    await expect(store.readCoreMemory()).resolves.toBe('');
  });

  it('serializes concurrent overwrite and append safely', async () => {
    const { store } = await createStore();

    await store.writeCoreMemory('initial', 'append');
    await Promise.all([
      store.writeCoreMemory('replacement', 'overwrite'),
      store.writeCoreMemory('extra', 'append'),
    ]);

    const content = await store.readCoreMemory();
    expect(['replacement\n', 'replacement\n\nextra\n']).toContain(content);
    expect(content).not.toContain('initial');
  });

  it('reloads core memory after external edits', async () => {
    const { dataDir, store } = await createStore();
    const corePath = join(dataDir, 'memory', 'core', 'memory.md');

    await store.writeCoreMemory('before', 'append');

    await expect(store.readCoreMemory()).resolves.toContain('before');

    await writeFile(corePath, 'after\n', 'utf8');

    await vi.waitFor(async () => {
      await expect(store.readCoreMemory()).resolves.toBe('after\n');
    }, { timeout: 1_500 });
  });
});
