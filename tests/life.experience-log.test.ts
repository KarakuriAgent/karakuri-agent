import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { applyLifeDbMigrations, openLifeDatabase, LIFE_DB_FILE_NAME } from '../src/life/db.js';
import { SqliteExperienceLogStore } from '../src/life/experience-log.js';
import type { NormalizedEvent } from '../src/life/types.js';

const temporaryDirectories: string[] = [];
const stores: SqliteExperienceLogStore[] = [];
const databases: Database.Database[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  for (const db of databases.splice(0)) {
    if (db.open) {
      db.close();
    }
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createDataDir(): Promise<string> {
  const dataDir = join(process.cwd(), '.test-artifacts', `karakuri-life-${randomUUID()}`);
  await mkdir(dataDir, { recursive: true });
  temporaryDirectories.push(dataDir);
  return dataDir;
}

async function createStore(): Promise<{ dataDir: string; store: SqliteExperienceLogStore }> {
  const dataDir = await createDataDir();
  const store = new SqliteExperienceLogStore({ dataDir });
  stores.push(store);
  return { dataDir, store };
}

function buildEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    receivedAt: new Date('2026-07-05T12:00:00.000Z'),
    channel: 'kw:bot-1',
    kind: 'world_event',
    actor: 'kw:agent:alice',
    payload: { summary: 'テスト', unknown_field: { nested: true } },
    ...overrides,
  };
}

describe('SqliteExperienceLogStore', () => {
  it('appends events and reads them back verbatim', async () => {
    const { store } = await createStore();

    const id = await store.append(buildEvent());
    expect(id).toBeGreaterThan(0);

    const records = await store.getRecent(10);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id,
      receivedAt: '2026-07-05T12:00:00.000Z',
      channel: 'kw:bot-1',
      kind: 'world_event',
      actor: 'kw:agent:alice',
    });
    // 未知フィールドを含む payload が逐語で保存される
    expect(JSON.parse(records[0]!.payload)).toEqual({
      summary: 'テスト',
      unknown_field: { nested: true },
    });
  });

  it('stores events without actor', async () => {
    const { store } = await createStore();
    await store.append(buildEvent({ actor: undefined, kind: 'own_action' }));

    const records = await store.getRecent(1);
    expect(records[0]?.actor).toBeNull();
  });

  it('filters by channel and kind', async () => {
    const { store } = await createStore();
    await store.append(buildEvent({ channel: 'discord', kind: 'chat_turn' }));
    await store.append(buildEvent({ channel: 'kw:bot-1', kind: 'own_action' }));
    await store.append(buildEvent({ channel: 'kw:bot-1', kind: 'world_event' }));

    const kwRecords = await store.getRecent(10, { channel: 'kw:bot-1' });
    expect(kwRecords).toHaveLength(2);

    const ownActions = await store.getRecent(10, { channel: 'kw:bot-1', kind: 'own_action' });
    expect(ownActions).toHaveLength(1);
    expect(await store.count()).toBe(3);
  });

  it('returns records newest first', async () => {
    const { store } = await createStore();
    await store.append(buildEvent({ kind: 'first' }));
    await store.append(buildEvent({ kind: 'second' }));

    const records = await store.getRecent(10);
    expect(records.map((record) => record.kind)).toEqual(['second', 'first']);
  });

  it('rejects UPDATE and DELETE at the database level (append-only)', async () => {
    const { dataDir, store } = await createStore();
    await store.append(buildEvent());

    const db = new Database(join(dataDir, LIFE_DB_FILE_NAME));
    databases.push(db);
    expect(() => db.prepare("UPDATE experience_log SET kind = 'tampered'").run())
      .toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM experience_log').run())
      .toThrow(/append-only/);
  });

  it('serializes non-JSON payloads without throwing', async () => {
    const { store } = await createStore();
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(store.append(buildEvent({ payload: circular }))).resolves.toBeGreaterThan(0);
    const records = await store.getRecent(1);
    expect(JSON.parse(records[0]!.payload)).toHaveProperty('unserializable');
  });
});

describe('life DB migrations', () => {
  it('applies migrations once and records versions', async () => {
    const dataDir = await createDataDir();

    const db1 = openLifeDatabase({ dataDir });
    databases.push(db1);
    const rows = db1.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>;
    expect(rows.length).toBeGreaterThan(0);
    db1.close();

    // 再オープンしても再適用されない（エラーにならず、バージョンが増えない）
    const db2 = openLifeDatabase({ dataDir });
    databases.push(db2);
    const rows2 = db2.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>;
    expect(rows2).toEqual(rows);
  });

  it('applies only pending migrations in version order', async () => {
    const dataDir = await createDataDir();
    const db = openLifeDatabase({ dataDir });
    databases.push(db);

    const applied = applyLifeDbMigrations(db, [
      { version: 1, up: 'CREATE TABLE should_not_run (id INTEGER)' },
      { version: 100, up: 'CREATE TABLE added_later (id INTEGER)' },
    ]);
    expect(applied).toEqual([100]);
    expect(() => db.prepare('SELECT * FROM added_later').all()).not.toThrow();
    expect(() => db.prepare('SELECT * FROM should_not_run').all()).toThrow();
  });

  it('rejects duplicate migration versions', async () => {
    const dataDir = await createDataDir();
    const db = openLifeDatabase({ dataDir });
    databases.push(db);

    expect(() => applyLifeDbMigrations(db, [
      { version: 200, up: 'CREATE TABLE a (id INTEGER)' },
      { version: 200, up: 'CREATE TABLE b (id INTEGER)' },
    ])).toThrow(/Duplicate/);
  });
});
