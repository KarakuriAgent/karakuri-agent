import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

import type { SnsCredentials } from '../../config.js';
import type { IActionLedgerStore } from '../../life/action-ledger.js';
import { normalizeSnsOwnAction } from '../../life/normalize.js';
import type { ExperienceRecorder } from '../../life/recorder.js';
import { createSnsProvider } from '../../sns/index.js';
import { buildLikeLockKey, buildQuoteLockKey, buildReplyLockKey, buildRepostLockKey, buildWriteGateLockKey, runWithSnsActionLocks } from '../../sns/action-locks.js';
import type { SnsRateLimiter } from '../../sns/rate-limiter.js';
import type { ISnsActivityStore, SnsPost, SnsWriteActionKind } from '../../sns/types.js';
import type { IUserStore } from '../../user/types.js';
import { createLogger } from '../../utils/logger.js';
import { httpUrlSchema, type LookupFn } from '../../utils/safe-fetch.js';

const logger = createLogger('SnsTools');
const visibilitySchema = z.enum(['public', 'unlisted', 'private', 'direct']);
// Cap LLM-based user evaluations per turn to limit cost and latency.
// Callers can share evaluatedUsers across provider-specific tool sets within a turn.
const MAX_USER_EVALUATIONS_PER_TURN = 3;

const snsPostInputSchema = z.object({
  text: z.string().trim().min(1).max(140),
  reply_to_id: z.string().trim().min(1).optional(),
  quote_post_id: z.string().trim().min(1).optional(),
  media_ids: z.array(z.string().trim().min(1)).optional(),
  visibility: visibilitySchema.default('public'),
}).strict();

const snsGetPostInputSchema = z.object({
  post_id: z.string().trim().min(1),
}).strict();

const snsLikeInputSchema = z.object({
  post_id: z.string().trim().min(1),
}).strict();

const snsRepostInputSchema = z.object({
  post_id: z.string().trim().min(1),
}).strict();

const snsUploadMediaInputSchema = z.object({
  url: httpUrlSchema,
  alt_text: z.string().trim().min(1).optional(),
}).strict();

const snsGetThreadInputSchema = z.object({
  post_id: z.string().trim().min(1),
}).strict();

export interface CreateSnsToolsOptions {
  sns: SnsCredentials;
  dataDir?: string;
  fetch?: typeof fetch;
  lookupFn?: LookupFn;
  sleep?: (milliseconds: number) => Promise<void>;
  activityStore?: ISnsActivityStore;
  userStore?: IUserStore;
  evaluateUser?: (snsUserId: string, displayName: string, postText: string) => void;
  reportError?: (message: string) => void;
  evaluatedUsers?: Set<string> | undefined;
  experienceRecorder?: ExperienceRecorder | undefined;
  /** M6: 話題偏り検出用の頻度台帳（bucket=topic に投稿話題を記録） */
  actionLedger?: IActionLedgerStore | undefined;
  /** M8: 書き込みアクションの決定論レート制限（未設定なら制限なし） */
  rateLimiter?: SnsRateLimiter | undefined;
}

function formatError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    const prefix = error.name !== 'Error' ? `[${error.name}] ` : '';
    return `${prefix}${error.message}`;
  }

  return typeof error === 'string' ? error : 'Unknown SNS error';
}

async function executeSafely<T>(toolName: string, operation: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await operation();
  } catch (error) {
    logger.error('SNS tool execution failed', { toolName, error });
    return { error: formatError(error) };
  }
}

function ensureSnsUser(
  userStore: IUserStore | undefined,
  provider: string,
  authorId: string,
  authorName: string,
): void {
  if (userStore == null) {
    return;
  }

  const snsUserId = `sns:${provider}:${authorId}`;
  void userStore.ensureUser(snsUserId, authorName).catch((error) => {
    logger.warn('Failed to ensure SNS user', error, { snsUserId });
  });
}

async function safeRecord(
  operationName: string,
  operation: () => Promise<void>,
  reportError?: (message: string) => void,
): Promise<string | null> {
  try {
    await operation();
    return null;
  } catch (error) {
    const message = `Failed to persist SNS activity for ${operationName} -- duplicate prevention may be compromised`;
    logger.error(message, error);
    reportError?.(`⚠️ ${message}: ${formatError(error)}`);
    return message;
  }
}

async function safeCheck<T>(operationName: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    logger.warn(`Failed to check SNS activity for ${operationName}`, error);
    throw new Error(`Failed to verify duplicate protection for ${operationName}: ${formatError(error)}`);
  }
}

function trackPost(
  post: SnsPost,
  provider: string,
  userStore: IUserStore | undefined,
  evaluateUser: ((snsUserId: string, displayName: string, postText: string) => void) | undefined,
  evaluatedUsers: Set<string>,
): void {
  ensureSnsUser(userStore, provider, post.authorId, post.authorName);
  if (evaluateUser == null) {
    return;
  }

  const snsUserId = `sns:${provider}:${post.authorId}`;
  if (evaluatedUsers.has(snsUserId) || evaluatedUsers.size >= MAX_USER_EVALUATIONS_PER_TURN) {
    return;
  }

  evaluatedUsers.add(snsUserId);
  evaluateUser(snsUserId, post.authorName, post.text);
}

function trackThread(
  posts: SnsPost[],
  provider: string,
  userStore: IUserStore | undefined,
  evaluateUser: ((snsUserId: string, displayName: string, postText: string) => void) | undefined,
  evaluatedUsers: Set<string>,
): void {
  for (const post of posts) {
    trackPost(post, provider, userStore, evaluateUser, evaluatedUsers);
  }
}

/**
 * 投稿本文から話題キーを決定論で抽出する（LLM 不要）。
 * ハッシュタグを優先し、無ければ本文冒頭を丸めたキーを使う。
 */
export function extractPostTopics(text: string): string[] {
  const hashtags = [...text.matchAll(/#([^\s#]{1,30})/gu)].map((match) => match[1]!.toLowerCase());
  if (hashtags.length > 0) {
    return [...new Set(hashtags)].slice(0, 3);
  }
  const normalized = text.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, '').trim();
  if (normalized.length === 0) {
    return [];
  }
  return [[...normalized].slice(0, 12).join('')];
}

function assertSupportedVisibility(provider: SnsCredentials['provider'], visibility: z.infer<typeof visibilitySchema>): void {
  if (provider === 'x' && visibility !== 'public') {
    throw new Error('X only supports public visibility');
  }
  if (provider === 'elyth' && visibility !== 'public') {
    throw new Error('ELYTH only supports public visibility');
  }
}

function assertProviderSupportsMedia(provider: SnsCredentials['provider'], mediaIds: string[] | undefined): void {
  if (provider === 'elyth' && mediaIds != null && mediaIds.length > 0) {
    throw new Error('ELYTH does not support media uploads');
  }
}

function assertProviderSupportsQuote(provider: SnsCredentials['provider'], quotePostId: string | undefined): void {
  if (provider === 'elyth' && quotePostId != null) {
    throw new Error('ELYTH does not support quote posts');
  }
}

export function createSnsTools(options: CreateSnsToolsOptions): ToolSet {
  const snsProviderType = options.sns.provider;
  const provider = createSnsProvider({
    ...options.sns,
    ...(options.dataDir != null ? { dataDir: options.dataDir } : {}),
    ...(options.fetch != null ? { fetch: options.fetch } : {}),
    ...(options.lookupFn != null ? { lookupFn: options.lookupFn } : {}),
    ...(options.sleep != null ? { sleep: options.sleep } : {}),
  });
  const evaluatedUsers = options.evaluatedUsers ?? new Set<string>();
  const toolPrefix = `sns_${snsProviderType}`;
  const toolName = (action: string) => `${toolPrefix}_${action}`;
  const threadDescription = snsProviderType === 'x'
    ? '投稿のスレッド文脈を取得する。X では自分の返信を除外しつつ、過去7日以内の対象投稿から辿れる会話のみを返す。7日を超える投稿は空の結果を返す。'
    : '投稿のスレッド文脈を取得する。';

  if (options.activityStore == null) {
    logger.warn('SNS activity store is not configured; duplicate prevention is disabled');
  }

  // M8: 書き込みレート制限のハードゲート。拒否は「プラットフォームの仕様」として
  // 事実だけ返す（エージェントの内発的感情を捏造しない）。null なら実行可
  const checkRateLimit = async (kind: SnsWriteActionKind): Promise<{ status: 'rate_limited'; message: string } | null> => {
    if (options.rateLimiter == null) {
      return null;
    }
    const gate = await options.rateLimiter.checkWrite(kind);
    if (gate.allowed) {
      return null;
    }
    logger.info('SNS write action rate-limited', { provider: snsProviderType, kind });
    return { status: 'rate_limited' as const, message: gate.message };
  };

  const recordOwnAction = (action: string, detail: unknown): void => {
    void options.experienceRecorder?.record(normalizeSnsOwnAction({
      provider: snsProviderType,
      action,
      detail,
      receivedAt: new Date(),
    }));
  };
  const recordPostTopics = (text: string): void => {
    if (options.actionLedger == null) {
      return;
    }
    const occurredAt = new Date();
    for (const topic of extractPostTopics(text)) {
      void options.actionLedger.increment('topic', topic, occurredAt).catch((error: unknown) => {
        logger.warn('Failed to record SNS post topic', { error });
      });
    }
  };

  const tools: ToolSet = {
    [toolName('post')]: tool({
      description: `${snsProviderType} に投稿する（本文は140文字以内）。必要なら返信先や引用元、メディア、公開範囲を指定する。重複防止で既存の返信・引用を検出した場合は投稿オブジェクトの代わりに { status: "skipped", reason: "already_replied" | "already_quoted", reply_to_id?, quote_post_id? } を返す。プラットフォームのレート制限中は { status: "rate_limited", message } を返す。`,
      inputSchema: snsPostInputSchema,
      execute: async (input) => executeSafely(toolName('post'), async () => runWithSnsActionLocks([
        input.reply_to_id != null ? buildReplyLockKey(snsProviderType, input.reply_to_id) : '',
        input.quote_post_id != null ? buildQuoteLockKey(snsProviderType, input.quote_post_id) : '',
        // レート制限のゲート判定〜活動ログ記録を provider 単位で直列化（並列ツール呼び出し対策）
        options.rateLimiter != null ? buildWriteGateLockKey(snsProviderType) : '',
      ], async () => {
        assertSupportedVisibility(snsProviderType, input.visibility);
        assertProviderSupportsMedia(snsProviderType, input.media_ids);
        assertProviderSupportsQuote(snsProviderType, input.quote_post_id);
        const rateLimited = await checkRateLimit(input.reply_to_id != null ? 'reply' : 'post');
        if (rateLimited != null) {
          return rateLimited;
        }
        if (input.reply_to_id != null) {
          const alreadyReplied = await safeCheck('hasReplied', () => options.activityStore?.hasReplied(input.reply_to_id!) ?? Promise.resolve(false));
          if (alreadyReplied) {
            return { status: 'skipped' as const, reason: 'already_replied' as const, reply_to_id: input.reply_to_id };
          }
        }
        if (input.quote_post_id != null) {
          const alreadyQuoted = await safeCheck('hasQuoted', () => options.activityStore?.hasQuoted(input.quote_post_id!) ?? Promise.resolve(false));
          if (alreadyQuoted) {
            return { status: 'skipped' as const, reason: 'already_quoted' as const, quote_post_id: input.quote_post_id };
          }
        }

        const result = await provider.post({
          text: input.text,
          replyToId: input.reply_to_id,
          quotePostId: input.quote_post_id,
          mediaIds: input.media_ids,
          visibility: input.visibility,
        });
        const warning = await safeRecord('sns_post', () => options.activityStore?.recordPost(result.id, input.text, input.reply_to_id, input.quote_post_id) ?? Promise.resolve(), options.reportError);
        recordPostTopics(input.text);
        recordOwnAction('post', {
          post_id: result.id,
          text: input.text,
          ...(input.reply_to_id != null ? { reply_to_id: input.reply_to_id } : {}),
          ...(input.quote_post_id != null ? { quote_post_id: input.quote_post_id } : {}),
          visibility: input.visibility,
        });
        return warning != null ? { ...result, _warning: warning } : result;
      })),
    }),
    [toolName('get_post')]: tool({
      description: `${snsProviderType} の特定投稿を取得する。\`post_id\` を渡す。`,
      inputSchema: snsGetPostInputSchema,
      execute: async (input) => executeSafely(toolName('get_post'), async () => {
        const result = await provider.getPost(input.post_id);
        trackPost(result, snsProviderType, options.userStore, options.evaluateUser, evaluatedUsers);
        return result;
      }),
    }),
    [toolName('like')]: tool({
      description: `${snsProviderType} の指定した投稿にいいねする。重複防止で既に処理済みなら投稿オブジェクトの代わりに { status: "skipped", reason: "already_liked", post_id } を返す。プラットフォームのレート制限中は { status: "rate_limited", message } を返す。`,
      inputSchema: snsLikeInputSchema,
      execute: async (input) => executeSafely(toolName('like'), async () => runWithSnsActionLocks([buildLikeLockKey(snsProviderType, input.post_id), options.rateLimiter != null ? buildWriteGateLockKey(snsProviderType) : ''], async () => {
        const rateLimited = await checkRateLimit('like');
        if (rateLimited != null) {
          return rateLimited;
        }
        const alreadyLiked = await safeCheck('hasLiked', () => options.activityStore?.hasLiked(input.post_id) ?? Promise.resolve(false));
        if (alreadyLiked) {
          return { status: 'skipped' as const, reason: 'already_liked' as const, post_id: input.post_id };
        }

        const result = await provider.like(input.post_id);
        const warning = await safeRecord('sns_like', () => options.activityStore?.recordLike(input.post_id) ?? Promise.resolve(), options.reportError);
        recordOwnAction('like', { post_id: input.post_id });
        trackPost(result, snsProviderType, options.userStore, options.evaluateUser, evaluatedUsers);
        return warning != null ? { ...result, _warning: warning } : result;
      })),
    }),
    [toolName('repost')]: tool({
      description: `${snsProviderType} の指定した投稿をリポストする。重複防止で既に処理済みなら投稿オブジェクトの代わりに { status: "skipped", reason: "already_reposted", post_id } を返す。プラットフォームのレート制限中は { status: "rate_limited", message } を返す。`,
      inputSchema: snsRepostInputSchema,
      execute: async (input) => executeSafely(toolName('repost'), async () => runWithSnsActionLocks([buildRepostLockKey(snsProviderType, input.post_id), options.rateLimiter != null ? buildWriteGateLockKey(snsProviderType) : ''], async () => {
        const rateLimited = await checkRateLimit('repost');
        if (rateLimited != null) {
          return rateLimited;
        }
        const alreadyReposted = await safeCheck('hasReposted', () => options.activityStore?.hasReposted(input.post_id) ?? Promise.resolve(false));
        if (alreadyReposted) {
          return { status: 'skipped' as const, reason: 'already_reposted' as const, post_id: input.post_id };
        }

        const result = await provider.repost(input.post_id);
        const warning = await safeRecord('sns_repost', () => options.activityStore?.recordRepost(input.post_id) ?? Promise.resolve(), options.reportError);
        recordOwnAction('repost', { post_id: input.post_id });
        trackPost(result, snsProviderType, options.userStore, options.evaluateUser, evaluatedUsers);
        return warning != null ? { ...result, _warning: warning } : result;
      })),
    }),
    [toolName('upload_media')]: tool({
      description: `${snsProviderType} 用に URL からメディアをアップロードし、処理完了を待って投稿用 mediaId を返す。`,
      inputSchema: snsUploadMediaInputSchema,
      execute: async (input) => executeSafely(toolName('upload_media'), () => provider.uploadMedia({
        url: input.url,
        altText: input.alt_text,
      })),
    }),
    [toolName('get_thread')]: tool({
      description: threadDescription,
      inputSchema: snsGetThreadInputSchema,
      execute: async (input) => executeSafely(toolName('get_thread'), async () => {
        const result = await provider.getThread(input.post_id);
        trackThread([...result.ancestors, ...result.descendants], snsProviderType, options.userStore, options.evaluateUser, evaluatedUsers);
        return result;
      }),
    }),
  };

  // Backward-compatible non-enumerable aliases for unit tests and direct imports.
  // They are intentionally not enumerable, so LLM tool exposure remains provider-namespaced.
  for (const action of ['post', 'get_post', 'like', 'repost', 'upload_media', 'get_thread'] as const) {
    Object.defineProperty(tools, `sns_${action}`, {
      value: tools[toolName(action)],
      enumerable: false,
      configurable: true,
    });
  }

  return tools;
}
