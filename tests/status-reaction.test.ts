import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DONE_REACTION_DURATION_MS,
  STATUS_EMOJI,
  StatusReactionController,
  TERMINAL_RECONCILE_MAX_RETRIES,
  type ReactionAdapter,
} from '../src/status-reaction.js';

function createReactionAdapter() {
  const operations: string[] = [];
  const adapter: ReactionAdapter = {
    addReaction: vi.fn(async (_threadId: string, _messageId: string, emoji: string) => {
      operations.push(`add:${emoji}`);
    }),
    removeReaction: vi.fn(async (_threadId: string, _messageId: string, emoji: string) => {
      operations.push(`remove:${emoji}`);
    }),
  };

  return { adapter, operations };
}

function createController(adapter: ReactionAdapter): StatusReactionController {
  return new StatusReactionController(adapter, 'thread-1', 'message-1');
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });

  return { promise, resolve };
}

async function flushMicrotasks(count = 4): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await Promise.resolve();
  }
}

describe('StatusReactionController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reconciles desired emoji changes to the adapter', async () => {
    const { adapter, operations } = createReactionAdapter();
    const controller = createController(adapter);

    controller.setQueued();
    await controller.waitForCompletion();

    controller.setThinking();
    await controller.waitForCompletion();

    expect(operations).toEqual([
      `add:${STATUS_EMOJI.queued}`,
      `remove:${STATUS_EMOJI.queued}`,
      `add:${STATUS_EMOJI.thinking}`,
    ]);
  });

  it('deduplicates repeated requests for the same emoji', async () => {
    const { adapter } = createReactionAdapter();
    const controller = createController(adapter);

    controller.setQueued();
    await controller.waitForCompletion();

    controller.setQueued();
    await controller.waitForCompletion();

    expect(adapter.addReaction).toHaveBeenCalledTimes(1);
    expect(adapter.removeReaction).not.toHaveBeenCalled();
  });

  it('skips stale intermediate desired states during fast transitions', async () => {
    const operations: string[] = [];
    const removeGate = createDeferred();
    const adapter: ReactionAdapter = {
      addReaction: vi.fn(async (_threadId: string, _messageId: string, emoji: string) => {
        operations.push(`add:${emoji}`);
      }),
      removeReaction: vi.fn(async (_threadId: string, _messageId: string, emoji: string) => {
        operations.push(`remove:${emoji}`);
        await removeGate.promise;
      }),
    };
    const controller = createController(adapter);

    controller.setQueued();
    await controller.waitForCompletion();

    controller.setThinking();
    controller.setTool('webFetch');
    await flushMicrotasks();

    expect(operations).toEqual([
      `add:${STATUS_EMOJI.queued}`,
      `remove:${STATUS_EMOJI.queued}`,
    ]);

    removeGate.resolve();
    await controller.waitForCompletion();

    expect(operations).toEqual([
      `add:${STATUS_EMOJI.queued}`,
      `remove:${STATUS_EMOJI.queued}`,
      `add:${STATUS_EMOJI.web}`,
    ]);
  });

  it('preserves a newer desired emoji when add fails mid-update', async () => {
    let controller!: StatusReactionController;
    const operations: string[] = [];
    const adapter: ReactionAdapter = {
      addReaction: vi.fn(async (_threadId: string, _messageId: string, emoji: string) => {
        operations.push(`add:${emoji}`);
        if (emoji === STATUS_EMOJI.queued) {
          controller.setThinking();
          throw new Error('add failed');
        }
      }),
      removeReaction: vi.fn(async (_threadId: string, _messageId: string, emoji: string) => {
        operations.push(`remove:${emoji}`);
      }),
    };
    controller = createController(adapter);

    controller.setQueued();
    await controller.waitForCompletion();

    expect(operations).toEqual([
      `add:${STATUS_EMOJI.queued}`,
      `add:${STATUS_EMOJI.thinking}`,
    ]);
  });

  it('preserves a newer desired emoji when remove fails mid-update', async () => {
    let controller!: StatusReactionController;
    const operations: string[] = [];
    let shouldFailRemove = true;
    const adapter: ReactionAdapter = {
      addReaction: vi.fn(async (_threadId: string, _messageId: string, emoji: string) => {
        operations.push(`add:${emoji}`);
      }),
      removeReaction: vi.fn(async (_threadId: string, _messageId: string, emoji: string) => {
        operations.push(`remove:${emoji}`);
        if (shouldFailRemove) {
          shouldFailRemove = false;
          controller.setTool('webFetch');
          throw new Error('remove failed');
        }
      }),
    };
    controller = createController(adapter);

    controller.setQueued();
    await controller.waitForCompletion();

    controller.setThinking();
    await controller.waitForCompletion();

    expect(operations).toEqual([
      `add:${STATUS_EMOJI.queued}`,
      `remove:${STATUS_EMOJI.queued}`,
      `remove:${STATUS_EMOJI.queued}`,
      `add:${STATUS_EMOJI.web}`,
    ]);
  });

  it('shows done briefly and then removes it', async () => {
    const { adapter, operations } = createReactionAdapter();
    const controller = createController(adapter);

    controller.setThinking();
    await controller.waitForCompletion();

    controller.done();
    await flushMicrotasks();

    expect(operations).toEqual([
      `add:${STATUS_EMOJI.thinking}`,
      `remove:${STATUS_EMOJI.thinking}`,
      `add:${STATUS_EMOJI.done}`,
    ]);

    await vi.advanceTimersByTimeAsync(DONE_REACTION_DURATION_MS);
    await controller.waitForCompletion();

    expect(operations).toEqual([
      `add:${STATUS_EMOJI.thinking}`,
      `remove:${STATUS_EMOJI.thinking}`,
      `add:${STATUS_EMOJI.done}`,
      `remove:${STATUS_EMOJI.done}`,
    ]);
    expect(adapter.removeReaction).toHaveBeenLastCalledWith(
      'thread-1',
      'message-1',
      STATUS_EMOJI.done,
    );
  });

  it('keeps the error reaction applied', async () => {
    const { adapter, operations } = createReactionAdapter();
    const controller = createController(adapter);

    controller.setThinking();
    await controller.waitForCompletion();

    controller.error();
    await controller.waitForCompletion();
    await vi.advanceTimersByTimeAsync(DONE_REACTION_DURATION_MS * 2);

    expect(operations).toEqual([
      `add:${STATUS_EMOJI.thinking}`,
      `remove:${STATUS_EMOJI.thinking}`,
      `add:${STATUS_EMOJI.error}`,
    ]);
    expect(adapter.removeReaction).not.toHaveBeenCalledWith(
      'thread-1',
      'message-1',
      STATUS_EMOJI.error,
    );
  });

  it('ignores non-terminal state changes after an error', async () => {
    const { adapter, operations } = createReactionAdapter();
    const controller = createController(adapter);

    controller.error();
    await controller.waitForCompletion();

    controller.setQueued();
    controller.setThinking();
    controller.setTool('userLookup');
    controller.done();
    await controller.waitForCompletion();

    expect(operations).toEqual([`add:${STATUS_EMOJI.error}`]);
  });

  it('retries reconcile when terminal error transition fails due to API error', async () => {
    const operations: string[] = [];
    let removeFailCount = 0;
    const adapter: ReactionAdapter = {
      addReaction: vi.fn(async (_threadId: string, _messageId: string, emoji: string) => {
        operations.push(`add:${emoji}`);
      }),
      removeReaction: vi.fn(async (_threadId: string, _messageId: string, emoji: string) => {
        operations.push(`remove:${emoji}`);
        if (removeFailCount < 1) {
          removeFailCount += 1;
          throw new Error('transient API failure');
        }
      }),
    };
    const controller = createController(adapter);

    controller.setThinking();
    await controller.waitForCompletion();

    controller.error();
    await controller.waitForCompletion();

    expect(operations).toEqual([
      `add:${STATUS_EMOJI.thinking}`,
      `remove:${STATUS_EMOJI.thinking}`,
      `remove:${STATUS_EMOJI.thinking}`,
      `add:${STATUS_EMOJI.error}`,
    ]);
  });

  it('gives up terminal reconcile after max retries', async () => {
    const operations: string[] = [];
    const adapter: ReactionAdapter = {
      addReaction: vi.fn(async (_threadId: string, _messageId: string, emoji: string) => {
        operations.push(`add:${emoji}`);
      }),
      removeReaction: vi.fn(async (_threadId: string, _messageId: string, emoji: string) => {
        operations.push(`remove:${emoji}`);
        throw new Error('permanent API failure');
      }),
    };
    const controller = createController(adapter);

    controller.setThinking();
    await controller.waitForCompletion();

    controller.error();
    await controller.waitForCompletion();

    // 1 initial + TERMINAL_RECONCILE_MAX_RETRIES retries
    const removeCalls = operations.filter((op) => op.startsWith('remove:'));
    expect(removeCalls).toHaveLength(1 + TERMINAL_RECONCILE_MAX_RETRIES);
  });

  it('starts the done timer after the done emoji is actually applied', async () => {
    const operations: string[] = [];
    const addGate = createDeferred();
    const adapter: ReactionAdapter = {
      addReaction: vi.fn(async (_threadId: string, _messageId: string, emoji: string) => {
        if (emoji === STATUS_EMOJI.done) {
          await addGate.promise;
        }
        operations.push(`add:${emoji}`);
      }),
      removeReaction: vi.fn(async (_threadId: string, _messageId: string, emoji: string) => {
        operations.push(`remove:${emoji}`);
      }),
    };
    const controller = new StatusReactionController(adapter, 'thread-1', 'message-1', 100);

    controller.done();
    await flushMicrotasks();

    // Timer should NOT have started yet (done emoji not applied)
    await vi.advanceTimersByTimeAsync(200);
    expect(operations).toEqual([]);

    addGate.resolve();
    await flushMicrotasks();

    expect(operations).toEqual([`add:${STATUS_EMOJI.done}`]);

    // Now the timer starts; advance past doneDisplayMs
    await vi.advanceTimersByTimeAsync(200);
    await controller.waitForCompletion();

    expect(operations).toEqual([
      `add:${STATUS_EMOJI.done}`,
      `remove:${STATUS_EMOJI.done}`,
    ]);
  });

  it('cancels the done timer when error overrides done', async () => {
    const { adapter, operations } = createReactionAdapter();
    const controller = createController(adapter);

    controller.done();
    await flushMicrotasks();

    controller.error();
    await controller.waitForCompletion();
    await vi.advanceTimersByTimeAsync(DONE_REACTION_DURATION_MS * 2);

    expect(operations).toEqual([
      `add:${STATUS_EMOJI.done}`,
      `remove:${STATUS_EMOJI.done}`,
      `add:${STATUS_EMOJI.error}`,
    ]);
    expect(adapter.removeReaction).not.toHaveBeenCalledWith(
      'thread-1',
      'message-1',
      STATUS_EMOJI.error,
    );
  });
});
