import { afterEach, describe, expect, it, vi } from 'vitest';

import { HeartbeatRunner } from '../src/scheduler/heartbeat.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('HeartbeatRunner', () => {
  it('runs heartbeat instructions and posts a report', async () => {
    vi.useFakeTimers();
    const agent = {
      handleMessage: vi.fn(async () => 'HEARTBEAT_OK'),
      summarizeSession: vi.fn(async () => 'summary'),
    };
    const schedulerStore = {
      readHeartbeatInstructions: vi.fn(async () => 'Check systems.'),
      listCronJobs: vi.fn(async () => []),
      registerJob: vi.fn(),
      unregisterJob: vi.fn(),
      setReloadListener: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const messageSink = { postMessage: vi.fn(async () => {}) };

    const runner = new HeartbeatRunner({
      agent,
      schedulerStore,
      intervalMinutes: 0.001,
      messageSink,
      reportChannelId: 'report',
    });
    await runner.sync();

    await vi.advanceTimersByTimeAsync(60);

    expect(agent.handleMessage).toHaveBeenCalledWith('heartbeat', '(heartbeat tick)', 'heartbeat', {
      extraSystemPrompt: 'Check systems.',
      userId: 'system',
    });
    expect(messageSink.postMessage).toHaveBeenCalledWith('report', expect.stringMatching(/^✅ Heartbeat succeeded in \d+ms$/));

    await runner.close();
  });

  it('skips overlapping runs', async () => {
    vi.useFakeTimers();
    let resolveRun!: () => void;
    const agent = {
      handleMessage: vi.fn(async () => new Promise<string>((resolve) => {
        resolveRun = () => resolve('done');
      })),
      summarizeSession: vi.fn(async () => 'summary'),
    };
    const schedulerStore = {
      readHeartbeatInstructions: vi.fn(async () => 'Check systems.'),
      listCronJobs: vi.fn(async () => []),
      registerJob: vi.fn(),
      unregisterJob: vi.fn(),
      setReloadListener: vi.fn(),
      close: vi.fn(async () => {}),
    };

    const runner = new HeartbeatRunner({
      agent,
      schedulerStore,
      intervalMinutes: 0.001,
    });
    await runner.sync();

    await vi.advanceTimersByTimeAsync(60);
    await vi.advanceTimersByTimeAsync(60);
    expect(agent.handleMessage).toHaveBeenCalledTimes(1);

    resolveRun();
    await Promise.resolve();
    await runner.close();
  });

  it('does not start when proactive messaging is disabled', async () => {
    vi.useFakeTimers();
    const agent = {
      handleMessage: vi.fn(async () => 'HEARTBEAT_OK'),
      summarizeSession: vi.fn(async () => 'summary'),
    };
    const schedulerStore = {
      readHeartbeatInstructions: vi.fn(async () => 'Check systems.'),
      listCronJobs: vi.fn(async () => []),
      registerJob: vi.fn(),
      unregisterJob: vi.fn(),
      setReloadListener: vi.fn(),
      close: vi.fn(async () => {}),
    };

    const runner = new HeartbeatRunner({
      agent,
      schedulerStore,
      intervalMinutes: 0.001,
      enabled: false,
    });
    await runner.sync();
    await vi.advanceTimersByTimeAsync(120);

    expect(agent.handleMessage).not.toHaveBeenCalled();

    await runner.close();
  });

  it('restarts when heartbeat instructions are added later and stops when removed', async () => {
    vi.useFakeTimers();
    const agent = {
      handleMessage: vi.fn(async () => 'HEARTBEAT_OK'),
      summarizeSession: vi.fn(async () => 'summary'),
    };
    let instructions: string | null = null;
    const schedulerStore = {
      readHeartbeatInstructions: vi.fn(async () => instructions),
      listCronJobs: vi.fn(async () => []),
      registerJob: vi.fn(),
      unregisterJob: vi.fn(),
      setReloadListener: vi.fn(),
      close: vi.fn(async () => {}),
    };

    const runner = new HeartbeatRunner({
      agent,
      schedulerStore,
      intervalMinutes: 0.001,
    });
    await runner.sync();

    await vi.advanceTimersByTimeAsync(120);
    expect(agent.handleMessage).not.toHaveBeenCalled();

    instructions = 'Check systems.';
    await runner.sync();
    await vi.advanceTimersByTimeAsync(60);
    expect(agent.handleMessage).toHaveBeenCalledTimes(1);

    instructions = null;
    await runner.sync();
    await vi.advanceTimersByTimeAsync(120);
    expect(agent.handleMessage).toHaveBeenCalledTimes(1);

    await runner.close();
  });

  it('waits for an in-flight heartbeat during shutdown', async () => {
    vi.useFakeTimers();
    let resolveRun!: (value: string) => void;
    const agent = {
      handleMessage: vi.fn(async () => new Promise<string>((resolve) => {
        resolveRun = resolve;
      })),
      summarizeSession: vi.fn(async () => 'summary'),
    };
    const schedulerStore = {
      readHeartbeatInstructions: vi.fn(async () => 'Check systems.'),
      listCronJobs: vi.fn(async () => []),
      registerJob: vi.fn(),
      unregisterJob: vi.fn(),
      setReloadListener: vi.fn(),
      close: vi.fn(async () => {}),
    };

    const runner = new HeartbeatRunner({
      agent,
      schedulerStore,
      intervalMinutes: 0.001,
    });
    await runner.sync();
    await vi.advanceTimersByTimeAsync(60);

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

  it('logs report failures without stopping future heartbeat ticks', async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const agent = {
      handleMessage: vi.fn(async () => 'HEARTBEAT_OK'),
      summarizeSession: vi.fn(async () => 'summary'),
    };
    const schedulerStore = {
      readHeartbeatInstructions: vi.fn(async () => 'Check systems.'),
      listCronJobs: vi.fn(async () => []),
      registerJob: vi.fn(),
      unregisterJob: vi.fn(),
      setReloadListener: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const runner = new HeartbeatRunner({
      agent,
      schedulerStore,
      intervalMinutes: 0.001,
      messageSink: { postMessage: vi.fn(async () => { throw new Error('report failed'); }) },
      reportChannelId: 'report',
    });

    await runner.sync();
    await vi.advanceTimersByTimeAsync(60);
    await vi.advanceTimersByTimeAsync(60);

    expect(agent.handleMessage).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[ERROR] [HeartbeatRunner] Heartbeat report failed'), expect.any(Error));

    await runner.close();
  });
});
