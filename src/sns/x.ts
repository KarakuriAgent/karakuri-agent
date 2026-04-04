import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { Client, OAuth1, OAuth2 } from '@xdevplatform/xdk';

import type {
  NotificationFetchResult,
  NotificationParams,
  PostParams,
  SearchParams,
  SearchResult,
  SnsNotification,
  SnsPost,
  SnsProvider,
  ThreadResult,
  TimelineParams,
  UploadMediaParams,
  UploadMediaResult,
  UserPostsParams,
} from './types.js';
import {
  fetchWithValidatedRedirects,
  type LookupFn,
  ResponseTooLargeError,
} from '../utils/safe-fetch.js';
import { createLogger } from '../utils/logger.js';
import { KeyedMutex } from '../utils/mutex.js';

const logger = createLogger('XProvider');

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_MEDIA_BYTES = 40_000_000;
const MEDIA_CHUNK_SIZE = 5_000_000;
const MEDIA_POLL_INTERVAL_MS = 1_000;
const MAX_MEDIA_POLL_ATTEMPTS = 10;
const MAX_NOTIFICATION_PAGE_REQUESTS = 5;
const MAX_THREAD_PAGE_REQUESTS = 5;
// X の Recent Search API は過去 7 日間のツイートのみ対象。それ以前のスレッドは取得不可
const RECENT_THREAD_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const TOKEN_STATE_FILE_NAME = 'sns-token-state.json';
const POST_FIELDS = ['author_id', 'attachments', 'conversation_id', 'created_at', 'entities', 'in_reply_to_user_id', 'public_metrics', 'referenced_tweets'];
const POST_EXPANSIONS = ['attachments.media_keys', 'author_id', 'referenced_tweets.id', 'referenced_tweets.id.author_id', 'in_reply_to_user_id'];
const USER_FIELDS = ['id', 'name', 'username'];
const MEDIA_FIELDS = ['media_key', 'preview_image_url', 'type', 'url'];
const TOKEN_REFRESH_MUTEX = new KeyedMutex();

interface XUser {
  id: string;
  name?: string;
  username?: string;
}

interface XMedia {
  mediaKey?: string;
  url?: string;
  previewImageUrl?: string;
  type?: string;
}

interface XPostMetrics {
  retweetCount?: number;
  likeCount?: number;
  replyCount?: number;
}

interface XReferencedPost {
  id: string;
  type?: string;
}

interface XPost {
  id: string;
  text?: string;
  authorId?: string;
  createdAt?: string;
  conversationId?: string;
  inReplyToUserId?: string;
  referencedTweets?: XReferencedPost[];
  publicMetrics?: XPostMetrics;
  attachments?: {
    mediaKeys?: string[];
  };
}

interface XIncludes {
  users?: XUser[];
  media?: XMedia[];
  tweets?: XPost[];
}

interface XListResponse<T> {
  data?: T[];
  includes?: XIncludes;
  meta?: {
    nextToken?: string;
    newestId?: string;
    oldestId?: string;
    resultCount?: number;
  };
}

interface XSingleResponse<T> {
  data?: T;
  includes?: XIncludes;
}

interface XMediaUploadResponse {
  data?: {
    id?: string;
    mediaId?: string;
    processingInfo?: {
      state?: string;
      error?: {
        message?: string;
      };
    };
  };
}

interface XTokenState {
  provider: 'x';
  configFingerprint: string;
  accessToken: string;
  refreshToken?: string;
  updatedAt: string;
}

type SleepFn = (milliseconds: number) => Promise<void>;

class IncompleteThreadFetchError extends Error {
  constructor() {
    super('X thread could not be fetched completely before pagination limits were reached.');
    this.name = 'IncompleteThreadFetchError';
  }
}

export interface CreateXProviderOptions {
  accessToken: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  apiKey?: string;
  apiSecret?: string;
  accessTokenSecret?: string;
  dataDir?: string;
  lookupFn?: LookupFn;
  sleep?: SleepFn;
}

// Credential set が変わったら永続化済みトークンを破棄するための fingerprint
function hashTokenStateConfig(parts: Array<string | undefined>): string {
  return createHash('sha256')
    .update(parts.map((part) => part ?? '').join('\0'))
    .digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}


// XProvider はターンごとに再生成されるため毎回読み込まれるが、
// ファイルは数百バイトの JSON なので同期 I/O のブロックは無視できる。
// 非同期化するとコンストラクタを async にする必要があり、構造が複雑になるため同期のまま維持する。
function readPersistedTokenState(path: string): XTokenState | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    logger.warn('Failed to read persisted token state', error);
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.provider !== 'x') {
      return undefined;
    }
    if (typeof parsed.accessToken !== 'string' || parsed.accessToken.length === 0) {
      return undefined;
    }
    return {
      provider: 'x',
      configFingerprint: typeof parsed.configFingerprint === 'string' && parsed.configFingerprint.length > 0
        ? parsed.configFingerprint
        : '',
      accessToken: parsed.accessToken,
      ...(typeof parsed.refreshToken === 'string' && parsed.refreshToken.length > 0 ? { refreshToken: parsed.refreshToken } : {}),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
    };
  } catch (error) {
    logger.warn('Failed to parse persisted token state', error);
    return undefined;
  }
}

function getApiStatus(error: unknown): number | undefined {
  if (error instanceof Error && 'status' in error && typeof (error as { status?: unknown }).status === 'number') {
    return (error as { status: number }).status;
  }
  return undefined;
}

function buildPostUrl(username: string | undefined, postId: string): string {
  if (username != null && username.length > 0) {
    return `https://x.com/${username}/status/${postId}`;
  }
  return `https://x.com/i/web/status/${postId}`;
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (value == null) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

function getReplyToReference(post: XPost): XReferencedPost | undefined {
  return post.referencedTweets?.find((reference) => reference.type === 'replied_to');
}

function getQuotedReference(post: XPost): XReferencedPost | undefined {
  return post.referencedTweets?.find((reference) => reference.type === 'quoted');
}

function mergeIncludes(...includesList: Array<XIncludes | undefined>): XIncludes | undefined {
  const users = new Map<string, XUser>();
  const media = new Map<string, XMedia>();
  const tweets = new Map<string, XPost>();

  for (const includes of includesList) {
    for (const user of includes?.users ?? []) {
      users.set(user.id, user);
    }
    for (const item of includes?.media ?? []) {
      if (item.mediaKey != null) {
        media.set(item.mediaKey, item);
      }
    }
    for (const tweet of includes?.tweets ?? []) {
      tweets.set(tweet.id, tweet);
    }
  }

  if (users.size === 0 && media.size === 0 && tweets.size === 0) {
    return undefined;
  }

  return {
    ...(users.size > 0 ? { users: [...users.values()] } : {}),
    ...(media.size > 0 ? { media: [...media.values()] } : {}),
    ...(tweets.size > 0 ? { tweets: [...tweets.values()] } : {}),
  };
}

function mapUser(user: XUser): { id: string; name: string; handle: string; url: string } {
  const handle = user.username?.trim() || user.id;
  return {
    id: user.id,
    name: user.name?.trim() || handle,
    handle,
    url: `https://x.com/${handle}`,
  };
}

function findEffectivePost(post: XPost, includes: XIncludes | undefined): XPost {
  const repostReference = post.referencedTweets?.find((reference) => reference.type === 'retweeted');
  if (repostReference == null) {
    return post;
  }
  return includes?.tweets?.find((candidate) => candidate.id === repostReference.id) ?? post;
}

function mapTweet(post: XPost, includes: XIncludes | undefined): SnsPost {
  const effectivePost = findEffectivePost(post, includes);
  const author = includes?.users?.find((candidate) => candidate.id === effectivePost.authorId);
  const mappedAuthor = author != null
    ? mapUser(author)
    : {
        id: effectivePost.authorId ?? 'unknown',
        name: effectivePost.authorId ?? 'unknown',
        handle: effectivePost.authorId ?? 'unknown',
        url: buildPostUrl(undefined, effectivePost.id),
      };
  const mediaUrls = (effectivePost.attachments?.mediaKeys ?? [])
    .map((mediaKey) => includes?.media?.find((candidate) => candidate.mediaKey === mediaKey))
    .map((media) => media?.url ?? media?.previewImageUrl ?? undefined)
    .filter((url): url is string => url != null && url.length > 0);
  const replyToReference = getReplyToReference(effectivePost);

  return {
    id: effectivePost.id,
    ...(effectivePost.id !== post.id ? { timelineEntryId: post.id } : {}),
    text: effectivePost.text ?? '',
    authorId: mappedAuthor.id,
    authorName: mappedAuthor.name,
    authorHandle: mappedAuthor.handle,
    createdAt: effectivePost.createdAt ?? new Date(0).toISOString(),
    url: buildPostUrl(author?.username?.trim(), effectivePost.id),
    visibility: 'public',
    ...(replyToReference != null ? { inReplyToId: replyToReference.id } : {}),
    repostCount: effectivePost.publicMetrics?.retweetCount ?? 0,
    likeCount: effectivePost.publicMetrics?.likeCount ?? 0,
    replyCount: effectivePost.publicMetrics?.replyCount ?? 0,
    ...(mediaUrls.length > 0 ? { mediaUrls } : {}),
  };
}

function mapNotification(post: XPost, includes: XIncludes | undefined, currentUserId: string): SnsNotification {
  const mappedPost = mapTweet(post, includes);
  const quotedReference = getQuotedReference(post);
  const quotedPost = quotedReference != null
    ? includes?.tweets?.find((candidate) => candidate.id === quotedReference.id)
    : undefined;
  return {
    id: mappedPost.id,
    type: post.inReplyToUserId === currentUserId
      ? 'reply'
      : quotedPost?.authorId === currentUserId
        ? 'quote'
        : 'mention',
    createdAt: mappedPost.createdAt,
    accountId: mappedPost.authorId,
    accountName: mappedPost.authorName,
    accountHandle: mappedPost.authorHandle,
    post: mappedPost,
  };
}

function assertResponseData<T>(value: T | undefined, context: string): T {
  if (value == null) {
    throw new Error(`X API returned no data for ${context}`);
  }
  return value;
}

function normalizeMediaCategory(contentType: string | undefined): string {
  if (contentType == null) {
    return 'tweet_image';
  }
  if (contentType === 'image/gif') {
    return 'tweet_gif';
  }
  if (contentType.startsWith('video/')) {
    return 'tweet_video';
  }
  return 'tweet_image';
}

export class XProvider implements SnsProvider {
  private client: Client;
  private readonly lookupFn: LookupFn | undefined;
  private readonly sleepFn: SleepFn;
  private readonly tokenStatePath: string;
  private readonly tokenStateConfigFingerprint: string;
  private readonly oauth2: OAuth2 | undefined;
  private accessToken: string;
  private refreshToken: string | undefined;
  private currentUserPromise: Promise<XUser> | undefined;

  constructor({
    accessToken,
    clientId,
    clientSecret,
    refreshToken,
    apiKey,
    apiSecret,
    accessTokenSecret,
    dataDir = './data',
    lookupFn,
    sleep = async (milliseconds) => new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    }),
  }: CreateXProviderOptions) {
    this.lookupFn = lookupFn;
    this.sleepFn = sleep;
    this.tokenStatePath = resolve(dataDir, TOKEN_STATE_FILE_NAME);
    this.tokenStateConfigFingerprint = apiKey != null && apiSecret != null && accessTokenSecret != null
      ? hashTokenStateConfig(['oauth1', apiKey, apiSecret, accessTokenSecret, accessToken])
      : clientId != null
        ? hashTokenStateConfig(['oauth2', clientId, clientSecret, accessToken, refreshToken])
        : hashTokenStateConfig(['access-token', accessToken]);

    const persistedState = readPersistedTokenState(this.tokenStatePath);
    const canReusePersistedState = persistedState?.configFingerprint === this.tokenStateConfigFingerprint;
    this.accessToken = canReusePersistedState ? persistedState.accessToken : accessToken;
    this.refreshToken = canReusePersistedState
      ? persistedState.refreshToken ?? refreshToken
      : refreshToken;

    if (apiKey != null && apiSecret != null && accessTokenSecret != null) {
      const oauth1 = new OAuth1({
        apiKey,
        apiSecret,
        callback: 'oob',
        accessToken: this.accessToken,
        accessTokenSecret,
      });
      this.client = new Client({ oauth1, timeout: REQUEST_TIMEOUT_MS, retry: false });
      this.oauth2 = undefined;
      return;
    }

    if (clientId != null) {
      this.oauth2 = new OAuth2({
        clientId,
        ...(clientSecret != null ? { clientSecret } : {}),
        redirectUri: 'https://localhost',
      });
      this.oauth2.setToken({
        access_token: this.accessToken,
        token_type: 'bearer',
        expires_in: 7200,
        ...(this.refreshToken != null ? { refresh_token: this.refreshToken } : {}),
      });
    } else {
      this.oauth2 = undefined;
    }

    this.client = new Client({ accessToken: this.accessToken, timeout: REQUEST_TIMEOUT_MS, retry: false });
  }

  async post(params: PostParams): Promise<SnsPost> {
    if (params.visibility != null && params.visibility !== 'public') {
      throw new Error('X only supports public visibility');
    }

    const response = await this.callWithRefresh((client) => client.posts.create({
      text: params.text,
      ...(params.replyToId != null ? { reply: { in_reply_to_tweet_id: params.replyToId } } : {}),
      ...(params.quotePostId != null ? { quote_tweet_id: params.quotePostId } : {}),
      ...(params.mediaIds != null && params.mediaIds.length > 0 ? { media: { media_ids: params.mediaIds } } : {}),
    }));
    const created = assertResponseData((response as XSingleResponse<XPost>).data, 'posts.create');
    return this.getPost(created.id);
  }

  async getPost(postId: string): Promise<SnsPost> {
    const response = await this.callWithRefresh((client) => client.posts.getById(postId, {
      tweetFields: POST_FIELDS,
      expansions: POST_EXPANSIONS,
      mediaFields: MEDIA_FIELDS,
      userFields: USER_FIELDS,
    }));
    const post = assertResponseData((response as XSingleResponse<XPost>).data, 'posts.getById');
    return mapTweet(post, (response as XSingleResponse<XPost>).includes);
  }

  async getTimeline(params: TimelineParams = {}): Promise<SnsPost[]> {
    const currentUser = await this.getCurrentUser();
    const response = await this.callWithRefresh((client) => client.users.getTimeline(currentUser.id, {
      ...(params.limit != null ? { maxResults: params.limit } : {}),
      ...(params.sinceId != null ? { sinceId: params.sinceId } : {}),
      ...(params.maxId != null ? { untilId: params.maxId } : {}),
      tweetFields: POST_FIELDS,
      expansions: POST_EXPANSIONS,
      mediaFields: MEDIA_FIELDS,
      userFields: USER_FIELDS,
    }));
    return ((response as XListResponse<XPost>).data ?? []).map((post) => mapTweet(post, (response as XListResponse<XPost>).includes));
  }

  async search(params: SearchParams): Promise<SearchResult> {
    if (params.type === 'users') {
      const response = await this.callWithRefresh((client) => client.users.search(params.query, {
        ...(params.limit != null ? { maxResults: params.limit } : {}),
        userFields: USER_FIELDS,
      }));
      const users = ((response as XListResponse<XUser>).data ?? []).map((user) => mapUser(user));
      return { posts: [], users };
    }

    const response = await this.callWithRefresh((client) => client.posts.searchRecent(params.query, {
      ...(params.limit != null ? { maxResults: params.limit } : {}),
      tweetFields: POST_FIELDS,
      expansions: POST_EXPANSIONS,
      mediaFields: MEDIA_FIELDS,
      userFields: USER_FIELDS,
    }));
    return {
      posts: ((response as XListResponse<XPost>).data ?? []).map((post) => mapTweet(post, (response as XListResponse<XPost>).includes)),
      users: [],
    };
  }

  async like(postId: string): Promise<SnsPost> {
    const currentUser = await this.getCurrentUser();
    await this.callWithRefresh((client) => client.users.likePost(currentUser.id, {
      body: { tweetId: postId },
    }));
    return this.getPost(postId);
  }

  async repost(postId: string): Promise<SnsPost> {
    const currentUser = await this.getCurrentUser();
    await this.callWithRefresh((client) => client.users.repostPost(currentUser.id, {
      body: { tweetId: postId },
    }));
    return this.getPost(postId);
  }

  async getNotifications(params: NotificationParams = {}): Promise<NotificationFetchResult> {
    let currentUser: XUser;
    try {
      currentUser = await this.getCurrentUser();
    } catch (error) {
      if (getApiStatus(error) === 429) {
        logger.warn('X API rate limit hit while loading current user for notifications');
        return {
          notifications: [],
          complete: false,
        };
      }
      throw error;
    }
    const requestedLimit = params.limit ?? 5;
    const requestedTypes = params.types != null ? new Set(params.types) : null;
    const collected: SnsNotification[] = [];
    let nextToken: string | undefined;
    let pageRequests = 0;
    let complete = true;

    while (collected.length < requestedLimit && pageRequests < MAX_NOTIFICATION_PAGE_REQUESTS) {
      pageRequests += 1;
      try {
        const response = await this.callWithRefresh((client) => client.users.getMentions(currentUser.id, {
          ...(params.sinceId != null ? { sinceId: params.sinceId } : {}),
          ...(params.maxId != null ? { untilId: params.maxId } : {}),
          ...(nextToken != null ? { paginationToken: nextToken } : {}),
          maxResults: Math.min(Math.max(requestedLimit * 3, 20), 100),
          tweetFields: POST_FIELDS,
          expansions: POST_EXPANSIONS,
          mediaFields: MEDIA_FIELDS,
          userFields: USER_FIELDS,
        }));
        const typedResponse = response as XListResponse<XPost>;
        const page = (typedResponse.data ?? [])
          .map((post) => mapNotification(post, typedResponse.includes, currentUser.id))
          .filter((notification) => requestedTypes == null || requestedTypes.has(notification.type));
        collected.push(...page);
        nextToken = typedResponse.meta?.nextToken;
        if (nextToken == null) {
          break;
        }
      } catch (error) {
        if (getApiStatus(error) === 429) {
          logger.warn('X API rate limit hit during notification pagination');
          complete = false;
          break;
        }
        throw error;
      }
    }

    if (nextToken != null && collected.length < requestedLimit) {
      complete = false;
    }

    return {
      notifications: collected.slice(0, requestedLimit),
      complete,
    };
  }

  async uploadMedia(params: UploadMediaParams): Promise<UploadMediaResult> {
    let mediaResponse: Response;
    let mediaBodyBytes: Uint8Array | undefined;

    try {
      ({ response: mediaResponse, bodyBytes: mediaBodyBytes } = await fetchWithValidatedRedirects(params.url, {
        ...(this.lookupFn != null ? { lookupFn: this.lookupFn } : {}),
        requestInit: {
          headers: {
            Accept: '*/*',
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
        maxResponseBytes: MAX_MEDIA_BYTES,
      }));
    } catch (error) {
      if (error instanceof ResponseTooLargeError) {
        throw new Error(`Media file exceeds ${MAX_MEDIA_BYTES} bytes.`);
      }
      throw error;
    }

    if (!mediaResponse.ok) {
      throw new Error(`Failed to fetch media from ${params.url}: ${mediaResponse.status} ${mediaResponse.statusText}`);
    }

    const contentType = mediaResponse.headers.get('content-type') ?? undefined;
    const bytes = mediaBodyBytes ?? new Uint8Array(0);
    // SDK の型定義が特定リテラル型を要求するため as キャストで回避
    const initialize = await this.callWithRefresh((client) => client.media.initializeUpload({
      body: {
        totalBytes: bytes.byteLength,
        mediaType: (contentType || 'image/png') as 'image/png',
        mediaCategory: normalizeMediaCategory(contentType) as 'tweet_image' | 'tweet_gif' | 'tweet_video',
      },
    }));
    const mediaId = (initialize as XMediaUploadResponse).data?.id ?? (initialize as XMediaUploadResponse).data?.mediaId;
    if (mediaId == null || mediaId.length === 0) {
      throw new Error('Invalid X media upload response');
    }

    for (let offset = 0, segmentIndex = 0; offset < bytes.byteLength; offset += MEDIA_CHUNK_SIZE, segmentIndex += 1) {
      const chunk = bytes.slice(offset, Math.min(offset + MEDIA_CHUNK_SIZE, bytes.byteLength));
      await this.callWithRefresh((client) => client.media.appendUpload(mediaId, {
        body: {
          segmentIndex,
          media: Buffer.from(chunk).toString('base64'),
        },
      }));
    }

    await this.callWithRefresh((client) => client.media.finalizeUpload(mediaId));
    await this.waitForMediaReady(mediaId);

    if (params.altText != null) {
      await this.callWithRefresh((client) => client.media.createMetadata({
        body: {
          id: mediaId,
          metadata: {
            alt_text: { text: params.altText },
          },
        },
      }));
    }

    return { mediaId };
  }

  async getThread(postId: string): Promise<ThreadResult> {
    const response = await this.callWithRefresh((client) => client.posts.getById(postId, {
      tweetFields: POST_FIELDS,
      expansions: POST_EXPANSIONS,
      mediaFields: MEDIA_FIELDS,
      userFields: USER_FIELDS,
    }));
    const typedResponse = response as XSingleResponse<XPost>;
    const target = assertResponseData(typedResponse.data, 'posts.getById');
    const targetTimestamp = parseTimestamp(target.createdAt);
    if (targetTimestamp != null && Date.now() - targetTimestamp > RECENT_THREAD_WINDOW_MS) {
      return { ancestors: [], descendants: [] };
    }

    const currentUser = await this.getCurrentUser();
    const conversationId = target.conversationId ?? target.id;
    const allPostsById = new Map<string, XPost>();
    const includesList: Array<XIncludes | undefined> = [typedResponse.includes];
    for (const post of [
      target,
      ...(typedResponse.includes?.tweets ?? []),
    ]) {
      allPostsById.set(post.id, post);
    }

    let nextToken: string | undefined;
    let pageRequests = 0;
    do {
      pageRequests += 1;
      const conversation = await this.callWithRefresh((client) => client.posts.searchRecent(`conversation_id:${conversationId}`, {
        ...(nextToken != null ? { paginationToken: nextToken } : {}),
        maxResults: 100,
        tweetFields: POST_FIELDS,
        expansions: POST_EXPANSIONS,
        mediaFields: MEDIA_FIELDS,
        userFields: USER_FIELDS,
      }));
      const typedConversation = conversation as XListResponse<XPost>;
      includesList.push(typedConversation.includes);
      for (const post of [
        ...(typedConversation.includes?.tweets ?? []),
        ...(typedConversation.data ?? []),
      ]) {
        allPostsById.set(post.id, post);
      }
      nextToken = typedConversation.meta?.nextToken;
    } while (nextToken != null && pageRequests < MAX_THREAD_PAGE_REQUESTS);

    if (nextToken != null) {
      throw new IncompleteThreadFetchError();
    }

    const mergedIncludes = mergeIncludes(...includesList);

    const ancestorChain: XPost[] = [];
    const seenAncestorIds = new Set<string>();
    let parentId = getReplyToReference(target)?.id;
    while (parentId != null && !seenAncestorIds.has(parentId)) {
      seenAncestorIds.add(parentId);
      const parentPost = allPostsById.get(parentId);
      if (parentPost == null) {
        return { ancestors: [], descendants: [] };
      }
      ancestorChain.push(parentPost);
      parentId = getReplyToReference(parentPost)?.id;
    }

    const childrenByParentId = new Map<string, XPost[]>();
    for (const post of allPostsById.values()) {
      if (post.id === target.id) {
        continue;
      }
      const replyToId = getReplyToReference(post)?.id;
      if (replyToId == null) {
        continue;
      }
      const children = childrenByParentId.get(replyToId);
      if (children != null) {
        children.push(post);
      } else {
        childrenByParentId.set(replyToId, [post]);
      }
    }

    const descendantSubtree: XPost[] = [];
    const queue = [...(childrenByParentId.get(target.id) ?? [])];
    const seenDescendantIds = new Set<string>();
    while (queue.length > 0) {
      const post = queue.shift();
      if (post == null || seenDescendantIds.has(post.id)) {
        continue;
      }
      seenDescendantIds.add(post.id);
      descendantSubtree.push(post);
      queue.push(...(childrenByParentId.get(post.id) ?? []));
    }

    return {
      ancestors: ancestorChain
        .reverse()
        .filter((post) => post.authorId !== currentUser.id)
        .map((post) => mapTweet(post, mergedIncludes)),
      descendants: descendantSubtree
        .filter((post) => post.authorId !== currentUser.id)
        .sort((left, right) => (parseTimestamp(left.createdAt) ?? 0) - (parseTimestamp(right.createdAt) ?? 0))
        .map((post) => mapTweet(post, mergedIncludes)),
    };
  }

  async getUserPosts(params: UserPostsParams): Promise<SnsPost[]> {
    const userResponse = await this.callWithRefresh((client) => client.users.getByUsername(params.userHandle, {
      userFields: USER_FIELDS,
    }));
    const user = assertResponseData((userResponse as XSingleResponse<XUser>).data, 'users.getByUsername');
    const postsResponse = await this.callWithRefresh((client) => client.users.getPosts(user.id, {
      ...(params.limit != null ? { maxResults: params.limit } : {}),
      ...(params.excludeReplies === true ? { exclude: ['replies'] } : {}),
      tweetFields: POST_FIELDS,
      expansions: POST_EXPANSIONS,
      mediaFields: MEDIA_FIELDS,
      userFields: USER_FIELDS,
    }));
    return ((postsResponse as XListResponse<XPost>).data ?? []).map((post) => mapTweet(post, (postsResponse as XListResponse<XPost>).includes));
  }

  // X API v2 の Trends エンドポイントはトピック名のみ返し SnsPost に変換できないため空配列を返す
  async getTrends(_limit = 5): Promise<SnsPost[]> {
    return [];
  }

  private async getCurrentUser(): Promise<XUser> {
    this.currentUserPromise ??= this.callWithRefresh((client) => client.users.getMe({ userFields: USER_FIELDS }))
      .then((response) => assertResponseData((response as XSingleResponse<XUser>).data, 'users.getMe'))
      .catch((error) => {
        this.currentUserPromise = undefined;
        throw error;
      });
    return this.currentUserPromise;
  }

  private async callWithRefresh<T>(operation: (client: Client) => Promise<T>): Promise<T> {
    const failedAccessToken = this.accessToken;
    const client = this.client;
    try {
      return await operation(client);
    } catch (error) {
      if (getApiStatus(error) !== 401 || this.oauth2 == null || this.refreshToken == null) {
        throw error;
      }
      logger.info('X API returned 401; attempting token refresh');
      await this.handleTokenRefresh(failedAccessToken);
      logger.info('X token refresh completed; retrying operation');
      return operation(this.client);
    }
  }

  private async handleTokenRefresh(failedAccessToken: string): Promise<void> {
    await TOKEN_REFRESH_MUTEX.runExclusive(this.tokenStatePath, async () => {
      if (this.oauth2 == null || this.refreshToken == null) {
        throw new Error('X OAuth2 refresh is not configured');
      }
      if (this.accessToken !== failedAccessToken) {
        return;
      }
      const persistedState = readPersistedTokenState(this.tokenStatePath);
      if (
        persistedState?.configFingerprint === this.tokenStateConfigFingerprint
        && persistedState.accessToken !== failedAccessToken
      ) {
        this.applyTokenState(persistedState.accessToken, persistedState.refreshToken);
        return;
      }

      const nextToken = await this.oauth2.refreshToken(this.refreshToken);
      this.applyTokenState(nextToken.access_token, nextToken.refresh_token ?? this.refreshToken);
      try {
        await this.persistTokenState();
      } catch (persistError) {
        logger.warn('Failed to persist refreshed token state; on restart the old token will be used and a new refresh cycle will occur', persistError);
      }
    });
  }

  private applyTokenState(accessToken: string, refreshToken: string | undefined): void {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    if (this.oauth2 != null) {
      this.oauth2.setToken({
        access_token: this.accessToken,
        token_type: 'bearer',
        expires_in: 7200,
        ...(this.refreshToken != null ? { refresh_token: this.refreshToken } : {}),
      });
    }
    this.client = new Client({ accessToken: this.accessToken, timeout: REQUEST_TIMEOUT_MS, retry: false });
    this.currentUserPromise = undefined;
  }

  private async persistTokenState(): Promise<void> {
    const state: XTokenState = {
      provider: 'x',
      configFingerprint: this.tokenStateConfigFingerprint,
      accessToken: this.accessToken,
      ...(this.refreshToken != null ? { refreshToken: this.refreshToken } : {}),
      updatedAt: new Date().toISOString(),
    };
    await mkdir(dirname(this.tokenStatePath), { recursive: true });
    await writeFile(this.tokenStatePath, `${JSON.stringify(state, null, 2)}
`, 'utf8');
  }

  private async waitForMediaReady(mediaId: string): Promise<void> {
    for (let attempt = 0; attempt < MAX_MEDIA_POLL_ATTEMPTS; attempt += 1) {
      const response = await this.callWithRefresh((client) => client.media.getUploadStatus(mediaId));
      const processingInfo = (response as XMediaUploadResponse).data?.processingInfo;
      const state = processingInfo?.state;
      if (state == null || state === 'succeeded') {
        return;
      }
      if (state === 'failed') {
        throw new Error(processingInfo?.error?.message ?? 'X media processing failed');
      }
      if (attempt === MAX_MEDIA_POLL_ATTEMPTS - 1) {
        break;
      }
      await this.sleepFn(MEDIA_POLL_INTERVAL_MS);
    }

    throw new Error('X media is still processing. Try again shortly.');
  }
}
