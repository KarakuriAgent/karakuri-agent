/**
 * 省察の実行スケジュール（M4）。実行は実時刻（既存 scheduler と同じタイマー方式）で行い、
 * 「世界の夜」の判定は差し替え可能な関数（IsNightFn）に委ねる。
 *
 * - 日次: 夜に 1 回。対象日が暦の上で終わった後（夜ウィンドウの 0 時以降の側）に
 *   実行する — 日が終わる前に書くと、実行後〜0 時のエピソードが取り漏れるため
 * - 週次: 日曜の夜（明けの深夜帯）に直近 7 日ぶん
 * - 月次: 月が変わった最初の夜に前月ぶん
 */

import type Database from 'better-sqlite3';

import type { IMessageSink } from '../scheduler/types.js';
import { formatError } from '../utils/error.js';
import { createLogger } from '../utils/logger.js';
import { reportSafely } from '../utils/report.js';
import { formatDateInTimezone, shiftDateString } from '../utils/date.js';
import { getLifeMeta, setLifeMeta } from './db.js';
import { defaultIsNight, reflectionDateFor, type IsNightFn, type ReflectionEngine } from './reflection.js';

const logger = createLogger('ReflectionRunner');
const MINUTE_MS = 60_000;

const META_DAILY = 'reflection_daily_last';
const META_WEEKLY = 'reflection_weekly_last';
const META_MONTHLY = 'reflection_monthly_last';

export interface ReflectionRunnerOptions {
  engine: ReflectionEngine;
  db: Database.Database;
  timezone: string;
  checkIntervalMinutes?: number | undefined;
  isNight?: IsNightFn | undefined;
  messageSink?: IMessageSink | undefined;
  reportChannelId?: string | undefined;
  now?: () => Date;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export class ReflectionRunner {
  private readonly isNight: IsNightFn;
  private readonly now: () => Date;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly checkIntervalMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private closed = false;
  private started = false;

  constructor(private readonly options: ReflectionRunnerOptions) {
    this.isNight = options.isNight ?? defaultIsNight;
    this.now = options.now ?? (() => new Date());
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
    this.checkIntervalMs = Math.max(1, options.checkIntervalMinutes ?? 15) * MINUTE_MS;
  }

  start(): void {
    if (this.closed || this.started) {
      return;
    }
    this.started = true;
    this.scheduleNext();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer != null) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
    }
    await this.inFlight;
  }

  /** テスト・手動実行用。夜であれば必要な省察を 1 回ぶん実行する */
  async tickOnce(): Promise<void> {
    const now = this.now();
    if (!this.isNight(now, this.options.timezone)) {
      return;
    }

    // 夜ウィンドウは 0 時をまたぐため「カレンダー上の今日」ではなく
    // 「この夜が振り返る日」を対象にする（深夜〜明け方は前日に帰属）。
    // カレンダー日付で判定すると、日付変更直後の tick がエピソード 0 件の
    // 新日付で実行済みマークを付け、本来の夜の実行が毎日スキップされる。
    const reflectionDate = reflectionDateFor(now, this.options.timezone);
    // 対象日が暦の上で終わってから実行する（夜ウィンドウの 0 時以降の側で走る）。
    // 日が終わる前（21〜24 時）に実行してマークを付けると、実行後〜0 時の
    // エピソードが当日の窓に属したままどの省察にも拾われず、毎晩恒久的に漏れる
    if (reflectionDate >= formatDateInTimezone(now, this.options.timezone)) {
      return;
    }
    try {
      if (getLifeMeta(this.options.db, META_DAILY) !== reflectionDate) {
        const result = await this.options.engine.runDaily(reflectionDate, now);
        setLifeMeta(this.options.db, META_DAILY, reflectionDate);
        if (result != null && result.diaryNarrativeId != null) {
          await reportSafely(
            this.options.messageSink,
            this.options.reportChannelId,
            `📔 日次省察 (${reflectionDate}): 日記を書いた。新しい信念 ${result.newBeliefs} 件 / 改訂 ${result.revisions} 件 / 失効 ${result.deactivations} 件 / 単一出所の格下げ ${result.demotedSingleSource} 件`,
            logger,
          );
        }
      }

      const weekKey = isoWeekKey(reflectionDate);
      if (isSunday(reflectionDate) && getLifeMeta(this.options.db, META_WEEKLY) !== weekKey) {
        const periodStart = shiftDateString(reflectionDate, -6);
        const result = await this.options.engine.runWeekly(periodStart, reflectionDate);
        setLifeMeta(this.options.db, META_WEEKLY, weekKey);
        if (result != null) {
          await reportSafely(
            this.options.messageSink,
            this.options.reportChannelId,
            `🗂 週次省察 (${periodStart}〜${reflectionDate}): テーマ ${result.themes} 件 / 自己像の更新 ${result.selfUpdates} 件`,
            logger,
          );
        }
      }

      const monthKey = reflectionDate.slice(0, 7);
      const lastMonthlyKey = getLifeMeta(this.options.db, META_MONTHLY);
      if (lastMonthlyKey == null) {
        // 初回は実行済み扱いにする（過去の空データに対する即時実行を避ける）。
        // マークは reflectionDate ではなくカレンダー上の今日の月で付ける:
        // 初回 tick が月初の深夜帯だと reflectionDate は前月に落ち、同日の夜の
        // tick が「月が変わった」と誤認して空の前月へ即時実行してしまう
        setLifeMeta(this.options.db, META_MONTHLY, formatDateInTimezone(now, this.options.timezone).slice(0, 7));
      } else if (monthKey > lastMonthlyKey) {
        // 前進方向の月替わりのみ実行する（YYYY-MM は辞書順 = 時系列順）。
        // 単純な不一致判定だと、月初の深夜帯 tick（reflectionDate が前月へ落ちる）が
        // 初回マークより「過去の月」を見て空の月へ即時実行 + マークを巻き戻してしまう
        const previousMonth = previousMonthRange(monthKey);
        const result = await this.options.engine.runMonthly(previousMonth.start, previousMonth.end, now);
        setLifeMeta(this.options.db, META_MONTHLY, monthKey);
        if (result != null) {
          await reportSafely(
            this.options.messageSink,
            this.options.reportChannelId,
            `📚 月次省察 (${previousMonth.start}〜${previousMonth.end}): 章 ${result.chapters} 件 / 浮力減衰 ${result.decayed} 件`,
            logger,
          );
        }
      }
    } catch (error) {
      logger.error('Reflection run failed', error);
      await reportSafely(
        this.options.messageSink,
        this.options.reportChannelId,
        `⚠️ 省察の実行に失敗しました\n${formatError(error)}`,
        logger,
      );
    }
  }

  private scheduleNext(): void {
    if (this.closed || this.timer != null) {
      return;
    }
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      const run = this.tickOnce().finally(() => {
        if (this.inFlight === run) {
          this.inFlight = null;
        }
        this.scheduleNext();
      });
      this.inFlight = run;
    }, this.checkIntervalMs);
  }
}

function isSunday(date: string): boolean {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay() === 0;
}

function isoWeekKey(date: string): string {
  const day = new Date(`${date}T00:00:00.000Z`);
  const year = day.getUTCFullYear();
  const start = new Date(Date.UTC(year, 0, 1));
  const week = Math.floor((day.getTime() - start.getTime()) / (7 * 86_400_000));
  return `${year}-W${week}`;
}

function previousMonthRange(monthKey: string): { start: string; end: string } {
  const [yearText, monthText] = monthKey.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const previousStart = new Date(Date.UTC(year, month - 2, 1));
  const previousEnd = new Date(Date.UTC(year, month - 1, 0));
  return {
    start: previousStart.toISOString().slice(0, 10),
    end: previousEnd.toISOString().slice(0, 10),
  };
}
