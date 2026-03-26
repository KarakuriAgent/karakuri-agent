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

  it('claims, recovers, and completes scheduled actions transactionally', async () => {
    const dataDir = createDataDir('schedule-store');
    await mkdir(dataDir, { recursive: true });
    const store = new SqliteSnsActivityStore({ dataDir });

    const dueAt = new Date();
    const actionId = await store.schedule({
      actionType: 'post',
      scheduledAt: dueAt,
      params: { text: 'queued post', visibility: 'public', replyToId: 'reply-42' },
    });

    await expect(store.getPendingAndExecuting()).resolves.toEqual([
      expect.objectContaining({
        id: actionId,
        actionType: 'post',
        status: 'pending',
        params: expect.objectContaining({ text: 'queued post', replyToId: 'reply-42' }),
      }),
    ]);

    const claimed = await store.claimPendingActions(new Date(dueAt.getTime() + 60_000));
    expect(claimed).toEqual([
      expect.objectContaining({
        id: actionId,
        actionType: 'post',
        status: 'executing',
        recoveredFromExecuting: false,
      }),
    ]);
    await expect(store.getPendingAndExecuting()).resolves.toEqual([
      expect.objectContaining({ id: actionId, status: 'executing' }),
    ]);

    await expect(store.recoverStaleExecuting()).resolves.toBe(1);
    await expect(store.getPendingAndExecuting()).resolves.toEqual([
      expect.objectContaining({ id: actionId, status: 'pending' }),
    ]);

    const recoveredClaim = await store.claimPendingActions(new Date(dueAt.getTime() + 60_000));
    expect(recoveredClaim).toEqual([
      expect.objectContaining({
        id: actionId,
        actionType: 'post',
        status: 'executing',
        recoveredFromExecuting: true,
      }),
    ]);
    await store.completeWithRecord(actionId, {
      type: 'post',
      postId: 'posted-1',
      text: 'queued post',
      replyToId: 'reply-42',
      createdAt: new Date(),
    });

    await expect(store.getPendingAndExecuting()).resolves.toEqual([]);
    await expect(store.hasReplied('reply-42')).resolves.toBe(true);
    await expect(store.getRecentActivities(5)).resolves.toEqual([
      expect.objectContaining({ type: 'post', postId: 'posted-1', replyToId: 'reply-42' }),
    ]);

    await store.close();
  });

  it('limits how many due scheduled actions are claimed at once', async () => {
    const dataDir = createDataDir('schedule-claim-limit');
    await mkdir(dataDir, { recursive: true });
    const store = new SqliteSnsActivityStore({ dataDir });

    const dueAt = new Date('2025-01-01T00:00:00.000Z');
    const firstId = await store.schedule({
      actionType: 'like',
      scheduledAt: dueAt,
      params: { postId: 'post-1' },
    });
    const secondId = await store.schedule({
      actionType: 'repost',
      scheduledAt: dueAt,
      params: { postId: 'post-2' },
    });

    const claimed = await store.claimPendingActions(new Date('2025-01-01T00:01:00.000Z'), 1);
    expect(claimed).toEqual([
      expect.objectContaining({ id: firstId, status: 'executing' }),
    ]);
    await expect(store.getPendingAndExecuting()).resolves.toEqual([
      expect.objectContaining({ id: firstId, status: 'executing' }),
      expect.objectContaining({ id: secondId, status: 'pending' }),
    ]);

    await store.close();
  });

  it('marks failed scheduled actions without creating activity records', async () => {
    const dataDir = createDataDir('failed-schedule');
    await mkdir(dataDir, { recursive: true });
    const store = new SqliteSnsActivityStore({ dataDir });

    const dueAt = new Date();
    const actionId = await store.schedule({
      actionType: 'like',
      scheduledAt: dueAt,
      params: { postId: 'post-7' },
    });

    await store.claimPendingActions(new Date(dueAt.getTime() + 60_000));
    await store.markFailed(actionId, 'api timeout');

    await expect(store.getPendingAndExecuting()).resolves.toEqual([]);
    await expect(store.hasLiked('post-7')).resolves.toBe(false);

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
