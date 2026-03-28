import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

import type { ApiCredentials } from '../../config.js';
import { createLogger } from '../../utils/logger.js';

const nodeIdSchema = z.string().regex(/^\d+-\d+$/);
const integerTextPattern = /^\d+$/;
const waitDurationSchema = z
  .preprocess((value) => {
    if (typeof value !== 'string') {
      return value;
    }

    const trimmed = value.trim();
    if (!integerTextPattern.test(trimmed)) {
      return value;
    }

    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) ? parsed : value;
  }, z.number().int().min(1).max(6))
  .describe('待機時間（10分単位、1=10分〜6=60分）');
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
  })
  .strict();

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

const conversationSpeakOperationSchema = z
  .object({
    operation: z.literal('conversation_speak'),
    message: z.string().min(1).describe('発言内容'),
  })
  .strict();

const endConversationOperationSchema = z
  .object({
    operation: z.literal('end_conversation'),
    message: z.string().min(1).describe('お別れのメッセージ'),
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
  waitOperationSchema,
  conversationStartOperationSchema,
  conversationAcceptOperationSchema,
  conversationRejectOperationSchema,
  conversationSpeakOperationSchema,
  endConversationOperationSchema,
  serverEventSelectOperationSchema,
  getMapOperationSchema,
  getWorldAgentsOperationSchema,
]);

const moveToolInputSchema = moveOperationSchema.omit({ operation: true });
const actionToolInputSchema = actionOperationSchema.omit({ operation: true });
const waitToolInputSchema = waitOperationSchema.omit({ operation: true });
const conversationStartToolInputSchema = conversationStartOperationSchema.omit({ operation: true });
const conversationAcceptToolInputSchema = conversationAcceptOperationSchema.omit({ operation: true });
const conversationRejectToolInputSchema = conversationRejectOperationSchema.omit({ operation: true });
const conversationSpeakToolInputSchema = conversationSpeakOperationSchema.omit({ operation: true });
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

const actionResponseSchema = z
  .object({
    action_id: z.string().min(1),
    action_name: z.string().min(1),
    completes_at: z.number().int(),
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

const conversationSpeakResponseSchema = z
  .object({
    turn: z.number().int(),
  })
  .strict();

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
          body: { action_id: input.action_id },
          responseSchema: actionResponseSchema,
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
      case 'conversation_speak':
        return requestJson({
          ...context,
          operation: input.operation,
          method: 'POST',
          path: 'api/agents/conversation/speak',
          body: {
            message: input.message,
          },
          responseSchema: conversationSpeakResponseSchema,
        });
      case 'end_conversation':
        // サーバー側 PR #20 で end もターン番号を返す設計のため conversationSpeakResponseSchema を共有
        return requestJson({
          ...context,
          operation: input.operation,
          method: 'POST',
          path: 'api/agents/conversation/end',
          body: {
            message: input.message,
          },
          responseSchema: conversationSpeakResponseSchema,
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
      description: 'アクションを実行する。`action_id` を渡す。',
      inputSchema: withComment(actionToolInputSchema),
      execute: async (input) => executeKarakuriWorldToolStrippingComment('action', input, context),
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
    karakuri_world_conversation_speak: tool({
      description: '会話中に発言する。`message` を渡す。',
      inputSchema: withComment(conversationSpeakToolInputSchema),
      execute: async (input) => executeKarakuriWorldToolStrippingComment('conversation_speak', input, context),
    }),
    karakuri_world_end_conversation: tool({
      description: '会話を自発的に終了する。お別れの `message` を渡す。',
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
