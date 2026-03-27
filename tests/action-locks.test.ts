import { describe, expect, it } from 'vitest';

import {
  buildReplyLockKey,
  buildQuoteLockKey,
  buildLikeLockKey,
  buildRepostLockKey,
  getSnsActionLockKeys,
  runWithSnsActionLocks,
} from '../src/sns/action-locks.js';
import type { ScheduledAction } from '../src/sns/types.js';

function createPostAction(
  overrides: Partial<Extract<ScheduledAction, { actionType: 'post' }>> = {},
): Extract<ScheduledAction, { actionType: 'post' }> {
  return {
    id: 1,
    actionType: 'post',
    scheduledAt: new Date('2025-01-01T00:00:00.000Z'),
    params: { text: 'hello', visibility: 'public' },
    status: 'pending',
    createdAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function createLikeAction(
  overrides: Partial<Extract<ScheduledAction, { actionType: 'like' }>> = {},
): Extract<ScheduledAction, { actionType: 'like' }> {
  return {
    id: 2,
    actionType: 'like',
    scheduledAt: new Date('2025-01-01T00:00:00.000Z'),
    params: { postId: 'post-1' },
    status: 'pending',
    createdAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function createRepostAction(
  overrides: Partial<Extract<ScheduledAction, { actionType: 'repost' }>> = {},
): Extract<ScheduledAction, { actionType: 'repost' }> {
  return {
    id: 3,
    actionType: 'repost',
    scheduledAt: new Date('2025-01-01T00:00:00.000Z'),
    params: { postId: 'post-1' },
    status: 'pending',
    createdAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('buildReplyLockKey', () => {
  it('returns key with reply: prefix', () => {
    expect(buildReplyLockKey('abc-123')).toBe('reply:abc-123');
  });
});

describe('buildQuoteLockKey', () => {
  it('returns key with quote: prefix', () => {
    expect(buildQuoteLockKey('xyz-456')).toBe('quote:xyz-456');
  });
});

describe('buildLikeLockKey', () => {
  it('returns key with like: prefix', () => {
    expect(buildLikeLockKey('post-99')).toBe('like:post-99');
  });
});

describe('buildRepostLockKey', () => {
  it('returns key with repost: prefix', () => {
    expect(buildRepostLockKey('post-77')).toBe('repost:post-77');
  });
});

describe('getSnsActionLockKeys', () => {
  it('returns reply key when post has replyToId only', () => {
    const action = createPostAction({
      params: { text: 'reply', visibility: 'public', replyToId: 'parent-1' },
    });
    expect(getSnsActionLockKeys(action)).toEqual(['reply:parent-1', '']);
  });

  it('returns quote key when post has quotePostId only', () => {
    const action = createPostAction({
      params: { text: 'quote', visibility: 'public', quotePostId: 'quoted-1' },
    });
    expect(getSnsActionLockKeys(action)).toEqual(['', 'quote:quoted-1']);
  });

  it('returns both reply and quote keys when post has both', () => {
    const action = createPostAction({
      params: {
        text: 'reply + quote',
        visibility: 'public',
        replyToId: 'parent-2',
        quotePostId: 'quoted-2',
      },
    });
    expect(getSnsActionLockKeys(action)).toEqual(['reply:parent-2', 'quote:quoted-2']);
  });

  it('returns empty strings for a plain post without reply or quote', () => {
    const action = createPostAction({
      params: { text: 'plain', visibility: 'public' },
    });
    expect(getSnsActionLockKeys(action)).toEqual(['', '']);
  });

  it('returns like key for a like action', () => {
    const action = createLikeAction({ params: { postId: 'liked-1' } });
    expect(getSnsActionLockKeys(action)).toEqual(['like:liked-1']);
  });

  it('returns repost key for a repost action', () => {
    const action = createRepostAction({ params: { postId: 'reposted-1' } });
    expect(getSnsActionLockKeys(action)).toEqual(['repost:reposted-1']);
  });
});

describe('runWithSnsActionLocks', () => {
  it('runs task without locking when keys are empty', async () => {
    const result = await runWithSnsActionLocks([], async () => 'done');
    expect(result).toBe('done');
  });

  it('runs task without locking when keys contain only empty strings', async () => {
    const result = await runWithSnsActionLocks(['', ''], async () => 'ok');
    expect(result).toBe('ok');
  });

  it('deduplicates keys before locking', async () => {
    const order: string[] = [];

    // If keys were not deduplicated, acquiring the same key twice would
    // cause a deadlock (second acquire waits for first, but first can't
    // finish because it needs second). Completing without hanging proves
    // deduplication works.
    const result = await runWithSnsActionLocks(
      ['reply:1', 'reply:1', 'reply:1'],
      async () => {
        order.push('task');
        return 42;
      },
    );

    expect(result).toBe(42);
    expect(order).toEqual(['task']);
  });

  it('acquires multiple keys in sorted order', async () => {
    const order: string[] = [];

    // Run two concurrent tasks with overlapping keys in different order.
    // Sorted-order acquisition prevents deadlocks and guarantees deterministic
    // serialization.
    const p1 = runWithSnsActionLocks(['reply:b', 'reply:a'], async () => {
      order.push('start:1');
      await new Promise((r) => setTimeout(r, 50));
      order.push('end:1');
    });

    const p2 = runWithSnsActionLocks(['reply:a', 'reply:b'], async () => {
      order.push('start:2');
      await new Promise((r) => setTimeout(r, 10));
      order.push('end:2');
    });

    await Promise.all([p1, p2]);

    // Both tasks acquire locks in sorted order (reply:a then reply:b), so
    // the first task to grab reply:a runs to completion before the second starts.
    expect(order).toEqual(['start:1', 'end:1', 'start:2', 'end:2']);
  });

  it('serializes concurrent calls with overlapping keys', async () => {
    const order: string[] = [];

    const p1 = runWithSnsActionLocks(['like:post-1'], async () => {
      order.push('start:A');
      await new Promise((r) => setTimeout(r, 50));
      order.push('end:A');
    });

    const p2 = runWithSnsActionLocks(['like:post-1'], async () => {
      order.push('start:B');
      await new Promise((r) => setTimeout(r, 10));
      order.push('end:B');
    });

    await Promise.all([p1, p2]);

    expect(order).toEqual(['start:A', 'end:A', 'start:B', 'end:B']);
  });

  it('allows concurrent calls with non-overlapping keys', async () => {
    const order: string[] = [];

    const p1 = runWithSnsActionLocks(['like:post-1'], async () => {
      order.push('start:A');
      await new Promise((r) => setTimeout(r, 50));
      order.push('end:A');
    });

    const p2 = runWithSnsActionLocks(['like:post-2'], async () => {
      order.push('start:B');
      await new Promise((r) => setTimeout(r, 50));
      order.push('end:B');
    });

    await Promise.all([p1, p2]);

    // Non-overlapping keys should allow concurrent execution
    expect(order[0]).toBe('start:A');
    expect(order[1]).toBe('start:B');
  });
});
