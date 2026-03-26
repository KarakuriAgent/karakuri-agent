import { describe, expect, it, vi } from 'vitest';

import { SnsSkillContextProvider } from '../src/sns/context-provider.js';
import type {
  ISnsActivityStore,
  ISnsScheduleStore,
  ScheduledAction,
  SnsNotification,
  SnsPost,
  SnsProvider,
} from '../src/sns/types.js';

function createPost(id: string, text: string): SnsPost {
  return {
    id,
    text,
    authorId: 'acct-1',
    authorName: 'Alice',
    authorHandle: 'alice@example.com',
    createdAt: '2025-01-01T00:00:00.000Z',
    url: `https://social.example/@alice/${id}`,
    visibility: 'public',
    repostCount: 1,
    likeCount: 2,
    replyCount: 3,
  };
}

function createActivityStore(overrides: Partial<ISnsActivityStore> = {}): ISnsActivityStore {
  return {
    recordPost: vi.fn(async () => {}),
    recordLike: vi.fn(async () => {}),
    recordRepost: vi.fn(async () => {}),
    hasLiked: vi.fn(async () => false),
    hasReposted: vi.fn(async () => false),
    hasReplied: vi.fn(async () => false),
    hasQuoted: vi.fn(async () => false),
    getRecentActivities: vi.fn(async () => []),
    getLastNotificationId: vi.fn(async () => null),
    setLastNotificationId: vi.fn(async () => {}),
    reserveLastNotificationId: vi.fn(async () => 'reservation-1'),
    commitLastNotificationReservation: vi.fn(async () => {}),
    releaseLastNotificationReservation: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

function createScheduleStore(overrides: Partial<ISnsScheduleStore> = {}): ISnsScheduleStore {
  return {
    schedule: vi.fn(async () => 1),
    claimPendingActions: vi.fn(async () => []),
    completeWithRecord: vi.fn(async () => {}),
    markFailed: vi.fn(async () => {}),
    recoverStaleExecuting: vi.fn(async () => 0),
    getPendingAndExecuting: vi.fn(async () => []),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

function createProvider(overrides: Partial<SnsProvider> = {}): SnsProvider {
  return {
    post: vi.fn(),
    getPost: vi.fn(),
    getTimeline: vi.fn(),
    search: vi.fn(),
    like: vi.fn(),
    repost: vi.fn(),
    getNotifications: vi.fn(async () => []),
    uploadMedia: vi.fn(),
    getThread: vi.fn(),
    getUserPosts: vi.fn(),
    getTrends: vi.fn(async () => []),
    ...overrides,
  } as never;
}

describe('SnsSkillContextProvider', () => {
  it('formats notifications, trends, activities, and scheduled actions and updates sinceId', async () => {
    const notifications: SnsNotification[] = [{
      id: 'notif-2',
      type: 'reply',
      createdAt: '2025-01-02T00:00:00.000Z',
      accountId: 'acct-2',
      accountName: 'Bob',
      accountHandle: 'bob@example.com',
      post: createPost('post-2', 'Reply text'),
    }];
    const scheduledActions: ScheduledAction[] = [{
      id: 9,
      actionType: 'post',
      scheduledAt: new Date('2025-01-02T01:00:00.000Z'),
      params: { text: 'Scheduled hello', visibility: 'public' },
      status: 'pending',
      createdAt: '2025-01-02T00:30:00.000Z',
    }];
    const activityStore = createActivityStore({
      getRecentActivities: vi.fn(async () => [{ id: 1, type: 'like' as const, postId: 'post-9', createdAt: '2025-01-01T00:00:00.000Z' }]),
      getLastNotificationId: vi.fn(async () => 'notif-1'),
    });
    const scheduleStore = createScheduleStore({
      getPendingAndExecuting: vi.fn(async () => scheduledActions),
    });
    const snsProvider = createProvider({
      getNotifications: vi.fn(async () => notifications),
      getTrends: vi.fn(async () => [createPost('trend-1', 'Trend text')]),
    });

    const provider = new SnsSkillContextProvider({ activityStore, scheduleStore, snsProvider });
    const context = await provider.getContext();
    await context.onSuccess?.();

    expect(snsProvider.getNotifications).toHaveBeenCalledWith({ sinceId: 'notif-1', limit: 5, types: ['mention', 'reply'] });
    expect(activityStore.reserveLastNotificationId).toHaveBeenCalledWith('notif-2');
    expect(activityStore.commitLastNotificationReservation).toHaveBeenCalledWith('reservation-1');
    expect(context.text).toContain('## 新着通知');
    expect(context.text).toContain('## トレンド');
    expect(context.text).toContain('## 直近の行動ログ');
    expect(context.text).toContain('Scheduled hello');
    expect(context.text).toContain('scheduled: 2025-01-02T01:00:00.000Z');
  });

  it('caps unseen notifications to the configured context limit', async () => {
    const activityStore = createActivityStore({
      getLastNotificationId: vi.fn(async () => 'notif-1'),
    });
    const scheduleStore = createScheduleStore();
    const snsProvider = createProvider({
      getNotifications: vi.fn(async ({ maxId }): Promise<SnsNotification[]> => {
        if (maxId == null) {
          return [
            { id: 'notif-5', type: 'reply', createdAt: '2025-01-05T00:00:00.000Z', accountId: 'acct-5', accountName: 'Eve', accountHandle: 'eve@example.com', post: createPost('post-5', 'Newest') },
            { id: 'notif-4', type: 'mention', createdAt: '2025-01-04T00:00:00.000Z', accountId: 'acct-4', accountName: 'Dana', accountHandle: 'dana@example.com', post: createPost('post-4', 'Older') },
          ];
        }
        return [
          { id: 'notif-3', type: 'reply', createdAt: '2025-01-03T00:00:00.000Z', accountId: 'acct-3', accountName: 'Cara', accountHandle: 'cara@example.com', post: createPost('post-3', 'Oldest unseen') },
        ];
      }),
    });

    const provider = new SnsSkillContextProvider({
      activityStore,
      scheduleStore,
      snsProvider,
      notificationLimit: 2,
    });
    const context = await provider.getContext();
    await context.onSuccess?.();

    expect(snsProvider.getNotifications).toHaveBeenNthCalledWith(1, {
      sinceId: 'notif-1',
      maxId: undefined,
      limit: 2,
      types: ['mention', 'reply'],
    });
    expect(snsProvider.getNotifications).toHaveBeenCalledTimes(1);
    expect(activityStore.commitLastNotificationReservation).toHaveBeenCalledWith('reservation-1');
    expect(context.text).toContain('Newest');
    expect(context.text).toContain('Older');
    expect(context.text).not.toContain('Oldest unseen');
  });

  it('keeps notification context when persisting the cursor fails', async () => {
    const notifications: SnsNotification[] = [{
      id: 'notif-2',
      type: 'mention',
      createdAt: '2025-01-02T00:00:00.000Z',
      accountId: 'acct-2',
      accountName: 'Bob',
      accountHandle: 'bob@example.com',
      post: createPost('post-2', 'Reply text'),
    }];
    const activityStore = createActivityStore({
      commitLastNotificationReservation: vi.fn(async () => { throw new Error('db failed'); }),
    });
    const scheduleStore = createScheduleStore();
    const snsProvider = createProvider({
      getNotifications: vi.fn(async () => notifications),
      getTrends: vi.fn(async () => [createPost('trend-1', 'Trend text')]),
    });

    const provider = new SnsSkillContextProvider({ activityStore, scheduleStore, snsProvider });
    const context = await provider.getContext();
    await expect(context.onSuccess?.()).resolves.toBeUndefined();
    expect(context.text).toContain('Reply text');
  });

  it('releases reserved notification cursors when the turn aborts', async () => {
    const activityStore = createActivityStore({
      getLastNotificationId: vi.fn(async () => 'notif-1'),
      reserveLastNotificationId: vi.fn(async () => 'reservation-2'),
    });
    const scheduleStore = createScheduleStore();
    const notifications: SnsNotification[] = [{
      id: 'notif-2',
      type: 'reply',
      createdAt: '2025-01-02T00:00:00.000Z',
      accountId: 'acct-2',
      accountName: 'Bob',
      accountHandle: 'bob@example.com',
      post: createPost('post-2', 'Reply text'),
    }];
    const snsProvider = createProvider({
      getNotifications: vi.fn(async () => notifications),
    });

    const provider = new SnsSkillContextProvider({ activityStore, scheduleStore, snsProvider });
    const context = await provider.getContext();
    await context.onAbort?.();

    expect(activityStore.releaseLastNotificationReservation).toHaveBeenCalledWith('reservation-2');
    expect(activityStore.commitLastNotificationReservation).not.toHaveBeenCalled();
  });

  it('includes error sections when notifications, trends, activities, or schedules fail', async () => {
    const activityStore = createActivityStore({
      getRecentActivities: vi.fn(async () => { throw new Error('activity db failed'); }),
    });
    const scheduleStore = createScheduleStore({
      getPendingAndExecuting: vi.fn(async () => { throw new Error('schedule db failed'); }),
    });
    const snsProvider = createProvider({
      getNotifications: vi.fn(async () => { throw new Error('notification api failed'); }),
      getTrends: vi.fn(async () => { throw new Error('trends api failed'); }),
    });

    const provider = new SnsSkillContextProvider({ activityStore, scheduleStore, snsProvider });
    const context = await provider.getContext();

    expect(context.text).toContain('[ERROR: 通知の取得に失敗しました: notification api failed]');
    expect(context.text).toContain('[ERROR: トレンドの取得に失敗しました: trends api failed]');
    expect(context.text).toContain('[ERROR: 行動ログの取得に失敗しました: activity db failed]');
    expect(context.text).toContain('[ERROR: スケジュール済みアクションの取得に失敗しました: schedule db failed]');
    expect(activityStore.commitLastNotificationReservation).not.toHaveBeenCalled();
  });

  it('preserves successful activity history when scheduled action loading fails', async () => {
    const activityStore = createActivityStore({
      getRecentActivities: vi.fn(async () => [{ id: 1, type: 'like' as const, postId: 'post-9', createdAt: '2025-01-01T00:00:00.000Z' }]),
    });
    const scheduleStore = createScheduleStore({
      getPendingAndExecuting: vi.fn(async () => { throw new Error('schedule db failed'); }),
    });
    const snsProvider = createProvider();

    const provider = new SnsSkillContextProvider({ activityStore, scheduleStore, snsProvider });
    const context = await provider.getContext();

    expect(context.text).toContain('- [like] post_id: post-9 (2025-01-01T00:00:00.000Z)');
    expect(context.text).toContain('[ERROR: スケジュール済みアクションの取得に失敗しました: schedule db failed]');
  });

  it('handles empty first page of notifications', async () => {
    const activityStore = createActivityStore({
      getLastNotificationId: vi.fn(async () => 'notif-1'),
    });
    const scheduleStore = createScheduleStore();
    const snsProvider = createProvider();

    const provider = new SnsSkillContextProvider({ activityStore, scheduleStore, snsProvider });
    const context = await provider.getContext();

    expect(context.text).toContain('## 新着通知\n- なし');
    expect(activityStore.reserveLastNotificationId).not.toHaveBeenCalled();
  });

  it('defers notification cursor persistence until the turn succeeds', async () => {
    const activityStore = createActivityStore({
      getLastNotificationId: vi.fn(async () => 'notif-1'),
    });
    const scheduleStore = createScheduleStore();
    const notifications: SnsNotification[] = [{
      id: 'notif-2',
      type: 'reply',
      createdAt: '2025-01-02T00:00:00.000Z',
      accountId: 'acct-2',
      accountName: 'Bob',
      accountHandle: 'bob@example.com',
      post: createPost('post-2', 'Reply text'),
    }];
    const snsProvider = createProvider({
      getNotifications: vi.fn(async () => notifications),
    });

    const provider = new SnsSkillContextProvider({ activityStore, scheduleStore, snsProvider });
    const context = await provider.getContext();

    expect(context.text).toContain('Reply text');
    expect(activityStore.commitLastNotificationReservation).not.toHaveBeenCalled();
    await context.onSuccess?.();
    expect(activityStore.commitLastNotificationReservation).toHaveBeenCalledWith('reservation-1');
  });

  it('keeps overlapping turns on the committed notification cursor until one succeeds', async () => {
    const reservations = new Map<string, string>();
    let committedCursor: string | null = '100';
    let reservationCounter = 0;
    const activityStore = createActivityStore({
      getLastNotificationId: vi.fn(async () => committedCursor),
      reserveLastNotificationId: vi.fn(async (notificationId: string) => {
        const token = `reservation-${++reservationCounter}`;
        reservations.set(token, notificationId);
        return token;
      }),
      commitLastNotificationReservation: vi.fn(async (token: string) => {
        const reservedCursor = reservations.get(token);
        if (reservedCursor != null) {
          committedCursor = committedCursor == null || reservedCursor.localeCompare(committedCursor) > 0
            ? reservedCursor
            : committedCursor;
        }
        reservations.delete(token);
      }),
      releaseLastNotificationReservation: vi.fn(async (token: string) => {
        reservations.delete(token);
      }),
    });
    const scheduleStore = createScheduleStore();
    const snsProvider = createProvider({
      getNotifications: vi.fn(async ({ sinceId }): Promise<SnsNotification[]> => {
        if (sinceId === '100') {
          return [{
            id: '200',
            type: 'reply',
            createdAt: '2025-01-02T00:00:00.000Z',
            accountId: 'acct-2',
            accountName: 'Bob',
            accountHandle: 'bob@example.com',
            post: createPost('post-2', 'First batch'),
          }];
        }
        if (sinceId === '200') {
          return [{
            id: '300',
            type: 'reply',
            createdAt: '2025-01-03T00:00:00.000Z',
            accountId: 'acct-3',
            accountName: 'Cara',
            accountHandle: 'cara@example.com',
            post: createPost('post-3', 'Second batch'),
          }];
        }
        return [];
      }),
    });

    const provider = new SnsSkillContextProvider({ activityStore, scheduleStore, snsProvider });
    const firstContext = await provider.getContext();
    const secondContext = await provider.getContext();
    await firstContext.onAbort?.();
    await secondContext.onSuccess?.();
    const thirdContext = await provider.getContext();

    expect(snsProvider.getNotifications).toHaveBeenNthCalledWith(1, {
      sinceId: '100',
      maxId: undefined,
      limit: 5,
      types: ['mention', 'reply'],
    });
    expect(snsProvider.getNotifications).toHaveBeenNthCalledWith(2, {
      sinceId: '100',
      maxId: undefined,
      limit: 5,
      types: ['mention', 'reply'],
    });
    expect(snsProvider.getNotifications).toHaveBeenNthCalledWith(3, {
      sinceId: '200',
      maxId: undefined,
      limit: 5,
      types: ['mention', 'reply'],
    });
    expect(firstContext.text).toContain('First batch');
    expect(secondContext.text).toContain('First batch');
    expect(thirdContext.text).toContain('Second batch');
  });
});
