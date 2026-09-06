import { randomUUID } from 'node:crypto';

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
/** Agent API v2 の limit 上限（1〜50、既定 20） */
const MAX_PAGE_LIMIT = 50;
/** 通知・スレッドのカーソル追跡で読む最大ページ数（暴走防止） */
const MAX_NOTIFICATION_PAGES = 5;
const MAX_THREAD_PAGES = 5;
/** 1 回の getNotifications で通知の本文取得（GET /posts/{id}）を行う上限 */
const MAX_NOTIFICATION_POST_FETCHES = 10;
/** POST /notifications/read の 1 リクエスト上限（API 仕様: 1〜100 件） */
const MARK_READ_CHUNK_SIZE = 100;

export interface CreateElythProviderOptions {
  apiKey: string;
  apiBase: string;
  fetch?: typeof fetch;
}

interface ElythAuthor {
  id?: string | null;
  display_name?: string | null;
  handle?: string | null;
}

interface ElythPost {
  id: string;
  author?: ElythAuthor | null;
  content: string;
  thread_id?: string | null;
  engagement?: {
    like_count?: number | null;
    reply_count?: number | null;
    liked_by_me?: boolean | null;
  } | null;
  created_at: string;
  kind?: 'post' | 'reply' | string | null;
  reply_to_id?: string | null;
}

interface ElythPage {
  has_more?: boolean | null;
  next_cursor?: string | null;
}

interface ElythPostData {
  post?: ElythPost;
}

interface ElythPostListData {
  items?: ElythPost[];
  page?: ElythPage;
}

interface ElythThreadData {
  thread?: {
    id?: string;
    root?: ElythPost;
    replies?: ElythPost[];
  };
  page?: ElythPage;
}

interface ElythProfile {
  id?: string | null;
  display_name: string;
  handle: string;
  bio?: string | null;
  stats?: {
    follower_count?: number | null;
    following_count?: number | null;
    post_count?: number | null;
  } | null;
  relationship?: {
    following?: boolean | null;
    follows_me?: boolean | null;
    mutual?: boolean | null;
  } | null;
}

interface ElythProfileData {
  profile?: ElythProfile;
}

interface ElythNotification {
  id: string;
  type: string;
  created_at: string;
  actor?: {
    type?: string | null;
    id?: string | null;
    display_name?: string | null;
    handle?: string | null;
  } | null;
  resource?: {
    type?: string | null;
    id?: string | null;
  } | null;
  preview?: {
    text?: string | null;
    truncated?: boolean | null;
  } | null;
}

interface ElythNotificationListData {
  items?: ElythNotification[];
  page?: ElythPage;
}

interface ElythMarkReadData {
  received_count?: number;
}

/** ELYTH API が non-2xx またはエラーエンベロープ（`{ error: { code, ... } }`）を返した場合に投げる。retry の判断は `status` / `details` を見て行う。 */
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

/** ELYTH では恒久的にサポートされない機能 (メディア添付・repost・search・非 public visibility) を呼び出した場合に投げる。retry 不要。 */
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

function clampPageLimit(limit: number): number {
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_PAGE_LIMIT);
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
  const authorHandle = firstNonEmpty(post.author?.handle, post.author?.id) ?? 'unknown';
  const authorName = firstNonEmpty(post.author?.display_name) ?? authorHandle;
  const authorId = firstNonEmpty(post.author?.id, post.author?.handle) ?? authorHandle;

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
    likeCount: post.engagement?.like_count ?? 0,
    replyCount: post.engagement?.reply_count ?? 0,
    ...(post.engagement?.liked_by_me != null ? { liked: post.engagement.liked_by_me } : {}),
  };
}

function mapNotificationType(type: string): SnsNotification['type'] {
  switch (type) {
    case 'post.reply_received':
      return 'reply';
    case 'post.mention_received':
      return 'mention';
    case 'relationship.follow_started':
      return 'follow';
    default:
      return 'other';
  }
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

    const path = params.replyToId != null
      ? `posts/${encodeURIComponent(params.replyToId)}/replies`
      : 'posts';
    const data = await this.requestJson<ElythPostData>('POST', path, { content: params.text }, undefined, {
      // v2 は投稿系 POST に Idempotency-Key が必須。呼び出し側から供給されない
      // 場合はコール単位で生成する（provider 内に再試行ループは無い）。
      idempotencyKey: params.idempotencyKey ?? randomUUID(),
    });
    if (data.post == null) {
      throw new ElythApiError(502, 'post_response_missing_post', data);
    }
    return mapPost(data.post, this.apiBase);
  }

  async getPost(postId: string): Promise<SnsPost> {
    const data = await this.requestJson<ElythPostData>('GET', `posts/${encodeURIComponent(postId)}`);
    if (data.post == null) {
      throw new ElythApiError(502, 'post_response_missing_post', data);
    }
    return mapPost(data.post, this.apiBase);
  }

  async getTimeline(params: TimelineParams = {}): Promise<SnsPost[]> {
    const data = await this.requestJson<ElythPostListData>('GET', 'timeline', undefined, {
      limit: String(clampPageLimit(params.limit ?? 20)),
    });
    return (data.items ?? []).map((post) => mapPost(post, this.apiBase));
  }

  async search(_params: SearchParams): Promise<SearchResult> {
    // v2 にはハッシュタグ検索（GET /posts/search?hashtag=）があるが、
    // SearchParams.query は自由文なのでセマンティクスが合わない。従来どおり非対応。
    throw new ElythNotSupportedError('search');
  }

  async like(postId: string): Promise<SnsPost> {
    await this.requestJson<unknown>('PUT', `posts/${encodeURIComponent(postId)}/like`);
    return this.getPost(postId);
  }

  async unlike(postId: string): Promise<SnsPost> {
    await this.requestJson<unknown>('DELETE', `posts/${encodeURIComponent(postId)}/like`);
    return this.getPost(postId);
  }

  async repost(_postId: string): Promise<SnsPost> {
    throw new ElythNotSupportedError('repost');
  }

  async follow(handle: string): Promise<void> {
    await this.requestJson<unknown>('PUT', `profiles/${encodeURIComponent(normalizeHandle(handle))}/follow`);
  }

  async unfollow(handle: string): Promise<void> {
    await this.requestJson<unknown>('DELETE', `profiles/${encodeURIComponent(normalizeHandle(handle))}/follow`);
  }

  async getUserProfile(handle: string): Promise<SnsUserProfile> {
    const data = await this.requestJson<ElythProfileData>('GET', `profiles/${encodeURIComponent(normalizeHandle(handle))}`);
    if (data.profile == null) {
      throw new ElythApiError(502, 'profile_response_missing_profile', data);
    }
    const profile = data.profile;
    return {
      id: firstNonEmpty(profile.id, profile.handle) ?? profile.handle,
      name: profile.display_name,
      handle: profile.handle,
      url: `${this.apiBase}/aitubers/${encodeURIComponent(profile.handle)}`,
      ...(profile.bio != null ? { bio: profile.bio } : {}),
      followerCount: profile.stats?.follower_count ?? 0,
      followingCount: profile.stats?.following_count ?? 0,
      postCount: profile.stats?.post_count ?? 0,
      // relationship は自分自身のプロフィールでは null（不明扱いで省略）。
      ...(profile.relationship?.following != null ? { followedByMe: profile.relationship.following } : {}),
    };
  }

  async getMyMetrics(): Promise<SnsMyMetrics> {
    const profile = await this.getMyProfile();
    return {
      followerCount: profile.stats?.follower_count ?? 0,
      followingCount: profile.stats?.following_count ?? 0,
      postCount: profile.stats?.post_count ?? 0,
    };
  }

  async markNotificationsRead(notificationIds: string[]): Promise<void> {
    for (let index = 0; index < notificationIds.length; index += MARK_READ_CHUNK_SIZE) {
      const chunk = notificationIds.slice(index, index + MARK_READ_CHUNK_SIZE);
      await this.requestJson<ElythMarkReadData>('POST', 'notifications/read', {
        notification_ids: chunk,
      });
    }
  }

  async getNotifications(params: NotificationParams = {}): Promise<NotificationFetchResult> {
    const requestedLimit = params.limit ?? 5;
    try {
      // v2 の /notifications は未読のみ・新しい順・カーソルページネーション。
      // sinceId（前回処理済み id）が見つかるまでページを追い、見つかったら
      // そこで切って complete:true。未読を全部読み切っても見つからない場合は
      // 「取得可能な通知はすべて返した」ので complete:true（それ以前はまとめて
      // 既読扱いのセマンティクス — 旧 API の恒久停滞問題は v2 で解消）。
      // ページ上限で打ち切った場合のみ complete:false でカーソルを進めさせない。
      const collected: ElythNotification[] = [];
      let cursor: string | undefined;
      let exhausted = false;
      let foundSinceId = false;
      for (let page = 0; page < MAX_NOTIFICATION_PAGES; page++) {
        const data = await this.requestJson<ElythNotificationListData>('GET', 'notifications', undefined, {
          limit: String(clampPageLimit(Math.max(requestedLimit, 20))),
          ...(cursor != null ? { cursor } : {}),
        });
        const items = data.items ?? [];
        collected.push(...items);
        if (params.sinceId != null && items.some((item) => item.id === params.sinceId)) {
          foundSinceId = true;
          break;
        }
        if (data.page?.has_more !== true || data.page.next_cursor == null) {
          exhausted = true;
          break;
        }
        cursor = data.page.next_cursor;
      }

      let complete = foundSinceId || exhausted;
      let sliced = collected;
      if (params.sinceId != null) {
        const cursorIndex = sliced.findIndex((notification) => notification.id === params.sinceId);
        if (cursorIndex >= 0) {
          sliced = sliced.slice(0, cursorIndex);
        } else if (!exhausted) {
          logger.warn('ELYTH sinceId not found within paged notifications', { sinceId: params.sinceId });
        }
      }
      if (params.maxId != null) {
        const cursorIndex = sliced.findIndex((notification) => notification.id === params.maxId);
        if (cursorIndex >= 0) {
          sliced = sliced.slice(cursorIndex + 1);
        } else {
          logger.warn('ELYTH maxId not found within paged notifications', { maxId: params.maxId });
          complete = false;
        }
      }

      const requestedTypes = params.types != null ? new Set(params.types) : null;
      const selected = sliced
        .map((notification) => ({ raw: notification, type: mapNotificationType(notification.type) }))
        .filter(({ type }) => requestedTypes == null || requestedTypes.has(type))
        .slice(0, requestedLimit);

      const notifications = await this.hydrateNotifications(selected);
      return { notifications, complete };
    } catch (error) {
      if (error instanceof ElythApiError && error.status === 429) {
        const retryAfter = isRecord(error.details) && error.details.retryAfter != null
          ? String(error.details.retryAfter)
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
    // v2 の thread は root + replies（古い順・ページネーション）を返す。
    let root: ElythPost | undefined;
    const replies: ElythPost[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_THREAD_PAGES; page++) {
      const data = await this.requestJson<ElythThreadData>('GET', `posts/${encodeURIComponent(postId)}/thread`, undefined, {
        limit: String(MAX_PAGE_LIMIT),
        ...(cursor != null ? { cursor } : {}),
      });
      root ??= data.thread?.root;
      replies.push(...(data.thread?.replies ?? []));
      if (data.page?.has_more !== true || data.page.next_cursor == null) {
        break;
      }
      cursor = data.page.next_cursor;
      if (page === MAX_THREAD_PAGES - 1) {
        logger.warn('ELYTH thread pagination truncated at page cap', { postId, pages: MAX_THREAD_PAGES });
      }
    }
    if (root == null) {
      throw new ElythApiError(502, 'thread_response_missing_root', undefined);
    }

    const posts = [root, ...replies];
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
        ancestorMissingId = parentId;
        break;
      }
      ancestorChain.push(parent);
      parentId = parent.reply_to_id ?? undefined;
    }
    if (ancestorMissingId != null) {
      logger.warn('ELYTH thread response missing ancestor', { postId, missingParentId: ancestorMissingId });
      return { ancestors: [], descendants: [] };
    }
    const ancestorPosts = ancestorChain;

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
    const path = normalized === currentHandle
      ? 'me/posts'
      : `profiles/${encodeURIComponent(normalized)}/posts`;
    const data = await this.requestJson<ElythPostListData>('GET', path, undefined, {
      limit: String(clampPageLimit(params.limit ?? 20)),
    });
    return (data.items ?? [])
      .filter((post) => params.excludeReplies !== true || post.reply_to_id == null)
      .map((post) => mapPost(post, this.apiBase));
  }

  async getTrends(_limit = 5): Promise<SnsPost[]> {
    if (!ElythProvider.#trendsWarned) {
      ElythProvider.#trendsWarned = true;
      logger.info('ELYTH does not support trends; returning empty array');
    }
    return [];
  }

  /** 選別済み通知に post 本文を付ける。preview は切り詰め済みのため、post 資源は個別取得で全文化する。 */
  private async hydrateNotifications(
    selected: Array<{ raw: ElythNotification; type: SnsNotification['type'] }>,
  ): Promise<SnsNotification[]> {
    let postFetches = 0;
    const notifications: SnsNotification[] = [];
    for (const { raw, type } of selected) {
      const actorHandle = firstNonEmpty(raw.actor?.handle, raw.actor?.id) ?? 'unknown';
      const base: SnsNotification = {
        id: raw.id,
        type,
        createdAt: raw.created_at,
        accountId: firstNonEmpty(raw.actor?.id, raw.actor?.handle) ?? actorHandle,
        accountName: firstNonEmpty(raw.actor?.display_name) ?? actorHandle,
        accountHandle: actorHandle,
      };
      const postId = raw.resource?.type === 'post' ? raw.resource.id : undefined;
      if (postId == null || postId.length === 0) {
        notifications.push(base);
        continue;
      }
      if (postFetches < MAX_NOTIFICATION_POST_FETCHES) {
        postFetches++;
        try {
          notifications.push({ ...base, post: await this.getPost(postId) });
          continue;
        } catch (error) {
          // 削除済み投稿などは preview へフォールバック（通知自体は失わない）
          logger.warn('ELYTH notification post fetch failed; falling back to preview', {
            notificationId: raw.id,
            postId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const previewText = raw.preview?.text;
      notifications.push({
        ...base,
        post: {
          id: postId,
          text: previewText != null ? `${previewText}${raw.preview?.truncated === true ? '…' : ''}` : '',
          authorId: base.accountId,
          authorName: base.accountName,
          authorHandle: base.accountHandle,
          createdAt: raw.created_at,
          url: `${this.apiBase}/posts/${encodeURIComponent(postId)}`,
          visibility: 'public',
          repostCount: 0,
          likeCount: 0,
          replyCount: 0,
        },
      });
    }
    return notifications;
  }

  private async getMyProfile(): Promise<ElythProfile> {
    const data = await this.requestJson<ElythProfileData>('GET', 'me/profile');
    if (data.profile == null) {
      throw new ElythApiError(502, 'me_profile_response_missing_profile', data);
    }
    return data.profile;
  }

  private async getCurrentAccountHandle(): Promise<string> {
    this.currentAccountHandlePromise ??= this.getMyProfile()
      .then((profile) => {
        const handle = firstNonEmpty(profile.handle);
        if (handle == null) {
          throw new Error('Unable to determine current ELYTH account handle from /me/profile');
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
    const url = new URL(`api/agent/v2/${path}`, ensureTrailingSlash(this.apiBase));
    if (query != null) {
      const entries = query instanceof URLSearchParams ? query.entries() : Object.entries(query);
      for (const [key, value] of entries) {
        url.searchParams.append(key, value);
      }
    }
    return url.toString();
  }

  private async requestJson<TData>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: Record<string, unknown>,
    query?: URLSearchParams | Record<string, string>,
    options?: { idempotencyKey?: string },
  ): Promise<TData> {
    const response = await this.fetchImpl(this.buildUrl(path, query), {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        ...(body != null ? { 'Content-Type': 'application/json' } : {}),
        ...(options?.idempotencyKey != null ? { 'Idempotency-Key': options.idempotencyKey } : {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(body != null ? { body: JSON.stringify(body) } : {}),
    });
    const responseBody = await readResponseBody(response);
    if (!response.ok || (isRecord(responseBody) && isRecord(responseBody.error))) {
      throw this.toApiError(response, responseBody);
    }
    if (responseBody == null) {
      throw new Error(`ELYTH API returned an empty response for ${method} ${path}`);
    }
    if (typeof responseBody === 'string') {
      throw new Error(`ELYTH API returned non-JSON response for ${method} ${path}: ${responseBody.slice(0, 200)}`);
    }
    if (!isRecord(responseBody) || !('data' in responseBody)) {
      throw new ElythApiError(502, 'response_missing_data_envelope', responseBody);
    }
    return responseBody.data as TData;
  }

  private toApiError(response: Response, responseBody: unknown): ElythApiError {
    const retryAfterHeader = response.headers.get('retry-after') ?? undefined;
    if (isRecord(responseBody) && isRecord(responseBody.error)) {
      const errorEnvelope = responseBody.error;
      const message = typeof errorEnvelope.message === 'string' && errorEnvelope.message.length > 0
        ? (typeof errorEnvelope.code === 'string' ? `${errorEnvelope.code}: ${errorEnvelope.message}` : errorEnvelope.message)
        : (typeof errorEnvelope.code === 'string' ? errorEnvelope.code : response.statusText || 'Request failed');
      const retryAfter = errorEnvelope.retry_after_seconds != null
        ? String(errorEnvelope.retry_after_seconds)
        : retryAfterHeader;
      return new ElythApiError(response.status, message, {
        ...errorEnvelope,
        ...(retryAfter != null ? { retryAfter } : {}),
      });
    }
    return new ElythApiError(
      response.status,
      typeof responseBody === 'string' && responseBody.length > 0
        ? responseBody.slice(0, 200)
        : (response.statusText || 'Request failed'),
      { body: responseBody, ...(retryAfterHeader != null ? { retryAfter: retryAfterHeader } : {}) },
    );
  }
}
