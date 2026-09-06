import { describe, expect, it, vi } from 'vitest';

import { ElythApiError, ElythNotSupportedError, ElythProvider } from '../src/sns/elyth.js';

type FetchMock = ReturnType<typeof vi.fn>;

function makePost(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    author: { id: `author-${id}`, display_name: `Author ${id}`, handle: `author_${id}` },
    content: `text ${id}`,
    thread_id: 'root',
    engagement: { like_count: 1, reply_count: 0, liked_by_me: false },
    created_at: `2025-01-01T00:00:0${id.replace(/\D/g, '').slice(-1) || '0'}.000Z`,
    images: [],
    image_generation: null,
    kind: 'post',
    reply_to_id: null,
    ...overrides,
  };
}

function makeNotification(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: 'post.reply_received',
    created_at: '2025-01-01T00:00:00.000Z',
    actor: { type: 'aituber', id: `actor-${id}`, display_name: `Actor ${id}`, handle: `actor_${id}` },
    resource: null,
    preview: null,
    ...overrides,
  };
}

function jsonData(data: unknown, init?: ResponseInit) {
  return Response.json({ data }, init);
}

function provider(fetchMock: FetchMock): ElythProvider {
  return new ElythProvider({ apiKey: 'elyth-key', apiBase: 'https://elythworld.com', fetch: fetchMock as typeof fetch });
}

describe('ElythProvider', () => {
  it('creates root posts and replies via v2 endpoints with Bearer auth and Idempotency-Key', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer elyth-key');
      expect(headers['Idempotency-Key']).toEqual(expect.any(String));
      if (url === 'https://elythworld.com/api/agent/v2/posts') {
        expect(JSON.parse(String(init?.body))).toEqual({ content: 'hello root' });
        return jsonData({ post: makePost('post-root', { content: 'hello root' }) });
      }
      if (url === 'https://elythworld.com/api/agent/v2/posts/parent-1/replies') {
        expect(JSON.parse(String(init?.body))).toEqual({ content: 'hello reply' });
        return jsonData({ post: makePost('post-reply', { content: 'hello reply', kind: 'reply', reply_to_id: 'parent-1' }) });
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const sut = provider(fetchMock);

    await expect(sut.post({ text: 'hello root', visibility: 'public' })).resolves.toEqual(expect.objectContaining({
      id: 'post-root',
      text: 'hello root',
      authorId: 'author-post-root',
      authorName: 'Author post-root',
      authorHandle: 'author_post-root',
      visibility: 'public',
      repostCount: 0,
    }));
    await expect(sut.post({ text: 'hello reply', replyToId: 'parent-1' })).resolves.toEqual(expect.objectContaining({
      id: 'post-reply',
      inReplyToId: 'parent-1',
    }));
    await expect(sut.post({ text: 'hello', visibility: 'unlisted' })).rejects.toBeInstanceOf(ElythNotSupportedError);
    await expect(sut.post({ text: 'hello', mediaIds: ['media-1'] })).rejects.toThrow('media uploads');
    await expect(sut.post({ text: 'hello', quotePostId: 'quoted' })).rejects.toThrow('quote posts');
  });

  it('passes a caller-provided idempotency key through to the header', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)['Idempotency-Key']).toBe('stable-key');
      return jsonData({ post: makePost('post-1') });
    });
    await provider(fetchMock).post({ text: 'hello', idempotencyKey: 'stable-key' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gets a post via GET /posts/{id}', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).toBe('https://elythworld.com/api/agent/v2/posts/post-1');
      return jsonData({ post: makePost('post-1') });
    });
    await expect(provider(fetchMock).getPost('post-1')).resolves.toEqual(expect.objectContaining({
      id: 'post-1',
      text: 'text post-1',
      likeCount: 1,
      liked: false,
    }));

    const missingFetch = vi.fn(async () => Response.json(
      { error: { code: 'NOT_FOUND', message: 'missing', retryable: false } },
      { status: 404 },
    ));
    await expect(provider(missingFetch).getPost('missing')).rejects.toMatchObject({
      name: 'ElythApiError',
      status: 404,
    });
  });

  it('reads the timeline from GET /timeline items', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe('/api/agent/v2/timeline');
      expect(url.searchParams.get('limit')).toBe('2');
      return jsonData({
        items: [makePost('t1'), makePost('t2')],
        page: { has_more: true, next_cursor: 'cursor-1' },
      });
    });
    await expect(provider(fetchMock).getTimeline({ limit: 2 })).resolves.toEqual([
      expect.objectContaining({ id: 't1' }),
      expect.objectContaining({ id: 't2' }),
    ]);
  });

  it('builds thread ancestors/descendants from v2 root+replies with loop/orphan guards', async () => {
    const root = makePost('root', { created_at: '2025-01-01T00:00:00.000Z' });
    const parent = makePost('parent', { kind: 'reply', reply_to_id: 'root', created_at: '2025-01-01T00:00:01.000Z' });
    const target = makePost('target', { kind: 'reply', reply_to_id: 'parent', created_at: '2025-01-01T00:00:02.000Z' });
    const child = makePost('child', { kind: 'reply', reply_to_id: 'target', created_at: '2025-01-01T00:00:03.000Z' });
    const grandchild = makePost('grandchild', { kind: 'reply', reply_to_id: 'child', created_at: '2025-01-01T00:00:04.000Z' });
    const loop = makePost('loop', { kind: 'reply', reply_to_id: 'loop' });
    const fetchMock = vi.fn(async () => jsonData({
      thread: { id: 'root', root, replies: [target, child, grandchild, parent, loop] },
      page: { has_more: false, next_cursor: null },
    }));

    await expect(provider(fetchMock).getThread('target')).resolves.toEqual({
      ancestors: [expect.objectContaining({ id: 'root' }), expect.objectContaining({ id: 'parent' })],
      descendants: [expect.objectContaining({ id: 'child' }), expect.objectContaining({ id: 'grandchild' })],
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const orphanFetch = vi.fn(async () => jsonData({
      thread: {
        id: 'root',
        root,
        replies: [
          makePost('target', { kind: 'reply', reply_to_id: 'missing' }),
          makePost('child', { kind: 'reply', reply_to_id: 'target', created_at: '2025-01-01T00:00:05.000Z' }),
        ],
      },
      page: { has_more: false, next_cursor: null },
    }));
    await expect(provider(orphanFetch).getThread('target')).resolves.toEqual({
      ancestors: [],
      descendants: [],
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('ELYTH thread response missing ancestor'),
      expect.objectContaining({ postId: 'target', missingParentId: 'missing' }),
    );
    warnSpy.mockRestore();

    const selfReplyFetch = vi.fn(async () => jsonData({
      thread: {
        id: 'target',
        root: makePost('target', { reply_to_id: 'target' }),
        replies: [makePost('child', { kind: 'reply', reply_to_id: 'target' })],
      },
      page: { has_more: false, next_cursor: null },
    }));
    await expect(provider(selfReplyFetch).getThread('target')).resolves.toEqual({
      ancestors: [],
      descendants: [expect.objectContaining({ id: 'child' })],
    });
  });

  it('follows thread reply pagination cursors until exhausted', async () => {
    const root = makePost('root');
    const reply1 = makePost('r1', { kind: 'reply', reply_to_id: 'root', created_at: '2025-01-01T00:00:01.000Z' });
    const reply2 = makePost('r2', { kind: 'reply', reply_to_id: 'root', created_at: '2025-01-01T00:00:02.000Z' });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.searchParams.get('cursor') === 'cursor-1') {
        return jsonData({ thread: { id: 'root', root, replies: [reply2] }, page: { has_more: false, next_cursor: null } });
      }
      return jsonData({ thread: { id: 'root', root, replies: [reply1] }, page: { has_more: true, next_cursor: 'cursor-1' } });
    });

    await expect(provider(fetchMock).getThread('root')).resolves.toEqual({
      ancestors: [],
      descendants: [expect.objectContaining({ id: 'r1' }), expect.objectContaining({ id: 'r2' })],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('normalizes v2 notification types and filters by requested types', async () => {
    const notifications = [
      makeNotification('n-reply', { type: 'post.reply_received' }),
      makeNotification('n-mention', { type: 'post.mention_received', created_at: '2025-01-01T00:00:01.000Z' }),
      makeNotification('n-follow', { type: 'relationship.follow_started', created_at: '2025-01-01T00:00:02.000Z' }),
      makeNotification('n-announce', { type: 'announcement.published', created_at: '2025-01-01T00:00:03.000Z' }),
    ];
    const fetchMock = vi.fn(async () => jsonData({
      items: notifications,
      page: { has_more: false, next_cursor: null },
    }));

    await expect(provider(fetchMock).getNotifications({ limit: 10 })).resolves.toEqual({
      notifications: [
        expect.objectContaining({ id: 'n-reply', type: 'reply', accountHandle: 'actor_n-reply' }),
        expect.objectContaining({ id: 'n-mention', type: 'mention' }),
        expect.objectContaining({ id: 'n-follow', type: 'follow' }),
        expect.objectContaining({ id: 'n-announce', type: 'other' }),
      ],
      complete: true,
    });

    const filteredFetch = vi.fn(async () => jsonData({ items: notifications, page: { has_more: false, next_cursor: null } }));
    await expect(provider(filteredFetch).getNotifications({ limit: 10, types: ['reply', 'mention'] })).resolves.toEqual({
      notifications: [
        expect.objectContaining({ id: 'n-reply', type: 'reply' }),
        expect.objectContaining({ id: 'n-mention', type: 'mention' }),
      ],
      complete: true,
    });
  });

  it('hydrates notification posts via GET /posts/{id} and falls back to preview on failure', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const notifications = [
      makeNotification('n1', { resource: { type: 'post', id: 'p1' }, preview: { text: 'preview 1', truncated: true } }),
      makeNotification('n2', { resource: { type: 'post', id: 'p-deleted' }, preview: { text: 'preview 2', truncated: true } }),
    ];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/agent/v2/notifications')) {
        return jsonData({ items: notifications, page: { has_more: false, next_cursor: null } });
      }
      if (url.endsWith('/api/agent/v2/posts/p1')) {
        return jsonData({ post: makePost('p1', { content: 'full text 1' }) });
      }
      if (url.endsWith('/api/agent/v2/posts/p-deleted')) {
        return Response.json({ error: { code: 'NOT_FOUND', message: 'gone', retryable: false } }, { status: 404 });
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    await expect(provider(fetchMock).getNotifications({ limit: 5 })).resolves.toEqual({
      notifications: [
        expect.objectContaining({ id: 'n1', post: expect.objectContaining({ id: 'p1', text: 'full text 1' }) }),
        expect.objectContaining({ id: 'n2', post: expect.objectContaining({ id: 'p-deleted', text: 'preview 2…' }) }),
      ],
      complete: true,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('falling back to preview'),
      expect.objectContaining({ postId: 'p-deleted' }),
    );
    warnSpy.mockRestore();
  });

  it('slices notifications at sinceId and pages until it is found', async () => {
    const page1 = [makeNotification('n5'), makeNotification('n4')];
    const page2 = [makeNotification('n3'), makeNotification('n2')];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.searchParams.get('cursor') === 'cursor-1') {
        return jsonData({ items: page2, page: { has_more: true, next_cursor: 'cursor-2' } });
      }
      return jsonData({ items: page1, page: { has_more: true, next_cursor: 'cursor-1' } });
    });

    await expect(provider(fetchMock).getNotifications({ limit: 10, sinceId: 'n2' })).resolves.toEqual({
      notifications: [
        expect.objectContaining({ id: 'n5' }),
        expect.objectContaining({ id: 'n4' }),
        expect.objectContaining({ id: 'n3' }),
      ],
      complete: true,
    });
    // sinceId が 2 ページ目で見つかったのでカーソル追跡はそこで止まる
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('treats an exhausted unread list as complete even when sinceId is missing', async () => {
    const fetchMock = vi.fn(async () => jsonData({
      items: [makeNotification('n2'), makeNotification('n1')],
      page: { has_more: false, next_cursor: null },
    }));

    await expect(provider(fetchMock).getNotifications({ limit: 10, sinceId: 'gone' })).resolves.toEqual({
      notifications: [expect.objectContaining({ id: 'n2' }), expect.objectContaining({ id: 'n1' })],
      complete: true,
    });
  });

  it('marks notifications incomplete when the page cap is hit before finding sinceId', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      return jsonData({
        items: [makeNotification(`n-page-${call}`)],
        page: { has_more: true, next_cursor: `cursor-${call}` },
      });
    });

    await expect(provider(fetchMock).getNotifications({ limit: 10, sinceId: 'unreachable' })).resolves.toEqual({
      notifications: expect.arrayContaining([expect.objectContaining({ id: 'n-page-1' })]),
      complete: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('ELYTH sinceId not found'),
      expect.objectContaining({ sinceId: 'unreachable' }),
    );
    warnSpy.mockRestore();
  });

  it('slices after maxId when found and marks incomplete when missing', async () => {
    const items = [makeNotification('n3'), makeNotification('n2'), makeNotification('n1')];
    const foundFetch = vi.fn(async () => jsonData({ items, page: { has_more: false, next_cursor: null } }));
    await expect(provider(foundFetch).getNotifications({ limit: 10, maxId: 'n3' })).resolves.toEqual({
      notifications: [expect.objectContaining({ id: 'n2' }), expect.objectContaining({ id: 'n1' })],
      complete: true,
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const missingFetch = vi.fn(async () => jsonData({ items, page: { has_more: false, next_cursor: null } }));
    await expect(provider(missingFetch).getNotifications({ limit: 10, maxId: 'unknown' })).resolves.toEqual({
      notifications: [
        expect.objectContaining({ id: 'n3' }),
        expect.objectContaining({ id: 'n2' }),
        expect.objectContaining({ id: 'n1' }),
      ],
      complete: false,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('ELYTH maxId not found'),
      expect.objectContaining({ maxId: 'unknown' }),
    );
    warnSpy.mockRestore();
  });

  it('returns incomplete notifications on 429 and logs retry-after from the error envelope', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn(async () => Response.json(
      { error: { code: 'RATE_LIMITED', message: 'slow down', retryable: true, retry_after_seconds: 30 } },
      { status: 429 },
    ));

    await expect(provider(fetchMock).getNotifications({ limit: 5 })).resolves.toEqual({ notifications: [], complete: false });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('retry-after=30'));
    warnSpy.mockRestore();
  });

  it('throws unsupported errors for media, repost, and search and logs empty trends once', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const sut = provider(vi.fn());

    await expect(sut.uploadMedia({ url: 'https://example.com/a.png' })).rejects.toBeInstanceOf(ElythNotSupportedError);
    await expect(sut.repost('post-1')).rejects.toBeInstanceOf(ElythNotSupportedError);
    await expect(sut.search({ query: 'hello' })).rejects.toBeInstanceOf(ElythNotSupportedError);
    await expect(sut.getTrends()).resolves.toEqual([]);
    await expect(sut.getTrends()).resolves.toEqual([]);
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it('switches getUserPosts endpoints for self vs other via /me/profile', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/api/agent/v2/me/profile')) {
        return jsonData({
          profile: {
            id: 'me-id',
            display_name: 'Bot',
            handle: 'bot',
            bio: null,
            stats: { follower_count: 0, following_count: 0, post_count: 0 },
            relationship: null,
          },
        });
      }
      if (url.includes('/api/agent/v2/me/posts')) {
        return jsonData({
          items: [
            makePost('mine-1', { author: { id: 'me-id', display_name: 'Bot', handle: 'bot' } }),
            makePost('mine-reply', { kind: 'reply', reply_to_id: 'x', author: { id: 'me-id', display_name: 'Bot', handle: 'bot' } }),
          ],
          page: { has_more: false, next_cursor: null },
        });
      }
      if (url.includes('/api/agent/v2/profiles/alice/posts')) {
        return jsonData({
          items: [makePost('alice-1', { author: { id: 'alice-id', display_name: 'Alice', handle: 'alice' } })],
          page: { has_more: false, next_cursor: null },
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const sut = provider(fetchMock);

    await expect(sut.getUserPosts({ userHandle: '@bot', limit: 2, excludeReplies: true })).resolves.toEqual([
      expect.objectContaining({ id: 'mine-1', authorHandle: 'bot' }),
    ]);
    await expect(sut.getUserPosts({ userHandle: 'alice', limit: 3 })).resolves.toEqual([
      expect.objectContaining({
        id: 'alice-1',
        authorId: 'alice-id',
        authorName: 'Alice',
        authorHandle: 'alice',
      }),
    ]);
    // /me/profile は memoize され 1 回だけ呼ばれる
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/agent/v2/me/profile'))).toHaveLength(1);
  });

  it('implements like/unlike, follow/unfollow, profile, metrics, and markNotificationsRead on v2 routes', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/agent/v2/posts/post-1/like') && init?.method === 'PUT') {
        return jsonData({ like: { liked: true, like_count: 1 } });
      }
      if (url.endsWith('/api/agent/v2/posts/post-1/like') && init?.method === 'DELETE') {
        return jsonData({ like: { liked: false, like_count: 0 } });
      }
      if (url.endsWith('/api/agent/v2/posts/post-1')) {
        return jsonData({ post: makePost('post-1') });
      }
      if (url.endsWith('/api/agent/v2/profiles/alice/follow') && init?.method === 'PUT') {
        return jsonData({ relationship: { following: true, follows_me: false, mutual: false } });
      }
      if (url.endsWith('/api/agent/v2/profiles/alice/follow') && init?.method === 'DELETE') {
        return jsonData({ relationship: { following: false, follows_me: false, mutual: false } });
      }
      if (url.endsWith('/api/agent/v2/profiles/alice')) {
        return jsonData({
          profile: {
            id: 'alice-id',
            display_name: 'Alice',
            handle: 'alice',
            bio: 'bio',
            stats: { follower_count: 1, following_count: 2, post_count: 3 },
            relationship: { following: true, follows_me: false, mutual: false },
          },
        });
      }
      if (url.endsWith('/api/agent/v2/me/profile')) {
        return jsonData({
          profile: {
            id: 'me-id',
            display_name: 'Bot',
            handle: 'bot',
            bio: null,
            stats: { follower_count: 4, following_count: 5, post_count: 6 },
            relationship: null,
          },
        });
      }
      if (url.endsWith('/api/agent/v2/notifications/read')) {
        expect(JSON.parse(String(init?.body))).toEqual({ notification_ids: ['n1', 'n2'] });
        return jsonData({ received_count: 2 });
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const sut = provider(fetchMock);

    await expect(sut.like('post-1')).resolves.toEqual(expect.objectContaining({ id: 'post-1' }));
    await expect(sut.unlike('post-1')).resolves.toEqual(expect.objectContaining({ id: 'post-1' }));
    await expect(sut.follow('@alice')).resolves.toBeUndefined();
    await expect(sut.unfollow('alice')).resolves.toBeUndefined();
    await expect(sut.getUserProfile('alice')).resolves.toEqual(expect.objectContaining({
      id: 'alice-id',
      handle: 'alice',
      bio: 'bio',
      followerCount: 1,
      followingCount: 2,
      postCount: 3,
      followedByMe: true,
    }));
    await expect(sut.getMyMetrics()).resolves.toEqual({ followerCount: 4, followingCount: 5, postCount: 6 });
    await expect(sut.markNotificationsRead(['n1', 'n2'])).resolves.toBeUndefined();
  });

  it('omits followedByMe when relationship is null (own profile)', async () => {
    const fetchMock = vi.fn(async () => jsonData({
      profile: {
        id: 'me-id',
        display_name: 'Bot',
        handle: 'bot',
        bio: null,
        stats: { follower_count: 0, following_count: 0, post_count: 0 },
        relationship: null,
      },
    }));
    const result = await provider(fetchMock).getUserProfile('bot');
    expect(result).not.toHaveProperty('followedByMe');
  });

  it('returns immediately for empty markNotificationsRead without calling the API', async () => {
    const fetchMock = vi.fn();
    await expect(provider(fetchMock).markNotificationsRead([])).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('chunks markNotificationsRead into batches of 100 ids', async () => {
    const ids = Array.from({ length: 150 }, (_unused, index) => `n${index}`);
    const bodies: number[] = [];
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push((JSON.parse(String(init?.body)) as { notification_ids: string[] }).notification_ids.length);
      return jsonData({ received_count: 0 });
    });
    await provider(fetchMock).markNotificationsRead(ids);
    expect(bodies).toEqual([100, 50]);
  });

  it('surfaces the v2 error envelope through ElythApiError', async () => {
    const fetchMock = vi.fn(async () => Response.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Check the request input.',
          request_id: 'req_123',
          retryable: false,
          violations: [{ field: 'content', code: 'too_long' }],
        },
      },
      { status: 422 },
    ));
    await expect(provider(fetchMock).getPost('post-1')).rejects.toMatchObject({
      name: 'ElythApiError',
      status: 422,
      message: expect.stringContaining('VALIDATION_ERROR'),
      details: expect.objectContaining({ request_id: 'req_123' }),
    });
  });

  it('rejects success responses that lack the data envelope', async () => {
    const fetchMock = vi.fn(async () => Response.json({ ok: true }));
    await expect(provider(fetchMock).getPost('post-1')).rejects.toThrow('response_missing_data_envelope');
  });

  it('wraps non-JSON HTTP failures in ElythApiError with a truncated body', async () => {
    const fetchMock = vi.fn(async () => new Response(`<!DOCTYPE html>${'x'.repeat(500)}`, {
      status: 404,
      headers: { 'Content-Type': 'text/html' },
    }));
    await expect(provider(fetchMock).getPost('post-1')).rejects.toMatchObject({
      name: 'ElythApiError',
      status: 404,
    });
    await provider(fetchMock).getPost('post-1').catch((error: ElythApiError) => {
      expect(error.message.length).toBeLessThan(300);
    });
  });
});
