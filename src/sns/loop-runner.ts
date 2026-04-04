import type { IAgent } from '../agent/core.js';
import { buildSnsLoopActivityInstructions } from './builtin-skill.js';
import { formatError } from '../utils/error.js';
import { createLogger } from '../utils/logger.js';
import { reportSafely } from '../utils/report.js';
import { runExclusiveSystemTurn } from '../scheduler/system-turn-mutex.js';
import type { IMessageSink } from '../scheduler/types.js';

const logger = createLogger('SnsLoopRunner');
const MINUTE_MS = 60_000;

export interface SnsLoopRunnerOptions {
  agent: IAgent;
  minIntervalMinutes: number;
  maxIntervalMinutes: number;
  messageSink?: IMessageSink;
  reportChannelId?: string;
  hasPostMessage?: boolean;
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

    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      void this.tick().catch((error) => {
        logger.error('SNS loop tick crashed unexpectedly', error);
      });
    }, this.nextDelayMs());
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
    const skillActivityInstructions = buildSnsLoopActivityInstructions(
      this.options.hasPostMessage != null ? { hasPostMessage: this.options.hasPostMessage } : {},
    );

    try {
      await runExclusiveSystemTurn(async () => {
        if (this.closed) {
          logger.debug('Skipping SNS loop execution because runner closed before system turn lock');
          return;
        }

        const response = await this.options.agent.handleMessage(
          `sns-loop:${startedAt.toISOString()}`,
          '(sns loop tick)',
          'sns-loop',
          {
            userId: 'system',
            ephemeral: true,
            skillActivityInstructions,
            autoLoadSnsSkill: true,
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
          `✅ SNS loop succeeded in ${elapsed}ms${summary}`,
          logger,
        );
      });
    } catch (error) {
      logger.error('SNS loop run failed', error);
      await reportSafely(
        this.options.messageSink,
        this.options.reportChannelId,
        `❌ SNS loop failed in ${this.now().getTime() - startedAt.getTime()}ms
${formatError(error)}`,
        logger,
      );
    }
  }
}
