import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFileStateAdapter } from '../src/state/file-state.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createAdapter() {
  const dataDir = await mkdtemp(join(tmpdir(), 'karakuri-state-'));
  temporaryDirectories.push(dataDir);
  const adapter = createFileStateAdapter({ dataDir });
  await adapter.connect();
  return adapter;
}

describe('FileStateAdapter', () => {
  it('persists subscriptions across reconnects and clears stale locks on startup', async () => {
    const adapter = await createAdapter();
    await adapter.subscribe('thread-1');

    const initialLock = await adapter.acquireLock('thread-1', 60_000);
    expect(initialLock).not.toBeNull();

    await adapter.disconnect();

    const reconnected = createFileStateAdapter({
      dataDir: temporaryDirectories.at(-1) as string,
    });
    await reconnected.connect();

    await expect(reconnected.isSubscribed('thread-1')).resolves.toBe(true);
    await expect(reconnected.acquireLock('thread-1', 60_000)).resolves.toEqual(
      expect.objectContaining({
        threadId: 'thread-1',
      }),
    );
  });

  it('expires cache values and refreshes list ttl while trimming to max length', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    const adapter = await createAdapter();

    await adapter.set('cache-key', { ok: true }, 1_000);
    await expect(adapter.get('cache-key')).resolves.toEqual({ ok: true });

    vi.setSystemTime(new Date('2025-01-01T00:00:02.000Z'));
    await expect(adapter.get('cache-key')).resolves.toBeNull();

    vi.setSystemTime(new Date('2025-01-01T00:00:10.000Z'));
    await adapter.appendToList('history', 'one', { maxLength: 2, ttlMs: 1_000 });

    vi.setSystemTime(new Date('2025-01-01T00:00:10.500Z'));
    await adapter.appendToList('history', 'two', { maxLength: 2, ttlMs: 1_000 });

    vi.setSystemTime(new Date('2025-01-01T00:00:10.900Z'));
    await adapter.appendToList('history', 'three', { maxLength: 2, ttlMs: 1_000 });
    await expect(adapter.getList('history')).resolves.toEqual(['two', 'three']);

    vi.setSystemTime(new Date('2025-01-01T00:00:11.800Z'));
    await expect(adapter.getList('history')).resolves.toEqual(['two', 'three']);

    vi.setSystemTime(new Date('2025-01-01T00:00:12.100Z'));
    await expect(adapter.getList('history')).resolves.toEqual([]);
  });

  it('setIfNotExists returns false when the key already exists', async () => {
    const adapter = await createAdapter();

    const first = await adapter.setIfNotExists('key', 'value-1');
    expect(first).toBe(true);

    const second = await adapter.setIfNotExists('key', 'value-2');
    expect(second).toBe(false);

    await expect(adapter.get('key')).resolves.toBe('value-1');
  });
});
