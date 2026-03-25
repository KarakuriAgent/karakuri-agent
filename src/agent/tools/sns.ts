import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

import type { SnsCredentials } from '../../config.js';
import { createSnsProvider } from '../../sns/index.js';
import { createLogger } from '../../utils/logger.js';
import { httpUrlSchema, type LookupFn } from '../../utils/safe-fetch.js';

const logger = createLogger('SnsTools');

const defaultLimitSchema = z.number().int().min(1).max(40).default(5);
const timelineLimitSchema = z.number().int().min(1).max(40).default(5);
const notificationTypeSchema = z.enum(['mention', 'like', 'repost', 'follow', 'reply', 'other']);
const visibilitySchema = z.enum(['public', 'unlisted', 'private', 'direct']);

const snsPostInputSchema = z.object({
  text: z.string().trim().min(1),
  reply_to_id: z.string().trim().min(1).optional(),
  quote_post_id: z.string().trim().min(1).optional(),
  media_ids: z.array(z.string().trim().min(1)).optional(),
  visibility: visibilitySchema.default('public'),
}).strict();

const snsGetPostInputSchema = z.object({
  post_id: z.string().trim().min(1),
}).strict();

const snsGetTimelineInputSchema = z.object({
  limit: timelineLimitSchema,
  since_id: z.string().trim().min(1).optional(),
  max_id: z.string().trim().min(1).optional(),
}).strict();

const snsSearchInputSchema = z.object({
  query: z.string().trim().min(1),
  type: z.enum(['posts', 'users']).default('posts'),
  limit: defaultLimitSchema,
}).strict();

const snsLikeInputSchema = z.object({
  post_id: z.string().trim().min(1),
}).strict();

const snsRepostInputSchema = z.object({
  post_id: z.string().trim().min(1),
}).strict();

const snsGetNotificationsInputSchema = z.object({
  limit: defaultLimitSchema,
  types: z.array(notificationTypeSchema).optional(),
}).strict();

const snsUploadMediaInputSchema = z.object({
  url: httpUrlSchema,
  alt_text: z.string().trim().min(1).optional(),
}).strict();

const snsGetThreadInputSchema = z.object({
  post_id: z.string().trim().min(1),
}).strict();

const snsGetUserPostsInputSchema = z.object({
  user_handle: z.string().trim().min(1),
  limit: defaultLimitSchema,
  exclude_replies: z.boolean().default(false),
}).strict();

const snsGetTrendsInputSchema = z.object({
  limit: defaultLimitSchema,
}).strict();

export interface CreateSnsToolsOptions extends SnsCredentials {
  fetch?: typeof fetch;
  lookupFn?: LookupFn;
  sleep?: (milliseconds: number) => Promise<void>;
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

export function createSnsTools(options: CreateSnsToolsOptions): ToolSet {
  const provider = createSnsProvider(options);

  return {
    sns_post: tool({
      description: 'SNS に投稿する。必要なら返信先や引用元、メディア、公開範囲を指定する。',
      inputSchema: snsPostInputSchema,
      execute: async (input) => executeSafely('sns_post', () => provider.post({
        text: input.text,
        replyToId: input.reply_to_id,
        quotePostId: input.quote_post_id,
        mediaIds: input.media_ids,
        visibility: input.visibility,
      })),
    }),
    sns_get_post: tool({
      description: 'SNS の特定投稿を取得する。`post_id` を渡す。',
      inputSchema: snsGetPostInputSchema,
      execute: async (input) => executeSafely('sns_get_post', () => provider.getPost(input.post_id)),
    }),
    sns_get_timeline: tool({
      description: 'ホームタイムラインを取得する。必要なら件数や since/max ID を指定する。ブースト投稿には `timelineEntryId` が含まれるので、次ページ取得の `since_id` / `max_id` にはその値を優先して使う。',
      inputSchema: snsGetTimelineInputSchema,
      execute: async (input) => executeSafely('sns_get_timeline', () => provider.getTimeline({
        limit: input.limit,
        sinceId: input.since_id,
        maxId: input.max_id,
      })),
    }),
    sns_search: tool({
      description: '投稿またはユーザーを検索する。',
      inputSchema: snsSearchInputSchema,
      execute: async (input) => executeSafely('sns_search', () => provider.search({
        query: input.query,
        type: input.type,
        limit: input.limit,
      })),
    }),
    sns_like: tool({
      description: '指定した投稿にいいねする。',
      inputSchema: snsLikeInputSchema,
      execute: async (input) => executeSafely('sns_like', () => provider.like(input.post_id)),
    }),
    sns_repost: tool({
      description: '指定した投稿をリポストする。',
      inputSchema: snsRepostInputSchema,
      execute: async (input) => executeSafely('sns_repost', () => provider.repost(input.post_id)),
    }),
    sns_get_notifications: tool({
      description: '通知を取得する。必要なら通知種別と件数を絞る。',
      inputSchema: snsGetNotificationsInputSchema,
      execute: async (input) => executeSafely('sns_get_notifications', () => provider.getNotifications({
        limit: input.limit,
        types: input.types,
      })),
    }),
    sns_upload_media: tool({
      description: 'URL からメディアをアップロードし、処理完了を待って投稿用 mediaId を返す。',
      inputSchema: snsUploadMediaInputSchema,
      execute: async (input) => executeSafely('sns_upload_media', () => provider.uploadMedia({
        url: input.url,
        altText: input.alt_text,
      })),
    }),
    sns_get_thread: tool({
      description: '投稿のスレッド文脈を取得する。',
      inputSchema: snsGetThreadInputSchema,
      execute: async (input) => executeSafely('sns_get_thread', () => provider.getThread(input.post_id)),
    }),
    sns_get_user_posts: tool({
      description: '指定ユーザーの投稿一覧を取得する。',
      inputSchema: snsGetUserPostsInputSchema,
      execute: async (input) => executeSafely('sns_get_user_posts', () => provider.getUserPosts({
        userHandle: input.user_handle,
        limit: input.limit,
        excludeReplies: input.exclude_replies,
      })),
    }),
    sns_get_trends: tool({
      description: 'トレンド投稿を取得する。',
      inputSchema: snsGetTrendsInputSchema,
      execute: async (input) => executeSafely('sns_get_trends', () => provider.getTrends(input.limit)),
    }),
  };
}
