import { describe, expect, it, vi } from 'vitest';

import { ExperienceRecorder } from '../src/life/recorder.js';
import type { IExperienceLogStore, NormalizedEvent } from '../src/life/types.js';
import type { IMessageSink } from '../src/scheduler/types.js';

function buildEvent(): NormalizedEvent {
  return {
    receivedAt: new Date('2026-07-05T12:00:00.000Z'),
    channel: 'kw:bot-1',
    kind: 'world_event',
    payload: { summary: 'テスト' },
  };
}

function createStore(overrides: Partial<IExperienceLogStore> = {}): IExperienceLogStore {
  return {
    append: vi.fn().mockResolvedValue(1),
    getRecent: vi.fn().mockResolvedValue([]),
    listBetween: vi.fn().mockResolvedValue([]),
    countBetween: vi.fn().mockResolvedValue(0),
    listChannelsBetween: vi.fn().mockResolvedValue([]),
    maxReceivedAt: vi.fn().mockResolvedValue(null),
    count: vi.fn().mockResolvedValue(0),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('ExperienceRecorder', () => {
  it('appends events to the store', async () => {
    const store = createStore();
    const recorder = new ExperienceRecorder({ store });

    recorder.record(buildEvent());
    await recorder.flush();

    expect(store.append).toHaveBeenCalledTimes(1);
    expect(store.append).toHaveBeenCalledWith(expect.objectContaining({ channel: 'kw:bot-1' }));
  });

  it('does not throw when the store rejects, and reports the failure', async () => {
    const store = createStore({ append: vi.fn().mockRejectedValue(new Error('disk full')) });
    const postMessage = vi.fn().mockResolvedValue(undefined);
    const messageSink: IMessageSink = { postMessage };
    const recorder = new ExperienceRecorder({
      store,
      messageSink,
      reportChannelId: 'report-channel',
    });

    expect(() => recorder.record(buildEvent())).not.toThrow();
    await recorder.flush();

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(
      'report-channel',
      expect.stringContaining('体験ログの記録に失敗'),
    );
  });

  it('does not throw when the store throws synchronously', async () => {
    const store = createStore({
      append: vi.fn(() => {
        throw new Error('sync failure');
      }),
    });
    const recorder = new ExperienceRecorder({ store });

    expect(() => recorder.record(buildEvent())).not.toThrow();
    await recorder.flush();
  });

  it('flush waits for pending appends', async () => {
    let resolveAppend: (value: number) => void = () => {};
    const store = createStore({
      append: vi.fn(() => new Promise<number>((resolve) => {
        resolveAppend = resolve;
      })),
    });
    const recorder = new ExperienceRecorder({ store });

    recorder.record(buildEvent());
    let flushed = false;
    const flushPromise = recorder.flush().then(() => {
      flushed = true;
    });

    await Promise.resolve();
    expect(flushed).toBe(false);

    resolveAppend(1);
    await flushPromise;
    expect(flushed).toBe(true);
  });

  it('continues reporting even when the report itself fails', async () => {
    const store = createStore({ append: vi.fn().mockRejectedValue(new Error('disk full')) });
    const messageSink: IMessageSink = {
      postMessage: vi.fn().mockRejectedValue(new Error('discord down')),
    };
    const recorder = new ExperienceRecorder({
      store,
      messageSink,
      reportChannelId: 'report-channel',
    });

    expect(() => recorder.record(buildEvent())).not.toThrow();
    await expect(recorder.flush()).resolves.toBeUndefined();
  });
});
