import { describe, expect, it, vi } from 'vitest';

import { SnsRateLimiter } from '../src/sns/rate-limiter.js';
import type { ISnsWriteActivityCounter, SnsWriteActionKind } from '../src/sns/types.js';

const LIMITS = {
  postPerHour: 2,
  postPerDay: 5,
  postMinIntervalMinutes: 15,
  replyPerHour: 3,
  likePerHour: 4,
  repostPerHour: 1,
};

const FETCH_INTERVALS = { notificationsMinutes: 10, timelineMinutes: 30, trendsMinutes: 60 };

const NOW = new Date('2026-07-06T12:00:00.000Z');

interface CounterState {
  hourCounts?: Partial<Record<SnsWriteActionKind, { count: number; earliestAt: string | null }>>;
  dayCount?: { count: number; earliestAt: string | null };
  lastAt?: Partial<Record<SnsWriteActionKind, string | null>>;
}

function makeCounter(state: CounterState = {}): ISnsWriteActivityCounter {
  return {
    async countWriteActionsSince(kind, since) {
      const isDayWindow = NOW.getTime() - since.getTime() > 3_600_000;
      if (kind === 'post' && isDayWindow) {
        return state.dayCount ?? { count: 0, earliestAt: null };
      }
      return state.hourCounts?.[kind] ?? { count: 0, earliestAt: null };
    },
    async getLastWriteActionAt(kind) {
      return state.lastAt?.[kind] ?? null;
    },
  };
}

function makeLimiter(state: CounterState = {}, limits = LIMITS): SnsRateLimiter {
  return new SnsRateLimiter({
    limits,
    fetchIntervals: FETCH_INTERVALS,
    counter: makeCounter(state),
    timezone: 'Asia/Tokyo',
    now: () => NOW,
  });
}

describe('SnsRateLimiter.checkWrite', () => {
  it('allows actions under all limits', async () => {
    const limiter = makeLimiter({
      hourCounts: { post: { count: 1, earliestAt: '2026-07-06T11:30:00.000Z' } },
      dayCount: { count: 3, earliestAt: '2026-07-06T01:00:00.000Z' },
      lastAt: { post: '2026-07-06T11:30:00.000Z' },
    });
    expect(await limiter.checkWrite('like')).toEqual({ allowed: true });
    expect(await limiter.checkWrite('post')).toEqual({ allowed: true });
  });

  it('denies when the hourly limit is reached, with the next available time', async () => {
    const limiter = makeLimiter({
      hourCounts: { post: { count: 2, earliestAt: '2026-07-06T11:10:00.000Z' } },
    });
    const gate = await limiter.checkWrite('post');
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) {
      expect(gate.message).toContain('1 時間に 2 回まで');
      expect(gate.retryAt?.toISOString()).toBe('2026-07-06T12:10:00.000Z');
    }
  });

  it('denies when the daily post limit is reached', async () => {
    const limiter = makeLimiter({
      hourCounts: { post: { count: 0, earliestAt: null } },
      dayCount: { count: 5, earliestAt: '2026-07-05T20:00:00.000Z' },
    });
    const gate = await limiter.checkWrite('post');
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) {
      expect(gate.message).toContain('24 時間に 5 回まで');
    }
  });

  it('enforces the minimum interval between posts', async () => {
    const limiter = makeLimiter({
      lastAt: { post: '2026-07-06T11:50:00.000Z' },
    });
    const gate = await limiter.checkWrite('post');
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) {
      expect(gate.message).toContain('15 分以上あける');
      expect(gate.retryAt?.toISOString()).toBe('2026-07-06T12:05:00.000Z');
    }
  });

  it('denies entirely when the limit is zero', async () => {
    const limiter = makeLimiter({}, { ...LIMITS, repostPerHour: 0 });
    const gate = await limiter.checkWrite('repost');
    expect(gate.allowed).toBe(false);
    if (!gate.allowed) {
      expect(gate.message).toContain('リポストができない');
    }
  });

  it('tracks reply and post budgets independently', async () => {
    const limiter = makeLimiter({
      hourCounts: {
        post: { count: 2, earliestAt: '2026-07-06T11:10:00.000Z' },
        reply: { count: 0, earliestAt: null },
      },
    });
    expect((await limiter.checkWrite('post')).allowed).toBe(false);
    expect((await limiter.checkWrite('reply')).allowed).toBe(true);
  });
});

describe('SnsRateLimiter.throttleFetch', () => {
  it('serves cached values within the interval and refetches after it', async () => {
    let now = new Date('2026-07-06T12:00:00.000Z');
    const limiter = new SnsRateLimiter({
      limits: LIMITS,
      fetchIntervals: FETCH_INTERVALS,
      counter: makeCounter(),
      timezone: 'Asia/Tokyo',
      now: () => now,
    });
    const fetcher = vi.fn(async () => ({ posts: [now.toISOString()] }));

    const first = await limiter.throttleFetch('trends', fetcher);
    expect(first.cached).toBe(false);

    now = new Date('2026-07-06T12:30:00.000Z');
    const second = await limiter.throttleFetch('trends', fetcher);
    expect(second.cached).toBe(true);
    expect(second.value).toEqual(first.value);
    expect(fetcher).toHaveBeenCalledTimes(1);

    now = new Date('2026-07-06T13:01:00.000Z');
    const third = await limiter.throttleFetch('trends', fetcher);
    expect(third.cached).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(limiter.lastFetchedAt('trends')?.toISOString()).toBe('2026-07-06T13:01:00.000Z');
  });

  it('does not cache when the fetcher throws', async () => {
    const limiter = new SnsRateLimiter({
      limits: LIMITS,
      fetchIntervals: FETCH_INTERVALS,
      counter: makeCounter(),
      timezone: 'Asia/Tokyo',
      now: () => NOW,
    });
    const fetcher = vi.fn(async () => {
      throw new Error('api down');
    });
    await expect(limiter.throttleFetch('timeline', fetcher)).rejects.toThrow('api down');
    expect(limiter.lastFetchedAt('timeline')).toBeNull();
  });
});
