import { describe, expect, it, vi } from 'vitest';

import { SnsSkillContextProvider } from '../src/sns/context-provider.js';
import type {
  ISnsActivityStore,
  NotificationFetchResult,
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

function createNotificationResult(notifications: SnsNotification[], complete = true): NotificationFetchResult {
  return { notifications, complete };
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

function createProvider(overrides: Partial<SnsProvider> = {}): SnsProvider {
  return {
    post: vi.fn(),
    getPost: vi.fn(),
    getTimeline: vi.fn(),
    search: vi.fn(),
    like: vi.fn(),
    repost: vi.fn(),
    getNotifications: vi.fn(async () => createNotificationResult([])),
    uploadMedia: vi.fn(),
    getThread: vi.fn(),
    getUserPosts: vi.fn(),
    getTrends: vi.fn(async () => []),
    ...overrides,
  } as never;
}

describe('SnsSkillContextProvider', () => {
  it('formats notifications, trends, and activities and updates sinceId', async () => {
    const notifications: SnsNotification[] = [{
      id: 'notif-2',
      type: 'reply',
      createdAt: '2025-01-02T00:00:00.000Z',
      accountId: 'acct-2',
      accountName: 'Bob',
      accountHandle: 'bob@example.com',
      post: createPost('post-2', 'Reply text'),
    }];
    const activityStore = createActivityStore({
      getRecentActivities: vi.fn(async () => [{ id: 1, type: 'like' as const, postId: 'post-9', createdAt: '2025-01-01T00:00:00.000Z' }]),
      getLastNotificationId: vi.fn(async () => 'notif-1'),
    });
    const snsProvider = createProvider({
      getNotifications: vi.fn(async () => createNotificationResult(notifications)),
      getTrends: vi.fn(async () => [createPost('trend-1', 'Trend text')]),
    });

    const provider = new SnsSkillContextProvider({ activityStore, snsProvider });
    const context = await provider.getContext();
    await context.onSuccess?.();

    expect(snsProvider.getNotifications).toHaveBeenCalledWith({ sinceId: 'notif-1', limit: 5, types: ['mention', 'reply', 'quote'] });
    expect(activityStore.reserveLastNotificationId).toHaveBeenCalledWith('notif-2');
    expect(activityStore.commitLastNotificationReservation).toHaveBeenCalledWith('reservation-1');
    expect(context.text).toContain('## 新着通知');
    expect(context.text).toContain('## トレンド');
    expect(context.text).toContain('## 直近の行動ログ');
    expect(context.text).not.toContain('## スケジュール済みアクション');
  });

  it('caps unseen notifications to the configured context limit', async () => {
    const activityStore = createActivityStore({ getLastNotificationId: vi.fn(async () => 'notif-1') });
    const snsProvider = createProvider({
      getNotifications: vi.fn(async ({ maxId }): Promise<NotificationFetchResult> => {
        if (maxId == null) {
          return createNotificationResult([
            { id: 'notif-5', type: 'reply', createdAt: '2025-01-05T00:00:00.000Z', accountId: 'acct-5', accountName: 'Eve', accountHandle: 'eve@example.com', post: createPost('post-5', 'Newest') },
            { id: 'notif-4', type: 'mention', createdAt: '2025-01-04T00:00:00.000Z', accountId: 'acct-4', accountName: 'Dana', accountHandle: 'dana@example.com', post: createPost('post-4', 'Older') },
          ]);
        }
        return createNotificationResult([{ id: 'notif-3', type: 'reply', createdAt: '2025-01-03T00:00:00.000Z', accountId: 'acct-3', accountName: 'Cara', accountHandle: 'cara@example.com', post: createPost('post-3', 'Oldest unseen') }]);
      }),
    });

    const provider = new SnsSkillContextProvider({ activityStore, snsProvider, notificationLimit: 2 });
    const context = await provider.getContext();
    await context.onSuccess?.();

    expect(snsProvider.getNotifications).toHaveBeenCalledTimes(1);
    expect(context.text).toContain('Newest');
    expect(context.text).toContain('Older');
    expect(context.text).not.toContain('Oldest unseen');
  });

  it('includes quote notifications in the SNS loop context', async () => {
    const activityStore = createActivityStore({ getLastNotificationId: vi.fn(async () => 'notif-1') });
    const snsProvider = createProvider({
      getNotifications: vi.fn(async () => createNotificationResult([
        { id: 'notif-3', type: 'quote', createdAt: '2025-01-03T00:00:00.000Z', accountId: 'acct-3', accountName: 'Cara', accountHandle: 'cara@example.com', post: createPost('post-3', 'Quoted you') },
      ])),
    });

    const provider = new SnsSkillContextProvider({ activityStore, snsProvider });
    const context = await provider.getContext();

    expect(snsProvider.getNotifications).toHaveBeenCalledWith({ sinceId: 'notif-1', limit: 5, types: ['mention', 'reply', 'quote'] });
    expect(context.text).toContain('[quote]');
    expect(context.text).toContain('Quoted you');
  });

  it('keeps notification context when persisting the cursor fails', async () => {
    const activityStore = createActivityStore({
      commitLastNotificationReservation: vi.fn(async () => { throw new Error('db failed'); }),
    });
    const snsProvider = createProvider({
      getNotifications: vi.fn(async () => createNotificationResult([{ id: 'notif-2', type: 'mention', createdAt: '2025-01-02T00:00:00.000Z', accountId: 'acct-2', accountName: 'Bob', accountHandle: 'bob@example.com', post: createPost('post-2', 'Reply text') }])),
    });

    const provider = new SnsSkillContextProvider({ activityStore, snsProvider });
    const context = await provider.getContext();
    await expect(context.onSuccess?.()).resolves.toBeUndefined();
    expect(context.text).toContain('Reply text');
  });

  it('releases reserved notification cursors when the turn aborts', async () => {
    const activityStore = createActivityStore({
      getLastNotificationId: vi.fn(async () => 'notif-1'),
      reserveLastNotificationId: vi.fn(async () => 'reservation-2'),
    });
    const snsProvider = createProvider({
      getNotifications: vi.fn(async () => createNotificationResult([{ id: 'notif-2', type: 'reply', createdAt: '2025-01-02T00:00:00.000Z', accountId: 'acct-2', accountName: 'Bob', accountHandle: 'bob@example.com', post: createPost('post-2', 'Reply text') }])),
    });

    const provider = new SnsSkillContextProvider({ activityStore, snsProvider });
    const context = await provider.getContext();
    await context.onAbort?.();

    expect(activityStore.releaseLastNotificationReservation).toHaveBeenCalledWith('reservation-2');
  });

  it('includes error sections when notifications, trends, or activities fail', async () => {
    const activityStore = createActivityStore({ getRecentActivities: vi.fn(async () => { throw new Error('activity db failed'); }) });
    const snsProvider = createProvider({
      getNotifications: vi.fn(async () => { throw new Error('notification api failed'); }),
      getTrends: vi.fn(async () => { throw new Error('trends api failed'); }),
    });

    const provider = new SnsSkillContextProvider({ activityStore, snsProvider });
    const context = await provider.getContext();

    expect(context.text).toContain('[ERROR: 通知の取得に失敗しました: notification api failed]');
    expect(context.text).toContain('[ERROR: トレンドの取得に失敗しました: trends api failed]');
    expect(context.text).toContain('[ERROR: 行動ログの取得に失敗しました: activity db failed]');
  });

  it('does not reserve or advance the notification cursor when notification loading returns partial results', async () => {
    const activityStore = createActivityStore({ getLastNotificationId: vi.fn(async () => 'notif-1') });
    const snsProvider = createProvider({
      getNotifications: vi.fn(async () => createNotificationResult([{ id: 'notif-2', type: 'reply', createdAt: '2025-01-02T00:00:00.000Z', accountId: 'acct-2', accountName: 'Bob', accountHandle: 'bob@example.com', post: createPost('post-2', 'Partial reply text') }], false)),
    });

    const provider = new SnsSkillContextProvider({ activityStore, snsProvider });
    const context = await provider.getContext();

    expect(activityStore.reserveLastNotificationId).not.toHaveBeenCalled();
    expect(context.onSuccess).toBeUndefined();
    expect(context.text).toContain('Partial reply text');
  });
});
