import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

import type { ApiCredentials } from '../../config.js';
import { createLogger } from '../../utils/logger.js';

const nodeIdSchema = z.string().regex(/^\d+-\d+$/);
const integerTextPattern = /^\d+$/;
function preprocessSafeInteger(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (!integerTextPattern.test(trimmed)) {
    return value;
  }

  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : value;
}

const waitDurationSchema = z
  .preprocess(preprocessSafeInteger, z.number().int().min(1).max(6))
  .describe('待機時間（10分単位、1=10分〜6=60分）');
const transferQuantitySchema = z
  .preprocess(preprocessSafeInteger, z.number().int().min(1).max(10_000))
  .describe('譲渡するアイテム数量');
const transferMoneySchema = z
  .preprocess(preprocessSafeInteger, z.number().int().min(1).max(10_000_000))
  .describe('譲渡する所持金（1 以上の正の整数）');
const commentSchema = z
  .string()
  .trim()
  .min(1)
  .describe('この行動に対するコメントや感想。行動の理由や観察結果の所感を記述する。');
const okResponseSchema = z.object({ status: z.literal('ok') }).strict();
const notificationAckResponseSchema = z
  .object({ ok: z.literal(true), message: z.string().min(1) })
  .strict();
const errorResponseSchema = z
  .object({
    error: z.string().min(1),
    message: z.string().min(1),
    details: z.unknown().optional(),
  })
  .strict();

const moveOperationSchema = z
  .object({
    operation: z.literal('move'),
    target_node_id: nodeIdSchema.describe('移動先ノードID'),
  })
  .strict();

const actionOperationSchema = z
  .object({
    operation: z.literal('action'),
    action_id: z.string().min(1).describe('実行するアクションID'),
    duration_minutes: z
      .preprocess(preprocessSafeInteger, z.number().int().min(1).max(10080))
      .optional()
      .describe('可変時間アクションの所要時間（分）。通知に表示される範囲内で指定する。'),
  })
  .strict();

const useItemOperationSchema = z
  .object({
    operation: z.literal('use_item'),
    item_id: z.string().min(1).describe('使用するアイテムID'),
  })
  .strict();

const transferItemSchema = z.object({
  item_id: z.string().min(1),
  quantity: transferQuantitySchema,
}).strict();

// サーバー側 transferAttachmentSchema は { item } XOR { money } の排他 union。
// ここでは LLM 入力 / discriminatedUnion メンバーとの整合のため、両方 optional の
// strict object + superRefine で「ちょうど一方」を強制する。
function validateExclusiveItemOrMoney(
  data: { item?: unknown; money?: unknown },
  ctx: z.RefinementCtx,
): void {
  const hasItem = data.item != null;
  const hasMoney = data.money != null;
  if (hasItem && hasMoney) {
    ctx.addIssue({
      code: 'custom',
      message: 'item と money は同時に指定できません。どちらか 1 つだけを渡してください。',
    });
  } else if (!hasItem && !hasMoney) {
    ctx.addIssue({
      code: 'custom',
      message: 'item または money のいずれかを必ず指定してください。',
    });
  }
}

function validateExclusiveTransferAndResponse(
  data: { transfer?: unknown; transfer_response?: unknown },
  ctx: z.RefinementCtx,
): void {
  if (data.transfer != null && data.transfer_response != null) {
    ctx.addIssue({
      code: 'custom',
      message: 'transfer と transfer_response は同時に指定できません。',
    });
  }
}

const transferAttachmentSchema = z.object({
  item: transferItemSchema.optional(),
  money: transferMoneySchema.optional(),
}).strict().superRefine(validateExclusiveItemOrMoney);

const transferOperationObjectSchema = z.object({
  operation: z.literal('transfer'),
  target_agent_id: z.string().min(1),
  item: transferItemSchema.optional(),
  money: transferMoneySchema.optional(),
}).strict();

const acceptTransferOperationSchema = z.object({
  operation: z.literal('accept_transfer'),
  transfer_id: z.string().min(1),
}).strict();

const rejectTransferOperationSchema = z.object({
  operation: z.literal('reject_transfer'),
  transfer_id: z.string().min(1),
}).strict();

const waitOperationSchema = z
  .object({
    operation: z.literal('wait'),
    duration: waitDurationSchema,
  })
  .strict();

const conversationStartOperationSchema = z
  .object({
    operation: z.literal('conversation_start'),
    target_agent_id: z.string().min(1).describe('会話対象エージェントID'),
    message: z.string().min(1).describe('最初の発言'),
  })
  .strict();

const conversationAcceptOperationSchema = z
  .object({
    operation: z.literal('conversation_accept'),
    message: z.string().min(1).describe('受諾と同時に送る返答'),
  })
  .strict();

const conversationRejectOperationSchema = z
  .object({
    operation: z.literal('conversation_reject'),
  })
  .strict();

const conversationSpeakOperationObjectSchema = z
  .object({
    operation: z.literal('conversation_speak'),
    message: z.string().min(1).describe('発言内容'),
    next_speaker_agent_id: z.string().min(1).describe('次に発言すべきエージェントID'),
    transfer: transferAttachmentSchema.optional(),
    transfer_response: z.enum(['accept', 'reject']).optional(),
  })
  .strict();

const endConversationOperationSchema = z
  .object({
    operation: z.literal('end_conversation'),
    message: z.string().min(1).describe('お別れのメッセージ'),
    next_speaker_agent_id: z.string().min(1).describe('次に発言すべきエージェントID'),
    transfer_response: z.enum(['accept', 'reject']).optional(),
  })
  .strict();

const conversationJoinOperationSchema = z
  .object({
    operation: z.literal('conversation_join'),
    conversation_id: z.string().min(1).describe('参加する会話のID'),
  })
  .strict();

const conversationStayOperationSchema = z
  .object({
    operation: z.literal('conversation_stay'),
  })
  .strict();

const conversationLeaveOperationSchema = z
  .object({
    operation: z.literal('conversation_leave'),
    message: z.string().min(1).optional().describe('離脱時のメッセージ'),
  })
  .strict();

const serverEventSelectOperationSchema = z
  .object({
    operation: z.literal('server_event_select'),
    server_event_id: z.string().min(1).describe('サーバーイベントID'),
    choice_id: z.string().min(1).describe('選択肢ID'),
  })
  .strict();

const getMapOperationSchema = z.object({ operation: z.literal('get_map') }).strict();
const getWorldAgentsOperationSchema = z.object({ operation: z.literal('get_world_agents') }).strict();

export const karakuriWorldInputSchema = z.discriminatedUnion('operation', [
  moveOperationSchema,
  actionOperationSchema,
  useItemOperationSchema,
  transferOperationObjectSchema,
  acceptTransferOperationSchema,
  rejectTransferOperationSchema,
  waitOperationSchema,
  conversationStartOperationSchema,
  conversationAcceptOperationSchema,
  conversationRejectOperationSchema,
  conversationJoinOperationSchema,
  conversationStayOperationSchema,
  conversationLeaveOperationSchema,
  conversationSpeakOperationObjectSchema,
  endConversationOperationSchema,
  serverEventSelectOperationSchema,
  getMapOperationSchema,
  getWorldAgentsOperationSchema,
]).superRefine((input, ctx) => {
  if (input.operation === 'transfer') {
    validateExclusiveItemOrMoney(input, ctx);
  }

  if (input.operation === 'conversation_speak') {
    validateExclusiveTransferAndResponse(input, ctx);
  }
});

const moveToolInputSchema = moveOperationSchema.omit({ operation: true });
const actionToolInputSchema = actionOperationSchema.omit({ operation: true });
const useItemToolInputSchema = useItemOperationSchema.omit({ operation: true });
const transferToolInputSchema = transferOperationObjectSchema.omit({ operation: true });
const acceptTransferToolInputSchema = acceptTransferOperationSchema.omit({ operation: true });
const rejectTransferToolInputSchema = rejectTransferOperationSchema.omit({ operation: true });
const waitToolInputSchema = waitOperationSchema.omit({ operation: true });
const conversationStartToolInputSchema = conversationStartOperationSchema.omit({ operation: true });
const conversationAcceptToolInputSchema = conversationAcceptOperationSchema.omit({ operation: true });
const conversationRejectToolInputSchema = conversationRejectOperationSchema.omit({ operation: true });
const conversationJoinToolInputSchema = conversationJoinOperationSchema.omit({ operation: true });
const conversationStayToolInputSchema = conversationStayOperationSchema.omit({ operation: true });
const conversationLeaveToolInputSchema = conversationLeaveOperationSchema.omit({ operation: true });
const conversationSpeakToolInputSchema = conversationSpeakOperationObjectSchema.omit({ operation: true });
const endConversationToolInputSchema = endConversationOperationSchema.omit({ operation: true });
const serverEventSelectToolInputSchema = serverEventSelectOperationSchema.omit({ operation: true });
const getMapToolInputSchema = getMapOperationSchema.omit({ operation: true });
const getWorldAgentsToolInputSchema = getWorldAgentsOperationSchema.omit({ operation: true });

function withComment<TSchema extends z.AnyZodObject>(schema: TSchema) {
  return schema.extend({ comment: commentSchema });
}

const moveResponseSchema = z
  .object({
    from_node_id: nodeIdSchema,
    to_node_id: nodeIdSchema,
    arrives_at: z.number().int(),
  })
  .strict();

const waitResponseSchema = z
  .object({
    completes_at: z.number().int(),
  })
  .strict();

const conversationStartResponseSchema = z
  .object({
    conversation_id: z.string().min(1),
  })
  .strict();

// サーバー側 (karakuri-world) が将来 enum 値を追加してもクライアントを壊さないため、
// 既知 literal の union に汎用 string fallback を足して受ける。LLM への提示用 JSON schema は
// literal 列挙が残るので既知値の hint は維持される。
const transferStatusSchema = z.union([
  z.enum(['pending', 'completed', 'rejected', 'failed']),
  z.string().min(1),
]);
const transferFailureReasonSchema = z.union([
  z.enum([
    'persist_failed',
    'role_conflict',
    'overflow_inventory_full',
    'overflow_money',
    'validation_failed',
  ]),
  z.string().min(1),
]);

// transfer 系レスポンスは新機能で今後フィールド追加が見込まれるため `.strict()` を付けない。
// `ok: z.literal(true)` で API 失敗 (`{ ok: false, error }`) との取り違えはガードされる。
const transferActionResponseSchema = z.object({
  ok: z.literal(true),
  message: z.string().min(1),
  transfer_status: transferStatusSchema,
  transfer_id: z.string().min(1).optional(),
  failure_reason: transferFailureReasonSchema.optional(),
});

// `.strict()` を意図的に付けない: サーバーが将来 transfer_remaining_balance 等の
// フィールドを追加してもクライアントを壊さないため。後方互換性も維持
// (turn のみのレスポンスも引き続き valid)。
const conversationSpeakResponseSchema = z.object({
  turn: z.number().int(),
  transfer_status: transferStatusSchema.optional(),
  transfer_id: z.string().min(1).optional(),
  failure_reason: transferFailureReasonSchema.optional(),
});

// end_conversation は 2 人会話終了時に { turn } を返すが、
// 3 人以上のグループから自分だけ退出する場合は { status: 'ok' } を返す可能性がある。
const endConversationResponseSchema = z.union([conversationSpeakResponseSchema, okResponseSchema]);

export type KarakuriWorldInput = z.infer<typeof karakuriWorldInputSchema>;

type KarakuriWorldOperation = KarakuriWorldInput['operation'];
type KarakuriWorldToolInput<TOperation extends KarakuriWorldOperation> =
  Omit<Extract<KarakuriWorldInput, { operation: TOperation }>, 'operation'>;

export interface CreateKarakuriWorldToolsOptions extends ApiCredentials {
  fetch?: typeof fetch;
}

interface RequestContext {
  apiBaseUrl: string;
  apiKey: string;
  fetchImpl: typeof fetch;
}

type JsonResponseSchema = z.ZodTypeAny;

interface JsonRequestOptions<TSchema extends JsonResponseSchema> extends RequestContext {
  operation: KarakuriWorldInput['operation'];
  method: 'GET' | 'POST';
  path: string;
  responseSchema: TSchema;
  body?: Record<string, unknown>;
}

const TRANSIENT_FETCH_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_NETWORK_RETRIES = 1;
const BUSY_ERROR_CODES = new Set(['state_conflict', 'not_your_turn']);
const BUSY_INSTRUCTION = '今は同じ操作をすぐ再送しないでください。受信済みの会話依頼があればそれに対応し、それ以外は次の通知や状態変化を待ってください。';
const logger = createLogger('KarakuriWorldApi');

function normalizeApiBaseUrl(apiBaseUrl: string): string {
  return apiBaseUrl.replace(/\/+$/, '');
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const directCode = 'code' in error ? error.code : undefined;
  if (typeof directCode === 'string') {
    return directCode;
  }

  const cause = 'cause' in error ? error.cause : undefined;
  if (!cause || typeof cause !== 'object') {
    return undefined;
  }

  const causeCode = 'code' in cause ? cause.code : undefined;
  return typeof causeCode === 'string' ? causeCode : undefined;
}

function isRetryableFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error.name === 'AbortError' || error.name === 'TimeoutError') {
    return true;
  }

  const code = getErrorCode(error);
  if (code && TRANSIENT_FETCH_ERROR_CODES.has(code)) {
    return true;
  }

  return error instanceof TypeError && /fetch failed/i.test(error.message);
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return typeof error === 'string' ? error : 'Unknown error';
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    logger.debug('Response body is not valid JSON, returning raw text', {
      contentLength: text.length,
      prefix: text.slice(0, 120),
    });
    return text;
  }
}

export class KarakuriWorldNetworkError extends Error {
  readonly operation: KarakuriWorldInput['operation'];
  readonly url: string;
  readonly attempts: number;

  constructor(
    operation: KarakuriWorldInput['operation'],
    url: string,
    attempts: number,
    cause: unknown,
  ) {
    super(
      `Failed to reach the karakuri-world API for "${operation}" at ${url} after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${formatUnknownError(cause)}`,
      { cause },
    );
    this.name = 'KarakuriWorldNetworkError';
    this.operation = operation;
    this.url = url;
    this.attempts = attempts;
  }
}

export class KarakuriWorldApiError extends Error {
  readonly operation: KarakuriWorldInput['operation'];
  readonly url: string;
  readonly status: number;
  readonly code: string | undefined;
  readonly apiMessage: string;
  readonly details: unknown;

  constructor(
    operation: KarakuriWorldInput['operation'],
    url: string,
    status: number,
    message: string,
    code?: string,
    details?: unknown,
  ) {
    super(`karakuri-world API returned ${status} for "${operation}" at ${url}: ${message}`);
    this.name = 'KarakuriWorldApiError';
    this.operation = operation;
    this.url = url;
    this.status = status;
    this.apiMessage = message;
    this.code = code;
    this.details = details;
  }
}

export class KarakuriWorldResponseError extends Error {
  readonly operation: KarakuriWorldInput['operation'];
  readonly url: string;
  readonly status: number;
  readonly details: unknown;

  constructor(
    operation: KarakuriWorldInput['operation'],
    url: string,
    status: number,
    message: string,
    details?: unknown,
  ) {
    super(`Invalid karakuri-world API response for "${operation}" at ${url}: ${message}`);
    this.name = 'KarakuriWorldResponseError';
    this.operation = operation;
    this.url = url;
    this.status = status;
    this.details = details;
  }
}

async function requestJson<TSchema extends JsonResponseSchema>({
  operation,
  method,
  path,
  responseSchema,
  body,
  apiBaseUrl,
  apiKey,
  fetchImpl,
}: JsonRequestOptions<TSchema>): Promise<z.infer<TSchema>> {
  const normalizedBaseUrl = normalizeApiBaseUrl(apiBaseUrl);
  const url = new URL(path, ensureTrailingSlash(normalizedBaseUrl)).toString();
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  let attempts = 0;
  let lastError: unknown;

  while (attempts <= MAX_NETWORK_RETRIES) {
    attempts += 1;
    const requestInit: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    logger.debug('API request', {
      operation,
      method,
      url,
      attempt: attempts,
    });

    let response: Response;
    try {
      response = await fetchImpl(url, requestInit);
    } catch (error) {
      lastError = error;
      if (method === 'GET' && attempts <= MAX_NETWORK_RETRIES && isRetryableFetchError(error)) {
        logger.warn('Retrying API request', {
          operation,
          attempt: attempts,
          errorCode: getErrorCode(error),
        });
        continue;
      }

      logger.error('API network error', { operation, url, attempts });
      throw new KarakuriWorldNetworkError(operation, url, attempts, error);
    }

    let responseBody: unknown;
    try {
      responseBody = await readResponseBody(response);
    } catch (error) {
      lastError = error;
      if (method === 'GET' && attempts <= MAX_NETWORK_RETRIES && isRetryableFetchError(error)) {
        logger.warn('Retrying API request (body read failed)', {
          operation,
          attempt: attempts,
        });
        continue;
      }

      logger.error('Failed to read API response body', { operation, url, attempts });
      throw new KarakuriWorldNetworkError(operation, url, attempts, error);
    }

    if (!response.ok) {
      const parsedError = errorResponseSchema.safeParse(responseBody);
      if (parsedError.success) {
        logger.error('API error response', {
          operation,
          status: response.status,
          code: parsedError.data.error,
        });
        throw new KarakuriWorldApiError(
          operation,
          url,
          response.status,
          parsedError.data.message,
          parsedError.data.error,
          parsedError.data.details,
        );
      }

      logger.error('API error response', {
        operation,
        status: response.status,
        code: undefined,
      });
      throw new KarakuriWorldApiError(
        operation,
        url,
        response.status,
        typeof responseBody === 'string' && responseBody.length > 0
          ? responseBody
          : response.statusText || 'Request failed',
        undefined,
        responseBody,
      );
    }

    const parsedResponse = responseSchema.safeParse(responseBody);
    if (!parsedResponse.success) {
      logger.error('API response validation failed', { operation, status: response.status });
      throw new KarakuriWorldResponseError(
        operation,
        url,
        response.status,
        'Response validation failed.',
        {
          body: responseBody,
          issues: parsedResponse.error.issues,
        },
      );
    }

    logger.debug('API response', { operation, status: response.status });
    return parsedResponse.data;
  }

  logger.error('API network error', { operation, url, attempts });
  throw new KarakuriWorldNetworkError(operation, url, attempts, lastError);
}

async function executeKarakuriWorldOperation(
  input: KarakuriWorldInput,
  context: RequestContext,
): Promise<unknown> {
  logger.debug('Executing operation', { operation: input.operation });
  const result = await (async (): Promise<unknown> => {
    switch (input.operation) {
      case 'move':
        return requestJson({
          ...context,
          operation: input.operation,
          method: 'POST',
          path: 'api/agents/move',
          body: { target_node_id: input.target_node_id },
          responseSchema: moveResponseSchema,
        });
      case 'action':
        return requestJson({
          ...context,
          operation: input.operation,
          method: 'POST',
          path: 'api/agents/action',
          body: {
            action_id: input.action_id,
            ...(input.duration_minutes !== undefined && { duration_minutes: input.duration_minutes }),
          },
          responseSchema: notificationAckResponseSchema,
        });
      case 'use_item':
        return requestJson({
          ...context,
          operation: input.operation,
          method: 'POST',
          path: 'api/agents/use-item',
          body: { item_id: input.item_id },
          responseSchema: notificationAckResponseSchema,
        });
      case 'transfer':
        return requestJson({
          ...context,
          operation: input.operation,
          method: 'POST',
          path: 'api/agents/transfer',
          body: {
            target_agent_id: input.target_agent_id,
            ...(input.item !== undefined && { item: input.item }),
            ...(input.money !== undefined && { money: input.money }),
          },
          responseSchema: transferActionResponseSchema,
        });
      case 'accept_transfer':
        return requestJson({
          ...context,
          operation: input.operation,
          method: 'POST',
          path: 'api/agents/transfer/accept',
          body: { transfer_id: input.transfer_id },
          responseSchema: transferActionResponseSchema,
        });
      case 'reject_transfer':
        return requestJson({
          ...context,
          operation: input.operation,
          method: 'POST',
          path: 'api/agents/transfer/reject',
          body: { transfer_id: input.transfer_id },
          responseSchema: transferActionResponseSchema,
        });
      case 'wait':
        return requestJson({
          ...context,
          operation: input.operation,
          method: 'POST',
          path: 'api/agents/wait',
          body: { duration: input.duration },
          responseSchema: waitResponseSchema,
        });
      case 'conversation_start':
        return requestJson({
          ...context,
          operation: input.operation,
          method: 'POST',
          path: 'api/agents/conversation/start',
          body: {
            target_agent_id: input.target_agent_id,
            message: input.message,
          },
          responseSchema: conversationStartResponseSchema,
        });
      case 'conversation_accept':
        return requestJson({
          ...context,
          operation: input.operation,
          method: 'POST',
          path: 'api/agents/conversation/accept',
          body: { message: input.message },
          responseSchema: okResponseSchema,
        });
      case 'conversation_reject':
        return requestJson({
          ...context,
          operation: input.operation,
          method: 'POST',
          path: 'api/agents/conversation/reject',
          body: {},
          responseSchema: okResponseSchema,
        });
      case 'conversation_join':
        return requestJson({
          ...context,
          operation: input.operation,
          method: 'POST',
          path: 'api/agents/conversation/join',
          body: {
            conversation_id: input.conversation_id,
          },
          responseSchema: okResponseSchema,
        });
      case 'conversation_stay':
        return requestJson({
          ...context,
          operation: input.operation,
          method: 'POST',
          path: 'api/agents/conversation/stay',
          body: {},
          responseSchema: okResponseSchema,
        });
      case 'conversation_leave':
        return requestJson({
          ...context,
          operation: input.operation,
          method: 'POST',
          path: 'api/agents/conversation/leave',
          body: {
            ...(input.message !== undefined && { message: input.message }),
          },
          responseSchema: okResponseSchema,
        });
      case 'conversation_speak':
        return requestJson({
          ...context,
          operation: input.operation,
          method: 'POST',
          path: 'api/agents/conversation/speak',
          body: {
            message: input.message,
            next_speaker_agent_id: input.next_speaker_agent_id,
            ...(input.transfer !== undefined && { transfer: input.transfer }),
            ...(input.transfer_response !== undefined && { transfer_response: input.transfer_response }),
          },
          responseSchema: conversationSpeakResponseSchema,
        });
      case 'end_conversation':
        return requestJson({
          ...context,
          operation: input.operation,
          method: 'POST',
          path: 'api/agents/conversation/end',
          body: {
            message: input.message,
            next_speaker_agent_id: input.next_speaker_agent_id,
            ...(input.transfer_response !== undefined && { transfer_response: input.transfer_response }),
          },
          responseSchema: endConversationResponseSchema,
        });
      case 'server_event_select':
        return requestJson({
          ...context,
          operation: input.operation,
          method: 'POST',
          path: 'api/agents/server-event/select',
          body: {
            server_event_id: input.server_event_id,
            choice_id: input.choice_id,
          },
          responseSchema: okResponseSchema,
        });
      case 'get_map':
        return requestJson({
          ...context,
          operation: input.operation,
          method: 'GET',
          path: 'api/agents/map',
          responseSchema: notificationAckResponseSchema,
        });
      case 'get_world_agents':
        return requestJson({
          ...context,
          operation: input.operation,
          method: 'GET',
          path: 'api/agents/world-agents',
          responseSchema: notificationAckResponseSchema,
        });
      default: {
        const _exhaustive: never = input;
        throw new Error(`Unhandled karakuri-world operation: ${(_exhaustive as { operation: string }).operation}`);
      }
    }
  })();

  logger.debug('Operation completed', { operation: input.operation });
  return result;
}

function createOperationInput<TOperation extends KarakuriWorldOperation>(
  operation: TOperation,
  input: KarakuriWorldToolInput<TOperation>,
): KarakuriWorldInput {
  return karakuriWorldInputSchema.parse({
    operation,
    ...input,
  });
}

function isBusyError(error: unknown): error is KarakuriWorldApiError {
  return (
    error instanceof KarakuriWorldApiError
    && error.status === 409
    && error.code !== undefined
    && BUSY_ERROR_CODES.has(error.code)
  );
}

function isNotLoggedInError(error: unknown): error is KarakuriWorldApiError {
  return (
    error instanceof KarakuriWorldApiError
    && error.status === 403
    && error.code === 'not_logged_in'
  );
}

async function executeKarakuriWorldTool<TOperation extends KarakuriWorldOperation>(
  operation: TOperation,
  input: KarakuriWorldToolInput<TOperation>,
  context: RequestContext,
): Promise<unknown> {
  try {
    return await executeKarakuriWorldOperation(createOperationInput(operation, input), context);
  } catch (error) {
    if (isBusyError(error)) {
      logger.info('Agent is busy, returning informational response', {
        operation,
        status: error.status,
        code: error.code,
      });
      return {
        status: 'busy',
        message: error.apiMessage,
        instruction: BUSY_INSTRUCTION,
      };
    }

    if (isNotLoggedInError(error)) {
      logger.warn('Agent is not logged in, returning informational response', {
        operation,
        status: error.status,
        code: error.code,
      });
      return {
        status: 'not_logged_in',
        message: error.apiMessage,
      };
    }

    logger.error('Tool execution failed', { operation, error });
    throw error;
  }
}

async function executeKarakuriWorldToolStrippingComment(
  operation: KarakuriWorldOperation,
  input: Record<string, unknown>,
  context: RequestContext,
): Promise<unknown> {
  const { comment: _comment, ...requestInput } = input;
  return executeKarakuriWorldTool(operation as never, requestInput as never, context);
}

export function createKarakuriWorldTools({
  apiBaseUrl,
  apiKey,
  fetch: fetchImpl = (...args) => globalThis.fetch(...args),
}: CreateKarakuriWorldToolsOptions): ToolSet {
  const context: RequestContext = {
    apiBaseUrl,
    apiKey,
    fetchImpl,
  };

  return {
    karakuri_world_get_map: tool({
      description: 'ワールド全体の地図情報取得を依頼する。詳細は通知で届く。',
      inputSchema: withComment(getMapToolInputSchema),
      execute: async (input) => executeKarakuriWorldToolStrippingComment('get_map', input, context),
    }),
    karakuri_world_get_world_agents: tool({
      description: 'ログイン中エージェントの一覧と状態の取得を依頼する。詳細は通知で届く。',
      inputSchema: withComment(getWorldAgentsToolInputSchema),
      execute: async (input) => executeKarakuriWorldToolStrippingComment('get_world_agents', input, context),
    }),
    karakuri_world_move: tool({
      description: '目的地ノードへ移動する。`target_node_id` を渡す。',
      inputSchema: withComment(moveToolInputSchema),
      execute: async (input) => executeKarakuriWorldToolStrippingComment('move', input, context),
    }),
    karakuri_world_action: tool({
      description: 'アクションを実行する。`action_id` を渡す。可変時間アクションの場合は通知に表示された範囲内で `duration_minutes` も指定する。結果は通知で届く。',
      inputSchema: withComment(actionToolInputSchema),
      execute: async (input) => executeKarakuriWorldToolStrippingComment('action', input, context),
    }),
    karakuri_world_use_item: tool({
      description: '所持アイテムを使用する。`item_id` を渡す。結果は通知で届く。',
      inputSchema: withComment(useItemToolInputSchema),
      execute: async (input) => executeKarakuriWorldToolStrippingComment('use_item', input, context),
    }),
    karakuri_world_transfer: tool({
      description: '隣接または同一ノードの idle / in_action エージェントへアイテム 1 種類または所持金のいずれか 1 つを譲渡する。`target_agent_id` と `item`（{item_id, quantity}）または `money`（正の整数）のどちらか一方だけを渡す（同時指定不可）。受信側は accept/reject 通知に応答する。',
      inputSchema: withComment(transferToolInputSchema).superRefine((data, ctx) => {
        validateExclusiveItemOrMoney({ item: data.item, money: data.money }, ctx);
      }),
      execute: async (input) => executeKarakuriWorldToolStrippingComment('transfer', input, context),
    }),
    karakuri_world_accept_transfer: tool({
      description: '受信中の standalone 譲渡オファーを受諾する。`transfer_id` を渡す。会話中の譲渡は conversation_speak または end_conversation の transfer_response を使うこと。',
      inputSchema: withComment(acceptTransferToolInputSchema),
      execute: async (input) => executeKarakuriWorldToolStrippingComment('accept_transfer', input, context),
    }),
    karakuri_world_reject_transfer: tool({
      description: '受信中の standalone 譲渡オファーを拒否する。`transfer_id` を渡す。会話中の譲渡は conversation_speak または end_conversation の transfer_response を使うこと。',
      inputSchema: withComment(rejectTransferToolInputSchema),
      execute: async (input) => executeKarakuriWorldToolStrippingComment('reject_transfer', input, context),
    }),
    karakuri_world_wait: tool({
      description: 'その場で待機する。`duration` を渡す（10分単位、1〜6）。',
      inputSchema: withComment(waitToolInputSchema),
      execute: async (input) => executeKarakuriWorldToolStrippingComment('wait', input, context),
    }),
    karakuri_world_conversation_start: tool({
      description: '近くのエージェントへ話しかける。`target_agent_id` と `message` を渡す。',
      inputSchema: withComment(conversationStartToolInputSchema),
      execute: async (input) => executeKarakuriWorldToolStrippingComment('conversation_start', input, context),
    }),
    karakuri_world_conversation_accept: tool({
      description: '会話着信を受諾して返答する。`message` を渡す。',
      inputSchema: withComment(conversationAcceptToolInputSchema),
      execute: async (input) => executeKarakuriWorldToolStrippingComment('conversation_accept', input, context),
    }),
    karakuri_world_conversation_reject: tool({
      description: '会話着信を拒否する。引数不要。',
      inputSchema: withComment(conversationRejectToolInputSchema),
      execute: async (input) => executeKarakuriWorldToolStrippingComment('conversation_reject', input, context),
    }),
    karakuri_world_conversation_join: tool({
      description: '近くで進行中の会話に参加表明する。`conversation_id` を渡す。参加は次のターン境界で反映され、それまで発言機会は無い。',
      inputSchema: withComment(conversationJoinToolInputSchema),
      execute: async (input) => executeKarakuriWorldToolStrippingComment('conversation_join', input, context),
    }),
    karakuri_world_conversation_stay: tool({
      description: 'inactive_check 通知に対して会話に残ることを表明する。引数不要。',
      inputSchema: withComment(conversationStayToolInputSchema),
      execute: async (input) => executeKarakuriWorldToolStrippingComment('conversation_stay', input, context),
    }),
    karakuri_world_conversation_leave: tool({
      description: 'inactive_check 通知に対して会話から離脱する。任意でお別れの `message` を渡せる。',
      inputSchema: withComment(conversationLeaveToolInputSchema),
      execute: async (input) => executeKarakuriWorldToolStrippingComment('conversation_leave', input, context),
    }),
    karakuri_world_conversation_speak: tool({
      description: '会話中に発言する。`message` と `next_speaker_agent_id` を渡す。必要に応じて `transfer` または `transfer_response` を任意で添えられるが、同時指定はできない。',
      inputSchema: withComment(conversationSpeakToolInputSchema).superRefine((data, ctx) => {
        if (data.transfer && data.transfer_response) {
          ctx.addIssue({
            code: 'custom',
            message: 'transfer と transfer_response は同時に指定できません。',
          });
        }
      }),
      execute: async (input) => executeKarakuriWorldToolStrippingComment('conversation_speak', input, context),
    }),
    karakuri_world_end_conversation: tool({
      description: '会話を終了または退出する。お別れの `message` と `next_speaker_agent_id` を渡す。必要に応じて `transfer_response` のみ任意で添えられる。2人会話では会話全体を終了する。3人以上では自分だけ退出する。',
      inputSchema: withComment(endConversationToolInputSchema),
      execute: async (input) => executeKarakuriWorldToolStrippingComment('end_conversation', input, context),
    }),
    karakuri_world_server_event_select: tool({
      description: 'サーバーイベントの選択肢を選ぶ。`server_event_id` と `choice_id` を渡す。',
      inputSchema: withComment(serverEventSelectToolInputSchema),
      execute: async (input) => executeKarakuriWorldToolStrippingComment('server_event_select', input, context),
    }),
  };
}
