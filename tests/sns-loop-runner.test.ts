import { afterEach, describe, expect, it, vi } from 'vitest';

import { SnsLoopRunner } from '../src/sns/loop-runner.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('SnsLoopRunner', () => {
  it('runs sns loop instructions and posts a report', async () => {
    vi.useFakeTimers();
    const agent = {
      handleMessage: vi.fn(async () => 'SNS_IDLE 通知なし、投稿ネタなし'),
      summarizeSession: vi.fn(async () => 'summary'),
    };
    const messageSink = { postMessage: vi.fn(async () => {}) };

    const runner = new SnsLoopRunner({
      agent,
      minIntervalMinutes: 0.001,
      maxIntervalMinutes: 0.001,
      messageSink,
      reportChannelId: 'report',
      hasPostMessage: true,
    });
    runner.start();

    await vi.advanceTimersByTimeAsync(60);

    expect(agent.handleMessage).toHaveBeenCalledWith(expect.stringMatching(/^sns-loop:/), '(sns loop tick)', 'sns-loop', {
      userId: 'system',
      ephemeral: true,
      skillActivityInstructions: expect.stringContaining('SNS_IDLE'),
      autoLoadSnsSkill: true,
    });
    expect(messageSink.postMessage).toHaveBeenCalledWith('report', expect.stringMatching(/^✅ SNS loop succeeded in \d+ms\nSNS_IDLE 通知なし、投稿ネタなし$/));

    await runner.close();
  });

  it('uses random intervals within bounds', async () => {
    vi.useFakeTimers();
    const agent = {
      handleMessage: vi.fn(async () => 'ok'),
      summarizeSession: vi.fn(async () => 'summary'),
    };
    const randomFn = vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(1);

    const runner = new SnsLoopRunner({
      agent,
      minIntervalMinutes: 1,
      maxIntervalMinutes: 3,
      randomFn,
    });
    runner.start();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(agent.handleMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(agent.handleMessage).toHaveBeenCalledTimes(2);

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

    const runner = new SnsLoopRunner({ agent, minIntervalMinutes: 0.001, maxIntervalMinutes: 0.001 });
    runner.start();

    await vi.advanceTimersByTimeAsync(60);
    await vi.advanceTimersByTimeAsync(60);
    expect(agent.handleMessage).toHaveBeenCalledTimes(1);

    resolveRun();
    await Promise.resolve();
    await runner.close();
  });

  it('waits for an in-flight sns loop during shutdown', async () => {
    vi.useFakeTimers();
    let resolveRun!: (value: string) => void;
    const agent = {
      handleMessage: vi.fn(async () => new Promise<string>((resolve) => {
        resolveRun = resolve;
      })),
      summarizeSession: vi.fn(async () => 'summary'),
    };

    const runner = new SnsLoopRunner({ agent, minIntervalMinutes: 0.001, maxIntervalMinutes: 0.001 });
    runner.start();
    await vi.advanceTimersByTimeAsync(60);

    const closePromise = runner.close();
    let closed = false;
    void closePromise.then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);

    resolveRun('done');
    await closePromise;
    expect(closed).toBe(true);
  });

  it('reports errors and keeps running', async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const agent = {
      handleMessage: vi.fn(async () => { throw new Error('boom'); }),
      summarizeSession: vi.fn(async () => 'summary'),
    };
    const messageSink = { postMessage: vi.fn(async () => {}) };

    const runner = new SnsLoopRunner({
      agent,
      minIntervalMinutes: 0.001,
      maxIntervalMinutes: 0.001,
      messageSink,
      reportChannelId: 'report',
    });
    runner.start();

    await vi.advanceTimersByTimeAsync(60);
    await vi.advanceTimersByTimeAsync(60);

    expect(agent.handleMessage).toHaveBeenCalledTimes(2);
    expect(messageSink.postMessage).toHaveBeenCalledWith('report', expect.stringMatching(/^❌ SNS loop failed in \d+ms\nboom$/));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[ERROR] [SnsLoopRunner] SNS loop run failed'), expect.any(Error));

    await runner.close();
  });
});
