import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SqliteSnsActivityStore } from '../src/sns/activity-store.js';

function createDataDir(name: string): string {
  return join(process.cwd(), 'tests', '.runtime-sns', name);
}

describe('SqliteSnsActivityStore', () => {
  afterEach(async () => {
    await rm(join(process.cwd(), 'tests', '.runtime-sns'), { recursive: true, force: true });
  });

  it('records and queries recent activities and metadata', async () => {
    const dataDir = createDataDir('activity-store');
    await mkdir(dataDir, { recursive: true });
    const store = new SqliteSnsActivityStore({ dataDir });

    await store.recordPost('post-1', 'hello', 'reply-1');
    await store.recordLike('post-2');
    await store.recordRepost('post-3');
    await store.setLastNotificationId('notif-9');

    await expect(store.hasReplied('reply-1')).resolves.toBe(true);
    await expect(store.hasLiked('post-2')).resolves.toBe(true);
    await expect(store.hasReposted('post-3')).resolves.toBe(true);
    await expect(store.hasQuoted('post-9')).resolves.toBe(false);
    await expect(store.getLastNotificationId()).resolves.toBe('notif-9');
    await expect(store.getRecentActivities(5)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'post', postId: 'post-1', replyToId: 'reply-1' }),
      expect.objectContaining({ type: 'like', postId: 'post-2' }),
      expect.objectContaining({ type: 'repost', postId: 'post-3' }),
    ]));

    await store.close();
  });

  it('records and detects quoted posts', async () => {
    const dataDir = createDataDir('quote-store');
    await mkdir(dataDir, { recursive: true });
    const store = new SqliteSnsActivityStore({ dataDir });

    await store.recordPost('post-q1', 'quoting someone', undefined, 'quoted-1');

    await expect(store.hasQuoted('quoted-1')).resolves.toBe(true);
    await expect(store.hasQuoted('nonexistent')).resolves.toBe(false);
    await expect(store.getRecentActivities(5)).resolves.toEqual([
      expect.objectContaining({ type: 'post', postId: 'post-q1', text: 'quoting someone', quotePostId: 'quoted-1' }),
    ]);

    await store.close();
  });

  it('upserts last notification id on repeated calls', async () => {
    const dataDir = createDataDir('upsert-notif');
    await mkdir(dataDir, { recursive: true });
    const store = new SqliteSnsActivityStore({ dataDir });

    await store.setLastNotificationId('notif-1');
    await expect(store.getLastNotificationId()).resolves.toBe('notif-1');

    await store.setLastNotificationId('notif-2');
    await expect(store.getLastNotificationId()).resolves.toBe('notif-2');

    await store.close();
  });

  it('does not expose reserved notification cursors until they are committed', async () => {
    const dataDir = createDataDir('notification-reservations');
    await mkdir(dataDir, { recursive: true });
    const store = new SqliteSnsActivityStore({ dataDir });

    await expect(store.getLastNotificationId()).resolves.toBeNull();

    const firstReservation = await store.reserveLastNotificationId?.('100');
    await expect(store.getLastNotificationId()).resolves.toBeNull();

    const secondReservation = await store.reserveLastNotificationId?.('200');
    await expect(store.getLastNotificationId()).resolves.toBeNull();

    await store.releaseLastNotificationReservation?.(secondReservation!);
    await expect(store.getLastNotificationId()).resolves.toBeNull();

    await store.commitLastNotificationReservation?.(firstReservation!);
    await expect(store.getLastNotificationId()).resolves.toBe('100');

    await store.close();
  });

  it('clears abandoned notification reservations when reopening after a crash', async () => {
    const dataDir = createDataDir('notification-recovery');
    await mkdir(dataDir, { recursive: true });

    const crashedStore = new SqliteSnsActivityStore({ dataDir });
    await crashedStore.setLastNotificationId('100');
    await crashedStore.reserveLastNotificationId?.('200');
    await expect(crashedStore.getLastNotificationId()).resolves.toBe('100');
    await crashedStore.close();

    const recoveredStore = new SqliteSnsActivityStore({ dataDir });
    await expect(recoveredStore.getLastNotificationId()).resolves.toBe('100');
    await recoveredStore.close();
  });

  it('commits reserved notification cursors monotonically', async () => {
    const dataDir = createDataDir('notification-reservation-ttl');
    await mkdir(dataDir, { recursive: true });
    const store = new SqliteSnsActivityStore({ dataDir });

    await store.setLastNotificationId('100');
    const newerReservationToken = await store.reserveLastNotificationId?.('200');
    await expect(store.getLastNotificationId()).resolves.toBe('100');

    await store.commitLastNotificationReservation?.(newerReservationToken!);
    await expect(store.getLastNotificationId()).resolves.toBe('200');

    const olderReservationToken = await store.reserveLastNotificationId?.('150');
    await store.commitLastNotificationReservation?.(olderReservationToken!);
    await expect(store.getLastNotificationId()).resolves.toBe('200');

    await store.close();
  });



  it('close is idempotent', async () => {
    const dataDir = createDataDir('close-idem');
    await mkdir(dataDir, { recursive: true });
    const store = new SqliteSnsActivityStore({ dataDir });

    await store.close();
    await expect(store.close()).resolves.toBeUndefined();
  });
});
