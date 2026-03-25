import type { ToolExecutionOptions } from 'ai';
import type { ZodType } from 'zod';
import { describe, expect, it, vi } from 'vitest';

import { createSnsTools } from '../src/agent/tools/sns.js';
import { stripHtml } from '../src/sns/mastodon.js';
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

function createPublicLookup(): LookupFn {
  return vi.fn(async () => [
    { address: '93.184.216.34', family: 4 },
  ]);
}

const EXPECTED_TOOL_NAMES = [
  'sns_post',
  'sns_get_post',
  'sns_get_timeline',
  'sns_search',
  'sns_like',
  'sns_repost',
  'sns_get_notifications',
  'sns_upload_media',
  'sns_get_thread',
  'sns_get_user_posts',
  'sns_get_trends',
] as const;

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

function createReblogStatus(overrides: Partial<Record<string, unknown>> = {}) {
  return createStatus({
    id: 'boost-wrapper-1',
    content: '<p>Booster commentary</p>',
    account: {
      id: 'acct-booster',
      display_name: 'Booster',
      username: 'booster',
      acct: 'booster@example.com',
      url: 'https://social.example/@booster',
    },
    url: 'https://social.example/@booster/boost-wrapper-1',
    reblog: createStatus({
      id: 'boosted-post-1',
      content: '<p>Original boost content</p>',
      account: {
        id: 'acct-original',
        display_name: 'Original Author',
        username: 'original',
        acct: 'original@example.com',
        url: 'https://social.example/@original',
      },
      created_at: '2025-01-03T00:00:00.000Z',
      url: 'https://social.example/@original/boosted-post-1',
      reblogs_count: 9,
      favourites_count: 10,
      replies_count: 11,
      media_attachments: [{ url: 'https://cdn.example/original-media.png' }],
    }),
    ...overrides,
  });
}

describe('sns tools', () => {
  it('exports all 11 SNS tools', () => {
    const tools = createSnsTools({
      ...SNS_CREDS,
      fetch: vi.fn(),
    });

    expect(Object.keys(tools)).toEqual(EXPECTED_TOOL_NAMES);
  });

  it('accepts only http and https media URLs', () => {
    const tools = createSnsTools({
      ...SNS_CREDS,
      fetch: vi.fn(),
    });
    const schema = tools.sns_upload_media!.inputSchema as ZodType;

    expect(schema.safeParse({ url: 'file:///etc/passwd' }).success).toBe(false);
    expect(schema.safeParse({ url: 'ftp://cdn.example/file.png' }).success).toBe(false);
    expect(schema.safeParse({ url: 'https://cdn.example/file.png' }).success).toBe(true);
  });

  it('posts statuses with reply, quote, media, and visibility parameters', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(JSON.stringify(createStatus()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const tools = createSnsTools({ ...SNS_CREDS, fetch });

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
        headers: expect.objectContaining({
          Accept: 'application/json',
          Authorization: 'Bearer secret-token',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          status: 'Hello SNS',
          in_reply_to_id: 'reply-1',
          quoted_status_id: 'quote-1',
          media_ids: ['media-1'],
          visibility: 'unlisted',
        }),
      }),
    );
    expect(result).toEqual({
      id: 'status-1',
      text: 'Hello\nworld & friends',
      authorId: 'acct-1',
      authorName: 'Alice',
      authorHandle: 'alice@example.com',
      createdAt: '2025-01-01T00:00:00.000Z',
      url: 'https://social.example/@alice/status-1',
      visibility: 'public',
      repostCount: 2,
      likeCount: 3,
      replyCount: 4,
      mediaUrls: ['https://cdn.example/media-1.png'],
    });
  });

  it('gets timeline entries through the home timeline endpoint', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(JSON.stringify([
        createReblogStatus(),
      ]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const tools = createSnsTools({ ...SNS_CREDS, fetch });

    const result = await tools.sns_get_timeline!.execute!({
      limit: 7,
      since_id: 'since-1',
      max_id: 'max-1',
    }, DEFAULT_OPTIONS);

    expect(fetch).toHaveBeenCalledWith(
      'https://social.example/api/v1/timelines/home?limit=7&since_id=since-1&max_id=max-1',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Accept: 'application/json',
          Authorization: 'Bearer secret-token',
        }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result).toEqual([{
      id: 'boosted-post-1',
      timelineEntryId: 'boost-wrapper-1',
      text: 'Original boost content',
      authorId: 'acct-original',
      authorName: 'Original Author',
      authorHandle: 'original@example.com',
      createdAt: '2025-01-03T00:00:00.000Z',
      url: 'https://social.example/@original/boosted-post-1',
      visibility: 'public',
      repostCount: 9,
      likeCount: 10,
      replyCount: 11,
      mediaUrls: ['https://cdn.example/original-media.png'],
    }]);
  });

  it('searches statuses and users with Mastodon search type mapping', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        statuses: [createStatus({ id: 'status-2' })],
        accounts: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        statuses: [],
        accounts: [{
          id: 'acct-2',
          display_name: 'Bob',
          username: 'bob',
          acct: 'bob@example.com',
          url: 'https://social.example/@bob',
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const tools = createSnsTools({ ...SNS_CREDS, fetch });

    const posts = await tools.sns_search!.execute!({
      query: 'hello',
      type: 'posts',
      limit: 3,
    }, DEFAULT_OPTIONS);
    const users = await tools.sns_search!.execute!({
      query: 'bob',
      type: 'users',
      limit: 2,
    }, DEFAULT_OPTIONS);

    expect(fetch.mock.calls[0]?.[0]).toBe('https://social.example/api/v2/search?q=hello&type=statuses&resolve=true&limit=3');
    expect(fetch.mock.calls[1]?.[0]).toBe('https://social.example/api/v2/search?q=bob&type=accounts&resolve=true&limit=2');
    expect(posts).toEqual({
      posts: [expect.objectContaining({ id: 'status-2' })],
      users: [],
    });
    expect(users).toEqual({
      posts: [],
      users: [{
        id: 'acct-2',
        name: 'Bob',
        handle: 'bob@example.com',
        url: 'https://social.example/@bob',
      }],
    });
  });

  it('likes, reposts, fetches a post, and gets thread context', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(createStatus({ id: 'post-1' })), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(createStatus({ id: 'post-2' })), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(createStatus({ id: 'post-3' })), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ancestors: [createStatus({ id: 'ancestor-1' })],
        descendants: [createStatus({ id: 'descendant-1' })],
      }), { status: 200 }));
    const tools = createSnsTools({ ...SNS_CREDS, fetch });

    const getPostResult = await tools.sns_get_post!.execute!({ post_id: 'post-1' }, DEFAULT_OPTIONS);
    const likeResult = await tools.sns_like!.execute!({ post_id: 'post-2' }, DEFAULT_OPTIONS);
    const repostResult = await tools.sns_repost!.execute!({ post_id: 'post-3' }, DEFAULT_OPTIONS);
    const threadResult = await tools.sns_get_thread!.execute!({ post_id: 'thread-1' }, DEFAULT_OPTIONS);

    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      'https://social.example/api/v1/statuses/post-1',
      'https://social.example/api/v1/statuses/post-2/favourite',
      'https://social.example/api/v1/statuses/post-3/reblog',
      'https://social.example/api/v1/statuses/thread-1/context',
    ]);
    expect(getPostResult).toEqual(expect.objectContaining({ id: 'post-1' }));
    expect(likeResult).toEqual(expect.objectContaining({ id: 'post-2' }));
    expect(repostResult).toEqual(expect.objectContaining({ id: 'post-3' }));
    expect(threadResult).toEqual({
      ancestors: [expect.objectContaining({ id: 'ancestor-1' })],
      descendants: [expect.objectContaining({ id: 'descendant-1' })],
    });
  });

  it('maps notifications, resolves user posts, and fetches trends', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify([
        {
          id: 'notif-1',
          type: 'favourite',
          created_at: '2025-01-02T00:00:00.000Z',
          account: {
            id: 'acct-2',
            display_name: 'Bob',
            username: 'bob',
            acct: 'bob@example.com',
            url: 'https://social.example/@bob',
          },
          status: createStatus({ id: 'liked-1', in_reply_to_id: 'root-1' }),
        },
      ]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'acct-lookup',
        display_name: 'Carol',
        username: 'carol',
        acct: 'carol@example.com',
        url: 'https://social.example/@carol',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        createStatus({ id: 'user-post-1' }),
      ]), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        createReblogStatus({
          id: 'trend-wrapper-1',
          reblog: createStatus({ id: 'trend-1', content: '<p>Trend content</p>' }),
        }),
        createStatus({ id: 'trend-2' }),
      ]), { status: 200 }));
    const tools = createSnsTools({ ...SNS_CREDS, fetch });

    const notifications = await tools.sns_get_notifications!.execute!({
      limit: 4,
      types: ['like', 'reply'],
    }, DEFAULT_OPTIONS);
    const userPosts = await tools.sns_get_user_posts!.execute!({
      user_handle: 'carol@example.com',
      limit: 6,
      exclude_replies: true,
    }, DEFAULT_OPTIONS);
    const trends = await tools.sns_get_trends!.execute!({ limit: 1 }, DEFAULT_OPTIONS);

    expect(fetch.mock.calls[0]?.[0]).toBe(
      'https://social.example/api/v1/notifications?limit=20&types%5B%5D=favourite&types%5B%5D=mention',
    );
    expect(fetch.mock.calls[1]?.[0]).toBe(
      'https://social.example/api/v1/accounts/lookup?acct=carol%40example.com',
    );
    expect(fetch.mock.calls[2]?.[0]).toBe(
      'https://social.example/api/v1/accounts/acct-lookup/statuses?limit=6&exclude_replies=true',
    );
    expect(fetch.mock.calls[3]?.[0]).toBe(
      'https://social.example/api/v1/trends/statuses?limit=1',
    );
    expect(notifications).toEqual([{
      id: 'notif-1',
      type: 'like',
      createdAt: '2025-01-02T00:00:00.000Z',
      accountId: 'acct-2',
      accountName: 'Bob',
      accountHandle: 'bob@example.com',
      post: expect.objectContaining({ id: 'liked-1' }),
    }]);
    expect(userPosts).toEqual([expect.objectContaining({ id: 'user-post-1' })]);
    expect(trends).toEqual([expect.objectContaining({
      id: 'trend-1',
      timelineEntryId: 'trend-wrapper-1',
      text: 'Trend content',
      authorHandle: 'alice@example.com',
    })]);
  });

  it('filters reply and other notifications after Mastodon status mapping', async () => {
    const mentionReplyPayload = JSON.stringify([
      {
        id: 'notif-reply',
        type: 'mention',
        created_at: '2025-01-02T00:00:00.000Z',
        account: {
          id: 'acct-2',
          display_name: 'Bob',
          username: 'bob',
          acct: 'bob@example.com',
          url: 'https://social.example/@bob',
        },
        status: createStatus({
          id: 'reply-post',
          in_reply_to_id: 'root-1',
          in_reply_to_account_id: 'current-account',
        }),
      },
    ]);
    const mixedPayload = JSON.stringify([
      {
        id: 'notif-reply',
        type: 'mention',
        created_at: '2025-01-02T00:00:00.000Z',
        account: {
          id: 'acct-2',
          display_name: 'Bob',
          username: 'bob',
          acct: 'bob@example.com',
          url: 'https://social.example/@bob',
        },
        status: createStatus({
          id: 'reply-post',
          in_reply_to_id: 'root-1',
          in_reply_to_account_id: 'current-account',
        }),
      },
      {
        id: 'notif-other',
        type: 'status',
        created_at: '2025-01-03T00:00:00.000Z',
        account: {
          id: 'acct-3',
          display_name: 'Carol',
          username: 'carol',
          acct: 'carol@example.com',
          url: 'https://social.example/@carol',
        },
        status: createStatus({ id: 'other-post', in_reply_to_id: null }),
      },
    ]);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.endsWith('/api/v1/accounts/verify_credentials')) {
          return new Response(JSON.stringify({ id: 'current-account' }), { status: 200 });
        }
        return new Response(
          url.includes('types%5B%5D=mention') ? mentionReplyPayload : mixedPayload,
          { status: 200 },
        );
      });
    const tools = createSnsTools({ ...SNS_CREDS, fetch });

    const replyNotifications = await tools.sns_get_notifications!.execute!({
      limit: 5,
      types: ['reply'],
    }, DEFAULT_OPTIONS);
    const otherNotifications = await tools.sns_get_notifications!.execute!({
      limit: 5,
      types: ['other'],
    }, DEFAULT_OPTIONS);

    expect(fetch.mock.calls[0]?.[0]).toBe(
      'https://social.example/api/v1/notifications?limit=20&types%5B%5D=mention',
    );
    expect(fetch.mock.calls[1]?.[0]).toBe(
      'https://social.example/api/v1/accounts/verify_credentials',
    );
    expect(fetch.mock.calls[2]?.[0]).toBe(
      'https://social.example/api/v1/notifications?limit=20',
    );
    expect(replyNotifications).toEqual([
      expect.objectContaining({ id: 'notif-reply', type: 'reply' }),
    ]);
    expect(otherNotifications).toEqual([
      expect.objectContaining({ id: 'notif-other', type: 'other' }),
    ]);
  });

  it('bounds selective notification pagination when client-side filtering yields no matches', async () => {
    let requestCount = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      requestCount += 1;
      const offset = (requestCount - 1) * 20;
      return new Response(JSON.stringify(
        Array.from({ length: 20 }, (_, index) => ({
          id: `notif-${offset + index + 1}`,
          type: 'follow',
          created_at: '2025-01-02T00:00:00.000Z',
          account: {
            id: 'acct-2',
            display_name: 'Bob',
            username: 'bob',
            acct: 'bob@example.com',
            url: 'https://social.example/@bob',
          },
          status: createStatus({ id: `status-${offset + index + 1}` }),
        })),
      ), { status: 200 });
    });
    const tools = createSnsTools({ ...SNS_CREDS, fetch });

    const result = await tools.sns_get_notifications!.execute!({
      limit: 5,
      types: ['other'],
    }, DEFAULT_OPTIONS);

    expect(result).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(fetch.mock.calls[4]?.[0]).toBe(
      'https://social.example/api/v1/notifications?limit=20&max_id=notif-80',
    );
  });

  it('retries account verification after a transient reply-classification failure', async () => {
    const mentionReplyPayload = JSON.stringify([
      {
        id: 'notif-reply',
        type: 'mention',
        created_at: '2025-01-02T00:00:00.000Z',
        account: {
          id: 'acct-2',
          display_name: 'Bob',
          username: 'bob',
          acct: 'bob@example.com',
          url: 'https://social.example/@bob',
        },
        status: createStatus({
          id: 'reply-post',
          in_reply_to_id: 'root-1',
          in_reply_to_account_id: 'current-account',
        }),
      },
    ]);
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(mentionReplyPayload, { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'temporary failure' }), { status: 500 }))
      .mockResolvedValueOnce(new Response(mentionReplyPayload, { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'current-account' }), { status: 200 }));
    const tools = createSnsTools({ ...SNS_CREDS, fetch });

    const firstResult = await tools.sns_get_notifications!.execute!({
      limit: 5,
      types: ['reply'],
    }, DEFAULT_OPTIONS);
    const secondResult = await tools.sns_get_notifications!.execute!({
      limit: 5,
      types: ['reply'],
    }, DEFAULT_OPTIONS);

    expect(firstResult).toEqual({
      error: '[MastodonApiError] Mastodon API returned 500: temporary failure',
    });
    expect(secondResult).toEqual([
      expect.objectContaining({ id: 'notif-reply', type: 'reply' }),
    ]);
    expect(fetch.mock.calls[1]?.[0]).toBe('https://social.example/api/v1/accounts/verify_credentials');
    expect(fetch.mock.calls[3]?.[0]).toBe('https://social.example/api/v1/accounts/verify_credentials');
  });

  it('uploads media from a URL with multipart form data', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('image-bytes', {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'media-123',
        url: 'https://social.example/media/media-123.png',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const tools = createSnsTools({ ...SNS_CREDS, fetch, lookupFn: createPublicLookup() });

    const result = await tools.sns_upload_media!.execute!({
      url: 'https://cdn.example/path/image.png',
      alt_text: 'A sample image',
    }, DEFAULT_OPTIONS);

    expect(fetch.mock.calls[0]?.[0]).toBe('https://cdn.example/path/image.png');
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      headers: { Accept: '*/*' },
      redirect: 'manual',
    });
    expect(fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(fetch.mock.calls[0]?.[1]?.dispatcher).toBeDefined();
    expect(fetch.mock.calls[1]?.[0]).toBe('https://social.example/api/v2/media');
    expect(fetch.mock.calls[1]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    const secondCallBody = fetch.mock.calls[1]?.[1]?.body;
    expect(secondCallBody).toBeInstanceOf(FormData);
    expect((secondCallBody as FormData).get('description')).toBe('A sample image');
    expect((secondCallBody as FormData).get('file')).toBeInstanceOf(File);
    expect(result).toEqual({ mediaId: 'media-123' });
  });

  it('retries transient 404 responses while async media is becoming visible', async () => {
    const sleep = vi.fn(async () => {});
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('video-bytes', {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'media-404',
        url: null,
      }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: 'Record not found.',
      }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'media-404',
        url: 'https://social.example/media/media-404.mp4',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const tools = createSnsTools({
      ...SNS_CREDS,
      fetch,
      lookupFn: createPublicLookup(),
      sleep,
    });

    const result = await tools.sns_upload_media!.execute!({
      url: 'https://cdn.example/path/video.mp4',
    }, DEFAULT_OPTIONS);

    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      'https://cdn.example/path/video.mp4',
      'https://social.example/api/v2/media',
      'https://social.example/api/v1/media/media-404',
      'https://social.example/api/v1/media/media-404',
    ]);
    expect(sleep).toHaveBeenCalledOnce();
    expect(result).toEqual({ mediaId: 'media-404' });
  });

  it('retries timed out media polling requests', async () => {
    const sleep = vi.fn(async () => {});
    const timeoutError = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('video-bytes', {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'media-timeout',
        url: null,
      }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }))
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'media-timeout',
        url: 'https://social.example/media/media-timeout.mp4',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const tools = createSnsTools({
      ...SNS_CREDS,
      fetch,
      lookupFn: createPublicLookup(),
      sleep,
    });

    const result = await tools.sns_upload_media!.execute!({
      url: 'https://cdn.example/path/video.mp4',
    }, DEFAULT_OPTIONS);

    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      'https://cdn.example/path/video.mp4',
      'https://social.example/api/v2/media',
      'https://social.example/api/v1/media/media-timeout',
      'https://social.example/api/v1/media/media-timeout',
    ]);
    expect(fetch.mock.calls[2]?.[1]).toMatchObject({
      signal: expect.any(AbortSignal),
    });
    expect(sleep).toHaveBeenCalledOnce();
    expect(result).toEqual({ mediaId: 'media-timeout' });
  });

  it('waits for asynchronous Mastodon media processing before succeeding', async () => {
    const sleep = vi.fn(async () => {});
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('video-bytes', {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'media-async',
        url: null,
      }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'media-async',
        url: null,
      }), {
        status: 206,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'media-async',
        url: 'https://social.example/media/media-async.mp4',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const tools = createSnsTools({
      ...SNS_CREDS,
      fetch,
      lookupFn: createPublicLookup(),
      sleep,
    });

    const result = await tools.sns_upload_media!.execute!({
      url: 'https://cdn.example/path/video.mp4',
    }, DEFAULT_OPTIONS);

    expect(fetch.mock.calls.map((call) => call[0])).toEqual([
      'https://cdn.example/path/video.mp4',
      'https://social.example/api/v2/media',
      'https://social.example/api/v1/media/media-async',
      'https://social.example/api/v1/media/media-async',
    ]);
    expect(sleep).toHaveBeenCalledOnce();
    expect(result).toEqual({ mediaId: 'media-async' });
  });

  it('rejects oversized media downloads before buffering them fully', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('huge', {
      status: 200,
      headers: {
        'content-type': 'image/png',
        'content-length': '40000001',
      },
    }));
    const tools = createSnsTools({ ...SNS_CREDS, fetch, lookupFn: createPublicLookup() });

    const result = await tools.sns_upload_media!.execute!({
      url: 'https://cdn.example/path/huge.png',
    }, DEFAULT_OPTIONS);

    expect(result).toEqual({
      error: 'Media file exceeds 40000000 bytes.',
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('rejects blocked media URLs before fetching', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const tools = createSnsTools({ ...SNS_CREDS, fetch });

    const result = await tools.sns_upload_media!.execute!({
      url: 'http://127.0.0.1/internal.png',
    }, DEFAULT_OPTIONS);

    expect(result).toEqual({
      error: 'Blocked URL target: private, loopback, and link-local addresses are not allowed.',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects redirects that point to blocked media URLs', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, {
      status: 302,
      headers: {
        location: 'http://127.0.0.1/internal.png',
      },
    }));
    const tools = createSnsTools({ ...SNS_CREDS, fetch, lookupFn: createPublicLookup() });

    const result = await tools.sns_upload_media!.execute!({
      url: 'https://cdn.example/path/image.png',
    }, DEFAULT_OPTIONS);

    expect(result).toEqual({
      error: 'Blocked URL target: private, loopback, and link-local addresses are not allowed.',
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('rejects redirects that switch media downloads to disallowed schemes', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, {
      status: 302,
      headers: {
        location: 'ftp://cdn.example/internal.png',
      },
    }));
    const tools = createSnsTools({ ...SNS_CREDS, fetch, lookupFn: createPublicLookup() });

    const result = await tools.sns_upload_media!.execute!({
      url: 'https://cdn.example/path/image.png',
    }, DEFAULT_OPTIONS);

    expect(result).toEqual({
      error: 'URL must use http or https.',
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('returns an error object when the API request fails', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response(JSON.stringify({ error: 'Permission denied' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }));
    const tools = createSnsTools({ ...SNS_CREDS, fetch });

    const result = await tools.sns_get_post!.execute!({ post_id: 'post-1' }, DEFAULT_OPTIONS);

    expect(result).toEqual({
      error: '[MastodonApiError] Mastodon API returned 403: Permission denied',
    });
  });
});

describe('stripHtml', () => {
  it('converts simple HTML content into readable plain text', () => {
    expect(stripHtml('<p>Hello<br>world &amp; friends</p><p>Second line</p>')).toBe(
      'Hello\nworld & friends\n\nSecond line',
    );
  });

  it('decodes numeric and hex HTML entities', () => {
    expect(stripHtml('&#169; &#x41;')).toBe('\u00A9 A');
  });

  it('preserves invalid code points as raw entity strings', () => {
    expect(stripHtml('ok &#9999999999; end')).toBe('ok &#9999999999; end');
    expect(stripHtml('ok &#xDEADBEEF; end')).toBe('ok &#xDEADBEEF; end');
  });
});

describe('requestJson guards', () => {
  it('returns an error when the API responds with non-JSON on 200', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response('<html>Bad Gateway</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }));
    const tools = createSnsTools({ ...SNS_CREDS, fetch });

    const result = await tools.sns_get_post!.execute!({ post_id: 'post-1' }, DEFAULT_OPTIONS);

    expect(result).toEqual({
      error: expect.stringContaining('non-JSON response'),
    });
  });

  it('returns an error when the API responds with an empty body on 200', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      new Response('', { status: 200 }));
    const tools = createSnsTools({ ...SNS_CREDS, fetch });

    const result = await tools.sns_get_post!.execute!({ post_id: 'post-1' }, DEFAULT_OPTIONS);

    expect(result).toEqual({
      error: expect.stringContaining('empty response'),
    });
  });
});
