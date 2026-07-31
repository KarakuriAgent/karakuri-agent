import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SqliteActionLedgerStore } from '../src/life/action-ledger.js';

const temporaryDirectories: string[] = [];
const stores: SqliteActionLedgerStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createStore(windowMinutes?: number): Promise<SqliteActionLedgerStore> {
  const dataDir = join(process.cwd(), '.test-artifacts', `karakuri-ledger-${randomUUID()}`);
  await mkdir(dataDir, { recursive: true });
  temporaryDirectories.push(dataDir);
  const store = new SqliteActionLedgerStore({
    dataDir,
    ...(windowMinutes != null ? { windowMinutes } : {}),
  });
  stores.push(store);
  return store;
}

describe('SqliteActionLedgerStore', () => {
  it('aggregates increments within the same window', async () => {
    const store = await createStore(60);
    await store.increment('action', 'conversation_start', new Date('2026-07-05T10:05:00.000Z'));
    await store.increment('action', 'conversation_start', new Date('2026-07-05T10:45:00.000Z'));
    await store.increment('action', 'move', new Date('2026-07-05T10:10:00.000Z'));

    const counts = await store.getCounts('action', new Date('2026-07-05T10:00:00.000Z'));
    expect(counts).toEqual([
      { key: 'conversation_start', count: 2 },
      { key: 'move', count: 1 },
    ]);
  });

  it('filters by since across windows', async () => {
    const store = await createStore(60);
    await store.increment('target', 'agent-b', new Date('2026-07-05T08:00:00.000Z'));
    await store.increment('target', 'agent-b', new Date('2026-07-05T11:30:00.000Z'));

    const recent = await store.getCounts('target', new Date('2026-07-05T11:00:00.000Z'));
    expect(recent).toEqual([{ key: 'agent-b', count: 1 }]);

    const all = await store.getCounts('target', new Date('2026-07-05T00:00:00.000Z'));
    expect(all).toEqual([{ key: 'agent-b', count: 2 }]);
  });

  it('separates buckets', async () => {
    const store = await createStore();
    await store.increment('action', 'move', new Date('2026-07-05T10:00:00.000Z'));
    await store.increment('place', 'cinema', new Date('2026-07-05T10:00:00.000Z'));

    expect(await store.getCounts('action', new Date('2026-07-05T00:00:00.000Z'))).toEqual([
      { key: 'move', count: 1 },
    ]);
    expect(await store.getCounts('place', new Date('2026-07-05T00:00:00.000Z'))).toEqual([
      { key: 'cinema', count: 1 },
    ]);
  });
});
