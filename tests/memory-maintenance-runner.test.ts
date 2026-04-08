import type { LanguageModel } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  runExclusiveSystemTurn: vi.fn(async <T>(task: () => Promise<T>) => await task()),
  runExclusiveMemoryPersistence: vi.fn(async <T>(task: () => Promise<T>) => await task()),
  runMemoryMaintenance: vi.fn(),
}));

vi.mock('../src/scheduler/system-turn-mutex.js', () => ({
  runExclusiveSystemTurn: mockState.runExclusiveSystemTurn,
}));

vi.mock('../src/memory/maintenance.js', () => ({
  runMemoryMaintenance: mockState.runMemoryMaintenance,
}));

vi.mock('../src/memory/persistence-mutex.js', () => ({
  runExclusiveMemoryPersistence: mockState.runExclusiveMemoryPersistence,
}));

import { MemoryMaintenanceRunner } from '../src/memory/maintenance-runner.js';
import type { IMemoryStore } from '../src/memory/types.js';

const memoryStoreStub: IMemoryStore = {
  readCoreMemory: vi.fn(async () => ''),
  writeCoreMemory: vi.fn(async () => undefined),
  readDiary: vi.fn(async () => null),
  writeDiary: vi.fn(async () => undefined),
  replaceDiary: vi.fn(async () => undefined),
  deleteDiary: vi.fn(async () => false),
  getRecentDiaries: vi.fn(async () => []),
  listDiaryDates: vi.fn(async () => []),
  close: vi.fn(async () => undefined),
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  mockState.runExclusiveSystemTurn.mockReset();
  mockState.runExclusiveSystemTurn.mockImplementation(async <T>(task: () => Promise<T>) => await task());
  mockState.runExclusiveMemoryPersistence.mockReset();
  mockState.runExclusiveMemoryPersistence.mockImplementation(async <T>(task: () => Promise<T>) => await task());
  mockState.runMemoryMaintenance.mockReset();
});

describe('MemoryMaintenanceRunner', () => {
  it('runs on a fixed interval after start', async () => {
    vi.useFakeTimers();
    mockState.runMemoryMaintenance.mockResolvedValue({ diaryOps: [], coreMemoryAction: 'none', coreMemoryContent: '', summary: 'no changes' });

    const runner = new MemoryMaintenanceRunner({
      model: {} as LanguageModel,
      memoryStore: memoryStoreStub,
      intervalMinutes: 0.001,
      timezone: 'UTC',
    });
    runner.start();

    await vi.advanceTimersByTimeAsync(60);
    await vi.advanceTimersByTimeAsync(60);

    expect(mockState.runMemoryMaintenance).toHaveBeenCalledTimes(2);

    await runner.close();
  });

  it('uses runExclusiveSystemTurn for each run', async () => {
    vi.useFakeTimers();
    mockState.runMemoryMaintenance.mockResolvedValue({ diaryOps: [], coreMemoryAction: 'none', coreMemoryContent: '', summary: 'no changes' });

    const runner = new MemoryMaintenanceRunner({
      model: {} as LanguageModel,
      memoryStore: memoryStoreStub,
      intervalMinutes: 0.001,
      timezone: 'UTC',
    });
    runner.start();
    await vi.advanceTimersByTimeAsync(60);

    expect(mockState.runExclusiveSystemTurn).toHaveBeenCalledTimes(1);
    expect(mockState.runExclusiveMemoryPersistence).toHaveBeenCalledTimes(1);
    expect(mockState.runMemoryMaintenance).toHaveBeenCalledWith(expect.objectContaining({
      memoryStore: memoryStoreStub,
      recentDiaryDays: 30,
      timezone: 'UTC',
    }));

    await runner.close();
  });

  it('does not run after being closed', async () => {
    vi.useFakeTimers();
    mockState.runMemoryMaintenance.mockResolvedValue({ diaryOps: [], coreMemoryAction: 'none', coreMemoryContent: '', summary: 'no changes' });

    const runner = new MemoryMaintenanceRunner({
      model: {} as LanguageModel,
      memoryStore: memoryStoreStub,
      intervalMinutes: 0.001,
      timezone: 'UTC',
    });
    runner.start();
    await runner.close();

    await vi.advanceTimersByTimeAsync(120);
    expect(mockState.runMemoryMaintenance).not.toHaveBeenCalled();
  });

  it('reports after releasing the system-turn lock', async () => {
    vi.useFakeTimers();
    let lockReleased = false;
    mockState.runExclusiveSystemTurn.mockImplementation(async <T>(task: () => Promise<T>) => {
      const result = await task();
      lockReleased = true;
      return result;
    });
    mockState.runMemoryMaintenance.mockResolvedValue({ diaryOps: [], coreMemoryAction: 'none', coreMemoryContent: '', summary: 'no changes' });
    const messageSink = { postMessage: vi.fn(async () => {
      expect(lockReleased).toBe(true);
    }) };

    const runner = new MemoryMaintenanceRunner({
      model: {} as LanguageModel,
      memoryStore: memoryStoreStub,
      intervalMinutes: 0.001,
      timezone: 'UTC',
      messageSink,
      reportChannelId: 'report',
    });
    runner.start();
    await vi.advanceTimersByTimeAsync(60);

    expect(messageSink.postMessage).toHaveBeenCalledTimes(1);

    await runner.close();
  });

  it('reports the returned metadata-only summary', async () => {
    vi.useFakeTimers();
    mockState.runMemoryMaintenance.mockResolvedValue({
      diaryOps: [
        { date: '2025-01-10', action: 'rewrite', content: 'ignored' },
        { date: '2025-01-11', action: 'delete', content: '' },
      ],
      coreMemoryAction: 'rewrite',
      coreMemoryContent: 'secret replacement',
      summary: ' removed 1 outdated entry\nand consolidated core memory ',
    });
    const messageSink = { postMessage: vi.fn(async () => {}) };

    const runner = new MemoryMaintenanceRunner({
      model: {} as LanguageModel,
      memoryStore: memoryStoreStub,
      intervalMinutes: 0.001,
      timezone: 'UTC',
      messageSink,
      reportChannelId: 'report',
    });
    runner.start();
    await vi.advanceTimersByTimeAsync(60);

    expect(messageSink.postMessage).toHaveBeenCalledWith(
      'report',
      expect.stringMatching(/^✅ Memory maintenance: removed 1 outdated entry and consolidated core memory \(\d+ms\)$/),
    );
    const firstReportCall = messageSink.postMessage.mock.calls[0] as [string, string] | undefined;
    const reportText = firstReportCall?.[1];
    expect(reportText).not.toContain('secret replacement');

    await runner.close();
  });

  it('suppresses Discord mentions in report summaries', async () => {
    vi.useFakeTimers();
    mockState.runMemoryMaintenance.mockResolvedValue({
      diaryOps: [],
      coreMemoryAction: 'none',
      coreMemoryContent: '',
      summary: '@everyone cleaned <@123> and <#456>',
    });
    const messageSink = { postMessage: vi.fn(async () => {}) };

    const runner = new MemoryMaintenanceRunner({
      model: {} as LanguageModel,
      memoryStore: memoryStoreStub,
      intervalMinutes: 0.001,
      timezone: 'UTC',
      messageSink,
      reportChannelId: 'report',
    });
    runner.start();
    await vi.advanceTimersByTimeAsync(60);

    expect(messageSink.postMessage).toHaveBeenCalledWith(
      'report',
      expect.stringMatching(/^✅ Memory maintenance: @​everyone cleaned <@​123> and <#​456> \(\d+ms\)$/),
    );

    await runner.close();
  });

  it('skips overlapping runs and resumes later', async () => {
    vi.useFakeTimers();
    let resolveRun!: () => void;
    mockState.runMemoryMaintenance
      .mockImplementationOnce(async () => await new Promise((resolve) => {
        resolveRun = () => resolve({ diaryOps: [], coreMemoryAction: 'none', coreMemoryContent: '', summary: 'no changes' });
      }))
      .mockResolvedValueOnce({ diaryOps: [], coreMemoryAction: 'none', coreMemoryContent: '', summary: 'no changes' });

    const runner = new MemoryMaintenanceRunner({
      model: {} as LanguageModel,
      memoryStore: memoryStoreStub,
      intervalMinutes: 0.001,
      timezone: 'UTC',
    });
    runner.start();

    await vi.advanceTimersByTimeAsync(60);
    await vi.advanceTimersByTimeAsync(60);
    expect(mockState.runMemoryMaintenance).toHaveBeenCalledTimes(1);

    resolveRun();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(60);
    expect(mockState.runMemoryMaintenance).toHaveBeenCalledTimes(2);

    await runner.close();
  });

  it('waits for an in-flight run during close', async () => {
    vi.useFakeTimers();
    let resolveRun!: () => void;
    mockState.runMemoryMaintenance.mockImplementation(async () => await new Promise((resolve) => {
      resolveRun = () => resolve({ diaryOps: [], coreMemoryAction: 'none', coreMemoryContent: '', summary: 'no changes' });
    }));

    const runner = new MemoryMaintenanceRunner({
      model: {} as LanguageModel,
      memoryStore: memoryStoreStub,
      intervalMinutes: 0.001,
      timezone: 'UTC',
    });
    runner.start();
    await vi.advanceTimersByTimeAsync(60);

    const closePromise = runner.close();
    let closed = false;
    void closePromise.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    resolveRun();
    await closePromise;
    expect(closed).toBe(true);
  });

  it('reports missing structured output as a failure', async () => {
    vi.useFakeTimers();
    mockState.runMemoryMaintenance.mockResolvedValue(null);
    const messageSink = { postMessage: vi.fn(async () => {}) };

    const runner = new MemoryMaintenanceRunner({
      model: {} as LanguageModel,
      memoryStore: memoryStoreStub,
      intervalMinutes: 0.001,
      timezone: 'UTC',
      messageSink,
      reportChannelId: 'report',
    });
    runner.start();
    await vi.advanceTimersByTimeAsync(60);

    expect(messageSink.postMessage).toHaveBeenCalledWith('report', expect.stringMatching(/^❌ Memory maintenance failed \[no-output\] in \d+ms$/));

    await runner.close();
  });

  it('continues after report failures', async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockState.runMemoryMaintenance.mockResolvedValue({ diaryOps: [], coreMemoryAction: 'none', coreMemoryContent: '', summary: 'no changes' });
    const messageSink = { postMessage: vi.fn(async () => { throw new Error('report failed'); }) };

    const runner = new MemoryMaintenanceRunner({
      model: {} as LanguageModel,
      memoryStore: memoryStoreStub,
      intervalMinutes: 0.001,
      timezone: 'UTC',
      messageSink,
      reportChannelId: 'report',
    });
    runner.start();

    await vi.advanceTimersByTimeAsync(60);
    await vi.advanceTimersByTimeAsync(60);

    expect(mockState.runMemoryMaintenance).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[ERROR] [MemoryMaintenanceRunner] Failed to send report message'), expect.any(Error));

    await runner.close();
  });

  it('passes providerOptions through to memory maintenance when configured', async () => {
    vi.useFakeTimers();
    mockState.runMemoryMaintenance.mockResolvedValue({ diaryOps: [], coreMemoryAction: 'none', coreMemoryContent: '', summary: 'no changes' });
    const providerOptions = { openai: { reasoningEffort: 'low' as const } };

    const runner = new MemoryMaintenanceRunner({
      model: {} as LanguageModel,
      memoryStore: memoryStoreStub,
      intervalMinutes: 0.001,
      timezone: 'UTC',
      providerOptions,
    });
    runner.start();
    await vi.advanceTimersByTimeAsync(60);

    expect(mockState.runMemoryMaintenance).toHaveBeenCalledWith(expect.objectContaining({
      providerOptions,
    }));

    await runner.close();
  });

  it('passes through a custom diary inspection window', async () => {
    vi.useFakeTimers();
    mockState.runMemoryMaintenance.mockResolvedValue({ diaryOps: [], coreMemoryAction: 'none', coreMemoryContent: '', summary: 'no changes' });

    const runner = new MemoryMaintenanceRunner({
      model: {} as LanguageModel,
      memoryStore: memoryStoreStub,
      intervalMinutes: 0.001,
      recentDiaryDays: 120,
      timezone: 'UTC',
    });
    runner.start();
    await vi.advanceTimersByTimeAsync(60);

    expect(mockState.runMemoryMaintenance).toHaveBeenCalledWith(expect.objectContaining({
      recentDiaryDays: 120,
    }));

    await runner.close();
  });
});
