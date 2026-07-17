import type { AppraisalService } from '../life/appraisal.js';
import { normalizeSnsNotification } from '../life/normalize.js';
import type { ExperienceRecorder } from '../life/recorder.js';
import type { SkillContextProvider, SkillContextResult } from '../skill/context-provider.js';
import type { SnsRateLimiter } from './rate-limiter.js';
import type {
  ISnsActivityStore,
  NotificationFetchResult,
  SnsActivity,
  SnsNotification,
  SnsPost,
  SnsProvider,
  SnsProviderType,
} from './types.js';
import { createLogger } from '../utils/logger.js';
import { KeyedMutex } from '../utils/mutex.js';

export interface SnsSkillContextProviderOptions {
  activityStore: ISnsActivityStore;
  snsProvider: SnsProvider;
  provider?: SnsProviderType | undefined;
  notificationLimit?: number;
  trendLimit?: number;
  recentActivityLimit?: number;
  reportError?: ((message: string) => void) | undefined;
  experienceRecorder?: ExperienceRecorder | undefined;
  /** M6: SNS 反応の appraisal 入力（応答先行 → appraisal 事後の非同期経路） */
  appraisalService?: AppraisalService | undefined;
  /** M8: 読み取り系フェッチの最小間隔（間隔内は再フェッチせず「確認済み」を返す） */
  rateLimiter?: SnsRateLimiter | undefined;
}

const logger = createLogger('SnsSkillContextProvider');
const MAX_CONTEXT_NOTIFICATION_PAGES = 5;
/**
 * incomplete フェッチでカーソルが前進できなかった連続回数がこの値に達したら、
 * report した上でカーソルを最新へ強制前進する。ページングを持たない provider
 * （ELYTH）では sinceId がページから消えた時点でそれ以前の通知はどのみち永遠に
 * 取得できないため、待ち続ける利益がない — 放置すると同じページを毎回再取得して
 * 体験ログ・appraisal へ重複再体験を流し込み続ける（実機で同一 5 件を 44 回
 * 再評価し気分が飽和した）。ブートストラップと同じ「それ以前はまとめて既読」
 * セマンティクスで復旧する。
 */
const INCOMPLETE_FETCH_FORCE_ADVANCE_THRESHOLD = 3;
/** 記録済み通知 id を覚えておく上限（挿入順で古いものから捨てる） */
const MAX_RECORDED_NOTIFICATION_IDS = 500;

export class SnsSkillContextProvider implements SkillContextProvider {
  private readonly mutex = new KeyedMutex();
  private readonly notificationLimit: number;
  private readonly trendLimit: number;
  private readonly recentActivityLimit: number;
  /** カーソルが前進できなかった incomplete フェッチの連続回数（停滞の可視化用） */
  private incompleteFetchStreak = 0;
  /**
   * このプロセスで体験ログへ記録済みの通知 id。カーソルが前進できない間の
   * 再取得（同一通知）を体験ログ・appraisal へ二重に流さないための重複排除。
   * プロセス再起動で消えるため再起動を跨ぐ重複は残りうるが、raw ログの重複は
   * 設計上許容されている（重複解決は後段・reprocessing の仕事）。
   */
  private readonly recordedNotificationIds = new Set<string>();

  constructor(private readonly options: SnsSkillContextProviderOptions) {
    this.notificationLimit = Math.max(1, options.notificationLimit ?? 5);
    this.trendLimit = Math.max(1, options.trendLimit ?? 3);
    this.recentActivityLimit = Math.max(1, options.recentActivityLimit ?? 10);
  }

  async getContext(): Promise<SkillContextResult> {
    return this.mutex.runExclusive('sns-skill-context', async () => {
      const sinceId = await this.options.activityStore.getLastNotificationId();
      // M8: 読み取り系フェッチのスロットル。最小間隔内は再フェッチせず、
      // 通知は「確認済み」扱い（体験記録・カーソル操作もスキップ）、トレンドはキャッシュ表示
      const [notificationsResult, trendsResult, activitiesResult] = await Promise.allSettled([
        this.options.rateLimiter != null
          ? this.options.rateLimiter.throttleFetch('notifications', () => this.loadNotifications(sinceId))
          : this.loadNotifications(sinceId).then((value) => ({ value, cached: false as const, fetchedAt: new Date() })),
        this.options.rateLimiter != null
          ? this.options.rateLimiter.throttleFetch('trends', () => this.options.snsProvider.getTrends(this.trendLimit))
          : this.options.snsProvider.getTrends(this.trendLimit).then((value) => ({ value, cached: false as const, fetchedAt: new Date() })),
        this.options.activityStore.getRecentActivities(this.recentActivityLimit),
      ]);

      const sections: string[] = [];

      let latestNotificationId: string | undefined;
      let notificationReservationToken: string | undefined;

      if (notificationsResult.status === 'fulfilled' && notificationsResult.value.cached) {
        // 間隔内の再確認: 前回取得分は既に記録・提示済みなので「確認済み」だけ伝える
        sections.push(`## 新着通知\n- （${formatMinutesAgo(notificationsResult.value.fetchedAt)}に確認済み。新しい確認はもう少し時間をおいてから）`);
      } else if (notificationsResult.status === 'fulfilled') {
        const { notifications, complete } = notificationsResult.value.value;
        // 体験ログ（一次資料）へ届いた通知を逐語記録する。turn が abort されると
        // カーソルが戻り同じ通知を再取得しうるが、raw ログの重複は許容する
        // （kind / actor 同様、重複解決は後段・reprocessing の仕事）。
        if (this.options.provider != null && (this.options.experienceRecorder != null || this.options.appraisalService != null)) {
          for (const notification of notifications) {
            // カーソル停滞中の再取得（同一通知）は記録も appraisal もスキップする。
            // 同じ出来事を何度も「再体験」すると気分・社交欲求が実態から乖離するため
            if (this.recordedNotificationIds.has(notification.id)) {
              continue;
            }
            const event = normalizeSnsNotification({
              provider: this.options.provider,
              notification,
              receivedAt: new Date(),
            });
            // id は appraisal の provenance へ配線する（insert は軽量なので await で直列化）
            const eventId = (await this.options.experienceRecorder?.record(event)) ?? null;
            // SNS はチャットに準ずる: 応答先行 → appraisal 事後（fire-and-forget）
            void this.options.appraisalService?.enqueue(event, undefined, eventId ?? undefined);
            this.rememberRecordedNotificationId(notification.id);
          }
        }
        // カーソル前進の規則:
        // - カーソル保存済み（sinceId != null）: 取り漏らし防止のため complete な
        //   フェッチのみ前進する
        // - 初回（sinceId == null）: 履歴が limit を超えると complete にならず
        //   永遠にブートストラップできないため、incomplete でも最新 id へ前進する。
        //   セマンティクスは「導入時点より過去はまとめて既読、以後の差分から追跡」
        latestNotificationId = complete || sinceId == null ? notifications[0]?.id : undefined;
        if (!complete && sinceId != null) {
          // 正当な前進見送り（取り漏らし防止）だが、続くと同じ通知を再取得し続ける。
          // 停滞の連続回数を数え、閾値に達したらカーソルを最新へ強制前進して復旧する。
          // 通知 0 件の incomplete はレート制限等の一時的な取得縮退で「同じ通知の
          // 再取得」は起きていないため、数えも消しもしない
          if (notifications.length > 0) {
            this.incompleteFetchStreak += 1;
            if (this.incompleteFetchStreak >= INCOMPLETE_FETCH_FORCE_ADVANCE_THRESHOLD) {
              logger.warn('SNS notification cursor stalled; force-advancing to the latest page', {
                provider: this.options.provider,
                streak: this.incompleteFetchStreak,
                advanceTo: notifications[0]?.id,
              });
              this.options.reportError?.(
                `⚠️ [${this.options.provider}] SNS 通知カーソルが ${this.incompleteFetchStreak} 回連続で前進できなかったため、最新の通知へ強制前進しました。取得できていない過去の通知はまとめて既読扱いになります`,
              );
              latestNotificationId = notifications[0]?.id;
              this.incompleteFetchStreak = 0;
            }
          }
        } else {
          this.incompleteFetchStreak = 0;
        }
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
            this.options.reportError?.(`⚠️ [${this.options.provider}] Failed to reserve last SNS notification cursor; duplicate notification fetches may occur`);
          }
        }
        sections.push(formatNotifications(notifications));
      } else {
        logger.error('Failed to load SNS notifications for context', notificationsResult.reason);
        sections.push(`## 新着通知\n[ERROR: 通知の取得に失敗しました: ${formatContextError(notificationsResult.reason)}]`);
      }

      if (trendsResult.status === 'fulfilled') {
        sections.push(formatTrends(trendsResult.value.value));
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
                  this.options.reportError?.(`⚠️ [${this.options.provider}] ${message}`);
                }
              },
              ...(notificationReservationToken != null
                ? {
                    onAbort: async () => {
                      try {
                        await this.options.activityStore.releaseLastNotificationReservation?.(notificationReservationToken);
                      } catch (error) {
                        logger.error('Failed to release SNS notification cursor reservation', error);
                        this.options.reportError?.(`⚠️ [${this.options.provider}] Failed to release reserved SNS notification cursor after an aborted turn`);
                      }
                    },
                  }
                : {}),
            }
          : {}),
      };
    });
  }

  /** 記録済み通知 id を覚える（上限超過は挿入順で古いものから捨てる） */
  private rememberRecordedNotificationId(notificationId: string): void {
    this.recordedNotificationIds.add(notificationId);
    while (this.recordedNotificationIds.size > MAX_RECORDED_NOTIFICATION_IDS) {
      const oldest = this.recordedNotificationIds.values().next().value;
      if (oldest == null) {
        break;
      }
      this.recordedNotificationIds.delete(oldest);
    }
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

function formatMinutesAgo(fetchedAt: Date): string {
  const minutes = Math.max(0, Math.round((Date.now() - fetchedAt.getTime()) / 60_000));
  return minutes <= 0 ? 'たった今' : `${minutes} 分前`;
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
