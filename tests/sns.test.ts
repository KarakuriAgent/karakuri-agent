import type { ToolExecutionOptions } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSnsTools } from '../src/agent/tools/sns.js';
import { MastodonProvider } from '../src/sns/mastodon.js';
import type { ISnsActivityStore, ISnsScheduleStore, ScheduledAction } from '../src/sns/types.js';
import type { LookupFn } from '../src/utils/safe-fetch.js';

const DEFAULT_OPTIONS: ToolExecutionOptions = {
  toolCallId: 'tool-1',
  messages: [],
};

const SNS_CREDS = {
  provider: 'mastodon' as const,
  instanceUrl: 'https://social.example',
  accessToken: 'secret-token',
};

const SNS_OPTIONS = { sns: SNS_CREDS };

const EXPECTED_TOOL_NAMES = [
  'sns_post',
  'sns_get_post',
  'sns_like',
  'sns_repost',
  'sns_upload_media',
  'sns_get_thread',
] as const;

function createPublicLookup(): LookupFn {
  return vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function waitFor(predicate: () => boolean, attempts = 50): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  throw new Error('Condition not met in time');
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

function createStatus(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'status-1',
    content: '<p>Hello<br>world &amp; friends</p>',
    account: {
      id: 'acct-1',
      display_name: 'Alice',
      username: 'alice',
      acct: 'alice@example.com',
      url: 'https://social.example/@alice',
    },
    created_at: '2025-01-01T00:00:00.000Z',
    url: 'https://social.example/@alice/status-1',
    visibility: 'public',
    in_reply_to_id: null,
    reblogs_count: 2,
    favourites_count: 3,
    replies_count: 4,
    media_attachments: [{ url: 'https://cdn.example/media-1.png' }],
    ...overrides,
  };
}

describe('sns tools', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exports only the six supported SNS tools', () => {
    const tools = createSnsTools({ ...SNS_OPTIONS, fetch: vi.fn() });
    expect(Object.keys(tools)).toEqual(EXPECTED_TOOL_NAMES);
  });

  it('posts statuses with reply, quote, media, and visibility parameters', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(JSON.stringify(createStatus()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const tools = createSnsTools({ ...SNS_OPTIONS, fetch });

    const result = await tools.sns_post!.execute!({
      text: 'Hello SNS',
      reply_to_id: 'reply-1',
      quote_post_id: 'quote-1',
      media_ids: ['media-1'],
      visibility: 'unlisted',
    }, DEFAULT_OPTIONS);

    expect(fetch).toHaveBeenCalledWith(
      'https://social.example/api/v1/statuses',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          status: 'Hello SNS',
          in_reply_to_id: 'reply-1',
          quoted_status_id: 'quote-1',
          media_ids: ['media-1'],
          visibility: 'unlisted',
        }),
      }),
    );
    expect(result).toEqual(expect.objectContaining({ id: 'status-1', text: 'Hello\nworld & friends' }));
  });

  it('skips duplicate likes and reposts before calling the provider', async () => {
    const activityStore: ISnsActivityStore = {
      recordPost: vi.fn(async () => {}),
      recordLike: vi.fn(async () => {}),
      recordRepost: vi.fn(async () => {}),
      hasLiked: vi.fn(async () => true),
      hasReposted: vi.fn(async () => true),
      hasReplied: vi.fn(async () => false),
      hasQuoted: vi.fn(async () => false),
      getRecentActivities: vi.fn(async () => []),
      getLastNotificationId: vi.fn(async () => null),
      setLastNotificationId: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const fetch = vi.fn<typeof globalThis.fetch>();
    const tools = createSnsTools({ ...SNS_OPTIONS, fetch, activityStore });

    await expect(tools.sns_like!.execute!({ post_id: 'post-1' }, DEFAULT_OPTIONS)).resolves.toEqual({
      status: 'skipped',
      reason: 'already_liked',
      post_id: 'post-1',
    });
    await expect(tools.sns_repost!.execute!({ post_id: 'post-1' }, DEFAULT_OPTIONS)).resolves.toEqual({
      status: 'skipped',
      reason: 'already_reposted',
      post_id: 'post-1',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('skips duplicate replies and quotes before posting', async () => {
    const activityStore: ISnsActivityStore = {
      recordPost: vi.fn(async () => {}),
      recordLike: vi.fn(async () => {}),
      recordRepost: vi.fn(async () => {}),
      hasLiked: vi.fn(async () => false),
      hasReposted: vi.fn(async () => false),
      hasReplied: vi.fn(async () => true),
      hasQuoted: vi.fn(async () => true),
      getRecentActivities: vi.fn(async () => []),
      getLastNotificationId: vi.fn(async () => null),
      setLastNotificationId: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const fetch = vi.fn<typeof globalThis.fetch>();
    const tools = createSnsTools({ ...SNS_OPTIONS, fetch, activityStore });

    await expect(tools.sns_post!.execute!({ text: 'reply', reply_to_id: 'root-1' }, DEFAULT_OPTIONS)).resolves.toEqual({
      status: 'skipped',
      reason: 'already_replied',
      reply_to_id: 'root-1',
    });
    await expect(tools.sns_post!.execute!({ text: 'quote', quote_post_id: 'root-2' }, DEFAULT_OPTIONS)).resolves.toEqual({
      status: 'skipped',
      reason: 'already_quoted',
      quote_post_id: 'root-2',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed when duplicate checks cannot be verified', async () => {
    const activityStore: ISnsActivityStore = {
      recordPost: vi.fn(async () => {}),
      recordLike: vi.fn(async () => {}),
      recordRepost: vi.fn(async () => {}),
      hasLiked: vi.fn(async () => { throw new Error('db failed'); }),
      hasReposted: vi.fn(async () => { throw new Error('db failed'); }),
      hasReplied: vi.fn(async () => { throw new Error('db failed'); }),
      hasQuoted: vi.fn(async () => { throw new Error('db failed'); }),
      getRecentActivities: vi.fn(async () => []),
      getLastNotificationId: vi.fn(async () => null),
      setLastNotificationId: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const fetch = vi.fn<typeof globalThis.fetch>();
    const tools = createSnsTools({ ...SNS_OPTIONS, fetch, activityStore });

    await expect(tools.sns_like!.execute!({ post_id: 'post-1' }, DEFAULT_OPTIONS)).resolves.toEqual({
      error: 'Failed to verify duplicate protection for hasLiked: db failed',
    });
    await expect(tools.sns_repost!.execute!({ post_id: 'post-1' }, DEFAULT_OPTIONS)).resolves.toEqual({
      error: 'Failed to verify duplicate protection for hasReposted: db failed',
    });
    await expect(tools.sns_post!.execute!({ text: 'reply', reply_to_id: 'post-1' }, DEFAULT_OPTIONS)).resolves.toEqual({
      error: 'Failed to verify duplicate protection for hasReplied: db failed',
    });
    await expect(tools.sns_post!.execute!({ text: 'quote', quote_post_id: 'post-1' }, DEFAULT_OPTIONS)).resolves.toEqual({
      error: 'Failed to verify duplicate protection for hasQuoted: db failed',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns _warning and reports when activity persistence fails', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(createStatus({ id: 'post-2' })), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(createStatus({ id: 'post-3' })), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(createStatus({ id: 'post-4' })), { status: 200 }));
    const activityStore: ISnsActivityStore = {
      recordPost: vi.fn(async () => { throw new Error('db failed'); }),
      recordLike: vi.fn(async () => { throw new Error('db failed'); }),
      recordRepost: vi.fn(async () => { throw new Error('db failed'); }),
      hasLiked: vi.fn(async () => false),
      hasReposted: vi.fn(async () => false),
      hasReplied: vi.fn(async () => false),
      hasQuoted: vi.fn(async () => false),
      getRecentActivities: vi.fn(async () => []),
      getLastNotificationId: vi.fn(async () => null),
      setLastNotificationId: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const userStore = { ensureUser: vi.fn(async () => ({ userId: 'sns:mastodon:acct-1' })) };
    const evaluateUser = vi.fn();
    const reportError = vi.fn();
    const tools = createSnsTools({
      ...SNS_OPTIONS,
      fetch,
      activityStore,
      userStore: userStore as never,
      evaluateUser,
      reportError,
    });

    const postResult = await tools.sns_post!.execute!({ text: 'hello' }, DEFAULT_OPTIONS);
    const likeResult = await tools.sns_like!.execute!({ post_id: 'post-2' }, DEFAULT_OPTIONS);
    const repostResult = await tools.sns_repost!.execute!({ post_id: 'post-3' }, DEFAULT_OPTIONS);

    expect(postResult).toEqual(expect.objectContaining({ id: 'post-2', _warning: expect.stringContaining('duplicate prevention') }));
    expect(likeResult).toEqual(expect.objectContaining({ id: 'post-3', _warning: expect.stringContaining('duplicate prevention') }));
    expect(repostResult).toEqual(expect.objectContaining({ id: 'post-4', _warning: expect.stringContaining('duplicate prevention') }));
    expect(reportError).toHaveBeenCalledTimes(3);
    expect(reportError).toHaveBeenCalledWith(expect.stringContaining('sns_post'));
    expect(reportError).toHaveBeenCalledWith(expect.stringContaining('sns_like'));
    expect(reportError).toHaveBeenCalledWith(expect.stringContaining('sns_repost'));
    expect(userStore.ensureUser).toHaveBeenCalled();
    expect(evaluateUser).toHaveBeenCalledTimes(1);
  });

  it('caps user evaluations at MAX_USER_EVALUATIONS_PER_TURN', async () => {
    const users = ['alice', 'bob', 'carol', 'dave'].map((name, i) => ({
      id: `acct-${i + 1}`,
      display_name: name,
      username: name,
      acct: `${name}@example.com`,
      url: `https://social.example/@${name}`,
    }));
    const fetch = vi.fn<typeof globalThis.fetch>();
    for (const [i, user] of users.entries()) {
      fetch.mockResolvedValueOnce(new Response(JSON.stringify(
        createStatus({ id: `post-${i + 1}`, account: user }),
      ), { status: 200 }));
    }
    const activityStore: ISnsActivityStore = {
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
    };
    const evaluateUser = vi.fn();
    const tools = createSnsTools({
      ...SNS_OPTIONS,
      fetch,
      activityStore,
      userStore: { ensureUser: vi.fn(async () => ({})) } as never,
      evaluateUser,
    });

    for (let i = 0; i < 4; i++) {
      await tools.sns_get_post!.execute!({ post_id: `post-${i + 1}` }, DEFAULT_OPTIONS);
    }

    // MAX_USER_EVALUATIONS_PER_TURN = 3, so the 4th user should be skipped
    expect(evaluateUser).toHaveBeenCalledTimes(3);
  });

  it('does not register or evaluate the bot from its own newly created post', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(createStatus({ id: 'post-self' })), { status: 200 }));
    const activityStore: ISnsActivityStore = {
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
    };
    const userStore = { ensureUser: vi.fn(async () => ({ userId: 'sns:mastodon:acct-1' })) };
    const evaluateUser = vi.fn();
    const tools = createSnsTools({
      ...SNS_OPTIONS,
      fetch,
      activityStore,
      userStore: userStore as never,
      evaluateUser,
    });

    await expect(tools.sns_post!.execute!({ text: 'hello' }, DEFAULT_OPTIONS)).resolves.toEqual(
      expect.objectContaining({ id: 'post-self' }),
    );

    expect(userStore.ensureUser).not.toHaveBeenCalled();
    expect(evaluateUser).not.toHaveBeenCalled();
  });

  it('serializes duplicate-protected SNS actions across concurrent executions', async () => {
    const likedPosts = new Set<string>();
    const activityStore: ISnsActivityStore = {
      recordPost: vi.fn(async () => {}),
      recordLike: vi.fn(async (postId: string) => {
        likedPosts.add(postId);
      }),
      recordRepost: vi.fn(async () => {}),
      hasLiked: vi.fn(async (postId: string) => likedPosts.has(postId)),
      hasReposted: vi.fn(async () => false),
      hasReplied: vi.fn(async () => false),
      hasQuoted: vi.fn(async () => false),
      getRecentActivities: vi.fn(async () => []),
      getLastNotificationId: vi.fn(async () => null),
      setLastNotificationId: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    let resolveLike!: () => void;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      await new Promise<void>((resolve) => {
        resolveLike = resolve;
      });
      return new Response(JSON.stringify(createStatus({ id: 'post-2' })), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const tools = createSnsTools({ ...SNS_OPTIONS, fetch, activityStore });

    const first = tools.sns_like!.execute!({ post_id: 'post-1' }, DEFAULT_OPTIONS);
    const second = tools.sns_like!.execute!({ post_id: 'post-1' }, DEFAULT_OPTIONS);
    await waitFor(() => fetch.mock.calls.length === 1);
    expect(fetch).toHaveBeenCalledTimes(1);

    resolveLike();
    await expect(first).resolves.toEqual(expect.objectContaining({ id: 'post-2' }));
    await expect(second).resolves.toEqual({
      status: 'skipped',
      reason: 'already_liked',
      post_id: 'post-1',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('shares duplicate-protection locks across separate SNS tool instances', async () => {
    const likedPosts = new Set<string>();
    const activityStore: ISnsActivityStore = {
      recordPost: vi.fn(async () => {}),
      recordLike: vi.fn(async (postId: string) => {
        likedPosts.add(postId);
      }),
      recordRepost: vi.fn(async () => {}),
      hasLiked: vi.fn(async (postId: string) => likedPosts.has(postId)),
      hasReposted: vi.fn(async () => false),
      hasReplied: vi.fn(async () => false),
      hasQuoted: vi.fn(async () => false),
      getRecentActivities: vi.fn(async () => []),
      getLastNotificationId: vi.fn(async () => null),
      setLastNotificationId: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    let resolveLike!: () => void;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      await new Promise<void>((resolve) => {
        resolveLike = resolve;
      });
      return new Response(JSON.stringify(createStatus({ id: 'post-3' })), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const firstTools = createSnsTools({ ...SNS_OPTIONS, fetch, activityStore });
    const secondTools = createSnsTools({ ...SNS_OPTIONS, fetch, activityStore });

    const first = firstTools.sns_like!.execute!({ post_id: 'post-2' }, DEFAULT_OPTIONS);
    const second = secondTools.sns_like!.execute!({ post_id: 'post-2' }, DEFAULT_OPTIONS);
    await waitFor(() => fetch.mock.calls.length === 1);
    expect(fetch).toHaveBeenCalledTimes(1);

    resolveLike();
    await expect(first).resolves.toEqual(expect.objectContaining({ id: 'post-3' }));
    await expect(second).resolves.toEqual({
      status: 'skipped',
      reason: 'already_liked',
      post_id: 'post-2',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('gets a post and thread context', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(createStatus({ id: 'post-1' })), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ancestors: [createStatus({ id: 'ancestor-1' })],
        descendants: [createStatus({ id: 'descendant-1' })],
      }), { status: 200 }));
    const tools = createSnsTools({ ...SNS_OPTIONS, fetch });

    await expect(tools.sns_get_post!.execute!({ post_id: 'post-1' }, DEFAULT_OPTIONS)).resolves.toEqual(expect.objectContaining({ id: 'post-1' }));
    await expect(tools.sns_get_thread!.execute!({ post_id: 'thread-1' }, DEFAULT_OPTIONS)).resolves.toEqual({
      ancestors: [expect.objectContaining({ id: 'ancestor-1' })],
      descendants: [expect.objectContaining({ id: 'descendant-1' })],
    });
  });


  it('schedules SNS actions when scheduled_at is provided', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const activityStore: ISnsActivityStore = {
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
    };
    const scheduleStore = createScheduleStore();
    const tools = createSnsTools({
      ...SNS_OPTIONS,
      fetch,
      activityStore,
      scheduleStore,
      now: () => new Date('2025-01-01T00:00:00.000Z'),
    });

    await expect(tools.sns_post!.execute!({
      text: 'Hello later',
      scheduled_at: '2025-01-01T01:00:00.000Z',
      visibility: 'public',
    }, DEFAULT_OPTIONS)).resolves.toEqual({
      status: 'scheduled',
      scheduled_at: '2025-01-01T01:00:00.000Z',
    });
    expect(scheduleStore.schedule).toHaveBeenCalledWith({
      actionType: 'post',
      scheduledAt: new Date('2025-01-01T01:00:00.000Z'),
      params: { text: 'Hello later', visibility: 'public' },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects scheduled_at values without an explicit timezone', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const scheduleStore = createScheduleStore();
    const tools = createSnsTools({
      ...SNS_OPTIONS,
      fetch,
      scheduleStore,
      now: () => new Date('2025-01-01T00:00:00.000Z'),
    });

    await expect(tools.sns_post!.execute!({
      text: 'Hello later',
      scheduled_at: '2025-01-01T01:00:00',
      visibility: 'public',
    }, DEFAULT_OPTIONS)).resolves.toEqual({
      error: 'scheduled_at must be a valid datetime string with an explicit timezone offset (for example, Z or +09:00)',
    });
    expect(scheduleStore.schedule).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects scheduling non-public X posts before they are queued', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const scheduleStore = createScheduleStore();
    const tools = createSnsTools({
      sns: {
        provider: 'x',
        accessToken: 'x-token',
      },
      fetch,
      scheduleStore,
      now: () => new Date('2025-01-01T00:00:00.000Z'),
    });

    await expect(tools.sns_post!.execute!({
      text: 'Hello later',
      scheduled_at: '2025-01-01T01:00:00.000Z',
      visibility: 'direct',
    }, DEFAULT_OPTIONS)).resolves.toEqual({
      error: 'X only supports public visibility',
    });
    expect(scheduleStore.schedule).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects scheduled_at values in the past', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const scheduleStore = createScheduleStore();
    const tools = createSnsTools({
      ...SNS_OPTIONS,
      fetch,
      scheduleStore,
      now: () => new Date('2025-01-01T03:00:00.000Z'),
    });

    await expect(tools.sns_like!.execute!({
      post_id: 'post-1',
      scheduled_at: '2025-01-01T02:59:59.000Z',
    }, DEFAULT_OPTIONS)).resolves.toEqual({
      error: 'scheduled_at must be in the future',
    });
    expect(scheduleStore.schedule).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('skips scheduling duplicates that already exist in the schedule queue', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const activityStore: ISnsActivityStore = {
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
    };
    const scheduledActions: ScheduledAction[] = [{
      id: 5,
      actionType: 'like',
      scheduledAt: new Date('2025-01-01T01:00:00.000Z'),
      params: { postId: 'post-1' },
      status: 'pending',
      createdAt: '2025-01-01T00:00:00.000Z',
    }, {
      id: 6,
      actionType: 'post',
      scheduledAt: new Date('2025-01-01T01:30:00.000Z'),
      params: { text: 'reply', replyToId: 'root-1', visibility: 'public' },
      status: 'executing',
      createdAt: '2025-01-01T00:10:00.000Z',
    }];
    const scheduleStore = createScheduleStore({
      getPendingAndExecuting: vi.fn(async () => scheduledActions),
    });
    const tools = createSnsTools({
      ...SNS_OPTIONS,
      fetch,
      activityStore,
      scheduleStore,
      now: () => new Date('2025-01-01T00:00:00.000Z'),
    });

    await expect(tools.sns_like!.execute!({
      post_id: 'post-1',
      scheduled_at: '2025-01-01T02:00:00.000Z',
    }, DEFAULT_OPTIONS)).resolves.toEqual({
      status: 'skipped',
      reason: 'like_already_scheduled',
      post_id: 'post-1',
    });
    await expect(tools.sns_post!.execute!({
      text: 'duplicate reply',
      reply_to_id: 'root-1',
      scheduled_at: '2025-01-01T02:05:00.000Z',
      visibility: 'public',
    }, DEFAULT_OPTIONS)).resolves.toEqual({
      status: 'skipped',
      reason: 'reply_already_scheduled',
      reply_to_id: 'root-1',
    });
    expect(scheduleStore.schedule).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('skips immediate replies when an equivalent scheduled reply is already pending recovery', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const activityStore: ISnsActivityStore = {
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
    };
    const queuedReplies: ScheduledAction[] = [{
      id: 7,
      actionType: 'post',
      scheduledAt: new Date('2025-01-01T02:10:00.000Z'),
      params: { text: 'queued reply', replyToId: 'root-2', visibility: 'public' },
      status: 'executing',
      createdAt: '2025-01-01T02:00:00.000Z',
    }];
    const scheduleStore = createScheduleStore({
      getPendingAndExecuting: vi.fn(async () => queuedReplies),
    });
    const tools = createSnsTools({ ...SNS_OPTIONS, fetch, activityStore, scheduleStore });

    await expect(tools.sns_post!.execute!({
      text: 'reply now',
      reply_to_id: 'root-2',
      visibility: 'public',
    }, DEFAULT_OPTIONS)).resolves.toEqual({
      status: 'skipped',
      reason: 'reply_already_scheduled',
      reply_to_id: 'root-2',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('uploads media from a URL with multipart form data', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('image-bytes', {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'media-123', url: 'https://social.example/media/media-123.png' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const tools = createSnsTools({ ...SNS_OPTIONS, fetch, lookupFn: createPublicLookup() });

    await expect(tools.sns_upload_media!.execute!({ url: 'https://cdn.example/path/image.png', alt_text: 'A sample image' }, DEFAULT_OPTIONS)).resolves.toEqual({ mediaId: 'media-123' });
    const secondCallBody = fetch.mock.calls[1]?.[1]?.body;
    expect(secondCallBody).toBeInstanceOf(FormData);
  });
});

describe('MastodonProvider', () => {
  it('maps liked/reposted fields and supports notification since_id', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(createStatus({ favourited: true, reblogged: false })), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } }));
    const provider = new MastodonProvider({ ...SNS_CREDS, fetch });

    await expect(provider.getPost('post-1')).resolves.toEqual(expect.objectContaining({ liked: true, reposted: false }));
    await provider.getNotifications({ sinceId: 'notif-1', maxId: 'notif-9', limit: 5 });
    expect(fetch.mock.calls[1]?.[0]).toBe('https://social.example/api/v1/notifications?limit=5&since_id=notif-1&max_id=notif-9');
  });

  it('passes the idempotency key when creating posts', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(createStatus({ id: 'post-1' })), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const provider = new MastodonProvider({ ...SNS_CREDS, fetch });

    await expect(provider.post({
      text: 'Hello',
      visibility: 'public',
      idempotencyKey: 'sns-scheduled-post:42',
    })).resolves.toEqual(expect.objectContaining({ id: 'post-1' }));

    expect(fetch.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({
        'Content-Type': 'application/json',
        'Idempotency-Key': 'sns-scheduled-post:42',
      }),
    }));
  });
});
