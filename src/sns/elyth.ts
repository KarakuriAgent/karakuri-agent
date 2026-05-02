import { createLogger } from '../utils/logger.js';

import type {
  NotificationFetchResult,
  NotificationParams,
  PostParams,
  SearchParams,
  SearchResult,
  SnsMyMetrics,
  SnsNotification,
  SnsPost,
  SnsProvider,
  SnsUserProfile,
  ThreadResult,
  TimelineParams,
  UploadMediaParams,
  UploadMediaResult,
  UserPostsParams,
} from './types.js';

const logger = createLogger('ElythProvider');
const REQUEST_TIMEOUT_MS = 15_000;

export interface CreateElythProviderOptions {
  apiKey: string;
  apiBase: string;
  fetch?: typeof fetch;
}

interface ElythPostAituber {
  id?: string | null;
  name?: string | null;
  display_name?: string | null;
  handle?: string | null;
}

interface ElythPost {
  id: string;
  content: string;
  reply_to_id?: string | null;
  thread_id?: string | null;
  created_at: string;
  author_id?: string | null;
  author_name?: string | null;
  author_handle?: string | null;
  author_type?: 'user' | 'aituber' | string | null;
  aituber?: ElythPostAituber | null;
  like_count?: number | null;
  reply_count?: number | null;
  liked_by_me?: boolean | null;
}

interface ElythPostsResponse {
  posts?: ElythPost[];
  error?: string;
}

interface ElythPostResponse {
  success?: boolean;
  post?: ElythPost;
  error?: string;
}

interface ElythLikeResponse {
  success?: boolean;
  data?: { liked?: boolean; like_count?: number };
  error?: string;
}

interface ElythFollowResponse {
  success?: boolean;
  data?: { following?: boolean; follower_count?: number };
  error?: string;
}

interface ElythAituberProfile {
  display_name: string;
  handle: string;
  bio: string | null;
  follower_count: number;
  following_count: number;
  post_count: number;
  followed_by_me?: boolean | null;
}

interface ElythAituberResponse {
  profile?: ElythAituberProfile;
  posts?: ElythPost[];
  error?: string;
}

interface ElythNotification {
  notification_id: string;
  notification_type: 'reply' | 'mention' | 'system' | 'image_failed' | string;
  notification_created_at: string;
  post_id?: string | null;
  post_content?: string | null;
  post_reply_to_id?: string | null;
  post_thread_id?: string | null;
  post_created_at?: string | null;
  post_author_id?: string | null;
  post_author_name?: string | null;
  post_author_handle?: string | null;
  post_like_count?: number | null;
  post_reply_count?: number | null;
}

interface ElythInformationResponse {
  timeline?: ElythPost[];
  notifications?: ElythNotification[];
  my_metrics?: {
    follower_count: number;
    following_count: number;
    post_count: number;
  };
  error?: string;
}

interface ElythMarkNotificationsReadResponse {
  success?: boolean;
  marked_count?: number;
  error?: string;
}

/** ELYTH API が non-2xx を返したか、レスポンスが論理エラー (`error` フィールド) を含む場合に投げる。retry の判断は `status` を見て行う。 */
export class ElythApiError extends Error {
  readonly status: number;
  readonly details: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(`ELYTH API returned ${status}: ${message}`);
    this.name = 'ElythApiError';
    this.status = status;
    this.details = details;
  }
}

/** ELYTH では恒久的にサポートされない機能 (画像・repost・search・非 public visibility) を呼び出した場合に投げる。retry 不要。 */
export class ElythNotSupportedError extends Error {
  readonly feature: string;

  constructor(feature: string) {
    super(`ELYTH does not support ${feature}`);
    this.name = 'ElythNotSupportedError';
    this.feature = feature;
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function normalizeHandle(handle: string): string {
  return handle.trim().replace(/^@/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed != null && trimmed.length > 0) {
      return trimmed;
    }
  }
  return undefined;
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function mapPost(post: ElythPost, apiBase: string): SnsPost {
  const authorHandle = firstNonEmpty(post.author_handle, post.aituber?.handle, post.author_id, post.aituber?.id) ?? 'unknown';
  const authorName = firstNonEmpty(post.author_name, post.aituber?.name, post.aituber?.display_name) ?? authorHandle;
  const authorId = firstNonEmpty(post.author_id, post.aituber?.id, post.aituber?.handle) ?? authorHandle;

  return {
    id: post.id,
    text: post.content,
    authorId,
    authorName,
    authorHandle,
    createdAt: post.created_at,
    url: `${apiBase}/posts/${encodeURIComponent(post.id)}`,
    visibility: 'public',
    ...(post.reply_to_id != null ? { inReplyToId: post.reply_to_id } : {}),
    // ELYTH には repost 概念がないため常に 0。
    repostCount: 0,
    likeCount: post.like_count ?? 0,
    replyCount: post.reply_count ?? 0,
    ...(post.liked_by_me != null ? { liked: post.liked_by_me } : {}),
  };
}

function mapAituberProfilePost(
  post: ElythPost,
  profile: ElythAituberProfile | undefined,
  fallbackHandle: string,
  apiBase: string,
): SnsPost {
  const profileHandle = firstNonEmpty(profile?.handle, fallbackHandle) ?? 'unknown';
  const profileName = firstNonEmpty(profile?.display_name, profileHandle) ?? profileHandle;

  return mapPost({
    ...post,
    author_id: firstNonEmpty(post.author_id, profileHandle) ?? profileHandle,
    author_name: firstNonEmpty(post.author_name, profileName) ?? profileName,
    author_handle: firstNonEmpty(post.author_handle, profileHandle) ?? profileHandle,
  }, apiBase);
}

function mapNotification(notification: ElythNotification, apiBase: string): SnsNotification {
  const post = notification.post_id != null && notification.post_id.length > 0
    ? mapPost({
        id: notification.post_id,
        content: notification.post_content ?? '',
        ...(notification.post_reply_to_id !== undefined ? { reply_to_id: notification.post_reply_to_id } : {}),
        ...(notification.post_thread_id !== undefined ? { thread_id: notification.post_thread_id } : {}),
        created_at: notification.post_created_at ?? notification.notification_created_at,
        ...(notification.post_author_id !== undefined ? { author_id: notification.post_author_id } : {}),
        ...(notification.post_author_name !== undefined ? { author_name: notification.post_author_name } : {}),
        ...(notification.post_author_handle !== undefined ? { author_handle: notification.post_author_handle } : {}),
        ...(notification.post_like_count !== undefined ? { like_count: notification.post_like_count } : {}),
        ...(notification.post_reply_count !== undefined ? { reply_count: notification.post_reply_count } : {}),
      }, apiBase)
    : undefined;
  const accountHandle = notification.post_author_handle ?? notification.post_author_id ?? 'unknown';
  const mappedType = (() => {
    switch (notification.notification_type) {
      case 'reply':
        return 'reply';
      case 'mention':
        return 'mention';
      default:
        return 'other';
    }
  })();

  return {
    id: notification.notification_id,
    type: mappedType,
    createdAt: notification.notification_created_at,
    accountId: notification.post_author_id ?? accountHandle,
    accountName: notification.post_author_name ?? accountHandle,
    accountHandle,
    ...(post != null ? { post } : {}),
  };
}

export class ElythProvider implements SnsProvider {
  // ELYTH に trends 概念は無い。プロセス全体で初回のみ info ログを出すためのフラグ。
  static #trendsWarned = false;

  private readonly apiBase: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private currentAccountHandlePromise: Promise<string> | undefined;

  constructor({
    apiKey,
    apiBase,
    fetch: fetchImpl = (...args) => globalThis.fetch(...args),
  }: CreateElythProviderOptions) {
    this.apiBase = apiBase.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
  }

  async post(params: PostParams): Promise<SnsPost> {
    if (params.visibility != null && params.visibility !== 'public') {
      throw new ElythNotSupportedError('non-public visibility');
    }
    if (params.mediaIds != null && params.mediaIds.length > 0) {
      throw new ElythNotSupportedError('media uploads');
    }
    if (params.quotePostId != null) {
      throw new ElythNotSupportedError('quote posts');
    }

    const response = await this.requestJson<ElythPostResponse>('POST', 'api/mcp/posts', {
      content: params.text,
      ...(params.replyToId != null ? { reply_to_id: params.replyToId } : {}),
    });
    if (response.error != null || response.success === false || response.post == null) {
      throw new ElythApiError(400, response.error ?? 'post_failed', response);
    }
    return mapPost(response.post, this.apiBase);
  }

  async getPost(postId: string): Promise<SnsPost> {
    // TODO(#73): ELYTH に GET /api/mcp/posts/:id が追加されたら thread fallback を削除する
    const response = await this.getThreadResponse(postId);
    if (response.error != null) {
      throw new ElythApiError(400, response.error, response);
    }
    if (response.posts == null) {
      throw new ElythApiError(502, 'thread_api_does_not_include_target', response);
    }
    const target = response.posts.find((post) => post.id === postId);
    if (target == null) {
      throw new ElythApiError(404, 'post_not_found', response);
    }
    return mapPost(target, this.apiBase);
  }

  async getTimeline(params: TimelineParams = {}): Promise<SnsPost[]> {
    const response = await this.requestJson<ElythInformationResponse>('GET', 'api/mcp/information', undefined, {
      include: 'timeline',
      timeline_limit: String(params.limit ?? 20),
    });
    if (response.error != null) {
      throw new ElythApiError(400, response.error, response);
    }
    return (response.timeline ?? []).map((post) => mapPost(post, this.apiBase));
  }

  async search(_params: SearchParams): Promise<SearchResult> {
    throw new ElythNotSupportedError('search');
  }

  async like(postId: string): Promise<SnsPost> {
    const response = await this.requestJson<ElythLikeResponse>('POST', `api/mcp/posts/${encodeURIComponent(postId)}/like`);
    if (response.error != null || response.success === false || response.data == null) {
      throw new ElythApiError(400, response.error ?? 'like_failed', response);
    }
    return this.getPost(postId);
  }

  async unlike(postId: string): Promise<SnsPost> {
    const response = await this.requestJson<ElythLikeResponse>('DELETE', `api/mcp/posts/${encodeURIComponent(postId)}/like`);
    if (response.error != null || response.success === false || response.data == null) {
      throw new ElythApiError(400, response.error ?? 'unlike_failed', response);
    }
    return this.getPost(postId);
  }

  async repost(_postId: string): Promise<SnsPost> {
    throw new ElythNotSupportedError('repost');
  }

  async follow(handle: string): Promise<void> {
    const normalized = normalizeHandle(handle);
    const response = await this.requestJson<ElythFollowResponse>('POST', `api/mcp/aitubers/${encodeURIComponent(normalized)}/follow`);
    if (response.error != null || response.success === false || response.data == null) {
      throw new ElythApiError(400, response.error ?? 'follow_failed', response);
    }
  }

  async unfollow(handle: string): Promise<void> {
    const normalized = normalizeHandle(handle);
    const response = await this.requestJson<ElythFollowResponse>('DELETE', `api/mcp/aitubers/${encodeURIComponent(normalized)}/follow`);
    if (response.error != null || response.success === false || response.data == null) {
      throw new ElythApiError(400, response.error ?? 'unfollow_failed', response);
    }
  }

  async getUserProfile(handle: string): Promise<SnsUserProfile> {
    const response = await this.getAituber(normalizeHandle(handle));
    if (response.error != null || response.profile == null) {
      throw new ElythApiError(404, response.error ?? 'profile_not_found', response);
    }
    const profile = response.profile;
    return {
      id: profile.handle,
      name: profile.display_name,
      handle: profile.handle,
      url: `${this.apiBase}/aitubers/${encodeURIComponent(profile.handle)}`,
      ...(profile.bio != null ? { bio: profile.bio } : {}),
      followerCount: profile.follower_count,
      followingCount: profile.following_count,
      postCount: profile.post_count,
      ...(profile.followed_by_me != null ? { followedByMe: profile.followed_by_me } : {}),
    };
  }

  async getMyMetrics(): Promise<SnsMyMetrics> {
    const response = await this.requestJson<ElythInformationResponse>('GET', 'api/mcp/information', undefined, {
      include: 'my_metrics',
    });
    if (response.error != null || response.my_metrics == null) {
      throw new ElythApiError(400, response.error ?? 'my_metrics_unavailable', response);
    }
    return {
      followerCount: response.my_metrics.follower_count,
      followingCount: response.my_metrics.following_count,
      postCount: response.my_metrics.post_count,
    };
  }

  async markNotificationsRead(notificationIds: string[]): Promise<void> {
    if (notificationIds.length === 0) {
      return;
    }
    const response = await this.requestJson<ElythMarkNotificationsReadResponse>('POST', 'api/mcp/notifications/read', {
      notification_ids: notificationIds,
    });
    if (response.error != null || response.success === false) {
      throw new ElythApiError(400, response.error ?? 'mark_notifications_read_failed', response);
    }
  }

  async getNotifications(params: NotificationParams = {}): Promise<NotificationFetchResult> {
    const requestedLimit = params.limit ?? 5;
    try {
      const response = await this.requestJson<ElythInformationResponse>('GET', 'api/mcp/information', undefined, {
        include: 'notifications',
        notifications_limit: String(requestedLimit),
      });
      if (response.error != null) {
        throw new ElythApiError(400, response.error, response);
      }
      const rawNotifications = response.notifications ?? [];
      // サーバが limit と同数返してきた場合、ELYTH には次ページ取得手段がないため
      // それ以前の通知を取りこぼしうる。complete:false にして cursor を進めない。
      let complete = rawNotifications.length < requestedLimit;
      const requestedTypes = params.types != null ? new Set(params.types) : null;
      let notifications = rawNotifications
        .map((notification) => mapNotification(notification, this.apiBase))
        .filter((notification) => requestedTypes == null || requestedTypes.has(notification.type));
      if (params.sinceId != null) {
        const cursorIndex = notifications.findIndex((notification) => notification.id === params.sinceId);
        if (cursorIndex >= 0) {
          notifications = notifications.slice(0, cursorIndex);
        } else {
          // sinceId がページ内に無いと「sinceId 以降の通知だけ返す」契約を満たせない。
          logger.warn('ELYTH sinceId not found in current notifications page', { sinceId: params.sinceId });
          complete = false;
        }
      }
      if (params.maxId != null) {
        const cursorIndex = notifications.findIndex((notification) => notification.id === params.maxId);
        if (cursorIndex >= 0) {
          notifications = notifications.slice(cursorIndex + 1);
        } else {
          logger.warn('ELYTH maxId not found in current notifications page', { maxId: params.maxId });
          complete = false;
        }
      }
      notifications = notifications.slice(0, requestedLimit);
      return { notifications, complete };
    } catch (error) {
      if (error instanceof ElythApiError && error.status === 429) {
        const retryAfter = isRecord(error.details) && typeof error.details.retryAfter === 'string'
          ? error.details.retryAfter
          : undefined;
        logger.warn(`ELYTH notification fetch rate limited${retryAfter != null ? `; retry-after=${retryAfter}` : ''}`);
        return { notifications: [], complete: false };
      }
      throw error;
    }
  }

  async uploadMedia(_params: UploadMediaParams): Promise<UploadMediaResult> {
    throw new ElythNotSupportedError('media uploads');
  }

  async getThread(postId: string): Promise<ThreadResult> {
    const response = await this.getThreadResponse(postId);
    if (response.error != null) {
      throw new ElythApiError(400, response.error, response);
    }
    const posts = response.posts ?? [];
    const target = posts.find((post) => post.id === postId);
    if (target == null) {
      return { ancestors: [], descendants: [] };
    }

    const postsById = new Map(posts.map((post) => [post.id, post]));
    const ancestorChain: ElythPost[] = [];
    const seenAncestorIds = new Set<string>([target.id]);
    let parentId = target.reply_to_id ?? undefined;
    let ancestorMissingId: string | undefined;
    while (parentId != null && !seenAncestorIds.has(parentId)) {
      seenAncestorIds.add(parentId);
      const parent = postsById.get(parentId);
      if (parent == null) {
        // ancestor チェーンが thread レスポンスから欠損している場合は ancestor だけ
        // 諦めて descendants の計算は続行する。完全に空オブジェクトを返すと、
        // 取得済みの descendants まで失われ agent から原因が見えなくなる。
        ancestorMissingId = parentId;
        break;
      }
      ancestorChain.push(parent);
      parentId = parent.reply_to_id ?? undefined;
    }
    if (ancestorMissingId != null) {
      logger.warn('ELYTH thread response missing ancestor', { postId, missingParentId: ancestorMissingId });
    }
    const ancestorPosts = ancestorMissingId != null ? [] : ancestorChain;

    const childrenByParentId = new Map<string, ElythPost[]>();
    for (const post of posts) {
      if (post.id === target.id || post.reply_to_id == null) {
        continue;
      }
      const children = childrenByParentId.get(post.reply_to_id);
      if (children != null) {
        children.push(post);
      } else {
        childrenByParentId.set(post.reply_to_id, [post]);
      }
    }

    const descendants: ElythPost[] = [];
    const queue = [...(childrenByParentId.get(target.id) ?? [])];
    const seenDescendantIds = new Set<string>();
    while (queue.length > 0) {
      const post = queue.shift();
      if (post == null || seenDescendantIds.has(post.id)) {
        continue;
      }
      seenDescendantIds.add(post.id);
      descendants.push(post);
      queue.push(...(childrenByParentId.get(post.id) ?? []));
    }

    return {
      ancestors: ancestorPosts.slice().reverse().map((post) => mapPost(post, this.apiBase)),
      descendants: descendants
        .sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at))
        .map((post) => mapPost(post, this.apiBase)),
    };
  }

  async getUserPosts(params: UserPostsParams): Promise<SnsPost[]> {
    const normalized = normalizeHandle(params.userHandle);
    const currentHandle = await this.getCurrentAccountHandle();
    if (normalized === currentHandle) {
      const response = await this.requestJson<ElythPostsResponse>('GET', 'api/mcp/posts/mine', undefined, {
        limit: String(params.limit ?? 20),
      });
      if (response.error != null) {
        throw new ElythApiError(400, response.error, response);
      }
      return (response.posts ?? [])
        .filter((post) => params.excludeReplies !== true || post.reply_to_id == null)
        .map((post) => mapPost(post, this.apiBase));
    }

    const response = await this.getAituber(normalized, params.limit ?? 20);
    if (response.error != null) {
      throw new ElythApiError(404, response.error, response);
    }
    return (response.posts ?? [])
      .filter((post) => params.excludeReplies !== true || post.reply_to_id == null)
      .map((post) => mapAituberProfilePost(post, response.profile, normalized, this.apiBase));
  }

  async getTrends(_limit = 5): Promise<SnsPost[]> {
    if (!ElythProvider.#trendsWarned) {
      ElythProvider.#trendsWarned = true;
      logger.info('ELYTH does not support trends; returning empty array');
    }
    return [];
  }

  private async getThreadResponse(postId: string): Promise<ElythPostsResponse> {
    return this.requestJson<ElythPostsResponse>('GET', `api/mcp/posts/${encodeURIComponent(postId)}/thread`);
  }

  private async getAituber(handle: string, limit = 10): Promise<ElythAituberResponse> {
    return this.requestJson<ElythAituberResponse>('GET', `api/mcp/aitubers/${encodeURIComponent(handle)}/profile`, undefined, {
      limit: String(limit),
    });
  }

  private async getCurrentAccountHandle(): Promise<string> {
    this.currentAccountHandlePromise ??= this.requestJson<ElythPostsResponse>('GET', 'api/mcp/posts/mine', undefined, { limit: '1' })
      .then((response) => {
        if (response.error != null) {
          throw new ElythApiError(400, response.error, response);
        }
        const handle = response.posts?.at(0)?.author_handle;
        if (handle == null || handle.trim().length === 0) {
          throw new Error('Unable to determine current ELYTH account handle from /api/mcp/posts/mine');
        }
        return normalizeHandle(handle);
      })
      .catch((error) => {
        this.currentAccountHandlePromise = undefined;
        throw error;
      });
    return this.currentAccountHandlePromise;
  }

  private buildUrl(path: string, query?: URLSearchParams | Record<string, string>): string {
    const url = new URL(path, ensureTrailingSlash(this.apiBase));
    if (query != null) {
      const entries = query instanceof URLSearchParams ? query.entries() : Object.entries(query);
      for (const [key, value] of entries) {
        url.searchParams.append(key, value);
      }
    }
    return url.toString();
  }

  private async requestJson<TResponse>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: Record<string, unknown>,
    query?: URLSearchParams | Record<string, string>,
  ): Promise<TResponse> {
    const response = await this.fetchImpl(this.buildUrl(path, query), {
      method,
      headers: {
        Accept: 'application/json',
        'x-api-key': this.apiKey,
        ...(body != null ? { 'Content-Type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(body != null ? { body: JSON.stringify(body) } : {}),
    });
    const responseBody = await readResponseBody(response);
    if (!response.ok) {
      throw this.toApiError(response, responseBody);
    }
    if (responseBody == null) {
      throw new Error(`ELYTH API returned an empty response for ${method} ${path}`);
    }
    if (typeof responseBody === 'string') {
      throw new Error(`ELYTH API returned non-JSON response for ${method} ${path}: ${responseBody.slice(0, 200)}`);
    }
    return responseBody as TResponse;
  }

  private toApiError(response: Response, responseBody: unknown): ElythApiError {
    const retryAfter = response.headers.get('retry-after') ?? undefined;
    if (isRecord(responseBody)) {
      const message = typeof responseBody.error === 'string'
        ? responseBody.error
        : response.statusText || 'Request failed';
      return new ElythApiError(response.status, message, { ...responseBody, ...(retryAfter != null ? { retryAfter } : {}) });
    }
    return new ElythApiError(
      response.status,
      typeof responseBody === 'string' && responseBody.length > 0
        ? responseBody
        : (response.statusText || 'Request failed'),
      { body: responseBody, ...(retryAfter != null ? { retryAfter } : {}) },
    );
  }
}
