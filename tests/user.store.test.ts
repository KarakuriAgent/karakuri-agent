import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { SqliteUserStore } from '../src/user/store.js';

const temporaryDirectories: string[] = [];
const stores: SqliteUserStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createStore() {
  const dataDir = await mkdtemp(join(tmpdir(), 'karakuri-user-store-'));
  temporaryDirectories.push(dataDir);
  const store = new SqliteUserStore({ dataDir });
  stores.push(store);
  return { dataDir, store };
}

describe('SqliteUserStore', () => {
  it('creates a new user on first ensureUser', async () => {
    const { store } = await createStore();

    const user = await store.ensureUser('user-1', 'Alice');

    expect(user.userId).toBe('user-1');
    expect(user.displayName).toBe('Alice');
  });

  it('refreshes the display name on repeated ensureUser', async () => {
    const { store } = await createStore();

    const first = await store.ensureUser('user-1', 'Alice');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const user = await store.ensureUser('user-1', 'Alice Renamed');

    expect(user.displayName).toBe('Alice Renamed');
    expect(Date.parse(user.updatedAt)).toBeGreaterThan(Date.parse(first.updatedAt));
  });

  it('keeps the saved display name when ensureUser receives a blank name', async () => {
    const { store } = await createStore();

    await store.ensureUser('user-1', 'Alice');
    const user = await store.ensureUser('user-1', '   ');

    expect(user.displayName).toBe('Alice');
  });

  it('returns null for missing users and the record for existing users', async () => {
    const { store } = await createStore();

    await expect(store.getUser('missing')).resolves.toBeNull();
    await store.ensureUser('user-1', 'Alice');
    await expect(store.getUser('user-1')).resolves.toMatchObject({
      userId: 'user-1',
      displayName: 'Alice',
    });
  });

  it('searches users by partial display name matches', async () => {
    const { store } = await createStore();

    await store.ensureUser('user-1', 'Alice');
    await store.ensureUser('user-2', 'Bob');

    await expect(store.searchUsers('ali')).resolves.toMatchObject([
      { userId: 'user-1', displayName: 'Alice' },
    ]);
    await expect(store.searchUsers('bob')).resolves.toMatchObject([
      { userId: 'user-2', displayName: 'Bob' },
    ]);
  });

  it('caps search results and supports offsets', async () => {
    const { store } = await createStore();

    for (let i = 0; i < 12; i += 1) {
      await store.ensureUser(`user-${i}`, `Alice ${String(i).padStart(2, '0')}`);
    }

    await expect(store.searchUsers('Alice', { limit: 5, offset: 0 })).resolves.toHaveLength(5);
    await expect(store.searchUsers('Alice', { limit: 5, offset: 5 })).resolves.toHaveLength(5);
  });

  it('ranks exact matches before prefix matches before broader contains matches', async () => {
    const { store } = await createStore();

    await store.ensureUser('user-exact', 'Ali');
    await store.ensureUser('user-prefix', 'Alice');
    await store.ensureUser('user-contains', 'Bali');

    await expect(store.searchUsers('ali', { limit: 2 })).resolves.toMatchObject([
      { userId: 'user-exact', displayName: 'Ali' },
      { userId: 'user-prefix', displayName: 'Alice' },
    ]);
  });

  it('lists recent known users for empty queries', async () => {
    const { store } = await createStore();

    await store.ensureUser('user-1', 'Alice');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.ensureUser('user-2', 'Bob');

    await expect(store.searchUsers('', { limit: 2 })).resolves.toMatchObject([
      { userId: 'user-2', displayName: 'Bob' },
      { userId: 'user-1', displayName: 'Alice' },
    ]);
  });

  it('treats repeated ensureUser calls as recent activity for empty-query ordering', async () => {
    const { store } = await createStore();

    await store.ensureUser('user-1', 'Alice');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.ensureUser('user-2', 'Bob');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.ensureUser('user-1', 'Alice Renamed');

    await expect(store.searchUsers('', { limit: 2 })).resolves.toMatchObject([
      { userId: 'user-1', displayName: 'Alice Renamed' },
      { userId: 'user-2', displayName: 'Bob' },
    ]);
  });

  it('persists records across close and reopen', async () => {
    const { dataDir, store } = await createStore();

    await store.ensureUser('user-1', 'Alice');
    await store.close();
    stores.splice(stores.indexOf(store), 1);

    const reopened = new SqliteUserStore({ dataDir });
    stores.push(reopened);

    await expect(reopened.getUser('user-1')).resolves.toMatchObject({
      displayName: 'Alice',
    });
  });


  it('links, resolves, lists, and unlinks user aliases', async () => {
    const { store } = await createStore();

    await store.ensureUser('discord:1', 'Alice');
    await store.ensureUser('sns:mastodon:1', 'Alice@Mastodon');
    await store.linkUserAlias('sns:mastodon:1', 'discord:1', { linkedBy: 'admin', note: 'same person' });

    await expect(store.resolveAlias('sns:mastodon:1')).resolves.toMatchObject({
      primaryUserId: 'discord:1',
      aliasOf: { aliasUserId: 'sns:mastodon:1', primaryUserId: 'discord:1', linkedBy: 'admin', note: 'same person' },
    });
    await expect(store.listAliases('discord:1')).resolves.toMatchObject([
      { aliasUserId: 'sns:mastodon:1', primaryUserId: 'discord:1' },
    ]);
    await store.unlinkUserAlias('sns:mastodon:1');
    await expect(store.resolveAlias('sns:mastodon:1')).resolves.toEqual({ primaryUserId: 'sns:mastodon:1', aliasOf: null });
  });

  it('rejects invalid alias relationships', async () => {
    const { store } = await createStore();

    await store.ensureUser('primary', 'Primary');
    await store.ensureUser('alias', 'Alias');
    await store.ensureUser('other', 'Other');

    await expect(store.linkUserAlias('primary', 'primary')).rejects.toThrow('self_link');
    await expect(store.linkUserAlias('missing', 'primary')).rejects.toThrow('not_found');
    await store.linkUserAlias('alias', 'primary');
    await expect(store.linkUserAlias('alias', 'other')).rejects.toThrow('already_linked');
    await expect(store.linkUserAlias('other', 'alias')).rejects.toThrow('chain_detected');
    await expect(store.linkUserAlias('primary', 'other')).rejects.toThrow('cannot_demote_primary');
  });

  it('rejects unlinking an alias that is not currently linked', async () => {
    const { store } = await createStore();

    await store.ensureUser('discord:1', 'Alice');
    await expect(store.unlinkUserAlias('discord:1')).rejects.toThrow('not_linked');
    await expect(store.unlinkUserAlias('never-existed')).rejects.toThrow('not_linked');
    await expect(store.unlinkUserAlias('   ')).rejects.toThrow('invalid_user_id');
  });

  it('keeps getUser raw without alias resolution', async () => {
    const { store } = await createStore();

    await store.ensureUser('discord:1', 'Alice');
    await store.ensureUser('sns:x:1', 'X Alice');
    await store.linkUserAlias('sns:x:1', 'discord:1');

    const aliasRaw = await store.getUser('sns:x:1');
    expect(aliasRaw?.userId).toBe('sns:x:1');
    expect(aliasRaw?.displayName).toBe('X Alice');
  });

  it('resolveAlias follows multi-hop chains with bounded depth', async () => {
    const { dataDir, store } = await createStore();

    await store.ensureUser('a', 'A');
    await store.ensureUser('b', 'B');
    await store.ensureUser('c', 'C');
    await store.linkUserAlias('a', 'b');

    const sideChannel = new Database(join(dataDir, 'users.db'));
    try {
      sideChannel
        .prepare(`INSERT INTO user_aliases (alias_user_id, primary_user_id, linked_at, linked_by, note) VALUES (?, ?, ?, NULL, NULL)`)
        .run('b', 'c', new Date().toISOString());
    } finally {
      sideChannel.close();
    }

    const resolved = await store.resolveAlias('a');
    expect(resolved.primaryUserId).toBe('c');
    expect(resolved.aliasOf?.aliasUserId).toBe('a');
  });
});
