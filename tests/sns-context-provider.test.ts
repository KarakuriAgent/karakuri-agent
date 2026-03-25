import { describe, expect, it, vi } from 'vitest';

import { SnsSkillContextProvider } from '../src/sns/context-provider.js';
import type { ISnsActivityStore, SnsNotification, SnsPost, SnsProvider } from '../src/sns/types.js';

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
    const activityStore: ISnsActivityStore = {
      recordPost: vi.fn(async () => {}),
      recordLike: vi.fn(async () => {}),
      recordRepost: vi.fn(async () => {}),
      hasLiked: vi.fn(async () => false),
      hasReposted: vi.fn(async () => false),
      hasReplied: vi.fn(async () => false),
      hasQuoted: vi.fn(async () => false),
      getRecentActivities: vi.fn(async () => [{ id: 1, type: 'like' as const, postId: 'post-9', createdAt: '2025-01-01T00:00:00.000Z' }]),
      getLastNotificationId: vi.fn(async () => 'notif-1'),
      setLastNotificationId: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const snsProvider: SnsProvider = {
      post: vi.fn(),
      getPost: vi.fn(),
      getTimeline: vi.fn(),
      search: vi.fn(),
      like: vi.fn(),
      repost: vi.fn(),
      getNotifications: vi.fn(async () => notifications),
      uploadMedia: vi.fn(),
      getThread: vi.fn(),
      getUserPosts: vi.fn(),
      getTrends: vi.fn(async () => [createPost('trend-1', 'Trend text')]),
    } as never;

    const provider = new SnsSkillContextProvider({ activityStore, snsProvider });
    const context = await provider.getContext();

    expect(snsProvider.getNotifications).toHaveBeenCalledWith({ sinceId: 'notif-1', limit: 5, types: ['mention', 'reply'] });
    expect(activityStore.setLastNotificationId).toHaveBeenCalledWith('notif-2');
    expect(context).toContain('## 新着通知');
    expect(context).toContain('## トレンド');
    expect(context).toContain('## 直近の行動ログ');
  });

  it('caps unseen notifications to the configured context limit', async () => {
    const activityStore: ISnsActivityStore = {
      recordPost: vi.fn(async () => {}),
      recordLike: vi.fn(async () => {}),
      recordRepost: vi.fn(async () => {}),
      hasLiked: vi.fn(async () => false),
      hasReposted: vi.fn(async () => false),
      hasReplied: vi.fn(async () => false),
      hasQuoted: vi.fn(async () => false),
      getRecentActivities: vi.fn(async () => []),
      getLastNotificationId: vi.fn(async () => 'notif-1'),
      setLastNotificationId: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const snsProvider: SnsProvider = {
      post: vi.fn(),
      getPost: vi.fn(),
      getTimeline: vi.fn(),
      search: vi.fn(),
      like: vi.fn(),
      repost: vi.fn(),
      getNotifications: vi.fn(async ({ maxId }) => {
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
      uploadMedia: vi.fn(),
      getThread: vi.fn(),
      getUserPosts: vi.fn(),
      getTrends: vi.fn(async () => []),
    } as never;

    const provider = new SnsSkillContextProvider({
      activityStore,
      snsProvider,
      notificationLimit: 2,
    });
    const context = await provider.getContext();

    expect(snsProvider.getNotifications).toHaveBeenNthCalledWith(1, {
      sinceId: 'notif-1',
      maxId: undefined,
      limit: 2,
      types: ['mention', 'reply'],
    });
    expect(snsProvider.getNotifications).toHaveBeenCalledTimes(1);
    expect(activityStore.setLastNotificationId).toHaveBeenCalledWith('notif-5');
    expect(context).toContain('Newest');
    expect(context).toContain('Older');
    expect(context).not.toContain('Oldest unseen');
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
    const activityStore: ISnsActivityStore = {
      recordPost: vi.fn(async () => {}),
      recordLike: vi.fn(async () => {}),
      recordRepost: vi.fn(async () => {}),
      hasLiked: vi.fn(async () => false),
      hasReposted: vi.fn(async () => false),
      hasReplied: vi.fn(async () => false),
      hasQuoted: vi.fn(async () => false),
      getRecentActivities: vi.fn(async () => []),
      getLastNotificationId: vi.fn(async () => null),
      setLastNotificationId: vi.fn(async () => { throw new Error('db failed'); }),
      close: vi.fn(async () => {}),
    };
    const snsProvider: SnsProvider = {
      post: vi.fn(),
      getPost: vi.fn(),
      getTimeline: vi.fn(),
      search: vi.fn(),
      like: vi.fn(),
      repost: vi.fn(),
      getNotifications: vi.fn(async () => notifications),
      uploadMedia: vi.fn(),
      getThread: vi.fn(),
      getUserPosts: vi.fn(),
      getTrends: vi.fn(async () => [createPost('trend-1', 'Trend text')]),
    } as never;

    const provider = new SnsSkillContextProvider({ activityStore, snsProvider });

    await expect(provider.getContext()).resolves.toContain('Reply text');
  });

  it('includes error sections when notifications, trends, or activities fail', async () => {
    const activityStore: ISnsActivityStore = {
      recordPost: vi.fn(async () => {}),
      recordLike: vi.fn(async () => {}),
      recordRepost: vi.fn(async () => {}),
      hasLiked: vi.fn(async () => false),
      hasReposted: vi.fn(async () => false),
      hasReplied: vi.fn(async () => false),
      hasQuoted: vi.fn(async () => false),
      getRecentActivities: vi.fn(async () => { throw new Error('activity db failed'); }),
      getLastNotificationId: vi.fn(async () => null),
      setLastNotificationId: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const snsProvider: SnsProvider = {
      post: vi.fn(),
      getPost: vi.fn(),
      getTimeline: vi.fn(),
      search: vi.fn(),
      like: vi.fn(),
      repost: vi.fn(),
      getNotifications: vi.fn(async () => { throw new Error('notification api failed'); }),
      uploadMedia: vi.fn(),
      getThread: vi.fn(),
      getUserPosts: vi.fn(),
      getTrends: vi.fn(async () => { throw new Error('trends api failed'); }),
    } as never;

    const provider = new SnsSkillContextProvider({ activityStore, snsProvider });
    const context = await provider.getContext();

    expect(context).toContain('[ERROR: 通知の取得に失敗しました: notification api failed]');
    expect(context).toContain('[ERROR: トレンドの取得に失敗しました: trends api failed]');
    expect(context).toContain('[ERROR: 行動ログの取得に失敗しました: activity db failed]');
    expect(activityStore.setLastNotificationId).not.toHaveBeenCalled();
  });

  it('handles empty first page of notifications', async () => {
    const activityStore: ISnsActivityStore = {
      recordPost: vi.fn(async () => {}),
      recordLike: vi.fn(async () => {}),
      recordRepost: vi.fn(async () => {}),
      hasLiked: vi.fn(async () => false),
      hasReposted: vi.fn(async () => false),
      hasReplied: vi.fn(async () => false),
      hasQuoted: vi.fn(async () => false),
      getRecentActivities: vi.fn(async () => []),
      getLastNotificationId: vi.fn(async () => 'notif-1'),
      setLastNotificationId: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const snsProvider: SnsProvider = {
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
    } as never;

    const provider = new SnsSkillContextProvider({ activityStore, snsProvider });
    const context = await provider.getContext();

    expect(context).toContain('## 新着通知\n- なし');
    expect(activityStore.setLastNotificationId).not.toHaveBeenCalled();
  });
});
