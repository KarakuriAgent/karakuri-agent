import type {
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

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_MEDIA_BYTES = 40_000_000;
const MEDIA_POLL_INTERVAL_MS = 1_000;
const MAX_MEDIA_POLL_ATTEMPTS = 10;
const MAX_NOTIFICATION_PAGE_REQUESTS = 5;

type SleepFn = (milliseconds: number) => Promise<void>;

export interface CreateMastodonProviderOptions {
  instanceUrl: string;
  accessToken: string;
  fetch?: typeof fetch;
  lookupFn?: LookupFn;
  sleep?: SleepFn;
}

interface MastodonAccount {
  id: string;
  display_name: string;
  username: string;
  acct: string;
  url: string;
}

interface MastodonMediaAttachment {
  url?: string | null;
  preview_url?: string | null;
}

interface MastodonStatus {
  id: string;
  content: string;
  account: MastodonAccount;
  created_at: string;
  url: string | null;
  uri?: string | null;
  visibility: SnsPost['visibility'];
  in_reply_to_id?: string | null;
  in_reply_to_account_id?: string | null;
  reblogs_count: number;
  favourites_count: number;
  replies_count: number;
  media_attachments?: MastodonMediaAttachment[] | null;
  reblog?: MastodonStatus | null;
}

interface MastodonNotification {
  id: string;
  type: string;
  created_at: string;
  account: MastodonAccount;
  status?: MastodonStatus | null;
}

interface MastodonSearchResponse {
  statuses?: MastodonStatus[] | null;
  accounts?: MastodonAccount[] | null;
}

interface MastodonContextResponse {
  ancestors: MastodonStatus[];
  descendants: MastodonStatus[];
}

class MastodonApiError extends Error {
  readonly status: number;
  readonly details: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(`Mastodon API returned ${status}: ${message}`);
    this.name = 'MastodonApiError';
    this.status = status;
    this.details = details;
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function inferFileName(url: string): string {
  try {
    const parsed = new URL(url);
    const segment = parsed.pathname.split('/').filter(Boolean).at(-1);
    return segment != null && segment.length > 0 ? segment : 'upload';
  } catch {
    return 'upload';
  }
}

function safeFromCodePoint(codePoint: number, fallback: string): string {
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return fallback;
  }
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, '\'')
    .replace(/&#(\d+);/g, (match, code: string) => safeFromCodePoint(Number(code), match))
    .replace(/&#x([0-9a-f]+);/gi, (match, code: string) => safeFromCodePoint(Number.parseInt(code, 16), match));
}

export function stripHtml(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<p\b[^>]*>/gi, '')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function mapAccount(account: MastodonAccount): { id: string; name: string; handle: string; url: string } {
  return {
    id: account.id,
    name: account.display_name.trim() || account.username,
    handle: account.acct,
    url: account.url,
  };
}

function mapStatus(status: MastodonStatus): SnsPost {
  const effectiveStatus = status.reblog ?? status;
  const mediaUrls = (effectiveStatus.media_attachments ?? [])
    .map((attachment) => attachment.url ?? attachment.preview_url ?? undefined)
    .filter((url): url is string => url != null && url.length > 0);
  const author = mapAccount(effectiveStatus.account);

  return {
    id: effectiveStatus.id,
    ...(status.reblog != null && status.id !== effectiveStatus.id ? { timelineEntryId: status.id } : {}),
    text: stripHtml(effectiveStatus.content),
    authorId: author.id,
    authorName: author.name,
    authorHandle: author.handle,
    createdAt: effectiveStatus.created_at,
    url: effectiveStatus.url ?? effectiveStatus.uri ?? '',
    visibility: effectiveStatus.visibility,
    ...(effectiveStatus.in_reply_to_id != null ? { inReplyToId: effectiveStatus.in_reply_to_id } : {}),
    repostCount: effectiveStatus.reblogs_count,
    likeCount: effectiveStatus.favourites_count,
    replyCount: effectiveStatus.replies_count,
    ...(mediaUrls.length > 0 ? { mediaUrls } : {}),
  };
}

function mapNotification(
  notification: MastodonNotification,
  currentAccountId?: string,
): SnsNotification {
  const account = mapAccount(notification.account);
  const mappedType = (() => {
    switch (notification.type) {
      case 'mention':
        return notification.status?.in_reply_to_id != null
          && notification.status.in_reply_to_account_id === currentAccountId
          ? 'reply'
          : 'mention';
      case 'favourite':
        return 'like';
      case 'reblog':
        return 'repost';
      case 'follow':
        return 'follow';
      default:
        return 'other';
    }
  })();

  return {
    id: notification.id,
    type: mappedType,
    createdAt: notification.created_at,
    accountId: account.id,
    accountName: account.name,
    accountHandle: account.handle,
    ...(notification.status != null ? { post: mapStatus(notification.status) } : {}),
  };
}

type SnsNotificationType = NonNullable<NotificationParams['types']>[number];

function mapNotificationTypeToMastodon(
  type: SnsNotificationType,
): string[] {
  switch (type) {
    case 'mention':
      return ['mention'];
    case 'like':
      return ['favourite'];
    case 'repost':
      return ['reblog'];
    case 'follow':
      return ['follow'];
    case 'reply':
      return ['mention'];
    default:
      return [];
  }
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

function createBlobFromBytes(bodyBytes?: Uint8Array, contentType?: string): Blob {
  if (bodyBytes == null) {
    return contentType != null ? new Blob([], { type: contentType }) : new Blob([]);
  }

  const exactBytes = new Uint8Array(bodyBytes.byteLength);
  exactBytes.set(bodyBytes);
  return contentType != null ? new Blob([exactBytes], { type: contentType }) : new Blob([exactBytes]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function assertArray(value: unknown, context: string): void {
  if (!Array.isArray(value)) {
    throw new Error(`Expected array response for ${context}, got ${typeof value}`);
  }
}

function assertRecord(value: unknown, context: string): void {
  if (!isRecord(value)) {
    throw new Error(`Expected object response for ${context}, got ${typeof value}`);
  }
}

export class MastodonProvider implements SnsProvider {
  private readonly instanceUrl: string;
  private readonly accessToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly lookupFn: LookupFn | undefined;
  private readonly sleepFn: SleepFn;
  private currentAccountIdPromise: Promise<string> | undefined;

  constructor({
    instanceUrl,
    accessToken,
    fetch: fetchImpl = (...args) => globalThis.fetch(...args),
    lookupFn,
    sleep = async (milliseconds) => new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    }),
  }: CreateMastodonProviderOptions) {
    this.instanceUrl = instanceUrl.replace(/\/+$/, '');
    this.accessToken = accessToken;
    this.fetchImpl = fetchImpl;
    this.lookupFn = lookupFn;
    this.sleepFn = sleep;
  }

  async post(params: PostParams): Promise<SnsPost> {
    return mapStatus(await this.requestJson<MastodonStatus>('POST', 'api/v1/statuses', {
      status: params.text,
      ...(params.replyToId != null ? { in_reply_to_id: params.replyToId } : {}),
      ...(params.quotePostId != null ? { quoted_status_id: params.quotePostId } : {}),
      ...(params.mediaIds != null && params.mediaIds.length > 0 ? { media_ids: params.mediaIds } : {}),
      ...(params.visibility != null ? { visibility: params.visibility } : {}),
    }));
  }

  async getPost(postId: string): Promise<SnsPost> {
    return mapStatus(await this.requestJson<MastodonStatus>('GET', `api/v1/statuses/${encodeURIComponent(postId)}`));
  }

  async getTimeline(params: TimelineParams = {}): Promise<SnsPost[]> {
    const statuses = await this.requestJson<MastodonStatus[]>(
      'GET',
      'api/v1/timelines/home',
      undefined,
      {
        ...(params.limit != null ? { limit: String(params.limit) } : {}),
        ...(params.sinceId != null ? { since_id: params.sinceId } : {}),
        ...(params.maxId != null ? { max_id: params.maxId } : {}),
      },
    );
    assertArray(statuses, 'GET api/v1/timelines/home');
    return statuses.map(mapStatus);
  }

  async search(params: SearchParams): Promise<SearchResult> {
    const type = params.type === 'users' ? 'accounts' : 'statuses';
    const result = await this.requestJson<MastodonSearchResponse>('GET', 'api/v2/search', undefined, {
      q: params.query,
      type,
      resolve: 'true',
      ...(params.limit != null ? { limit: String(params.limit) } : {}),
    });
    assertRecord(result, 'GET api/v2/search');

    return {
      posts: (result.statuses ?? []).map(mapStatus),
      users: (result.accounts ?? []).map(mapAccount),
    };
  }

  async like(postId: string): Promise<SnsPost> {
    return mapStatus(await this.requestJson<MastodonStatus>(
      'POST',
      `api/v1/statuses/${encodeURIComponent(postId)}/favourite`,
    ));
  }

  async repost(postId: string): Promise<SnsPost> {
    return mapStatus(await this.requestJson<MastodonStatus>(
      'POST',
      `api/v1/statuses/${encodeURIComponent(postId)}/reblog`,
    ));
  }

  async getNotifications(params: NotificationParams = {}): Promise<SnsNotification[]> {
    const requestedLimit = params.limit ?? 5;
    const requestedTypes = params.types != null ? new Set(params.types) : null;
    const needsClientSideFiltering = requestedTypes != null
      && (requestedTypes.has('mention') || requestedTypes.has('reply') || requestedTypes.has('other'));
    const pageLimit = needsClientSideFiltering
      ? Math.min(Math.max(requestedLimit * 3, 20), 80)
      : requestedLimit;
    const collected: SnsNotification[] = [];
    let nextMaxId: string | undefined;
    let pageRequests = 0;

    while (collected.length < requestedLimit && pageRequests < MAX_NOTIFICATION_PAGE_REQUESTS) {
      pageRequests += 1;
      const query = new URLSearchParams();
      query.set('limit', String(pageLimit));
      if (nextMaxId != null) {
        query.set('max_id', nextMaxId);
      }

      if (requestedTypes == null || !requestedTypes.has('other')) {
        const mastodonTypes = new Set<string>();
        for (const type of params.types ?? []) {
          for (const mappedType of mapNotificationTypeToMastodon(type)) {
            mastodonTypes.add(mappedType);
          }
        }
        for (const mastodonType of mastodonTypes) {
          query.append('types[]', mastodonType);
        }
      }

      const notifications = await this.requestJson<MastodonNotification[]>(
        'GET',
        'api/v1/notifications',
        undefined,
        query,
      );
      assertArray(notifications, 'GET api/v1/notifications');
      if (notifications.length === 0) {
        break;
      }

      const currentAccountId = notifications.some((notification) => notification.type === 'mention')
        ? await this.getCurrentAccountId()
        : undefined;
      const mappedNotifications = notifications
        .map((notification) => mapNotification(notification, currentAccountId))
        .filter((notification) => requestedTypes == null || requestedTypes.has(notification.type));
      collected.push(...mappedNotifications);

      if (!needsClientSideFiltering || notifications.length < pageLimit) {
        break;
      }

      nextMaxId = notifications.at(-1)?.id;
      if (nextMaxId == null) {
        break;
      }
    }

    return collected.slice(0, requestedLimit);
  }

  async uploadMedia(params: UploadMediaParams): Promise<UploadMediaResult> {
    let requestUrl: string;
    let mediaResponse: Response;
    let mediaBodyBytes: Uint8Array | undefined;

    try {
      ({ requestUrl, response: mediaResponse, bodyBytes: mediaBodyBytes } = await fetchWithValidatedRedirects(params.url, {
        fetchFn: this.fetchImpl,
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

    const mediaBlob = createBlobFromBytes(mediaBodyBytes, mediaResponse.headers.get('content-type') ?? undefined);
    const formData = new FormData();
    formData.append('file', mediaBlob, inferFileName(requestUrl));
    if (params.altText != null) {
      formData.append('description', params.altText);
    }

    const response = await this.fetchImpl(this.buildUrl('api/v2/media'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
      },
      body: formData,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const responseBody = await readResponseBody(response);
    if (!response.ok) {
      throw this.toApiError(response, responseBody);
    }
    if (!isRecord(responseBody) || typeof responseBody.id !== 'string' || responseBody.id.length === 0) {
      throw new Error('Invalid Mastodon media upload response');
    }
    if (response.status === 202 || responseBody.url == null) {
      await this.waitForMediaReady(responseBody.id);
    }

    return { mediaId: responseBody.id };
  }

  async getThread(postId: string): Promise<ThreadResult> {
    const response = await this.requestJson<MastodonContextResponse>(
      'GET',
      `api/v1/statuses/${encodeURIComponent(postId)}/context`,
    );
    assertRecord(response, `GET api/v1/statuses/${postId}/context`);
    return {
      ancestors: response.ancestors.map(mapStatus),
      descendants: response.descendants.map(mapStatus),
    };
  }

  async getUserPosts(params: UserPostsParams): Promise<SnsPost[]> {
    const account = await this.requestJson<MastodonAccount>('GET', 'api/v1/accounts/lookup', undefined, {
      acct: params.userHandle,
    });
    const statuses = await this.requestJson<MastodonStatus[]>(
      'GET',
      `api/v1/accounts/${encodeURIComponent(account.id)}/statuses`,
      undefined,
      {
        ...(params.limit != null ? { limit: String(params.limit) } : {}),
        ...(params.excludeReplies === true ? { exclude_replies: 'true' } : {}),
      },
    );
    assertArray(statuses, `GET api/v1/accounts/${account.id}/statuses`);
    return statuses.map(mapStatus);
  }

  async getTrends(limit = 5): Promise<SnsPost[]> {
    const statuses = await this.requestJson<MastodonStatus[]>(
      'GET',
      'api/v1/trends/statuses',
      undefined,
      { limit: String(limit) },
    );
    assertArray(statuses, 'GET api/v1/trends/statuses');
    return statuses.slice(0, limit).map(mapStatus);
  }

  private buildUrl(path: string, query?: URLSearchParams | Record<string, string>): string {
    const url = new URL(path, ensureTrailingSlash(this.instanceUrl));
    if (query != null) {
      const entries = query instanceof URLSearchParams ? query.entries() : Object.entries(query);
      for (const [key, value] of entries) {
        url.searchParams.append(key, value);
      }
    }
    return url.toString();
  }

  private async requestJson<TResponse>(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
    query?: URLSearchParams | Record<string, string>,
  ): Promise<TResponse> {
    const response = await this.fetchImpl(this.buildUrl(path, query), {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.accessToken}`,
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
      throw new Error(`Mastodon API returned an empty response for ${method} ${path}`);
    }
    if (typeof responseBody === 'string') {
      throw new Error(`Mastodon API returned non-JSON response for ${method} ${path}: ${responseBody.slice(0, 200)}`);
    }

    return responseBody as TResponse;
  }

  private toApiError(response: Response, responseBody: unknown): MastodonApiError {
    if (isRecord(responseBody)) {
      const message = typeof responseBody.error === 'string'
        ? responseBody.error
        : typeof responseBody.error_description === 'string'
          ? responseBody.error_description
          : response.statusText || 'Request failed';
      return new MastodonApiError(response.status, message, responseBody);
    }

    return new MastodonApiError(
      response.status,
      typeof responseBody === 'string' && responseBody.length > 0
        ? responseBody
        : (response.statusText || 'Request failed'),
      responseBody,
    );
  }

  private isTransientMediaPendingResponse(response: Response, responseBody: unknown): boolean {
    return response.status === 404 && (this.extractApiErrorMessage(responseBody)?.includes('record not found') ?? false);
  }

  private describePendingMediaResponse(responseBody: unknown): string {
    const message = this.extractApiErrorMessage(responseBody);
    return message != null ? ` Last response: ${message}.` : '';
  }

  private isRetryableMediaPollError(error: unknown): boolean {
    return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
  }

  private extractApiErrorMessage(responseBody: unknown): string | undefined {
    if (isRecord(responseBody)) {
      if (typeof responseBody.error === 'string' && responseBody.error.trim().length > 0) {
        return responseBody.error.trim().toLowerCase();
      }
      if (typeof responseBody.error_description === 'string' && responseBody.error_description.trim().length > 0) {
        return responseBody.error_description.trim().toLowerCase();
      }
    }

    if (typeof responseBody === 'string' && responseBody.trim().length > 0) {
      return responseBody.trim().toLowerCase();
    }

    return undefined;
  }

  private async waitForMediaReady(mediaId: string): Promise<void> {
    let lastPendingResponse: unknown;

    for (let attempt = 0; attempt < MAX_MEDIA_POLL_ATTEMPTS; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(this.buildUrl(`api/v1/media/${encodeURIComponent(mediaId)}`), {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${this.accessToken}`,
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        if (!this.isRetryableMediaPollError(error) || attempt === MAX_MEDIA_POLL_ATTEMPTS - 1) {
          throw error;
        }
        await this.sleepFn(MEDIA_POLL_INTERVAL_MS);
        continue;
      }
      const responseBody = await readResponseBody(response);

      if (response.ok) {
        if (isRecord(responseBody) && typeof responseBody.url === 'string' && responseBody.url.length > 0) {
          return;
        }
        lastPendingResponse = responseBody;
      } else if (!this.isTransientMediaPendingResponse(response, responseBody)) {
        throw this.toApiError(response, responseBody);
      } else {
        lastPendingResponse = responseBody;
      }

      if (attempt === MAX_MEDIA_POLL_ATTEMPTS - 1) {
        break;
      }

      await this.sleepFn(MEDIA_POLL_INTERVAL_MS);
    }

    throw new Error(`Mastodon media is still processing. Try again shortly.${this.describePendingMediaResponse(lastPendingResponse)}`);
  }

  private async getCurrentAccountId(): Promise<string> {
    this.currentAccountIdPromise ??= this.requestJson<MastodonAccount>('GET', 'api/v1/accounts/verify_credentials')
      .then((account) => account.id)
      .catch((error) => {
        this.currentAccountIdPromise = undefined;
        throw error;
      });
    return this.currentAccountIdPromise;
  }
}
