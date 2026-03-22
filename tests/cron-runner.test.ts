import { afterEach, describe, expect, it, vi } from 'vitest';

import { CronRunner } from '../src/scheduler/cron-runner.js';
import type { CronJobDefinition } from '../src/scheduler/types.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function createSchedulerStore(jobOverrides: Partial<{
  name: string;
  schedule: string;
  instructions: string;
  enabled: boolean;
  sessionMode: 'isolated' | 'shared';
  staggerMs: number;
}> = {}) {
  return {
    readHeartbeatInstructions: vi.fn(async () => null),
    listCronJobs: vi.fn(async () => [{
      name: 'daily-summary',
      schedule: '* * * * *',
      instructions: 'Send summary.',
      enabled: true,
      sessionMode: 'isolated' as const,
      staggerMs: 0,
      ...jobOverrides,
    }]),
    registerJob: vi.fn(),
    unregisterJob: vi.fn(),
    setReloadListener: vi.fn(),
    close: vi.fn(async () => {}),
  };
}

describe('CronRunner', () => {
  it('runs scheduled cron jobs and posts reports', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    const agent = {
      handleMessage: vi.fn(async () => 'posted'),
      summarizeSession: vi.fn(async () => 'summary'),
    };
    const schedulerStore = createSchedulerStore();
    const messageSink = { postMessage: vi.fn(async () => {}) };
    const runner = new CronRunner({
      agent,
      schedulerStore,
      timezone: 'UTC',
      messageSink,
      reportChannelId: 'report',
    });

    await runner.syncJobs();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(agent.handleMessage).toHaveBeenCalledWith(
      expect.stringMatching(/^cron:daily-summary:/),
      '(cron tick: daily-summary)',
      'cron:daily-summary',
      { extraSystemPrompt: 'Send summary.', userId: 'system' },
    );
    expect(messageSink.postMessage).toHaveBeenCalledWith('report', expect.stringMatching(/^✅ Cron daily-summary succeeded in \d+ms$/));

    await runner.close();
  });

  it('uses a shared session id when configured', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    const agent = {
      handleMessage: vi.fn(async () => 'posted'),
      summarizeSession: vi.fn(async () => 'summary'),
    };
    const runner = new CronRunner({
      agent,
      schedulerStore: createSchedulerStore({ sessionMode: 'shared' }),
      timezone: 'UTC',
    });

    await runner.syncJobs();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(agent.handleMessage).toHaveBeenCalledWith(
      'cron:daily-summary',
      '(cron tick: daily-summary)',
      'cron:daily-summary',
      { extraSystemPrompt: 'Send summary.', userId: 'system' },
    );

    await runner.close();
  });

  it('skips overlapping cron runs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    let resolveRun!: () => void;
    const agent = {
      handleMessage: vi.fn(async () => new Promise<string>((resolve) => {
        resolveRun = () => resolve('done');
      })),
      summarizeSession: vi.fn(async () => 'summary'),
    };
    const runner = new CronRunner({
      agent,
      schedulerStore: createSchedulerStore(),
      timezone: 'UTC',
    });

    await runner.syncJobs();
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(agent.handleMessage).toHaveBeenCalledTimes(1);

    resolveRun();
    await Promise.resolve();
    await runner.close();
  });

  it('preserves skip-if-running when a job is reloaded during an active run', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    const runResolvers: Array<(value: string) => void> = [];
    const jobs: CronJobDefinition[] = [{
      name: 'daily-summary',
      schedule: '* * * * *',
      instructions: 'First version.',
      enabled: true,
      sessionMode: 'isolated' as const,
      staggerMs: 0,
    }];
    const schedulerStore = {
      readHeartbeatInstructions: vi.fn(async () => null),
      listCronJobs: vi.fn(async () => jobs.map((job) => ({ ...job }))),
      registerJob: vi.fn(),
      unregisterJob: vi.fn(),
      setReloadListener: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const agent = {
      handleMessage: vi.fn(async () => new Promise<string>((resolve) => {
        runResolvers.push(resolve);
      })),
      summarizeSession: vi.fn(async () => 'summary'),
    };
    const runner = new CronRunner({
      agent,
      schedulerStore,
      timezone: 'UTC',
    });

    await runner.syncJobs();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(agent.handleMessage).toHaveBeenCalledTimes(1);

    jobs[0] = { ...jobs[0]!, instructions: 'Second version.' };
    await runner.syncJobs();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(agent.handleMessage).toHaveBeenCalledTimes(1);

    runResolvers.shift()?.('done');
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(agent.handleMessage).toHaveBeenCalledTimes(2);
    expect(agent.handleMessage).toHaveBeenLastCalledWith(
      expect.stringMatching(/^cron:daily-summary:/),
      '(cron tick: daily-summary)',
      'cron:daily-summary',
      { extraSystemPrompt: 'Second version.', userId: 'system' },
    );
    runResolvers.shift()?.('done');
    await Promise.resolve();

    await runner.close();
  });

  it('does not execute a removed job after stagger delay elapses', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    const jobs: CronJobDefinition[] = [{
      name: 'daily-summary',
      schedule: '* * * * *',
      instructions: 'Send summary.',
      enabled: true,
      sessionMode: 'isolated',
      staggerMs: 1_000,
    }];
    const schedulerStore = {
      readHeartbeatInstructions: vi.fn(async () => null),
      listCronJobs: vi.fn(async () => jobs.map((job) => ({ ...job }))),
      registerJob: vi.fn(),
      unregisterJob: vi.fn(),
      setReloadListener: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const agent = {
      handleMessage: vi.fn(async () => 'posted'),
      summarizeSession: vi.fn(async () => 'summary'),
    };
    const runner = new CronRunner({
      agent,
      schedulerStore,
      timezone: 'UTC',
      random: () => 1,
    });

    await runner.syncJobs();
    await vi.advanceTimersByTimeAsync(60_000);
    jobs[0] = { ...jobs[0]!, enabled: false };
    await runner.syncJobs();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(agent.handleMessage).not.toHaveBeenCalled();

    await runner.close();
  });

  it('waits for in-flight cron jobs during shutdown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    let resolveRun!: (value: string) => void;
    const agent = {
      handleMessage: vi.fn(async () => new Promise<string>((resolve) => {
        resolveRun = resolve;
      })),
      summarizeSession: vi.fn(async () => 'summary'),
    };
    const runner = new CronRunner({
      agent,
      schedulerStore: createSchedulerStore(),
      timezone: 'UTC',
    });

    await runner.syncJobs();
    await vi.advanceTimersByTimeAsync(60_000);

    const closePromise = runner.close();
    let closed = false;
    void closePromise.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    resolveRun('done');
    await closePromise;
    expect(closed).toBe(true);
  });

  it('does not block shutdown on a job that is only waiting in stagger', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    let resolveSleep!: () => void;
    const agent = {
      handleMessage: vi.fn(async () => 'posted'),
      summarizeSession: vi.fn(async () => 'summary'),
    };
    const runner = new CronRunner({
      agent,
      schedulerStore: createSchedulerStore({ staggerMs: 1_000 }),
      timezone: 'UTC',
      random: () => 1,
      sleep: () => new Promise<void>((resolve) => {
        resolveSleep = resolve;
      }),
    });

    await runner.syncJobs();
    await vi.advanceTimersByTimeAsync(60_000);
    const closePromise = runner.close();
    await closePromise;

    resolveSleep();
    await Promise.resolve();

    expect(agent.handleMessage).not.toHaveBeenCalled();
  });

  it('logs report failures without stopping future cron ticks', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const agent = {
      handleMessage: vi.fn(async () => 'posted'),
      summarizeSession: vi.fn(async () => 'summary'),
    };
    const runner = new CronRunner({
      agent,
      schedulerStore: createSchedulerStore(),
      timezone: 'UTC',
      messageSink: { postMessage: vi.fn(async () => { throw new Error('report failed'); }) },
      reportChannelId: 'report',
    });

    await runner.syncJobs();
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(agent.handleMessage).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[ERROR] [CronRunner] Cron job daily-summary report failed'), expect.any(Error));

    await runner.close();
  });

  it('isolates unexpected due-job errors from becoming unhandled rejections', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const unhandledRejection = vi.fn();
    process.on('unhandledRejection', unhandledRejection);

    let nowCalls = 0;
    const agent = {
      handleMessage: vi.fn(async () => 'posted'),
      summarizeSession: vi.fn(async () => 'summary'),
    };
    const runner = new CronRunner({
      agent,
      schedulerStore: createSchedulerStore(),
      timezone: 'UTC',
      now: () => {
        nowCalls += 1;
        if (nowCalls === 2) {
          throw new Error('clock failed');
        }
        return new Date('2025-01-01T00:00:00.000Z');
      },
    });

    try {
      await runner.syncJobs();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(agent.handleMessage).not.toHaveBeenCalled();
      expect(unhandledRejection).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[ERROR] [CronRunner] Cron job daily-summary crashed unexpectedly'),
        expect.objectContaining({ message: 'clock failed' }),
      );
    } finally {
      process.off('unhandledRejection', unhandledRejection);
      await runner.close();
    }
  });
});
