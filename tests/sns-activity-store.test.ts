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

  it('commits non-numeric (UUID) notification cursors as last-write-wins', async () => {
    // UUID には順序が無い。localeCompare の見かけの順序でガードすると、辞書順の
    // 大きい UUID に当たった時点でカーソルが固着する（実機の ELYTH で発生 —
    // 通常前進も強制前進も全てコミットで棄却され、同じページを再取得し続けた）
    const dataDir = createDataDir('notification-reservation-uuid');
    await mkdir(dataDir, { recursive: true });
    const store = new SqliteSnsActivityStore({ dataDir });

    await store.setLastNotificationId('f4655bdc-2d4f-4c5f-9cde-e1e2a7cc4b19');
    const token = await store.reserveLastNotificationId?.('da592def-7179-4c48-92e6-b0dd3ab6bf6e');
    await store.commitLastNotificationReservation?.(token!);
    await expect(store.getLastNotificationId()).resolves.toBe('da592def-7179-4c48-92e6-b0dd3ab6bf6e');

    await store.close();
  });



  it('counts write actions per kind for rate limiting (M8)', async () => {
    const dataDir = createDataDir('rate-counter');
    await mkdir(dataDir, { recursive: true });
    let nowIso = '2026-07-06T10:00:00.000Z';
    const store = new SqliteSnsActivityStore({ dataDir, now: () => new Date(nowIso) });

    await store.recordPost('post-1', 'new post');
    nowIso = '2026-07-06T10:10:00.000Z';
    await store.recordPost('post-2', 'reply text', 'target-1');
    nowIso = '2026-07-06T10:20:00.000Z';
    await store.recordLike('post-3');

    const since = new Date('2026-07-06T09:30:00.000Z');
    await expect(store.countWriteActionsSince('post', since)).resolves.toEqual({
      count: 1,
      earliestAt: '2026-07-06T10:00:00.000Z',
    });
    await expect(store.countWriteActionsSince('reply', since)).resolves.toEqual({
      count: 1,
      earliestAt: '2026-07-06T10:10:00.000Z',
    });
    await expect(store.countWriteActionsSince('like', since)).resolves.toEqual({
      count: 1,
      earliestAt: '2026-07-06T10:20:00.000Z',
    });
    await expect(store.countWriteActionsSince('repost', since)).resolves.toEqual({ count: 0, earliestAt: null });
    // ウィンドウ外は数えない
    await expect(store.countWriteActionsSince('post', new Date('2026-07-06T10:05:00.000Z'))).resolves.toEqual({ count: 0, earliestAt: null });
    await expect(store.getLastWriteActionAt('post')).resolves.toBe('2026-07-06T10:00:00.000Z');
    await expect(store.getLastWriteActionAt('reply')).resolves.toBe('2026-07-06T10:10:00.000Z');

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
