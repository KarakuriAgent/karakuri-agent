import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    expect(user.profile).toBeNull();
  });

  it('preserves the saved display name on repeated ensureUser', async () => {
    const { store } = await createStore();

    const first = await store.ensureUser('user-1', 'Alice');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const user = await store.ensureUser('user-1', 'Alice Renamed');

    expect(user.displayName).toBe('Alice');
    expect(Date.parse(user.updatedAt)).toBeGreaterThan(Date.parse(first.updatedAt));
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

  it('updates and clears profile text', async () => {
    const { store } = await createStore();

    await store.ensureUser('user-1', 'Alice');
    await store.updateProfile('user-1', 'Likes TypeScript');
    await expect(store.getUser('user-1')).resolves.toMatchObject({ profile: 'Likes TypeScript' });

    await store.updateProfile('user-1', null);
    await expect(store.getUser('user-1')).resolves.toMatchObject({ profile: null });
  });

  it('updates display names explicitly', async () => {
    const { store } = await createStore();

    await store.ensureUser('user-1', 'Alice');
    await store.updateDisplayName('user-1', 'Alicia');

    await expect(store.getUser('user-1')).resolves.toMatchObject({ displayName: 'Alicia' });
  });

  it('searches users by partial display name and profile matches', async () => {
    const { store } = await createStore();

    await store.ensureUser('user-1', 'Alice');
    await store.updateProfile('user-1', 'Works on robotics');
    await store.ensureUser('user-2', 'Bob');
    await store.updateProfile('user-2', 'Enjoys music');

    await expect(store.searchUsers('ali')).resolves.toMatchObject([
      { userId: 'user-1', displayName: 'Alice' },
    ]);
    await expect(store.searchUsers('robot')).resolves.toMatchObject([
      { userId: 'user-1', displayName: 'Alice' },
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
    await store.updateProfile('user-2', 'Most recently updated');

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
      { userId: 'user-1', displayName: 'Alice' },
      { userId: 'user-2', displayName: 'Bob' },
    ]);
  });

  it('persists records across close and reopen', async () => {
    const { dataDir, store } = await createStore();

    await store.ensureUser('user-1', 'Alice');
    await store.updateProfile('user-1', 'Persistent profile');
    await store.close();
    stores.splice(stores.indexOf(store), 1);

    const reopened = new SqliteUserStore({ dataDir });
    stores.push(reopened);

    await expect(reopened.getUser('user-1')).resolves.toMatchObject({
      displayName: 'Alice',
      profile: 'Persistent profile',
    });
  });
});
