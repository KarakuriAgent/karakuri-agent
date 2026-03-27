import type { IAgent } from '../agent/core.js';
import { formatError } from '../utils/error.js';
import { createLogger } from '../utils/logger.js';
import { reportSafely } from '../utils/report.js';
import { runExclusiveSystemTurn } from './system-turn-mutex.js';
import type { IMessageSink, ISchedulerStore } from './types.js';

const logger = createLogger('HeartbeatRunner');

const MINUTE_MS = 60_000;

export interface HeartbeatRunnerOptions {
  agent: IAgent;
  schedulerStore: ISchedulerStore;
  intervalMinutes: number;
  messageSink?: IMessageSink | undefined;
  reportChannelId?: string | undefined;
  enabled?: boolean | undefined;
  now?: () => Date;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export class HeartbeatRunner {
  private readonly now: () => Date;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private instructions: string | null = null;
  private running = false;
  private skippedWhileRunning = false;
  private inFlight: Promise<void> | null = null;
  private closed = false;

  constructor(
    private readonly options: HeartbeatRunnerOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
    this.intervalMs = Math.max(1, Math.floor(options.intervalMinutes * MINUTE_MS));
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer != null) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
    }
    await this.inFlight;
  }

  async sync(...args: [instructions: string | null] | []): Promise<void> {
    const nextInstructions = args.length > 0
      ? args[0] ?? null
      : await this.options.schedulerStore.readHeartbeatInstructions();
    this.instructions = nextInstructions;

    if (this.options.enabled === false || nextInstructions == null) {
      this.skippedWhileRunning = false;
      if (!this.running && this.timer != null) {
        this.clearTimeoutFn(this.timer);
        this.timer = null;
      }
      return;
    }

    if (!this.running && this.timer == null) {
      this.scheduleNext();
    }
  }

  private scheduleNext(): void {
    if (this.closed || this.instructions == null || this.timer != null) {
      return;
    }

    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      void this.tick().catch((error) => {
        logger.error('Heartbeat tick crashed unexpectedly', error);
      });
    }, this.intervalMs);
  }

  private async tick(): Promise<void> {
    if (this.closed) {
      return;
    }

    if (this.running) {
      logger.debug('Skipping heartbeat tick because a previous run is still active');
      this.skippedWhileRunning = true;
      return;
    }

    const instructions = this.instructions;
    if (instructions == null) {
      return;
    }

    this.running = true;
    this.skippedWhileRunning = false;
    this.scheduleNext();
    const run = this.runHeartbeat(instructions).finally(() => {
      this.running = false;
      if (this.inFlight === run) {
        this.inFlight = null;
      }
      if (!this.closed && this.instructions != null && this.skippedWhileRunning && this.timer == null) {
        this.skippedWhileRunning = false;
        this.scheduleNext();
      }
    });
    this.inFlight = run;
    await run;
  }

  private async runHeartbeat(instructions: string): Promise<void> {
    const startedAt = this.now();

    try {
      await runExclusiveSystemTurn(async () => {
        if (this.closed || this.instructions == null) {
          logger.debug('Skipping heartbeat execution because runner closed before system turn lock');
          return;
        }

        const response = await this.options.agent.handleMessage(
          `heartbeat:${startedAt.toISOString()}`,
          '(heartbeat tick)',
          'heartbeat',
          {
            extraSystemPrompt: instructions,
            userId: 'system',
            ephemeral: true,
          },
        );
        const trimmedResponse = response.trim();
        logger.debug('Heartbeat run completed', { responseLength: trimmedResponse.length });
        const elapsed = this.now().getTime() - startedAt.getTime();
        const summary = trimmedResponse.length > 0 ? `\n${trimmedResponse}` : '';
        await reportSafely(
          this.options.messageSink,
          this.options.reportChannelId,
          `✅ Heartbeat succeeded in ${elapsed}ms${summary}`,
          logger,
        );
      });
    } catch (error) {
      logger.error('Heartbeat run failed', error);
      await reportSafely(
        this.options.messageSink,
        this.options.reportChannelId,
        `❌ Heartbeat failed in ${this.now().getTime() - startedAt.getTime()}ms\n${formatError(error)}`,
        logger,
      );
    }
  }
}
