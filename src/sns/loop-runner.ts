import type { IAgent } from '../agent/core.js';
import { circadianEnergyDecayFactor, type InnerState, type InnerStateService } from '../life/inner-state.js';
import { buildSnsLoopActivityInstructions } from './builtin-skill.js';
import { formatError } from '../utils/error.js';
import { createLogger } from '../utils/logger.js';
import { reportSafely } from '../utils/report.js';
import { runExclusiveSystemTurn } from '../scheduler/system-turn-mutex.js';
import type { IMessageSink } from '../scheduler/types.js';
import type { SnsProviderType } from './types.js';

const logger = createLogger('SnsLoopRunner');
const MINUTE_MS = 60_000;

/**
 * SNS ループ間隔の変調係数（M6）。
 * - 睡眠中・深夜は投稿が減る（間隔が大きく伸びる）
 * - 元気がない日は積極性が下がる（間隔が伸びる）
 * - 社交欲求が高いと交流が増える（間隔が縮む）
 */
export function snsLoopIntervalFactor(state: InnerState, now: Date, timezone: string): number {
  if (state.sleeping) {
    return 3;
  }

  let factor = 1;
  if (state.energy < 0.25) {
    factor *= 1.8;
  } else if (state.energy < 0.45) {
    factor *= 1.3;
  }
  if (state.social > 0.7) {
    factor *= 0.7;
  } else if (state.social < 0.2) {
    factor *= 1.2;
  }

  // 概日リズム: 深夜・早朝は投稿が減る
  const hour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hourCycle: 'h23',
  }).format(now));
  if (circadianEnergyDecayFactor(hour) > 1 && (hour >= 0 && hour < 6)) {
    factor *= 2;
  }

  return Math.min(4, Math.max(0.5, factor));
}

export interface SnsLoopRunnerOptions {
  agent: IAgent;
  provider?: SnsProviderType | undefined;
  minIntervalMinutes: number;
  maxIntervalMinutes: number;
  messageSink?: IMessageSink;
  reportChannelId?: string;
  hasPostMessage?: boolean;
  /** M6: 内部状態でループ頻度・積極性を変調する（元気がない日・深夜は間隔が伸びる） */
  innerStateService?: InnerStateService | undefined;
  timezone?: string | undefined;
  now?: () => Date;
  randomFn?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export class SnsLoopRunner {
  private readonly now: () => Date;
  private readonly randomFn: () => number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly minIntervalMs: number;
  private readonly maxIntervalMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private skippedWhileRunning = false;
  private inFlight: Promise<void> | null = null;
  private closed = false;
  private started = false;

  constructor(private readonly options: SnsLoopRunnerOptions) {
    this.now = options.now ?? (() => new Date());
    this.randomFn = options.randomFn ?? Math.random;
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
    this.minIntervalMs = Math.max(1, Math.floor(options.minIntervalMinutes * MINUTE_MS));
    this.maxIntervalMs = Math.max(this.minIntervalMs, Math.floor(options.maxIntervalMinutes * MINUTE_MS));
  }

  start(): void {
    if (this.closed) {
      logger.warn('SnsLoopRunner.start() called after close, ignoring');
      return;
    }
    if (this.started) {
      logger.debug('SnsLoopRunner.start() called multiple times, ignoring');
      return;
    }

    this.started = true;
    this.scheduleNext();
  }

  async close(): Promise<void> {
    logger.debug('Closing SNS loop runner');
    this.closed = true;
    if (this.timer != null) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
    }
    if (this.inFlight != null) {
      logger.debug('Waiting for in-flight SNS loop run to complete');
    }
    await this.inFlight;
    logger.debug('SNS loop runner closed');
  }

  private scheduleNext(): void {
    if (this.closed || this.timer != null) {
      return;
    }

    if (this.options.innerStateService == null) {
      this.scheduleWithFactor(1);
      return;
    }

    void this.resolveIntervalFactor().then((factor) => {
      if (this.closed || this.timer != null) {
        return;
      }
      this.scheduleWithFactor(factor);
    });
  }

  /** 内部状態・概日リズムによる間隔倍率。取得失敗時は 1（変調なし） */
  private async resolveIntervalFactor(): Promise<number> {
    if (this.options.innerStateService == null) {
      return 1;
    }

    try {
      const now = this.now();
      const state = await this.options.innerStateService.getCurrent(now);
      return snsLoopIntervalFactor(state, now, this.options.timezone ?? 'Asia/Tokyo');
    } catch (error) {
      logger.warn('Failed to resolve SNS loop interval factor', error);
      return 1;
    }
  }

  private scheduleWithFactor(factor: number): void {
    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      void this.tick().catch(async (error) => {
        logger.error('SNS loop tick crashed unexpectedly', error);
        await reportSafely(
          this.options.messageSink,
          this.options.reportChannelId,
          `❌ ${this.options.provider != null ? `[${this.options.provider}] ` : ''}SNS loop tick crashed unexpectedly: ${formatError(error)}`,
          logger,
        );
        if (!this.closed) {
          this.scheduleNext();
        }
      });
    }, Math.max(1, Math.floor(this.nextDelayMs() * factor)));
  }

  private nextDelayMs(): number {
    if (this.maxIntervalMs <= this.minIntervalMs) {
      return this.minIntervalMs;
    }
    const random = Math.min(1, Math.max(0, this.randomFn()));
    return Math.max(1, Math.floor(this.minIntervalMs + random * (this.maxIntervalMs - this.minIntervalMs)));
  }

  private async tick(): Promise<void> {
    if (this.closed) {
      return;
    }

    if (this.running) {
      logger.debug('Skipping SNS loop tick because a previous run is still active');
      this.skippedWhileRunning = true;
      return;
    }

    this.running = true;
    this.skippedWhileRunning = false;
    this.scheduleNext();
    const run = this.runLoop().finally(() => {
      this.running = false;
      if (this.inFlight === run) {
        this.inFlight = null;
      }
      if (!this.closed && this.skippedWhileRunning && this.timer == null) {
        this.skippedWhileRunning = false;
        this.scheduleNext();
      }
    });
    this.inFlight = run;
    await run;
  }

  private async runLoop(): Promise<void> {
    const startedAt = this.now();
    const provider = this.options.provider ?? 'mastodon';
    const providerLabel = this.options.provider != null ? `[${provider}] ` : '';

    try {
      const skillActivityInstructions = buildSnsLoopActivityInstructions({
        provider,
        ...(this.options.hasPostMessage != null ? { hasPostMessage: this.options.hasPostMessage } : {}),
      });
      await runExclusiveSystemTurn(async () => {
        if (this.closed) {
          logger.debug('Skipping SNS loop execution because runner closed before system turn lock');
          return;
        }

        const response = await this.options.agent.handleMessage(
          this.options.provider != null ? `sns-loop-${provider}:${startedAt.toISOString()}` : `sns-loop:${startedAt.toISOString()}`,
          '(sns loop tick)',
          'sns-loop',
          {
            userId: 'system',
            ephemeral: true,
            skillActivityInstructions,
            autoLoadSnsSkill: this.options.provider ?? true,
          },
        );
        const trimmedResponse = response.trim();
        logger.debug('SNS loop run completed', { responseLength: trimmedResponse.length });
        const elapsed = this.now().getTime() - startedAt.getTime();
        const summary = trimmedResponse.length > 0 ? `
${trimmedResponse}` : '';
        await reportSafely(
          this.options.messageSink,
          this.options.reportChannelId,
          `✅ ${providerLabel}SNS loop succeeded in ${elapsed}ms${summary}`,
          logger,
        );
      });
    } catch (error) {
      logger.error('SNS loop run failed', error);
      await reportSafely(
        this.options.messageSink,
        this.options.reportChannelId,
        `❌ ${providerLabel}SNS loop failed in ${this.now().getTime() - startedAt.getTime()}ms
${formatError(error)}`,
        logger,
      );
    }
  }
}
