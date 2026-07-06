/**
 * SNS レート制限（M8）— AI 判断に依存しない決定論ガード。
 *
 * - 書き込み系（post / reply / like / repost）: 活動ログの sliding window 集計 +
 *   同種アクションの最小間隔で、ツール実行直前にハードゲートする。
 * - 読み取り系（notifications / timeline / trends）: フェッチ最小間隔を持ち、
 *   間隔内は前回取得分のキャッシュを返す（API 保護。エージェントには
 *   「さっき見たばかりの内容」が見えるだけで自然）。
 *
 * 拒否文面は「プラットフォームの仕様」として返す。ツールがエージェントの
 * 内発的感情（「もう十分やった気がする」）を捏造しない — 感情の決定は
 * appraisal の仕事。制限は外的な世界の事実なので数値のまま見せてよい。
 */

import type { SnsWriteRateLimits } from '../config.js';
import { createLogger } from '../utils/logger.js';
import type { ISnsWriteActivityCounter, SnsWriteActionKind } from './types.js';

const logger = createLogger('SnsRateLimiter');

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const MINUTE_MS = 60_000;

export type SnsFetchKind = 'notifications' | 'timeline' | 'trends';

export type WriteGateResult =
  | { allowed: true }
  | { allowed: false; message: string; retryAt: Date | null };

export interface ThrottledFetchResult<T> {
  value: T;
  /** true のとき value は前回取得分のキャッシュ */
  cached: boolean;
  fetchedAt: Date;
}

export interface SnsRateLimiterOptions {
  limits: SnsWriteRateLimits;
  /** 読み取り系フェッチの最小間隔（分） */
  fetchIntervals: { notificationsMinutes: number; timelineMinutes: number; trendsMinutes: number };
  counter: ISnsWriteActivityCounter;
  timezone: string;
  now?: () => Date;
}

const WRITE_ACTION_LABELS: Record<SnsWriteActionKind, string> = {
  post: '投稿',
  reply: 'リプライ',
  like: 'いいね',
  repost: 'リポスト',
};

export class SnsRateLimiter {
  private readonly now: () => Date;
  private readonly fetchCache = new Map<SnsFetchKind, { value: unknown; fetchedAt: number }>();

  constructor(private readonly options: SnsRateLimiterOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * 書き込みアクションのゲート判定。実行直前に呼ぶ（判定のみで記録はしない —
   * 実行成功時に活動ログへ記録されるのが正であり、二重計上しない）。
   */
  async checkWrite(kind: SnsWriteActionKind): Promise<WriteGateResult> {
    const now = this.now();
    const label = WRITE_ACTION_LABELS[kind];
    const hourlyLimit = this.hourlyLimitFor(kind);

    if (hourlyLimit <= 0) {
      return {
        allowed: false,
        message: `この SNS では現在${label}ができない設定になっている。`,
        retryAt: null,
      };
    }

    const hourly = await this.options.counter.countWriteActionsSince(kind, new Date(now.getTime() - HOUR_MS));
    if (hourly.count >= hourlyLimit) {
      const retryAt = hourly.earliestAt != null ? new Date(new Date(hourly.earliestAt).getTime() + HOUR_MS) : null;
      return {
        allowed: false,
        message: `この SNS は${label}が 1 時間に ${hourlyLimit} 回までに制限されている。`
          + (retryAt != null ? `次に${label}できるのは ${this.formatTime(retryAt)} 以降。` : 'しばらく時間をおく必要がある。'),
        retryAt,
      };
    }

    if (kind === 'post') {
      const daily = await this.options.counter.countWriteActionsSince('post', new Date(now.getTime() - DAY_MS));
      if (daily.count >= this.options.limits.postPerDay) {
        const retryAt = daily.earliestAt != null ? new Date(new Date(daily.earliestAt).getTime() + DAY_MS) : null;
        return {
          allowed: false,
          message: `この SNS は投稿が 24 時間に ${this.options.limits.postPerDay} 回までに制限されていて、その上限に達している。`
            + (retryAt != null ? `次に投稿できるのは ${this.formatTime(retryAt)} 以降。` : ''),
          retryAt,
        };
      }

      const minIntervalMs = this.options.limits.postMinIntervalMinutes * MINUTE_MS;
      if (minIntervalMs > 0) {
        const lastAt = await this.options.counter.getLastWriteActionAt('post');
        if (lastAt != null) {
          const retryAtMs = new Date(lastAt).getTime() + minIntervalMs;
          if (now.getTime() < retryAtMs) {
            const retryAt = new Date(retryAtMs);
            return {
              allowed: false,
              message: `この SNS は連続投稿が制限されている（前回の投稿から ${this.options.limits.postMinIntervalMinutes} 分以上あける必要がある）。`
                + `次に投稿できるのは ${this.formatTime(retryAt)} 以降。`,
              retryAt,
            };
          }
        }
      }
    }

    return { allowed: true };
  }

  /**
   * 読み取り系フェッチのスロットル。最小間隔内は前回取得分のキャッシュを返す。
   * キャッシュが無い初回・失敗直後は必ず実フェッチする。
   */
  async throttleFetch<T>(kind: SnsFetchKind, fetcher: () => Promise<T>): Promise<ThrottledFetchResult<T>> {
    const now = this.now();
    const intervalMs = this.fetchIntervalMsFor(kind);
    const cached = this.fetchCache.get(kind);
    if (cached != null && intervalMs > 0 && now.getTime() - cached.fetchedAt < intervalMs) {
      logger.debug('Serving cached SNS fetch', { kind, ageMs: now.getTime() - cached.fetchedAt });
      return { value: cached.value as T, cached: true, fetchedAt: new Date(cached.fetchedAt) };
    }

    const value = await fetcher();
    this.fetchCache.set(kind, { value, fetchedAt: now.getTime() });
    return { value, cached: false, fetchedAt: now };
  }

  /** 最後に実フェッチした時刻（perception の「前回確認」表示用）。未フェッチなら null */
  lastFetchedAt(kind: SnsFetchKind): Date | null {
    const cached = this.fetchCache.get(kind);
    return cached != null ? new Date(cached.fetchedAt) : null;
  }

  private hourlyLimitFor(kind: SnsWriteActionKind): number {
    switch (kind) {
      case 'post':
        return this.options.limits.postPerHour;
      case 'reply':
        return this.options.limits.replyPerHour;
      case 'like':
        return this.options.limits.likePerHour;
      case 'repost':
        return this.options.limits.repostPerHour;
    }
  }

  private fetchIntervalMsFor(kind: SnsFetchKind): number {
    switch (kind) {
      case 'notifications':
        return this.options.fetchIntervals.notificationsMinutes * MINUTE_MS;
      case 'timeline':
        return this.options.fetchIntervals.timelineMinutes * MINUTE_MS;
      case 'trends':
        return this.options.fetchIntervals.trendsMinutes * MINUTE_MS;
    }
  }

  private formatTime(date: Date): string {
    try {
      return date.toLocaleTimeString('ja-JP', {
        timeZone: this.options.timezone,
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return date.toISOString().slice(11, 16);
    }
  }
}
