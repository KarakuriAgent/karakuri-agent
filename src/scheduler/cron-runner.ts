import { Cron } from 'croner';

import type { IAgent } from '../agent/core.js';
import { formatError } from '../utils/error.js';
import { createLogger } from '../utils/logger.js';
import { reportSafely } from '../utils/report.js';
import type { CronJobDefinition, IMessageSink, ISchedulerStore } from './types.js';

const logger = createLogger('CronRunner');

const MAX_TIMEOUT_CHUNK_MS = 24 * 60 * 60 * 1_000;

interface CronState {
  job: CronJobDefinition;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  skippedWhileRunning: boolean;
  inFlight: Promise<void> | null;
  rescheduleAfterRun: boolean;
  disposed: boolean;
}

export interface CronRunnerOptions {
  agent: IAgent;
  schedulerStore: ISchedulerStore;
  timezone: string;
  messageSink?: IMessageSink | undefined;
  reportChannelId?: string | undefined;
  now?: () => Date;
  random?: () => number;
  sleep?: (durationMs: number) => Promise<void>;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export class CronRunner {
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly sleep: (durationMs: number) => Promise<void>;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly states = new Map<string, CronState>();
  private closed = false;

  constructor(private readonly options: CronRunnerOptions) {
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? defaultSleep;
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  }

  async syncJobs(): Promise<void> {
    if (this.closed) {
      return;
    }

    const jobs = await this.options.schedulerStore.listCronJobs();
    const nextJobs = new Map(jobs.map((job) => [job.name, job]));

    for (const [name, state] of this.states) {
      const next = nextJobs.get(name);
      if (next == null || !next.enabled) {
        this.cancelState(state);
        this.states.delete(name);
        continue;
      }

      if (!sameJobDefinition(state.job, next)) {
        this.updateState(state, next);
      }

      nextJobs.delete(name);
    }

    for (const job of nextJobs.values()) {
      if (!job.enabled) {
        continue;
      }

      const state: CronState = {
        job,
        timer: null,
        running: false,
        skippedWhileRunning: false,
        inFlight: null,
        rescheduleAfterRun: false,
        disposed: false,
      };
      this.states.set(job.name, state);
      this.scheduleNext(state);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const inFlightRuns: Promise<void>[] = [];
    for (const state of this.states.values()) {
      this.cancelState(state);
      if (state.inFlight != null) {
        inFlightRuns.push(state.inFlight);
      }
    }
    this.states.clear();
    await Promise.allSettled(inFlightRuns);
  }

  private scheduleNext(state: CronState): void {
    if (this.closed || state.disposed || state.timer != null) {
      return;
    }

    const delayMs = getMsToNextRun(state.job.schedule, this.options.timezone, this.now());
    if (delayMs == null) {
      logger.warn(`Cron job ${state.job.name} does not have a future run`);
      return;
    }

    this.armTimeout(state, delayMs);
  }

  private armTimeout(state: CronState, remainingMs: number): void {
    if (this.closed || state.disposed) {
      return;
    }

    const delayMs = Math.min(remainingMs, MAX_TIMEOUT_CHUNK_MS);
    state.timer = this.setTimeoutFn(() => {
      if (this.closed || state.disposed) {
        return;
      }
      state.timer = null;
      const nextRemainingMs = remainingMs - delayMs;
      if (nextRemainingMs > 0) {
        this.armTimeout(state, nextRemainingMs);
        return;
      }

      void this.handleDueJob(state).catch((error) => {
        logger.error(`Cron job ${state.job.name} crashed unexpectedly`, error);
      });
    }, delayMs);
  }

  private async handleDueJob(state: CronState): Promise<void> {
    if (this.closed || state.disposed) {
      return;
    }

    if (state.running) {
      logger.debug('Skipping cron tick because a previous run is still active', { name: state.job.name });
      state.skippedWhileRunning = true;
      return;
    }

    state.running = true;
    state.skippedWhileRunning = false;
    state.rescheduleAfterRun = false;
    let run: Promise<void> | null = null;

    try {
      this.scheduleNext(state);
      run = this.executeJob(state).finally(() => {
        state.running = false;
        if (!this.closed && !state.disposed && state.timer == null && (state.skippedWhileRunning || state.rescheduleAfterRun)) {
          state.skippedWhileRunning = false;
          state.rescheduleAfterRun = false;
          this.scheduleNext(state);
        }
      });
      await run;
    } catch (error) {
      if (run == null) {
        state.running = false;
      }
      throw error;
    }
  }

  private async executeJob(state: CronState): Promise<void> {
    const { job } = state;
    const startedAt = this.now();
    let inFlight: Promise<void> | null = null;

    try {
      if (job.staggerMs > 0) {
        const delayMs = Math.floor(this.random() * (job.staggerMs + 1));
        if (delayMs > 0) {
          await this.sleep(delayMs);
        }
      }

      if (this.closed || state.disposed) {
        logger.debug('Skipping cancelled cron execution after stagger delay', { name: job.name });
        return;
      }

      inFlight = (async () => {
        try {
          const sessionId = job.sessionMode === 'shared'
            ? `cron:${job.name}`
            : `cron:${job.name}:${this.now().toISOString()}`;
          const response = await this.options.agent.handleMessage(
            sessionId,
            `(cron tick: ${job.name})`,
            `cron:${job.name}`,
            {
              extraSystemPrompt: job.instructions,
              userId: 'system',
            },
          );
          logger.debug('Cron run completed', { name: job.name, responseLength: response.trim().length });
          await reportSafely(
            this.options.messageSink,
            this.options.reportChannelId,
            `✅ Cron ${job.name} succeeded in ${this.now().getTime() - startedAt.getTime()}ms`,
            {
              error: (_message, error) => {
                logger.error(`Cron job ${job.name} report failed`, error);
              },
            },
          );
        } catch (error) {
          logger.error(`Cron job ${job.name} failed`, error);
          await reportSafely(
            this.options.messageSink,
            this.options.reportChannelId,
            `❌ Cron ${job.name} failed in ${this.now().getTime() - startedAt.getTime()}ms\n${formatError(error)}`,
            {
              error: (_message, reportError) => {
                logger.error(`Cron job ${job.name} report failed`, reportError);
              },
            },
          );
        }
      })();
      state.inFlight = inFlight;
      await inFlight;
    } catch (error) {
      logger.error(`Cron job ${job.name} failed`, error);
      await reportSafely(
        this.options.messageSink,
        this.options.reportChannelId,
        `❌ Cron ${job.name} failed in ${this.now().getTime() - startedAt.getTime()}ms\n${formatError(error)}`,
        {
          error: (_message, reportError) => {
            logger.error(`Cron job ${job.name} report failed`, reportError);
          },
        },
      );
    } finally {
      if (state.inFlight === inFlight) {
        state.inFlight = null;
      }
    }
  }

  private cancelState(state: CronState): void {
    state.disposed = true;
    state.skippedWhileRunning = false;
    state.rescheduleAfterRun = false;
    if (state.timer != null) {
      this.clearTimeoutFn(state.timer);
      state.timer = null;
    }
  }

  private updateState(state: CronState, job: CronJobDefinition): void {
    state.job = job;
    state.rescheduleAfterRun = false;
    if (state.timer != null) {
      this.clearTimeoutFn(state.timer);
      state.timer = null;
    }
    if (state.running) {
      state.rescheduleAfterRun = true;
      return;
    }
    this.scheduleNext(state);
  }
}

function sameJobDefinition(left: CronJobDefinition, right: CronJobDefinition): boolean {
  return left.schedule === right.schedule
    && left.instructions === right.instructions
    && left.enabled === right.enabled
    && left.sessionMode === right.sessionMode
    && left.staggerMs === right.staggerMs;
}

function getMsToNextRun(schedule: string, timezone: string, now: Date): number | null {
  const cron = new Cron(schedule, { paused: true, timezone });
  return cron.msToNext(now);
}

function defaultSleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}
