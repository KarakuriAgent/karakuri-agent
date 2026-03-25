import type { SkillContextProvider } from '../skill/context-provider.js';
import type { ISnsActivityStore, SnsActivity, SnsNotification, SnsPost, SnsProvider } from './types.js';
import { createLogger } from '../utils/logger.js';
import { KeyedMutex } from '../utils/mutex.js';

export interface SnsSkillContextProviderOptions {
  activityStore: ISnsActivityStore;
  snsProvider: SnsProvider;
  notificationLimit?: number;
  trendLimit?: number;
  recentActivityLimit?: number;
  reportError?: ((message: string) => void) | undefined;
}

const logger = createLogger('SnsSkillContextProvider');

// Cap pagination requests to prevent unbounded API calls from misbehaving providers
const MAX_CONTEXT_NOTIFICATION_PAGES = 5;

export class SnsSkillContextProvider implements SkillContextProvider {
  // Serialize context generation to prevent read-then-update races on the notification cursor
  // (concurrent calls could read the same sinceId, fetch overlapping notifications, and advance the cursor past unread items)
  private readonly mutex = new KeyedMutex();
  private readonly notificationLimit: number;
  private readonly trendLimit: number;
  private readonly recentActivityLimit: number;

  constructor(private readonly options: SnsSkillContextProviderOptions) {
    this.notificationLimit = Math.max(1, options.notificationLimit ?? 5);
    this.trendLimit = Math.max(1, options.trendLimit ?? 3);
    this.recentActivityLimit = Math.max(1, options.recentActivityLimit ?? 10);
  }

  async getContext(): Promise<string> {
    return this.mutex.runExclusive('sns-skill-context', async () => {
      const sinceId = await this.options.activityStore.getLastNotificationId();
      const [notificationsResult, trendsResult, activitiesResult] = await Promise.allSettled([
        this.loadNotifications(sinceId),
        this.options.snsProvider.getTrends(this.trendLimit),
        this.options.activityStore.getRecentActivities(this.recentActivityLimit),
      ]);

      const sections: string[] = [];

      if (notificationsResult.status === 'fulfilled') {
        const notifications = notificationsResult.value;
        // Notifications are expected newest-first (Mastodon convention); persist the first ID as the cursor for the next fetch
        if (notifications[0]?.id != null) {
          try {
            await this.options.activityStore.setLastNotificationId(notifications[0].id);
          } catch (error) {
            const message = 'Failed to persist last SNS notification cursor -- next fetch may return duplicate notifications';
            logger.error(message, error);
            this.options.reportError?.(`⚠️ ${message}`);
          }
        }
        sections.push(formatNotifications(notifications));
      } else {
        logger.error('Failed to load SNS notifications for context', notificationsResult.reason);
        sections.push(`## 新着通知\n[ERROR: 通知の取得に失敗しました: ${formatContextError(notificationsResult.reason)}]`);
      }

      if (trendsResult.status === 'fulfilled') {
        sections.push(formatTrends(trendsResult.value));
      } else {
        logger.error('Failed to load SNS trends for context', trendsResult.reason);
        sections.push(`## トレンド\n[ERROR: トレンドの取得に失敗しました: ${formatContextError(trendsResult.reason)}]`);
      }

      if (activitiesResult.status === 'fulfilled') {
        sections.push(formatActivities(activitiesResult.value));
      } else {
        logger.error('Failed to load SNS recent activities for context', activitiesResult.reason);
        sections.push(`## 直近の行動ログ\n[ERROR: 行動ログの取得に失敗しました: ${formatContextError(activitiesResult.reason)}]`);
      }

      return sections.join('\n\n');
    });
  }

  private async loadNotifications(sinceId: string | null): Promise<SnsNotification[]> {
    const notifications: SnsNotification[] = [];
    let nextMaxId: string | undefined;
    let pageCount = 0;

    while (notifications.length < this.notificationLimit && pageCount < MAX_CONTEXT_NOTIFICATION_PAGES) {
      pageCount++;
      const remainingLimit = this.notificationLimit - notifications.length;
      const page = await this.options.snsProvider.getNotifications({
        sinceId: sinceId ?? undefined,
        maxId: nextMaxId,
        limit: remainingLimit,
        types: ['mention', 'reply'],
      });
      if (page.length === 0) {
        break;
      }

      notifications.push(...page.slice(0, remainingLimit));
      if (page.length < remainingLimit || notifications.length >= this.notificationLimit) {
        break;
      }

      const oldestNotificationId = page.at(-1)?.id;
      if (oldestNotificationId == null || oldestNotificationId === nextMaxId) {
        break;
      }
      nextMaxId = oldestNotificationId;
    }

    return notifications;
  }
}

function formatContextError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === 'string' ? error : 'Unknown error';
}

function formatNotifications(notifications: SnsNotification[]): string {
  if (notifications.length === 0) {
    return '## 新着通知\n- なし';
  }

  return [
    '## 新着通知',
    ...notifications.map((notification) => {
      const suffix = notification.post != null ? ` (post_id: ${notification.post.id})` : '';
      const text = notification.post?.text?.trim();
      return `- [${notification.type}] @${notification.accountHandle}: ${text != null && text.length > 0 ? `"${text}"` : '(本文なし)'}${suffix}`;
    }),
  ].join('\n');
}

function formatTrends(posts: SnsPost[]): string {
  if (posts.length === 0) {
    return '## トレンド\n- なし';
  }

  return [
    '## トレンド',
    ...posts.map((post) => `- "${post.text}" by @${post.authorHandle} (likes: ${post.likeCount}, reposts: ${post.repostCount})`),
  ].join('\n');
}

function formatActivities(activities: SnsActivity[]): string {
  if (activities.length === 0) {
    return '## 直近の行動ログ\n- なし';
  }

  return [
    '## 直近の行動ログ',
    ...activities.map((activity) => {
      switch (activity.type) {
        case 'post':
          return `- [post] "${activity.text}" (${activity.createdAt})`;
        case 'like':
        case 'repost':
          return `- [${activity.type}] post_id: ${activity.postId} (${activity.createdAt})`;
      }
    }),
  ].join('\n');
}
