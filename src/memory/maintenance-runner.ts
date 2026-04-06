import type { LanguageModel } from 'ai';
import type { ProviderOptions } from '@ai-sdk/provider-utils';

import { runExclusiveSystemTurn } from '../scheduler/system-turn-mutex.js';
import type { IMessageSink } from '../scheduler/types.js';
import { createLogger } from '../utils/logger.js';
import { reportSafely } from '../utils/report.js';
import { runMemoryMaintenance } from './maintenance.js';
import { runExclusiveMemoryPersistence } from './persistence-mutex.js';
import type { IMemoryStore } from './types.js';

const logger = createLogger('MemoryMaintenanceRunner');
const MINUTE_MS = 60_000;
const DEFAULT_RECENT_DIARY_DAYS = 30;

export interface MemoryMaintenanceRunnerOptions {
  model: LanguageModel;
  memoryStore: IMemoryStore;
  intervalMinutes: number;
  recentDiaryDays?: number;
  timezone: string;
  messageSink?: IMessageSink;
  reportChannelId?: string;
  now?: () => Date;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  generateTextFn?: typeof import('ai').generateText;
  providerOptions?: ProviderOptions | undefined;
}

export class MemoryMaintenanceRunner {
  private readonly now: () => Date;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly intervalMs: number;
  private readonly recentDiaryDays: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private skippedWhileRunning = false;
  private inFlight: Promise<void> | null = null;
  private closed = false;
  private started = false;

  constructor(private readonly options: MemoryMaintenanceRunnerOptions) {
    this.now = options.now ?? (() => new Date());
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
    this.intervalMs = Math.max(1, Math.floor(options.intervalMinutes * MINUTE_MS));
    this.recentDiaryDays = Math.max(1, Math.floor(options.recentDiaryDays ?? DEFAULT_RECENT_DIARY_DAYS));
  }

  start(): void {
    if (this.closed) {
      logger.warn('MemoryMaintenanceRunner.start() called after close, ignoring');
      return;
    }
    if (this.started) {
      logger.debug('MemoryMaintenanceRunner.start() called multiple times, ignoring');
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

  private scheduleNext(): void {
    if (this.closed || !this.started || this.timer != null) {
      return;
    }

    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      void this.tick().catch(async (error) => {
        logger.error('Memory maintenance tick crashed unexpectedly', error);
        await reportSafely(
          this.options.messageSink,
          this.options.reportChannelId,
          '❌ Memory maintenance tick crashed unexpectedly',
          logger,
          { suppressDiscordMentions: true },
        );
        if (!this.closed) {
          this.scheduleNext();
        }
      });
    }, this.intervalMs);
  }

  private async tick(): Promise<void> {
    if (this.closed) {
      return;
    }

    if (this.running) {
      logger.debug('Skipping memory maintenance tick because a previous run is still active');
      this.skippedWhileRunning = true;
      return;
    }

    this.running = true;
    this.skippedWhileRunning = false;
    this.scheduleNext();
    const run = this.runMaintenance().finally(() => {
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

  private async runMaintenance(): Promise<void> {
    const startedAt = this.now();

    try {
      let skipped = false;
      let result: Awaited<ReturnType<typeof runMemoryMaintenance>> | undefined;
      await runExclusiveSystemTurn(async () => {
        if (this.closed) {
          logger.debug('Skipping memory maintenance because runner closed before system turn lock');
          skipped = true;
          return;
        }

        result = await runExclusiveMemoryPersistence(async () => await runMemoryMaintenance({
          model: this.options.model,
          memoryStore: this.options.memoryStore,
          recentDiaryDays: this.recentDiaryDays,
          timezone: this.options.timezone,
          ...(this.options.generateTextFn != null ? { generateTextFn: this.options.generateTextFn } : {}),
          ...(this.options.providerOptions != null ? { providerOptions: this.options.providerOptions } : {}),
        }));
      });
      if (skipped) {
        return;
      }

      if (result == null) {
        throw new Error('Memory maintenance returned no structured output');
      }

      const elapsed = this.now().getTime() - startedAt.getTime();
      // Defensive re-sanitize (runMemoryMaintenance already normalizes)
      const sanitizedSummary = result.summary.replace(/\s+/g, ' ').trim();
      await reportSafely(
        this.options.messageSink,
        this.options.reportChannelId,
        `✅ Memory maintenance: ${sanitizedSummary} (${elapsed}ms)`,
        logger,
        { suppressDiscordMentions: true },
      );
    } catch (error) {
      const category = categorizeMaintenanceError(error);
      logger.error(`Memory maintenance run failed [${category}]`, error);
      await reportSafely(
        this.options.messageSink,
        this.options.reportChannelId,
        `❌ Memory maintenance failed [${category}] in ${this.now().getTime() - startedAt.getTime()}ms`,
        logger,
        { suppressDiscordMentions: true },
      );
    }
  }
}

function categorizeMaintenanceError(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'unknown';
  }
  const message = error.message;
  if (message.includes('no structured output')) {
    return 'no-output';
  }
  if (message.includes('metadata-only') || message.includes('unknown dates') || message.includes('unloaded dates')) {
    return 'assertion';
  }
  if (message.includes('Diary operation failed at index')) {
    return 'partial-apply';
  }
  return 'unexpected';
}
