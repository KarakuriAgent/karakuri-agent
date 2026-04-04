import { describe, expect, it } from 'vitest';

import {
  buildReplyLockKey,
  buildQuoteLockKey,
  buildLikeLockKey,
  buildRepostLockKey,
  runWithSnsActionLocks,
} from '../src/sns/action-locks.js';

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
    const result = await runWithSnsActionLocks(['reply:1', 'reply:1', 'reply:1'], async () => {
      order.push('task');
      return 42;
    });

    expect(result).toBe(42);
    expect(order).toEqual(['task']);
  });

  it('acquires multiple keys in sorted order', async () => {
    const order: string[] = [];

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
    expect(order[0]).toBe('start:A');
    expect(order[1]).toBe('start:B');
  });
});
