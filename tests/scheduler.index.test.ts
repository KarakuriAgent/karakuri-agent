import { afterEach, describe, expect, it, vi } from 'vitest';

import { createScheduler } from '../src/scheduler/index.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createScheduler', () => {
  it('does not enable heartbeat when only the report channel is configured', async () => {
    vi.useFakeTimers();

    const agent = {
      handleMessage: vi.fn(async () => 'HEARTBEAT_OK'),
      summarizeSession: vi.fn(async () => 'summary'),
    };
    const store = {
      readHeartbeatInstructions: vi.fn(async () => 'Check systems.'),
      listCronJobs: vi.fn(async () => []),
      registerJob: vi.fn(),
      unregisterJob: vi.fn(),
      setReloadListener: vi.fn(),
      close: vi.fn(async () => {}),
    };

    const scheduler = await createScheduler({
      agent,
      config: {
        dataDir: '/tmp/data',
        timezone: 'UTC',
        heartbeatIntervalMinutes: 0.001,
        reportChannelId: 'report-1',
      },
      messageSink: { postMessage: vi.fn(async () => {}) },
      store: store as never,
    });

    await vi.advanceTimersByTimeAsync(120);

    expect(agent.handleMessage).not.toHaveBeenCalled();

    await scheduler.close();
  });
});
