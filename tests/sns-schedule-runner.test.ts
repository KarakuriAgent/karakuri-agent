import { afterEach, describe, expect, it, vi } from 'vitest';

import { SnsScheduleRunner } from '../src/sns/schedule-runner.js';
import type { ISnsActivityStore, ISnsScheduleStore, ScheduledAction, SnsPost, SnsProvider } from '../src/sns/types.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const noopSetTimeout = ((() => 1 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout);
const noopClearTimeout = ((() => undefined) as unknown as typeof clearTimeout);

function createPost(id: string): SnsPost {
  return {
    id,
    text: 'hello',
    authorId: 'acct-1',
    authorName: 'Alice',
    authorHandle: 'alice@example.com',
    createdAt: '2025-01-01T00:00:00.000Z',
    url: `https://social.example/@alice/${id}`,
    visibility: 'public',
    repostCount: 0,
    likeCount: 0,
    replyCount: 0,
  };
}

function createPostAction(overrides: Partial<Extract<ScheduledAction, { actionType: 'post' }>> = {}): Extract<ScheduledAction, { actionType: 'post' }> {
  return {
    id: 1,
    actionType: 'post',
    scheduledAt: new Date('2025-01-01T00:00:00.000Z'),
    params: { text: 'scheduled post', visibility: 'public' },
    status: 'executing',
    createdAt: '2025-01-01T00:00:00.000Z',
    recoveredFromExecuting: false,
    ...overrides,
  };
}

function createLikeAction(overrides: Partial<Extract<ScheduledAction, { actionType: 'like' }>> = {}): Extract<ScheduledAction, { actionType: 'like' }> {
  return {
    id: 1,
    actionType: 'like',
    scheduledAt: new Date('2025-01-01T00:00:00.000Z'),
    params: { postId: 'post-1' },
    status: 'executing',
    createdAt: '2025-01-01T00:00:00.000Z',
    recoveredFromExecuting: false,
    ...overrides,
  };
}

function createRepostAction(overrides: Partial<Extract<ScheduledAction, { actionType: 'repost' }>> = {}): Extract<ScheduledAction, { actionType: 'repost' }> {
  return {
    id: 1,
    actionType: 'repost',
    scheduledAt: new Date('2025-01-01T00:00:00.000Z'),
    params: { postId: 'post-1' },
    status: 'executing',
    createdAt: '2025-01-01T00:00:00.000Z',
    recoveredFromExecuting: false,
    ...overrides,
  };
}

function createActivityStore(overrides: Partial<ISnsActivityStore> = {}): ISnsActivityStore {
  return {
    recordPost: vi.fn(async () => {}),
    recordLike: vi.fn(async () => {}),
    recordRepost: vi.fn(async () => {}),
    hasLiked: vi.fn(async () => false),
    hasReposted: vi.fn(async () => false),
    hasReplied: vi.fn(async () => false),
    hasQuoted: vi.fn(async () => false),
    getRecentActivities: vi.fn(async () => []),
    getLastNotificationId: vi.fn(async () => null),
    setLastNotificationId: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

function createScheduleStore(overrides: Partial<ISnsScheduleStore> = {}): ISnsScheduleStore {
  return {
    schedule: vi.fn(async () => 1),
    claimPendingActions: vi.fn(async () => []),
    completeWithRecord: vi.fn(async () => {}),
    markFailed: vi.fn(async () => {}),
    recoverStaleExecuting: vi.fn(async () => 0),
    getPendingAndExecuting: vi.fn(async () => []),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}

function createProvider(overrides: Partial<SnsProvider> = {}): SnsProvider {
  return {
    post: vi.fn(async () => createPost('post-1')),
    getPost: vi.fn(async (postId: string) => createPost(postId)),
    getTimeline: vi.fn(),
    search: vi.fn(),
    like: vi.fn(async () => createPost('post-1')),
    repost: vi.fn(async () => createPost('post-1')),
    getNotifications: vi.fn(),
    uploadMedia: vi.fn(),
    getThread: vi.fn(),
    getUserPosts: vi.fn(),
    getTrends: vi.fn(),
    ...overrides,
  } as never;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('SnsScheduleRunner', () => {
  it('recovers stale executions and records successful scheduled actions', async () => {
    const executedAt = new Date('2025-01-02T00:00:00.000Z');
    const scheduleStore = createScheduleStore({
      recoverStaleExecuting: vi.fn(async () => 1),
      claimPendingActions: vi.fn(async () => [createLikeAction()]),
    });
    const activityStore = createActivityStore();
    const snsProvider = createProvider({
      like: vi.fn(async () => createPost('liked-post')),
    });

    const runner = new SnsScheduleRunner({
      scheduleStore,
      activityStore,
      snsProvider,
      now: () => executedAt,
      setTimeoutFn: noopSetTimeout,
      clearTimeoutFn: noopClearTimeout,
    });
    runner.start();
    await runner.close();

    expect(scheduleStore.recoverStaleExecuting).toHaveBeenNthCalledWith(1);
    expect(scheduleStore.recoverStaleExecuting).toHaveBeenNthCalledWith(2, new Date('2025-01-01T23:59:00.000Z'));
    expect(scheduleStore.claimPendingActions).toHaveBeenCalledWith(executedAt, 5);
    expect(snsProvider.like).toHaveBeenCalledWith('post-1');
    expect(scheduleStore.completeWithRecord).toHaveBeenCalledWith(1, expect.objectContaining({
      type: 'like',
      postId: 'post-1',
      createdAt: executedAt,
    }));
  });

  it('uses a deterministic idempotency key for scheduled posts', async () => {
    const scheduleStore = createScheduleStore({
      claimPendingActions: vi.fn(async () => [createPostAction({ id: 7 })]),
    });
    const activityStore = createActivityStore();
    const snsProvider = createProvider();

    const runner = new SnsScheduleRunner({
      scheduleStore,
      activityStore,
      snsProvider,
      setTimeoutFn: noopSetTimeout,
      clearTimeoutFn: noopClearTimeout,
    });
    runner.start();
    await runner.close();

    expect(snsProvider.post).toHaveBeenCalledWith(expect.objectContaining({
      text: 'scheduled post',
      visibility: 'public',
      idempotencyKey: 'sns-scheduled-post:7',
    }));
  });

  it('marks duplicates as failed without calling the provider', async () => {
    const scheduleStore = createScheduleStore({
      claimPendingActions: vi.fn(async () => [createRepostAction({ id: 2 })]),
    });
    const activityStore = createActivityStore({
      hasReposted: vi.fn(async () => true),
    });
    const snsProvider = createProvider();

    const runner = new SnsScheduleRunner({
      scheduleStore,
      activityStore,
      snsProvider,
      setTimeoutFn: noopSetTimeout,
      clearTimeoutFn: noopClearTimeout,
    });
    runner.start();
    await runner.close();

    expect(snsProvider.repost).not.toHaveBeenCalled();
    expect(scheduleStore.markFailed).toHaveBeenCalledWith(2, 'already_reposted:post-1');
  });

  it('does not reconcile fresh likes before their first write', async () => {
    const scheduleStore = createScheduleStore({
      claimPendingActions: vi.fn(async () => [createLikeAction({ id: 15 })]),
    });
    const activityStore = createActivityStore({
      hasLiked: vi.fn(async () => false),
    });
    const snsProvider = createProvider();

    const runner = new SnsScheduleRunner({
      scheduleStore,
      activityStore,
      snsProvider,
      setTimeoutFn: noopSetTimeout,
      clearTimeoutFn: noopClearTimeout,
    });
    runner.start();
    await runner.close();

    expect(snsProvider.getPost).not.toHaveBeenCalled();
    expect(snsProvider.like).toHaveBeenCalledWith('post-1');
  });

  it('reconciles remotely completed likes only after recovery', async () => {
    const scheduleStore = createScheduleStore({
      claimPendingActions: vi.fn(async () => [createLikeAction({ id: 14, recoveredFromExecuting: true })]),
    });
    const activityStore = createActivityStore({
      hasLiked: vi.fn(async () => false),
    });
    const snsProvider = createProvider({
      getPost: vi.fn(async () => ({ ...createPost('post-1'), liked: true })),
    });

    const runner = new SnsScheduleRunner({
      scheduleStore,
      activityStore,
      snsProvider,
      setTimeoutFn: noopSetTimeout,
      clearTimeoutFn: noopClearTimeout,
    });
    runner.start();
    await runner.close();

    expect(snsProvider.like).not.toHaveBeenCalled();
    expect(scheduleStore.completeWithRecord).toHaveBeenCalledWith(14, expect.objectContaining({
      type: 'like',
      postId: 'post-1',
    }));
  });

  it('keeps recovered likes executing when remote reconciliation fails transiently', async () => {
    const scheduleStore = createScheduleStore({
      claimPendingActions: vi.fn(async () => [createLikeAction({ id: 16, recoveredFromExecuting: true })]),
    });
    const activityStore = createActivityStore({
      hasLiked: vi.fn(async () => false),
    });
    const reportError = vi.fn();
    const snsProvider = createProvider({
      getPost: vi.fn(async () => { throw new Error('network timeout'); }),
    });

    const runner = new SnsScheduleRunner({
      scheduleStore,
      activityStore,
      snsProvider,
      reportError,
      now: () => new Date('2025-01-01T00:01:00.000Z'),
      setTimeoutFn: noopSetTimeout,
      clearTimeoutFn: noopClearTimeout,
    });
    runner.start();
    await runner.close();

    expect(snsProvider.like).not.toHaveBeenCalled();
    expect(scheduleStore.markFailed).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith('⚠️ Scheduled SNS action #16 hit a transient recovery check failure and will stay executing for retry: network timeout');
  });

  it('keeps ambiguous scheduled post failures executing for crash-safe recovery', async () => {
    const scheduleStore = createScheduleStore({
      claimPendingActions: vi.fn(async () => [createPostAction({ id: 3 })]),
    });
    const activityStore = createActivityStore();
    const reportError = vi.fn();
    const snsProvider = createProvider({
      post: vi.fn(async () => { throw new Error('api timeout'); }),
    });

    const runner = new SnsScheduleRunner({
      scheduleStore,
      activityStore,
      snsProvider,
      reportError,
      now: () => new Date('2025-01-01T00:01:00.000Z'),
      setTimeoutFn: noopSetTimeout,
      clearTimeoutFn: noopClearTimeout,
    });
    runner.start();
    await runner.close();

    expect(scheduleStore.markFailed).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith('⚠️ Scheduled SNS action #3 hit an ambiguous post failure and will stay executing for crash-safe recovery: api timeout');
  });

  it('keeps remotely successful actions executing when local persistence fails', async () => {
    const scheduleStore = createScheduleStore({
      claimPendingActions: vi.fn(async () => [createPostAction({ id: 13 })]),
      completeWithRecord: vi.fn(async () => { throw new Error('sqlite write failed'); }),
    });
    const activityStore = createActivityStore();
    const reportError = vi.fn();
    const snsProvider = createProvider({
      post: vi.fn(async () => createPost('post-13')),
    });

    const runner = new SnsScheduleRunner({
      scheduleStore,
      activityStore,
      snsProvider,
      reportError,
      setTimeoutFn: noopSetTimeout,
      clearTimeoutFn: noopClearTimeout,
    });
    runner.start();
    await runner.close();

    expect(scheduleStore.markFailed).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith('⚠️ Scheduled SNS action #13 completed remotely but local persistence failed and will stay executing for recovery: sqlite write failed');
  });

  it('marks definite scheduled post failures as failed', async () => {
    const scheduleStore = createScheduleStore({
      claimPendingActions: vi.fn(async () => [createPostAction({ id: 8 })]),
    });
    const activityStore = createActivityStore();
    const reportError = vi.fn();
    const snsProvider = createProvider({
      post: vi.fn(async () => { throw new Error('validation rejected'); }),
    });

    const runner = new SnsScheduleRunner({
      scheduleStore,
      activityStore,
      snsProvider,
      reportError,
      setTimeoutFn: noopSetTimeout,
      clearTimeoutFn: noopClearTimeout,
    });
    runner.start();
    await runner.close();

    expect(scheduleStore.markFailed).toHaveBeenCalledWith(8, 'validation rejected');
    expect(reportError).toHaveBeenCalledWith('⚠️ Scheduled SNS action #8 failed: validation rejected');
  });

  it('waits for an in-flight action during shutdown', async () => {
    let resolveLike!: () => void;
    const scheduleStore = createScheduleStore({
      claimPendingActions: vi.fn(async () => [createLikeAction({ id: 4 })]),
    });
    const activityStore = createActivityStore();
    const snsProvider = createProvider({
      like: vi.fn(async () => {
        await new Promise<void>((resolve) => {
          resolveLike = resolve;
        });
        return createPost('post-1');
      }),
    });

    const runner = new SnsScheduleRunner({
      scheduleStore,
      activityStore,
      snsProvider,
      setTimeoutFn: noopSetTimeout,
      clearTimeoutFn: noopClearTimeout,
    });
    runner.start();
    await flushPromises();
    await flushPromises();

    const closePromise = runner.close();
    let closed = false;
    void closePromise.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    resolveLike();
    await closePromise;
    expect(closed).toBe(true);
  });

  it('limits claimed backlog size and spaces out executions', async () => {
    const sleep = vi.fn(async () => {});
    const scheduleStore = createScheduleStore({
      claimPendingActions: vi.fn(async () => [
        createLikeAction({ id: 10, params: { postId: 'post-10' } }),
        createRepostAction({ id: 11, params: { postId: 'post-11' } }),
      ]),
    });
    const activityStore = createActivityStore();
    const snsProvider = createProvider();

    const runner = new SnsScheduleRunner({
      scheduleStore,
      activityStore,
      snsProvider,
      maxActionsPerPoll: 2,
      actionSpacingMs: 250,
      sleep,
      setTimeoutFn: noopSetTimeout,
      clearTimeoutFn: noopClearTimeout,
    });
    runner.start();
    await runner.close();

    expect(scheduleStore.claimPendingActions).toHaveBeenCalledWith(expect.any(Date), 2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(250);
    expect(snsProvider.like).toHaveBeenCalledWith('post-10');
    expect(snsProvider.repost).toHaveBeenCalledWith('post-11');
  });

  it('requeues ambiguous scheduled post failures on a later poll without restarting', async () => {
    let now = new Date('2025-01-01T00:00:00.000Z');
    let timerCallback: (() => void) | undefined;
    let queuedAgain = false;
    const scheduleStore = createScheduleStore({
      recoverStaleExecuting: vi.fn(async (before?: Date) => {
        if (before != null && before.getTime() >= new Date('2025-01-01T00:01:00.000Z').getTime()) {
          queuedAgain = true;
          return 1;
        }
        return 0;
      }),
      claimPendingActions: vi.fn(async () => {
        if (!queuedAgain) {
          queuedAgain = true;
          return [createPostAction({ id: 12 })];
        }
        if (queuedAgain) {
          queuedAgain = false;
          return [createPostAction({ id: 12 })];
        }
        return [];
      }),
    });
    const activityStore = createActivityStore();
    const snsProvider = createProvider({
      post: vi
        .fn()
        .mockRejectedValueOnce(new Error('api timeout'))
        .mockResolvedValueOnce(createPost('post-12')),
    });

    const runner = new SnsScheduleRunner({
      scheduleStore,
      activityStore,
      snsProvider,
      now: () => now,
      pollIntervalMs: 5,
      executingRecoveryDelayMs: 60_000,
      setTimeoutFn: (((callback: () => void) => {
        timerCallback = callback;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout),
      clearTimeoutFn: noopClearTimeout,
    });
    runner.start();
    for (let i = 0; i < 5 && timerCallback == null; i += 1) {
      await flushPromises();
    }

    now = new Date('2025-01-01T00:02:00.000Z');
    const scheduledCallback = timerCallback;
    expect(scheduledCallback).toBeTypeOf('function');
    scheduledCallback?.();
    await flushPromises();
    await flushPromises();
    await runner.close();

    expect(scheduleStore.recoverStaleExecuting).toHaveBeenCalledWith(new Date('2025-01-01T00:01:00.000Z'));
    expect(snsProvider.post).toHaveBeenCalledTimes(2);
    expect(scheduleStore.completeWithRecord).toHaveBeenCalledWith(12, expect.objectContaining({
      type: 'post',
      postId: 'post-12',
    }));
  });

  it('executes scheduled repost actions successfully', async () => {
    const executedAt = new Date('2025-01-02T00:00:00.000Z');
    const scheduleStore = createScheduleStore({
      claimPendingActions: vi.fn(async () => [createRepostAction({ id: 20, params: { postId: 'post-20' } })]),
    });
    const activityStore = createActivityStore();
    const snsProvider = createProvider({
      repost: vi.fn(async () => createPost('post-20')),
    });

    const runner = new SnsScheduleRunner({
      scheduleStore,
      activityStore,
      snsProvider,
      now: () => executedAt,
      setTimeoutFn: noopSetTimeout,
      clearTimeoutFn: noopClearTimeout,
    });
    runner.start();
    await runner.close();

    expect(snsProvider.repost).toHaveBeenCalledWith('post-20');
    expect(scheduleStore.completeWithRecord).toHaveBeenCalledWith(20, expect.objectContaining({
      type: 'repost',
      postId: 'post-20',
      createdAt: executedAt,
    }));
  });

  it('reconciles remotely completed reposts only after recovery', async () => {
    const scheduleStore = createScheduleStore({
      claimPendingActions: vi.fn(async () => [createRepostAction({ id: 21, recoveredFromExecuting: true })]),
    });
    const activityStore = createActivityStore({
      hasReposted: vi.fn(async () => false),
    });
    const snsProvider = createProvider({
      getPost: vi.fn(async () => ({ ...createPost('post-1'), reposted: true })),
    });

    const runner = new SnsScheduleRunner({
      scheduleStore,
      activityStore,
      snsProvider,
      setTimeoutFn: noopSetTimeout,
      clearTimeoutFn: noopClearTimeout,
    });
    runner.start();
    await runner.close();

    expect(snsProvider.repost).not.toHaveBeenCalled();
    expect(scheduleStore.completeWithRecord).toHaveBeenCalledWith(21, expect.objectContaining({
      type: 'repost',
      postId: 'post-1',
    }));
  });

  it('expires ambiguous failures after MAX_RECOVERY_AGE_MS', async () => {
    const scheduledAt = new Date('2025-01-01T00:00:00.000Z');
    const now = new Date(scheduledAt.getTime() + 11 * 60 * 1_000);
    const scheduleStore = createScheduleStore({
      claimPendingActions: vi.fn(async () => [createPostAction({ id: 22, scheduledAt })]),
    });
    const activityStore = createActivityStore();
    const reportError = vi.fn();
    const snsProvider = createProvider({
      post: vi.fn(async () => { throw new Error('api timeout'); }),
    });

    const runner = new SnsScheduleRunner({
      scheduleStore,
      activityStore,
      snsProvider,
      reportError,
      now: () => now,
      setTimeoutFn: noopSetTimeout,
      clearTimeoutFn: noopClearTimeout,
    });
    runner.start();
    await runner.close();

    expect(scheduleStore.markFailed).toHaveBeenCalledWith(22, 'api timeout');
  });
});
