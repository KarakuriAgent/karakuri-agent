import { describe, expect, it, vi } from 'vitest';

import { ElythApiError, ElythNotSupportedError, ElythProvider } from '../src/sns/elyth.js';

type FetchMock = ReturnType<typeof vi.fn>;

function makePost(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    content: `text ${id}`,
    reply_to_id: null,
    thread_id: 'root',
    created_at: `2025-01-01T00:00:0${id.replace(/\D/g, '').slice(-1) || '0'}.000Z`,
    author_id: `author-${id}`,
    author_name: `Author ${id}`,
    author_handle: `author_${id}`,
    like_count: 1,
    reply_count: 0,
    liked_by_me: false,
    ...overrides,
  };
}

function provider(fetchMock: FetchMock): ElythProvider {
  return new ElythProvider({ apiKey: 'elyth-key', apiBase: 'https://elythworld.com', fetch: fetchMock as typeof fetch });
}

describe('ElythProvider', () => {
  it('creates posts and rejects unsupported visibility/media at the provider boundary', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('https://elythworld.com/api/mcp/posts');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toEqual(expect.objectContaining({ 'x-api-key': 'elyth-key' }));
      expect(JSON.parse(String(init?.body))).toEqual({ content: 'hello', reply_to_id: 'root' });
      return Response.json({
        success: true,
        post: makePost('post-1', {
          content: 'hello',
          reply_to_id: 'root',
          author_id: null,
          author_name: null,
          author_handle: null,
          aituber: { name: 'Ely Alice', handle: 'ely_alice' },
        }),
      });
    });
    const sut = provider(fetchMock);

    await expect(sut.post({ text: 'hello', replyToId: 'root', visibility: 'public' })).resolves.toEqual(expect.objectContaining({
      id: 'post-1',
      text: 'hello',
      inReplyToId: 'root',
      authorId: 'ely_alice',
      authorName: 'Ely Alice',
      authorHandle: 'ely_alice',
      visibility: 'public',
      repostCount: 0,
    }));
    await expect(sut.post({ text: 'hello', visibility: 'unlisted' })).rejects.toBeInstanceOf(ElythNotSupportedError);
    await expect(sut.post({ text: 'hello', mediaIds: ['media-1'] })).rejects.toThrow('media uploads');
    await expect(sut.post({ text: 'hello', quotePostId: 'quoted' })).rejects.toThrow('quote posts');
  });

  it('builds thread ancestors/descendants from flat ELYTH posts with loop/orphan guards', async () => {
    const root = makePost('root', { created_at: '2025-01-01T00:00:00.000Z' });
    const parent = makePost('parent', { reply_to_id: 'root', created_at: '2025-01-01T00:00:01.000Z' });
    const target = makePost('target', { reply_to_id: 'parent', created_at: '2025-01-01T00:00:02.000Z' });
    const child = makePost('child', { reply_to_id: 'target', created_at: '2025-01-01T00:00:03.000Z' });
    const grandchild = makePost('grandchild', { reply_to_id: 'child', created_at: '2025-01-01T00:00:04.000Z' });
    const loop = makePost('loop', { reply_to_id: 'loop' });
    const fetchMock = vi.fn(async () => Response.json({ posts: [target, child, root, grandchild, parent, loop] }));

    await expect(provider(fetchMock).getThread('target')).resolves.toEqual({
      ancestors: [expect.objectContaining({ id: 'root' }), expect.objectContaining({ id: 'parent' })],
      descendants: [expect.objectContaining({ id: 'child' }), expect.objectContaining({ id: 'grandchild' })],
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const orphanFetch = vi.fn(async () => Response.json({
      posts: [
        makePost('target', { reply_to_id: 'missing' }),
        makePost('child', { reply_to_id: 'target', created_at: '2025-01-01T00:00:05.000Z' }),
      ],
    }));
    await expect(provider(orphanFetch).getThread('target')).resolves.toEqual({
      ancestors: [],
      descendants: [expect.objectContaining({ id: 'child' })],
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('ELYTH thread response missing ancestor'),
      expect.objectContaining({ postId: 'target', missingParentId: 'missing' }),
    );
    warnSpy.mockRestore();

    const selfReplyFetch = vi.fn(async () => Response.json({
      posts: [
        makePost('target', { reply_to_id: 'target' }),
        makePost('child', { reply_to_id: 'target' }),
      ],
    }));
    await expect(provider(selfReplyFetch).getThread('target')).resolves.toEqual({
      ancestors: [],
      descendants: [expect.objectContaining({ id: 'child' })],
    });
  });

  it('gets a post via thread fallback and reports missing targets distinctly', async () => {
    const fetchMock = vi.fn(async () => Response.json({ posts: [makePost('post-1')] }));
    await expect(provider(fetchMock).getPost('post-1')).resolves.toEqual(expect.objectContaining({ id: 'post-1' }));
    await expect(provider(fetchMock).getPost('missing')).rejects.toMatchObject({
      name: 'ElythApiError',
      status: 404,
    });
    const malformedFetch = vi.fn(async () => Response.json({ ok: true }));
    await expect(provider(malformedFetch).getPost('post-1')).rejects.toThrow('thread_api_does_not_include_target');
  });

  it('normalizes notification types and filters by requested types', async () => {
    const notifications = [
      { notification_id: 'n-reply', notification_type: 'reply', notification_created_at: '2025-01-01T00:00:00.000Z', post_id: 'p1', post_author_id: 'a1', post_author_handle: 'a1' },
      { notification_id: 'n-mention', notification_type: 'mention', notification_created_at: '2025-01-01T00:00:01.000Z', post_id: 'p2', post_author_id: 'a2', post_author_handle: 'a2' },
      { notification_id: 'n-system', notification_type: 'system', notification_created_at: '2025-01-01T00:00:02.000Z' },
      { notification_id: 'n-image-failed', notification_type: 'image_failed', notification_created_at: '2025-01-01T00:00:03.000Z' },
    ];
    const fetchMock = vi.fn(async () => Response.json({ notifications }));
    const sut = provider(fetchMock);

    await expect(sut.getNotifications({ limit: 10 })).resolves.toEqual({
      notifications: [
        expect.objectContaining({ id: 'n-reply', type: 'reply' }),
        expect.objectContaining({ id: 'n-mention', type: 'mention' }),
        expect.objectContaining({ id: 'n-system', type: 'other' }),
        expect.objectContaining({ id: 'n-image-failed', type: 'other' }),
      ],
      complete: true,
    });

    await expect(provider(vi.fn(async () => Response.json({ notifications }))).getNotifications({ limit: 10, types: ['reply', 'mention'] })).resolves.toEqual({
      notifications: [
        expect.objectContaining({ id: 'n-reply', type: 'reply' }),
        expect.objectContaining({ id: 'n-mention', type: 'mention' }),
      ],
      complete: true,
    });
  });

  it('slices by sinceId/maxId when found and warns + marks incomplete when missing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const notifications = [
      { notification_id: 'n3', notification_type: 'mention', notification_created_at: '2025-01-01T00:00:03.000Z', post_id: 'p3', post_author_id: 'a3', post_author_handle: 'a3' },
      { notification_id: 'n2', notification_type: 'mention', notification_created_at: '2025-01-01T00:00:02.000Z', post_id: 'p2', post_author_id: 'a2', post_author_handle: 'a2' },
      { notification_id: 'n1', notification_type: 'mention', notification_created_at: '2025-01-01T00:00:01.000Z', post_id: 'p1', post_author_id: 'a1', post_author_handle: 'a1' },
    ];
    const sinceFetch = vi.fn(async () => Response.json({ notifications }));
    await expect(provider(sinceFetch).getNotifications({ limit: 10, sinceId: 'n1' })).resolves.toEqual({
      notifications: [expect.objectContaining({ id: 'n3' }), expect.objectContaining({ id: 'n2' })],
      complete: true,
    });

    const missingFetch = vi.fn(async () => Response.json({ notifications }));
    await expect(provider(missingFetch).getNotifications({ limit: 10, sinceId: 'unknown' })).resolves.toEqual({
      notifications: [expect.objectContaining({ id: 'n3' }), expect.objectContaining({ id: 'n2' }), expect.objectContaining({ id: 'n1' })],
      complete: false,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('ELYTH sinceId not found'),
      expect.objectContaining({ sinceId: 'unknown' }),
    );
    warnSpy.mockRestore();
  });

  it('marks notifications incomplete when the server returns a full page (no further pagination)', async () => {
    const notifications = Array.from({ length: 5 }, (_unused, index) => ({
      notification_id: `n${index}`,
      notification_type: 'mention',
      notification_created_at: `2025-01-01T00:00:0${index}.000Z`,
      post_id: `p${index}`,
      post_author_id: `a${index}`,
      post_author_handle: `a${index}`,
    }));
    const fetchMock = vi.fn(async () => Response.json({ notifications }));

    await expect(provider(fetchMock).getNotifications({ limit: 5 })).resolves.toEqual({
      notifications: expect.arrayContaining([expect.objectContaining({ id: 'n0' })]),
      complete: false,
    });
  });

  it('returns incomplete notifications on 429 and logs Retry-After', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn(async () => Response.json({ error: 'rate limited' }, {
      status: 429,
      headers: { 'Retry-After': '30' },
    }));

    await expect(provider(fetchMock).getNotifications({ limit: 5 })).resolves.toEqual({ notifications: [], complete: false });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('retry-after=30'));
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

  it('switches getUserPosts endpoints for self vs other and propagates self handle lookup failures', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/mcp/posts/mine?limit=1')) {
        return Response.json({ posts: [makePost('mine-handle', { author_handle: 'bot' })] });
      }
      if (url.includes('/api/mcp/posts/mine?limit=2')) {
        return Response.json({ posts: [makePost('mine-1', { author_handle: 'bot' })] });
      }
      if (url.includes('/api/mcp/aitubers/alice/profile')) {
        return Response.json({
          profile: {
            display_name: 'Alice',
            handle: 'alice',
            bio: null,
            follower_count: 1,
            following_count: 0,
            post_count: 1,
          },
          posts: [makePost('alice-1', { author_id: null, author_name: null, author_handle: null })],
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const sut = provider(fetchMock);

    await expect(sut.getUserPosts({ userHandle: '@bot', limit: 2 })).resolves.toEqual([expect.objectContaining({ id: 'mine-1' })]);
    await expect(sut.getUserPosts({ userHandle: 'alice', limit: 3 })).resolves.toEqual([
      expect.objectContaining({
        id: 'alice-1',
        authorId: 'alice',
        authorName: 'Alice',
        authorHandle: 'alice',
      }),
    ]);

    const failingFetch = vi.fn(async () => Response.json({ posts: [] }));
    await expect(provider(failingFetch).getUserPosts({ userHandle: 'bot' })).rejects.toThrow('Unable to determine current ELYTH account handle');
  });

  it('implements unlike, follow, profile, metrics, and markNotificationsRead', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/posts/post-1/like') && init?.method === 'DELETE') {
        return Response.json({ success: true, data: { liked: false, like_count: 0 } });
      }
      if (url.includes('/posts/post-1/thread')) {
        return Response.json({ posts: [makePost('post-1', { liked_by_me: false })] });
      }
      if (url.includes('/aitubers/alice/follow') && init?.method === 'POST') {
        return Response.json({ success: true, data: { following: true, follower_count: 1 } });
      }
      if (url.includes('/aitubers/alice/follow') && init?.method === 'DELETE') {
        return Response.json({ success: true, data: { following: false, follower_count: 0 } });
      }
      if (url.includes('/aitubers/alice/profile')) {
        return Response.json({
          profile: {
            display_name: 'Alice',
            handle: 'alice',
            bio: 'bio',
            follower_count: 1,
            following_count: 2,
            post_count: 3,
            followed_by_me: true,
          },
          posts: [],
        });
      }
      if (url.includes('/information?include=my_metrics')) {
        return Response.json({ my_metrics: { follower_count: 4, following_count: 5, post_count: 6 } });
      }
      if (url.includes('/notifications/read')) {
        expect(JSON.parse(String(init?.body))).toEqual({ notification_ids: ['n1', 'n2'] });
        return Response.json({ success: true, marked_count: 2 });
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const sut = provider(fetchMock);

    await expect(sut.unlike('post-1')).resolves.toEqual(expect.objectContaining({ id: 'post-1' }));
    await expect(sut.follow('@alice')).resolves.toBeUndefined();
    await expect(sut.unfollow('alice')).resolves.toBeUndefined();
    await expect(sut.getUserProfile('alice')).resolves.toEqual(expect.objectContaining({
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

  it('returns immediately for empty markNotificationsRead without calling the API', async () => {
    const fetchMock = vi.fn();
    await expect(provider(fetchMock).markNotificationsRead([])).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('memoizes the current account handle across getUserPosts(self) calls', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/api/mcp/posts/mine?limit=1')) {
        return Response.json({ posts: [makePost('mine-handle', { author_handle: 'bot' })] });
      }
      if (url.includes('/api/mcp/posts/mine?limit=2')) {
        return Response.json({ posts: [makePost('mine-1', { author_handle: 'bot' })] });
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const sut = provider(fetchMock);

    await sut.getUserPosts({ userHandle: 'bot', limit: 2 });
    await sut.getUserPosts({ userHandle: 'bot', limit: 2 });

    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('/api/mcp/posts/mine?limit=1'))).toHaveLength(1);
  });

  it('wraps HTTP failures in ElythApiError', async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: 'bad' }, { status: 500 }));
    await expect(provider(fetchMock).getPost('post-1')).rejects.toBeInstanceOf(ElythApiError);
  });
});
