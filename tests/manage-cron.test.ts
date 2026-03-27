import { describe, expect, it, vi } from 'vitest';

import { createManageCronTool } from '../src/agent/tools/manage-cron.js';

describe('manageCron tool', () => {
  it('registers, lists, and unregisters jobs for admin users', async () => {
    const messageSink = { postMessage: vi.fn(async () => {}) };
    const schedulerStore = {
      registerJob: vi.fn(async (input) => ({
        name: input.name,
        schedule: input.schedule,
        instructions: input.instructions,
        enabled: input.enabled ?? true,
        sessionMode: input.sessionMode ?? 'isolated',
        staggerMs: input.staggerMs ?? 0,
        oneshot: input.oneshot ?? false,
      })),
      unregisterJob: vi.fn(async () => true),
      listCronJobs: vi.fn(async () => [{
        name: 'daily-summary',
        schedule: '0 9 * * *',
        instructions: 'Run.',
        enabled: true,
        sessionMode: 'isolated' as const,
        staggerMs: 0,
        oneshot: false,
      }]),
      readHeartbeatInstructions: vi.fn(async () => null),
      setReloadListener: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const tool = createManageCronTool({
      schedulerStore,
      adminUserIds: ['admin-1'],
      userId: 'admin-1',
      messageSink,
      reportChannelId: 'report',
    });

    await expect(tool.execute!(
      { action: 'register', name: 'daily-summary', schedule: '0 9 * * *', instructions: 'Run.', oneshot: true },
      { toolCallId: 'c1', messages: [], abortSignal: undefined as never },
    )).resolves.toMatchObject({ action: 'register', job: { name: 'daily-summary', oneshot: true } });
    expect(messageSink.postMessage).toHaveBeenNthCalledWith(
      1,
      'report',
      '⏰ Cron `daily-summary` saved (schedule: 0 9 * * *)',
    );

    await expect(tool.execute!(
      { action: 'list' },
      { toolCallId: 'c2', messages: [], abortSignal: undefined as never },
    )).resolves.toEqual({
      action: 'list',
      jobs: [{
        name: 'daily-summary',
        schedule: '0 9 * * *',
        instructions: 'Run.',
        enabled: true,
        sessionMode: 'isolated',
        staggerMs: 0,
        oneshot: false,
      }],
    });

    await expect(tool.execute!(
      { action: 'unregister', name: 'daily-summary' },
      { toolCallId: 'c3', messages: [], abortSignal: undefined as never },
    )).resolves.toEqual({ action: 'unregister', name: 'daily-summary', removed: true });
    expect(messageSink.postMessage).toHaveBeenNthCalledWith(
      2,
      'report',
      '🗑️ Cron `daily-summary` unregistered',
    );
  });

  it('rejects non-admin users', async () => {
    const tool = createManageCronTool({
      schedulerStore: {
        registerJob: vi.fn(),
        unregisterJob: vi.fn(),
        listCronJobs: vi.fn(async () => []),
        readHeartbeatInstructions: vi.fn(async () => null),
        setReloadListener: vi.fn(),
        close: vi.fn(async () => {}),
      },
      adminUserIds: ['admin-1'],
      userId: 'user-1',
    });

    await expect(tool.execute!(
      { action: 'list' },
      { toolCallId: 'c1', messages: [], abortSignal: undefined as never },
    )).rejects.toThrow(/administrator/);
  });

  it('allows system runs when admin users are not configured', async () => {
    const schedulerStore = {
      registerJob: vi.fn(),
      unregisterJob: vi.fn(),
      listCronJobs: vi.fn(async () => []),
      readHeartbeatInstructions: vi.fn(async () => null),
      setReloadListener: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const tool = createManageCronTool({
      schedulerStore,
      adminUserIds: [],
      userId: 'system',
    });

    await expect(tool.execute!(
      { action: 'list' },
      { toolCallId: 'c1', messages: [], abortSignal: undefined as never },
    )).resolves.toEqual({ action: 'list', jobs: [] });
    expect(schedulerStore.listCronJobs).toHaveBeenCalledTimes(1);
  });

  it('does not report unregister when no job was removed', async () => {
    const messageSink = { postMessage: vi.fn(async () => {}) };
    const tool = createManageCronTool({
      schedulerStore: {
        registerJob: vi.fn(),
        unregisterJob: vi.fn(async () => false),
        listCronJobs: vi.fn(async () => []),
        readHeartbeatInstructions: vi.fn(async () => null),
        setReloadListener: vi.fn(),
        close: vi.fn(async () => {}),
      },
      adminUserIds: ['admin-1'],
      userId: 'admin-1',
      messageSink,
      reportChannelId: 'report',
    });

    await expect(tool.execute!(
      { action: 'unregister', name: 'daily-summary' },
      { toolCallId: 'c1', messages: [], abortSignal: undefined as never },
    )).resolves.toEqual({ action: 'unregister', name: 'daily-summary', removed: false });
    expect(messageSink.postMessage).not.toHaveBeenCalled();
  });

  it('swallows report failures for register and unregister', async () => {
    const messageSink = { postMessage: vi.fn(async () => { throw new Error('report failed'); }) };
    const schedulerStore = {
      registerJob: vi.fn(async (input) => ({
        name: input.name,
        schedule: input.schedule,
        instructions: input.instructions,
        enabled: input.enabled ?? true,
        sessionMode: input.sessionMode ?? 'isolated',
        staggerMs: input.staggerMs ?? 0,
        oneshot: input.oneshot ?? false,
      })),
      unregisterJob: vi.fn(async () => true),
      listCronJobs: vi.fn(async () => []),
      readHeartbeatInstructions: vi.fn(async () => null),
      setReloadListener: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const tool = createManageCronTool({
      schedulerStore,
      adminUserIds: ['admin-1'],
      userId: 'admin-1',
      messageSink,
      reportChannelId: 'report',
    });

    await expect(tool.execute!(
      { action: 'register', name: 'daily-summary', schedule: '0 9 * * *', instructions: 'Run.', oneshot: true },
      { toolCallId: 'c1', messages: [], abortSignal: undefined as never },
    )).resolves.toMatchObject({ action: 'register', job: { name: 'daily-summary', oneshot: true } });

    await expect(tool.execute!(
      { action: 'unregister', name: 'daily-summary' },
      { toolCallId: 'c2', messages: [], abortSignal: undefined as never },
    )).resolves.toEqual({ action: 'unregister', name: 'daily-summary', removed: true });
  });
});
