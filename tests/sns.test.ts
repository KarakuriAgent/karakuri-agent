import type { ToolExecutionOptions } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSnsTools } from '../src/agent/tools/sns.js';
import { MastodonProvider } from '../src/sns/mastodon.js';
import type { ISnsActivityStore } from '../src/sns/types.js';
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
  'sns_mastodon_post',
  'sns_mastodon_get_post',
  'sns_mastodon_like',
  'sns_mastodon_repost',
  'sns_mastodon_upload_media',
  'sns_mastodon_get_thread',
] as const;

function createPublicLookup(): LookupFn {
  return vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
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

  it('returns rate_limited from the deterministic gate without calling the provider (M8)', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const checkWrite = vi.fn(async (kind: string) => ({ allowed: false as const, message: `limited:${kind}`, retryAt: null }));
    const tools = createSnsTools({
      ...SNS_OPTIONS,
      fetch,
      rateLimiter: { checkWrite } as never,
    });

    await expect(tools.sns_post!.execute!({ text: 'hi' }, DEFAULT_OPTIONS))
      .resolves.toEqual({ status: 'rate_limited', message: 'limited:post' });
    await expect(tools.sns_post!.execute!({ text: 'hi', reply_to_id: 'p1' }, DEFAULT_OPTIONS))
      .resolves.toEqual({ status: 'rate_limited', message: 'limited:reply' });
    await expect(tools.sns_like!.execute!({ post_id: 'p1' }, DEFAULT_OPTIONS))
      .resolves.toEqual({ status: 'rate_limited', message: 'limited:like' });
    await expect(tools.sns_repost!.execute!({ post_id: 'p1' }, DEFAULT_OPTIONS))
      .resolves.toEqual({ status: 'rate_limited', message: 'limited:repost' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('serializes the rate-limit gate across parallel write calls (M8 review fix)', async () => {
    // 残枠 1 の like を 2 件同時に実行しても 1 件しか通らないこと（check-then-act の原子化）
    const likedAt: string[] = [];
    const activityStore: ISnsActivityStore = {
      recordPost: vi.fn(async () => {}),
      recordLike: vi.fn(async () => {
        likedAt.push(new Date().toISOString());
      }),
      recordRepost: vi.fn(async () => {}),
      hasLiked: vi.fn(async () => false),
      hasReposted: vi.fn(async () => false),
      hasReplied: vi.fn(async () => false),
      hasQuoted: vi.fn(async () => false),
      getRecentActivities: vi.fn(async () => []),
      getLastNotificationId: vi.fn(async () => null),
      setLastNotificationId: vi.fn(async () => {}),
      countWriteActionsSince: vi.fn(async () => ({ count: likedAt.length, earliestAt: likedAt[0] ?? null })),
      getLastWriteActionAt: vi.fn(async () => likedAt.at(-1) ?? null),
      close: vi.fn(async () => {}),
    };
    const { SnsRateLimiter } = await import('../src/sns/rate-limiter.js');
    const rateLimiter = new SnsRateLimiter({
      limits: { postPerHour: 5, postPerDay: 5, postMinIntervalMinutes: 0, replyPerHour: 5, likePerHour: 1, repostPerHour: 5 },
      fetchIntervals: { notificationsMinutes: 0, timelineMinutes: 0, trendsMinutes: 0 },
      counter: activityStore as never,
      timezone: 'Asia/Tokyo',
    });
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(JSON.stringify(createStatus()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const tools = createSnsTools({ ...SNS_OPTIONS, fetch, activityStore, rateLimiter });

    const [first, second] = await Promise.all([
      tools.sns_like!.execute!({ post_id: 'post-a' }, DEFAULT_OPTIONS),
      tools.sns_like!.execute!({ post_id: 'post-b' }, DEFAULT_OPTIONS),
    ]);

    const results = [first, second] as Array<Record<string, unknown>>;
    const limited = results.filter((result) => result.status === 'rate_limited');
    expect(limited).toHaveLength(1);
    expect(likedAt).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
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
    const reportError = vi.fn();
    const tools = createSnsTools({
      ...SNS_OPTIONS,
      fetch,
      activityStore,
      userStore: userStore as never,
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
  });

  it('does not register the bot from its own newly created post', async () => {
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
    const tools = createSnsTools({
      ...SNS_OPTIONS,
      fetch,
      activityStore,
      userStore: userStore as never,
    });

    await expect(tools.sns_post!.execute!({ text: 'hello' }, DEFAULT_OPTIONS)).resolves.toEqual(
      expect.objectContaining({ id: 'post-self' }),
    );

    expect(userStore.ensureUser).not.toHaveBeenCalled();
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


  it.each(['unlisted', 'private', 'direct'] as const)('rejects non-public X posts before they are published (%s)', async (visibility) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const tools = createSnsTools({
      sns: {
        provider: 'x',
        accessToken: 'x-token',
      },
      fetch,
    });

    await expect(tools.sns_post!.execute!({
      text: 'Hello later',
      visibility,
    }, DEFAULT_OPTIONS)).resolves.toEqual({
      error: 'X only supports public visibility',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['unlisted', 'private', 'direct'] as const)('rejects non-public ELYTH posts before they are published (%s)', async (visibility) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const tools = createSnsTools({
      sns: {
        provider: 'elyth',
        apiKey: 'elyth-key',
        apiBase: 'https://elythworld.com',
      },
      fetch,
    });

    await expect(tools.sns_post!.execute!({
      text: 'Hello later',
      visibility,
    }, DEFAULT_OPTIONS)).resolves.toEqual({
      error: 'ELYTH only supports public visibility',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects unsupported ELYTH media and quote at the tool boundary', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const tools = createSnsTools({
      sns: {
        provider: 'elyth',
        apiKey: 'elyth-key',
        apiBase: 'https://elythworld.com',
      },
      fetch,
    });

    await expect(tools.sns_post!.execute!({
      text: 'Hello media',
      media_ids: ['media-1'],
      visibility: 'public',
    }, DEFAULT_OPTIONS)).resolves.toEqual({
      error: 'ELYTH does not support media uploads',
    });
    await expect(tools.sns_post!.execute!({
      text: 'Hello quote',
      quote_post_id: 'quoted',
      visibility: 'public',
    }, DEFAULT_OPTIONS)).resolves.toEqual({
      error: 'ELYTH does not support quote posts',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects post text exceeding 140 characters', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const tools = createSnsTools({ ...SNS_OPTIONS, fetch });

    const longText = 'あ'.repeat(141);
    const result = await tools.sns_post!.execute!({
      text: longText,
      visibility: 'public',
    }, DEFAULT_OPTIONS) as { error?: string };
    expect(result.error).toBeDefined();
  });

  it('accepts post text at exactly 140 characters', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(JSON.stringify(createStatus()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const tools = createSnsTools({ ...SNS_OPTIONS, fetch });

    const exactText = 'あ'.repeat(140);
    const result = await tools.sns_post!.execute!({
      text: exactText,
      visibility: 'public',
    }, DEFAULT_OPTIONS) as { error?: string };
    expect(result.error).toBeUndefined();
    expect(fetch).toHaveBeenCalled();
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
