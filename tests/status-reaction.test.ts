import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEBOUNCE_MS,
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

  it('applies the first emoji immediately without debounce', async () => {
    const { adapter, operations } = createReactionAdapter();
    const controller = createController(adapter);

    controller.setQueued();
    await controller.waitForCompletion();

    expect(operations).toEqual([`add:${STATUS_EMOJI.queued}`]);
    expect(adapter.addReaction).toHaveBeenCalledTimes(1);
  });

  it('debounces intermediate emoji changes', async () => {
    const { adapter, operations } = createReactionAdapter();
    const controller = createController(adapter);

    controller.setQueued();
    await controller.waitForCompletion();

    controller.setThinking();
    await flushMicrotasks();

    // Debounce timer has not fired yet — no remove/add
    expect(operations).toEqual([`add:${STATUS_EMOJI.queued}`]);

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await controller.waitForCompletion();

    expect(operations).toEqual([
      `add:${STATUS_EMOJI.queued}`,
      `remove:${STATUS_EMOJI.queued}`,
      `add:${STATUS_EMOJI.thinking}`,
    ]);
  });

  it('collapses rapid intermediate changes into a single reconcile', async () => {
    const { operations, adapter } = createReactionAdapter();
    const controller = createController(adapter);

    controller.setQueued();
    await controller.waitForCompletion();

    // Rapid-fire intermediate changes within the debounce window
    controller.setThinking();
    controller.setTool('webFetch');
    controller.setTool('userLookup');

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await controller.waitForCompletion();

    // Only the final desired emoji (memory) should be applied
    expect(operations).toEqual([
      `add:${STATUS_EMOJI.queued}`,
      `remove:${STATUS_EMOJI.queued}`,
      `add:${STATUS_EMOJI.memory}`,
    ]);
  });

  it('deduplicates repeated requests for the same emoji', async () => {
    const { adapter } = createReactionAdapter();
    const controller = createController(adapter);

    controller.setQueued();
    await controller.waitForCompletion();

    controller.setQueued();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await controller.waitForCompletion();

    expect(adapter.addReaction).toHaveBeenCalledTimes(1);
    expect(adapter.removeReaction).not.toHaveBeenCalled();
  });

  it('skips stale intermediate desired states during in-flight reconcile', async () => {
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

    // Trigger debounced transition
    controller.setThinking();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await flushMicrotasks();

    // Remove is now in-flight (blocked by gate)
    expect(operations).toEqual([
      `add:${STATUS_EMOJI.queued}`,
      `remove:${STATUS_EMOJI.queued}`,
    ]);

    // While remove is in-flight, change desired to web
    controller.setTool('webFetch');

    removeGate.resolve();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await controller.waitForCompletion();

    // Thinking was skipped; web was applied directly
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
    await flushMicrotasks();

    // The failed add triggers re-reconcile from finally; debounce from setThinking is cancelled
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
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
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await flushMicrotasks();

    // The failed remove triggers re-reconcile from finally; debounce from setTool is cancelled
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await controller.waitForCompletion();

    expect(operations).toEqual([
      `add:${STATUS_EMOJI.queued}`,
      `remove:${STATUS_EMOJI.queued}`,
      `remove:${STATUS_EMOJI.queued}`,
      `add:${STATUS_EMOJI.web}`,
    ]);
  });

  it('terminal done() bypasses debounce and executes immediately', async () => {
    const { adapter, operations } = createReactionAdapter();
    const controller = createController(adapter);

    controller.setThinking();
    await controller.waitForCompletion();

    // Start a debounced intermediate change
    controller.setTool('webFetch');
    await flushMicrotasks();

    // done() should cancel the debounce and apply immediately
    controller.done();
    await flushMicrotasks();

    expect(operations).toEqual([
      `add:${STATUS_EMOJI.thinking}`,
      `remove:${STATUS_EMOJI.thinking}`,
      `add:${STATUS_EMOJI.done}`,
    ]);
  });

  it('terminal error() bypasses debounce and executes immediately', async () => {
    const { adapter, operations } = createReactionAdapter();
    const controller = createController(adapter);

    controller.setThinking();
    await controller.waitForCompletion();

    // Start a debounced intermediate change
    controller.setTool('webFetch');
    await flushMicrotasks();

    // error() should cancel the debounce and apply immediately
    controller.error();
    await flushMicrotasks();

    expect(operations).toEqual([
      `add:${STATUS_EMOJI.thinking}`,
      `remove:${STATUS_EMOJI.thinking}`,
      `add:${STATUS_EMOJI.error}`,
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
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
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
