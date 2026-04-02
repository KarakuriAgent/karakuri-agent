import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  clientConfigs: [] as Array<Record<string, unknown>>,
  oauth1Configs: [] as Array<Record<string, unknown>>,
  oauth2Configs: [] as Array<Record<string, unknown>>,
  posts: {
    create: vi.fn(),
    getById: vi.fn(),
    searchRecent: vi.fn(),
  },
  users: {
    getMe: vi.fn(),
    getTimeline: vi.fn(),
    search: vi.fn(),
    likePost: vi.fn(),
    repostPost: vi.fn(),
    getMentions: vi.fn(),
    getByUsername: vi.fn(),
    getPosts: vi.fn(),
  },
  media: {
    initializeUpload: vi.fn(),
    appendUpload: vi.fn(),
    finalizeUpload: vi.fn(),
    createMetadata: vi.fn(),
    getUploadStatus: vi.fn(),
  },
  refreshTokenMock: vi.fn(),
  setTokenMock: vi.fn(),
}));

vi.mock('@xdevplatform/xdk', () => ({
  Client: vi.fn(function Client(this: unknown, config: Record<string, unknown>) {
    mockState.clientConfigs.push(config);
    return {
      posts: mockState.posts,
      users: mockState.users,
      media: mockState.media,
    };
  }),
  OAuth1: vi.fn(function OAuth1(this: unknown, config: Record<string, unknown>) {
    mockState.oauth1Configs.push(config);
    return { config };
  }),
  OAuth2: vi.fn(function OAuth2(this: unknown, config: Record<string, unknown>) {
    mockState.oauth2Configs.push(config);
    return {
      config,
      refreshToken: mockState.refreshTokenMock,
      setToken: mockState.setTokenMock,
    };
  }),
}));

import { XProvider } from '../src/sns/x.js';

type XPost = {
  id: string;
  text?: string;
  authorId?: string;
  createdAt?: string;
  conversationId?: string;
  inReplyToUserId?: string;
  referencedTweets?: Array<{ id: string; type?: string }>;
  publicMetrics?: {
    retweetCount?: number;
    likeCount?: number;
    replyCount?: number;
  };
  attachments?: {
    mediaKeys?: string[];
  };
};

const TEST_DATA_DIR = resolve(process.cwd(), '.test-artifacts/x-provider');

function makeUser(id = 'user-1', username = 'alice', name = 'Alice') {
  return { id, username, name };
}

function makePost(overrides: Partial<XPost> = {}): XPost {
  return {
    id: 'post-1',
    text: 'Hello X',
    authorId: 'user-1',
    createdAt: '2025-01-02T00:00:00.000Z',
    conversationId: 'conversation-1',
    publicMetrics: {
      retweetCount: 2,
      likeCount: 3,
      replyCount: 4,
    },
    attachments: {
      mediaKeys: ['media-1'],
    },
    ...overrides,
  };
}

function makePostResponse(post: XPost, options: { users?: unknown[]; tweets?: unknown[]; media?: unknown[] } = {}) {
  return {
    data: post,
    includes: {
      users: options.users ?? [makeUser(post.authorId ?? 'user-1')],
      tweets: options.tweets ?? [],
      media: options.media ?? [{ mediaKey: 'media-1', url: 'https://cdn.example/media-1.png' }],
    },
  };
}

function makeListResponse(posts: XPost[], options: { users?: unknown[]; tweets?: unknown[]; media?: unknown[]; nextToken?: string } = {}) {
  return {
    data: posts,
    includes: {
      users: options.users ?? [makeUser()],
      tweets: options.tweets ?? [],
      media: options.media ?? [],
    },
    meta: {
      ...(options.nextToken != null ? { nextToken: options.nextToken } : {}),
    },
  };
}

function resetMocks(): void {
  mockState.clientConfigs.length = 0;
  mockState.oauth1Configs.length = 0;
  mockState.oauth2Configs.length = 0;
  for (const group of [mockState.posts, mockState.users, mockState.media]) {
    for (const fn of Object.values(group)) {
      fn.mockReset();
    }
  }
  mockState.refreshTokenMock.mockReset();
  mockState.setTokenMock.mockReset();
}

describe('XProvider', () => {
  beforeEach(async () => {
    resetMocks();
    await rm(TEST_DATA_DIR, { recursive: true, force: true });
    await mkdir(TEST_DATA_DIR, { recursive: true });
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(TEST_DATA_DIR, { recursive: true, force: true });
  });

  it('creates posts and rejects non-public visibility', async () => {
    mockState.posts.create.mockResolvedValue({ data: { id: 'post-created' } });
    mockState.posts.getById.mockResolvedValue(makePostResponse(makePost({ id: 'post-created' })));

    const provider = new XProvider({ accessToken: 'token' });

    await expect(provider.post({ text: 'hello', visibility: 'public' })).resolves.toEqual(expect.objectContaining({
      id: 'post-created',
      url: 'https://x.com/alice/status/post-created',
    }));
    expect(mockState.posts.create).toHaveBeenCalledWith({ text: 'hello' });
    await expect(provider.post({ text: 'hello', visibility: 'direct' })).rejects.toThrow('X only supports public visibility');
  });

  it('maps post lookups and timeline reposts', async () => {
    const repostWrapper = makePost({
      id: 'timeline-1',
      authorId: 'retweeter-1',
      referencedTweets: [{ id: 'post-2', type: 'retweeted' }],
    });
    const original = makePost({ id: 'post-2', authorId: 'user-2', text: 'Original post' });
    mockState.posts.getById.mockResolvedValue(makePostResponse(makePost({ id: 'post-1' })));
    mockState.users.getMe.mockResolvedValue({ data: makeUser('me-1', 'bot', 'Bot') });
    mockState.users.getTimeline.mockResolvedValue(makeListResponse([repostWrapper], {
      users: [makeUser('retweeter-1', 'retweeter', 'Retweeter'), makeUser('user-2', 'bob', 'Bob')],
      tweets: [original],
      media: [{ mediaKey: 'media-1', url: 'https://cdn.example/original.png' }],
    }));

    const provider = new XProvider({ accessToken: 'token' });

    await expect(provider.getPost('post-1')).resolves.toEqual(expect.objectContaining({
      id: 'post-1',
      mediaUrls: ['https://cdn.example/media-1.png'],
    }));
    await expect(provider.getTimeline({ limit: 5 })).resolves.toEqual([
      expect.objectContaining({
        id: 'post-2',
        timelineEntryId: 'timeline-1',
        authorHandle: 'bob',
      }),
    ]);
  });

  it('searches posts and users', async () => {
    mockState.posts.searchRecent.mockResolvedValue(makeListResponse([makePost({ id: 'post-search' })]));
    mockState.users.search.mockResolvedValue({ data: [makeUser('user-9', 'searcher', 'Searcher')] });

    const provider = new XProvider({ accessToken: 'token' });

    await expect(provider.search({ query: 'hello' })).resolves.toEqual({
      posts: [expect.objectContaining({ id: 'post-search' })],
      users: [],
    });
    await expect(provider.search({ query: 'alice', type: 'users' })).resolves.toEqual({
      posts: [],
      users: [{ id: 'user-9', name: 'Searcher', handle: 'searcher', url: 'https://x.com/searcher' }],
    });
  });

  it('likes and reposts via user context then fetches the post', async () => {
    mockState.users.getMe.mockResolvedValue({ data: makeUser('me-1', 'bot', 'Bot') });
    mockState.users.likePost.mockResolvedValue({ data: { liked: true } });
    mockState.users.repostPost.mockResolvedValue({ data: { reposted: true } });
    mockState.posts.getById
      .mockResolvedValueOnce(makePostResponse(makePost({ id: 'liked-post' })))
      .mockResolvedValueOnce(makePostResponse(makePost({ id: 'reposted-post' })));

    const provider = new XProvider({ accessToken: 'token' });

    await expect(provider.like('liked-post')).resolves.toEqual(expect.objectContaining({ id: 'liked-post' }));
    await expect(provider.repost('reposted-post')).resolves.toEqual(expect.objectContaining({ id: 'reposted-post' }));
    expect(mockState.users.likePost).toHaveBeenCalledWith('me-1', { body: { tweetId: 'liked-post' } });
    expect(mockState.users.repostPost).toHaveBeenCalledWith('me-1', { body: { tweetId: 'reposted-post' } });
  });

  it('classifies mentions vs replies and returns partial notifications when rate limited mid-pagination', async () => {
    mockState.users.getMe.mockResolvedValue({ data: makeUser('me-1', 'bot', 'Bot') });
    mockState.users.getMentions
      .mockResolvedValueOnce(makeListResponse([
        makePost({ id: 'reply-1', inReplyToUserId: 'me-1', authorId: 'user-2' }),
        makePost({ id: 'mention-1', authorId: 'user-3' }),
      ], {
        users: [makeUser('user-2', 'replier', 'Replier'), makeUser('user-3', 'mentioner', 'Mentioner')],
        nextToken: 'next-token',
      }))
      .mockRejectedValueOnce(Object.assign(new Error('rate limited'), { status: 429 }));

    const provider = new XProvider({ accessToken: 'token' });

    await expect(provider.getNotifications({ limit: 5 })).resolves.toEqual({
      notifications: [
        expect.objectContaining({ id: 'reply-1', type: 'reply', accountHandle: 'replier' }),
        expect.objectContaining({ id: 'mention-1', type: 'mention', accountHandle: 'mentioner' }),
      ],
      complete: false,
    });
  });

  it('filters reply and mention notifications using the classified type', async () => {
    mockState.users.getMe.mockResolvedValue({ data: makeUser('me-1', 'bot', 'Bot') });
    mockState.users.getMentions
      .mockResolvedValueOnce(makeListResponse([
        makePost({ id: 'reply-1', inReplyToUserId: 'me-1', authorId: 'user-2' }),
        makePost({ id: 'mention-1', authorId: 'user-3' }),
      ], {
        users: [makeUser('user-2', 'replier', 'Replier'), makeUser('user-3', 'mentioner', 'Mentioner')],
      }))
      .mockResolvedValueOnce(makeListResponse([
        makePost({ id: 'reply-1', inReplyToUserId: 'me-1', authorId: 'user-2' }),
        makePost({ id: 'mention-1', authorId: 'user-3' }),
      ], {
        users: [makeUser('user-2', 'replier', 'Replier'), makeUser('user-3', 'mentioner', 'Mentioner')],
      }));

    const provider = new XProvider({ accessToken: 'token' });

    await expect(provider.getNotifications({ limit: 5, types: ['reply'] })).resolves.toEqual({
      notifications: [
        expect.objectContaining({ id: 'reply-1', type: 'reply' }),
      ],
      complete: true,
    });
    await expect(provider.getNotifications({ limit: 5, types: ['mention'] })).resolves.toEqual({
      notifications: [
        expect.objectContaining({ id: 'mention-1', type: 'mention' }),
      ],
      complete: true,
    });
  });

  it('returns partial notifications when pagination stops before the full result set is loaded', async () => {
    mockState.users.getMe.mockResolvedValue({ data: makeUser('me-1', 'bot', 'Bot') });
    mockState.users.getMentions
      .mockResolvedValueOnce(makeListResponse([
        makePost({ id: 'reply-1', inReplyToUserId: 'me-1', authorId: 'user-2' }),
      ], {
        users: [makeUser('user-2', 'replier', 'Replier')],
        nextToken: 'token-1',
      }))
      .mockResolvedValueOnce(makeListResponse([
        makePost({ id: 'reply-2', inReplyToUserId: 'me-1', authorId: 'user-3' }),
      ], {
        users: [makeUser('user-3', 'replier-2', 'Replier 2')],
        nextToken: 'token-2',
      }))
      .mockResolvedValueOnce(makeListResponse([
        makePost({ id: 'reply-3', inReplyToUserId: 'me-1', authorId: 'user-4' }),
      ], {
        users: [makeUser('user-4', 'replier-3', 'Replier 3')],
        nextToken: 'token-3',
      }))
      .mockResolvedValueOnce(makeListResponse([
        makePost({ id: 'reply-4', inReplyToUserId: 'me-1', authorId: 'user-5' }),
      ], {
        users: [makeUser('user-5', 'replier-4', 'Replier 4')],
        nextToken: 'token-4',
      }))
      .mockResolvedValueOnce(makeListResponse([
        makePost({ id: 'reply-5', inReplyToUserId: 'me-1', authorId: 'user-6' }),
      ], {
        users: [makeUser('user-6', 'replier-5', 'Replier 5')],
        nextToken: 'token-5',
      }));

    const provider = new XProvider({ accessToken: 'token' });

    await expect(provider.getNotifications({ limit: 10 })).resolves.toEqual({
      notifications: [
        expect.objectContaining({ id: 'reply-1', type: 'reply' }),
        expect.objectContaining({ id: 'reply-2', type: 'reply' }),
        expect.objectContaining({ id: 'reply-3', type: 'reply' }),
        expect.objectContaining({ id: 'reply-4', type: 'reply' }),
        expect.objectContaining({ id: 'reply-5', type: 'reply' }),
      ],
      complete: false,
    });
    expect(mockState.users.getMentions).toHaveBeenCalledTimes(5);
  });

  it('returns an empty partial result when rate limited before collecting notifications', async () => {
    mockState.users.getMe.mockResolvedValue({ data: makeUser('me-1', 'bot', 'Bot') });
    mockState.users.getMentions.mockRejectedValueOnce(Object.assign(new Error('rate limited'), { status: 429 }));

    const provider = new XProvider({ accessToken: 'token' });

    await expect(provider.getNotifications({ limit: 5 })).resolves.toEqual({
      notifications: [],
      complete: false,
    });
  });

  it('returns an empty partial result when rate limited while loading the current user', async () => {
    mockState.users.getMe.mockRejectedValueOnce(Object.assign(new Error('rate limited'), { status: 429 }));

    const provider = new XProvider({ accessToken: 'token' });

    await expect(provider.getNotifications({ limit: 5 })).resolves.toEqual({
      notifications: [],
      complete: false,
    });
  });

  it('returns an empty partial result when filtered notifications remain incomplete after pagination limits', async () => {
    mockState.users.getMe.mockResolvedValue({ data: makeUser('me-1', 'bot', 'Bot') });
    mockState.users.getMentions
      .mockResolvedValueOnce(makeListResponse([
        makePost({ id: 'mention-1', authorId: 'user-2' }),
      ], {
        users: [makeUser('user-2', 'mentioner-1', 'Mentioner 1')],
        nextToken: 'token-1',
      }))
      .mockResolvedValueOnce(makeListResponse([
        makePost({ id: 'mention-2', authorId: 'user-3' }),
      ], {
        users: [makeUser('user-3', 'mentioner-2', 'Mentioner 2')],
        nextToken: 'token-2',
      }))
      .mockResolvedValueOnce(makeListResponse([
        makePost({ id: 'mention-3', authorId: 'user-4' }),
      ], {
        users: [makeUser('user-4', 'mentioner-3', 'Mentioner 3')],
        nextToken: 'token-3',
      }))
      .mockResolvedValueOnce(makeListResponse([
        makePost({ id: 'mention-4', authorId: 'user-5' }),
      ], {
        users: [makeUser('user-5', 'mentioner-4', 'Mentioner 4')],
        nextToken: 'token-4',
      }))
      .mockResolvedValueOnce(makeListResponse([
        makePost({ id: 'mention-5', authorId: 'user-6' }),
      ], {
        users: [makeUser('user-6', 'mentioner-5', 'Mentioner 5')],
        nextToken: 'token-5',
      }));

    const provider = new XProvider({ accessToken: 'token' });

    await expect(provider.getNotifications({ limit: 5, types: ['reply'] })).resolves.toEqual({
      notifications: [],
      complete: false,
    });
  });

  it('returns the requested notification limit even when more matching notifications remain on later pages', async () => {
    mockState.users.getMe.mockResolvedValue({ data: makeUser('me-1', 'bot', 'Bot') });
    mockState.users.getMentions.mockResolvedValueOnce(makeListResponse([
      makePost({ id: 'reply-1', inReplyToUserId: 'me-1', authorId: 'user-2' }),
      makePost({ id: 'reply-2', inReplyToUserId: 'me-1', authorId: 'user-3' }),
      makePost({ id: 'mention-1', authorId: 'user-4' }),
    ], {
      users: [
        makeUser('user-2', 'replier', 'Replier'),
        makeUser('user-3', 'replier-2', 'Replier 2'),
        makeUser('user-4', 'mentioner', 'Mentioner'),
      ],
      nextToken: 'token-1',
    }));

    const provider = new XProvider({ accessToken: 'token' });

    await expect(provider.getNotifications({ limit: 2 })).resolves.toEqual({
      notifications: [
        expect.objectContaining({ id: 'reply-1', type: 'reply' }),
        expect.objectContaining({ id: 'reply-2', type: 'reply' }),
      ],
      complete: true,
    });
  });

  it('uploads media with chunked upload and alt text metadata', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('image-bytes', {
      status: 200,
      headers: { 'content-type': 'image/png' },
    })));
    mockState.media.initializeUpload.mockResolvedValue({ data: { id: 'media-1' } });
    mockState.media.appendUpload.mockResolvedValue({ data: {} });
    mockState.media.finalizeUpload.mockResolvedValue({ data: { id: 'media-1' } });
    mockState.media.getUploadStatus.mockResolvedValue({ data: { processingInfo: { state: 'succeeded' } } });
    mockState.media.createMetadata.mockResolvedValue({ data: {} });

    const provider = new XProvider({
      accessToken: 'token',
      lookupFn: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
    });

    await expect(provider.uploadMedia({ url: 'https://cdn.example/image.png', altText: 'sample alt' })).resolves.toEqual({ mediaId: 'media-1' });
    expect(mockState.media.initializeUpload).toHaveBeenCalled();
    expect(mockState.media.appendUpload).toHaveBeenCalledTimes(1);
    expect(mockState.media.finalizeUpload).toHaveBeenCalledWith('media-1');
    expect(mockState.media.createMetadata).toHaveBeenCalledWith({
      body: {
        id: 'media-1',
        metadata: {
          alt_text: { text: 'sample alt' },
        },
      },
    });
  });

  it('returns empty thread for posts older than seven days and excludes sibling branches from recent conversations', async () => {
    const now = Date.now();
    const recentRoot = new Date(now - (2 * 24 * 60 * 60 * 1_000)).toISOString();
    const recentParent = new Date(now - (2 * 24 * 60 * 60 * 1_000) - (60 * 60 * 1_000)).toISOString();
    const recentTarget = new Date(now - (2 * 24 * 60 * 60 * 1_000) + (10 * 60 * 1_000)).toISOString();
    const recentBotReply = new Date(now - (2 * 24 * 60 * 60 * 1_000) + (30 * 60 * 1_000)).toISOString();
    const recentDescendant = new Date(now - (2 * 24 * 60 * 60 * 1_000) + (60 * 60 * 1_000)).toISOString();
    const siblingTimestamp = new Date(now - (2 * 24 * 60 * 60 * 1_000) + (20 * 60 * 1_000)).toISOString();
    const oldPost = new Date(now - (10 * 24 * 60 * 60 * 1_000)).toISOString();

    mockState.posts.getById
      .mockResolvedValueOnce(makePostResponse(makePost({ createdAt: oldPost })))
      .mockResolvedValueOnce(makePostResponse(makePost({
        id: 'target-post',
        authorId: 'user-3',
        createdAt: recentTarget,
        conversationId: 'conversation-1',
        referencedTweets: [{ id: 'ancestor-1', type: 'replied_to' }],
      })));
    mockState.users.getMe.mockResolvedValue({ data: makeUser('me-1', 'bot', 'Bot') });
    mockState.posts.searchRecent.mockResolvedValue(makeListResponse([
      makePost({ id: 'thread-root', authorId: 'user-2', createdAt: recentRoot }),
      makePost({
        id: 'ancestor-1',
        authorId: 'user-2',
        createdAt: recentParent,
        referencedTweets: [{ id: 'thread-root', type: 'replied_to' }],
      }),
      makePost({
        id: 'target-post',
        authorId: 'user-3',
        createdAt: recentTarget,
        referencedTweets: [{ id: 'ancestor-1', type: 'replied_to' }],
      }),
      makePost({
        id: 'sibling-branch',
        authorId: 'user-4',
        createdAt: siblingTimestamp,
        referencedTweets: [{ id: 'ancestor-1', type: 'replied_to' }],
      }),
      makePost({
        id: 'self-post',
        authorId: 'me-1',
        createdAt: recentBotReply,
        referencedTweets: [{ id: 'target-post', type: 'replied_to' }],
      }),
      makePost({
        id: 'descendant-1',
        authorId: 'user-5',
        createdAt: recentDescendant,
        referencedTweets: [{ id: 'self-post', type: 'replied_to' }],
      }),
    ], {
      users: [
        makeUser('user-2', 'ancestor', 'Ancestor'),
        makeUser('user-3', 'target', 'Target'),
        makeUser('user-4', 'sibling', 'Sibling'),
        makeUser('user-5', 'descendant', 'Descendant'),
        makeUser('me-1', 'bot', 'Bot'),
      ],
    }));

    const provider = new XProvider({ accessToken: 'token' });

    await expect(provider.getThread('old-post')).resolves.toEqual({ ancestors: [], descendants: [] });
    await expect(provider.getThread('target-post')).resolves.toEqual({
      ancestors: [
        expect.objectContaining({ id: 'thread-root', authorHandle: 'ancestor' }),
        expect.objectContaining({ id: 'ancestor-1', authorHandle: 'ancestor' }),
      ],
      descendants: [expect.objectContaining({ id: 'descendant-1', authorHandle: 'descendant' })],
    });
  });

  it('rejects incomplete thread fetches when conversation pagination exceeds the limit', async () => {
    const recentTarget = new Date(Date.now() - 2 * 60_000).toISOString();
    mockState.posts.getById.mockResolvedValue(makePostResponse(makePost({
      id: 'target-post',
      authorId: 'user-3',
      createdAt: recentTarget,
      referencedTweets: [{ id: 'ancestor-1', type: 'replied_to' }],
    }), {
      users: [makeUser('user-3', 'target', 'Target')],
      tweets: [makePost({ id: 'ancestor-1', authorId: 'user-2' })],
    }));
    mockState.users.getMe.mockResolvedValue({ data: makeUser('me-1', 'bot', 'Bot') });
    mockState.posts.searchRecent
      .mockResolvedValueOnce(makeListResponse([], { nextToken: 'page-2' }))
      .mockResolvedValueOnce(makeListResponse([], { nextToken: 'page-3' }))
      .mockResolvedValueOnce(makeListResponse([], { nextToken: 'page-4' }))
      .mockResolvedValueOnce(makeListResponse([], { nextToken: 'page-5' }))
      .mockResolvedValueOnce(makeListResponse([], { nextToken: 'page-6' }));

    const provider = new XProvider({ accessToken: 'token' });

    await expect(provider.getThread('target-post')).rejects.toThrow(
      'X thread could not be fetched completely before pagination limits were reached.',
    );
    expect(mockState.posts.searchRecent).toHaveBeenCalledTimes(5);
  });

  it('returns no thread context when a recent reply belongs to an older conversation that cannot be reconstructed', async () => {
    const recentTarget = new Date(Date.now() - 2 * 60_000).toISOString();
    mockState.posts.getById.mockResolvedValue(makePostResponse(makePost({
      id: 'target-post',
      authorId: 'user-3',
      createdAt: recentTarget,
      referencedTweets: [{ id: 'missing-ancestor', type: 'replied_to' }],
    }), {
      users: [makeUser('user-3', 'target', 'Target')],
      tweets: [],
    }));
    mockState.users.getMe.mockResolvedValue({ data: makeUser('me-1', 'bot', 'Bot') });
    mockState.posts.searchRecent.mockResolvedValue(makeListResponse([
      makePost({
        id: 'target-post',
        authorId: 'user-3',
        createdAt: recentTarget,
        referencedTweets: [{ id: 'missing-ancestor', type: 'replied_to' }],
      }),
      makePost({
        id: 'descendant-1',
        authorId: 'user-5',
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        referencedTweets: [{ id: 'target-post', type: 'replied_to' }],
      }),
    ], {
      users: [
        makeUser('user-3', 'target', 'Target'),
        makeUser('user-5', 'descendant', 'Descendant'),
      ],
    }));

    const provider = new XProvider({ accessToken: 'token' });

    await expect(provider.getThread('target-post')).resolves.toEqual({ ancestors: [], descendants: [] });
  });

  it('loads user posts and returns no trends', async () => {
    mockState.users.getByUsername.mockResolvedValue({ data: makeUser('user-7', 'alice', 'Alice') });
    mockState.users.getPosts.mockResolvedValue(makeListResponse([makePost({ id: 'user-post-1', authorId: 'user-7' })], {
      users: [makeUser('user-7', 'alice', 'Alice')],
    }));

    const provider = new XProvider({ accessToken: 'token' });

    await expect(provider.getUserPosts({ userHandle: 'alice', limit: 3, excludeReplies: true })).resolves.toEqual([
      expect.objectContaining({ id: 'user-post-1', authorHandle: 'alice' }),
    ]);
    await expect(provider.getTrends()).resolves.toEqual([]);
    expect(mockState.users.getPosts).toHaveBeenCalledWith('user-7', expect.objectContaining({
      maxResults: 3,
      exclude: ['replies'],
    }));
  });

  it('refreshes OAuth2 tokens on 401 and persists rotated tokens', async () => {
    mockState.posts.getById
      .mockRejectedValueOnce(Object.assign(new Error('expired'), { status: 401 }))
      .mockResolvedValueOnce(makePostResponse(makePost({ id: 'post-after-refresh' })));
    mockState.refreshTokenMock.mockResolvedValue({
      access_token: 'new-access-token',
      refresh_token: 'new-refresh-token',
      token_type: 'bearer',
      expires_in: 7200,
    });

    const provider = new XProvider({
      accessToken: 'old-access-token',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
      dataDir: TEST_DATA_DIR,
    });

    await expect(provider.getPost('post-after-refresh')).resolves.toEqual(expect.objectContaining({ id: 'post-after-refresh' }));
    expect(mockState.refreshTokenMock).toHaveBeenCalledWith('refresh-token');
    expect(mockState.clientConfigs.at(-1)).toEqual(expect.objectContaining({ accessToken: 'new-access-token' }));

    const persisted = JSON.parse(await readFile(resolve(TEST_DATA_DIR, 'sns-token-state.json'), 'utf8')) as Record<string, string>;
    expect(persisted.configFingerprint).toEqual(expect.any(String));
    expect(persisted.accessToken).toBe('new-access-token');
    expect(persisted.refreshToken).toBe('new-refresh-token');
  });

  it('deduplicates refreshes for concurrent 401s on a single provider instance', async () => {
    const expiredError = Object.assign(new Error('expired'), { status: 401 });
    let rejectSecondInitialRequest: ((error: Error) => void) | undefined;
    mockState.posts.getById
      .mockRejectedValueOnce(expiredError)
      .mockImplementationOnce(async () => new Promise((_, reject: (error: Error) => void) => {
        rejectSecondInitialRequest = reject;
      }))
      .mockResolvedValueOnce(makePostResponse(makePost({ id: 'post-after-first-refresh' })))
      .mockResolvedValueOnce(makePostResponse(makePost({ id: 'post-after-second-retry' })));
    mockState.refreshTokenMock.mockResolvedValue({
      access_token: 'new-access-token',
      refresh_token: 'new-refresh-token',
      token_type: 'bearer',
      expires_in: 7200,
    });

    const provider = new XProvider({
      accessToken: 'old-access-token',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
      dataDir: TEST_DATA_DIR,
    });

    const firstRequest = provider.getPost('post-after-first-refresh');
    const secondRequest = provider.getPost('post-after-second-retry');

    await expect(firstRequest).resolves.toEqual(expect.objectContaining({ id: 'post-after-first-refresh' }));
    rejectSecondInitialRequest?.(expiredError);
    await expect(secondRequest).resolves.toEqual(expect.objectContaining({ id: 'post-after-second-retry' }));
    expect(mockState.refreshTokenMock).toHaveBeenCalledTimes(1);
  });

  it('ignores persisted tokens when explicit OAuth credentials change', async () => {
    await mkdir(TEST_DATA_DIR, { recursive: true });
    await writeFile(resolve(TEST_DATA_DIR, 'sns-token-state.json'), JSON.stringify({
      provider: 'x',
      configFingerprint: 'stale-config',
      accessToken: 'persisted-access-token',
      refreshToken: 'persisted-refresh-token',
      updatedAt: new Date().toISOString(),
    }), 'utf8');
    mockState.posts.getById.mockResolvedValue(makePostResponse(makePost({ id: 'fresh-config-post' })));

    const provider = new XProvider({
      accessToken: 'fresh-access-token',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'fresh-refresh-token',
      dataDir: TEST_DATA_DIR,
    });

    await expect(provider.getPost('fresh-config-post')).resolves.toEqual(expect.objectContaining({ id: 'fresh-config-post' }));
    expect(mockState.setTokenMock).toHaveBeenCalledWith(expect.objectContaining({
      access_token: 'fresh-access-token',
      refresh_token: 'fresh-refresh-token',
    }));
    expect(mockState.clientConfigs[0]).toEqual(expect.objectContaining({ accessToken: 'fresh-access-token' }));
  });

  it('ignores persisted OAuth2 tokens when switching to OAuth1', async () => {
    await mkdir(TEST_DATA_DIR, { recursive: true });
    await writeFile(resolve(TEST_DATA_DIR, 'sns-token-state.json'), JSON.stringify({
      provider: 'x',
      configFingerprint: 'oauth2-config',
      accessToken: 'persisted-access-token',
      refreshToken: 'persisted-refresh-token',
      updatedAt: new Date().toISOString(),
    }), 'utf8');
    mockState.posts.getById.mockResolvedValue(makePostResponse(makePost({ id: 'oauth1-post' })));

    const provider = new XProvider({
      accessToken: 'oauth1-token',
      apiKey: 'api-key',
      apiSecret: 'api-secret',
      accessTokenSecret: 'access-secret',
      dataDir: TEST_DATA_DIR,
    });

    await expect(provider.getPost('oauth1-post')).resolves.toEqual(expect.objectContaining({ id: 'oauth1-post' }));
    expect(mockState.oauth1Configs).toEqual([expect.objectContaining({
      accessToken: 'oauth1-token',
      accessTokenSecret: 'access-secret',
    })]);
  });

  it('shares refresh state across provider instances using the same data directory', async () => {
    mockState.posts.getById
      .mockRejectedValueOnce(Object.assign(new Error('expired-a'), { status: 401 }))
      .mockRejectedValueOnce(Object.assign(new Error('expired-b'), { status: 401 }))
      .mockResolvedValue(makePostResponse(makePost({ id: 'shared-refresh-post' })));
    mockState.refreshTokenMock.mockImplementation(async () => {
      await new Promise((resolve) => { setTimeout(resolve, 10); });
      return {
        access_token: 'shared-access-token',
        refresh_token: 'shared-refresh-token',
        token_type: 'bearer',
        expires_in: 7200,
      };
    });

    const firstProvider = new XProvider({
      accessToken: 'old-access-token',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
      dataDir: TEST_DATA_DIR,
    });
    const secondProvider = new XProvider({
      accessToken: 'old-access-token',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
      dataDir: TEST_DATA_DIR,
    });

    await expect(Promise.all([
      firstProvider.getPost('shared-refresh-post'),
      secondProvider.getPost('shared-refresh-post'),
    ])).resolves.toHaveLength(2);
    expect(mockState.refreshTokenMock).toHaveBeenCalledTimes(1);
  });

  it('supports OAuth1 user context configuration', async () => {
    mockState.posts.getById.mockResolvedValue(makePostResponse(makePost({ id: 'oauth1-post' })));

    const provider = new XProvider({
      accessToken: 'oauth1-token',
      apiKey: 'api-key',
      apiSecret: 'api-secret',
      accessTokenSecret: 'access-secret',
    });

    await expect(provider.getPost('oauth1-post')).resolves.toEqual(expect.objectContaining({ id: 'oauth1-post' }));
    expect(mockState.oauth1Configs).toEqual([expect.objectContaining({
      apiKey: 'api-key',
      apiSecret: 'api-secret',
      accessToken: 'oauth1-token',
      accessTokenSecret: 'access-secret',
    })]);
    expect(mockState.oauth2Configs).toEqual([]);
  });
});
