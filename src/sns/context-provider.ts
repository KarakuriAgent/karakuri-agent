import type { SkillContextProvider, SkillContextResult } from '../skill/context-provider.js';
import type {
  ISnsActivityStore,
  NotificationFetchResult,
  SnsActivity,
  SnsNotification,
  SnsPost,
  SnsProvider,
} from './types.js';
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
const MAX_CONTEXT_NOTIFICATION_PAGES = 5;

export class SnsSkillContextProvider implements SkillContextProvider {
  private readonly mutex = new KeyedMutex();
  private readonly notificationLimit: number;
  private readonly trendLimit: number;
  private readonly recentActivityLimit: number;

  constructor(private readonly options: SnsSkillContextProviderOptions) {
    this.notificationLimit = Math.max(1, options.notificationLimit ?? 5);
    this.trendLimit = Math.max(1, options.trendLimit ?? 3);
    this.recentActivityLimit = Math.max(1, options.recentActivityLimit ?? 10);
  }

  async getContext(): Promise<SkillContextResult> {
    return this.mutex.runExclusive('sns-skill-context', async () => {
      const sinceId = await this.options.activityStore.getLastNotificationId();
      const [notificationsResult, trendsResult, activitiesResult] = await Promise.allSettled([
        this.loadNotifications(sinceId),
        this.options.snsProvider.getTrends(this.trendLimit),
        this.options.activityStore.getRecentActivities(this.recentActivityLimit),
      ]);

      const sections: string[] = [];

      let latestNotificationId: string | undefined;
      let notificationReservationToken: string | undefined;

      if (notificationsResult.status === 'fulfilled') {
        const { notifications, complete } = notificationsResult.value;
        latestNotificationId = complete ? notifications[0]?.id : undefined;
        if (
          latestNotificationId != null
          && this.options.activityStore.reserveLastNotificationId != null
          && this.options.activityStore.commitLastNotificationReservation != null
          && this.options.activityStore.releaseLastNotificationReservation != null
        ) {
          try {
            notificationReservationToken = await this.options.activityStore.reserveLastNotificationId(latestNotificationId);
          } catch (error) {
            logger.error('Failed to reserve SNS notification cursor', error);
            this.options.reportError?.('⚠️ Failed to reserve last SNS notification cursor; duplicate notification fetches may occur');
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

      const activityErrors: { activity?: string } = {};
      if (activitiesResult.status === 'rejected') {
        logger.error('Failed to load SNS recent activities for context', activitiesResult.reason);
        activityErrors.activity = `行動ログの取得に失敗しました: ${formatContextError(activitiesResult.reason)}`;
      }
      sections.push(formatActivities(
        activitiesResult.status === 'fulfilled' ? activitiesResult.value : null,
        activityErrors,
      ));

      return {
        text: sections.join('\n\n'),
        ...(latestNotificationId != null
          ? {
              onSuccess: async () => {
                try {
                  if (
                    notificationReservationToken != null
                    && this.options.activityStore.commitLastNotificationReservation != null
                  ) {
                    await this.options.activityStore.commitLastNotificationReservation(notificationReservationToken);
                    return;
                  }
                  await this.options.activityStore.setLastNotificationId(latestNotificationId);
                } catch (error) {
                  const message = 'Failed to persist last SNS notification cursor -- next fetch may return duplicate notifications';
                  logger.error(message, error);
                  this.options.reportError?.(`⚠️ ${message}`);
                }
              },
              ...(notificationReservationToken != null
                ? {
                    onAbort: async () => {
                      try {
                        await this.options.activityStore.releaseLastNotificationReservation?.(notificationReservationToken);
                      } catch (error) {
                        logger.error('Failed to release SNS notification cursor reservation', error);
                        this.options.reportError?.('⚠️ Failed to release reserved SNS notification cursor after an aborted turn');
                      }
                    },
                  }
                : {}),
            }
          : {}),
      };
    });
  }

  private async loadNotifications(sinceId: string | null): Promise<NotificationFetchResult> {
    const result: NotificationFetchResult = {
      notifications: [],
      complete: true,
    };
    let nextMaxId: string | undefined;
    let pageCount = 0;

    while (result.notifications.length < this.notificationLimit && pageCount < MAX_CONTEXT_NOTIFICATION_PAGES) {
      pageCount++;
      const remainingLimit = this.notificationLimit - result.notifications.length;
      const pageResult = await this.options.snsProvider.getNotifications({
        sinceId: sinceId ?? undefined,
        maxId: nextMaxId,
        limit: remainingLimit,
        types: ['mention', 'reply', 'quote'],
      });
      const page = pageResult.notifications;
      if (!pageResult.complete) {
        result.complete = false;
      }
      if (page.length === 0) {
        break;
      }

      result.notifications.push(...page.slice(0, remainingLimit));
      if (!pageResult.complete) {
        break;
      }
      if (page.length < remainingLimit || result.notifications.length >= this.notificationLimit) {
        break;
      }

      const oldestNotificationId = page.at(-1)?.id;
      if (oldestNotificationId == null || oldestNotificationId === nextMaxId) {
        break;
      }
      nextMaxId = oldestNotificationId;
    }

    if (pageCount >= MAX_CONTEXT_NOTIFICATION_PAGES && result.notifications.length < this.notificationLimit) {
      result.complete = false;
    }

    return result;
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

function formatActivities(
  activities: SnsActivity[] | null,
  errors: { activity?: string } = {},
): string {
  return [
    '## 直近の行動ログ',
    ...(errors.activity != null
      ? [`[ERROR: ${errors.activity}]`]
      : activities != null && activities.length > 0
        ? activities.map((activity) => {
            switch (activity.type) {
              case 'post':
                return `- [post] "${activity.text}" (${activity.createdAt})`;
              case 'like':
              case 'repost':
                return `- [${activity.type}] post_id: ${activity.postId} (${activity.createdAt})`;
              default: {
                const _exhaustive: never = activity;
                return `- [unknown] ${JSON.stringify(_exhaustive)}`;
              }
            }
          })
        : ['- なし']),
  ].join('\n');
}
