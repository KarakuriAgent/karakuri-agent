import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

import type { ApiCredentials } from '../../config.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('KarakuriWorldApi');

const commandSchema = z
  .string()
  .trim()
  .min(1)
  .describe('取得済み通知の notification.choices[] に含まれる command をそのまま指定する。');

const paramsSchema = z
  .record(z.string(), z.unknown())
  .optional()
  .default({})
  .describe('選んだ choices[].params に、required_params / param_schema から補った値だけを merge した JSON object。');

const commentSchema = z
  .string()
  .trim()
  .min(1)
  .describe('Discord に返すキャラ口調の行動コメント。現在のロール/人格に合う短い口調で、選んだ command と実用上の理由が伝わるように書く。');

export const karakuriWorldCommandInputSchema = z
  .object({
    command: commandSchema,
    params: paramsSchema,
    comment: commentSchema,
  })
  .strict();

const karakuriWorldNotificationChoiceSchema = z
  .object({
    command: z.string().min(1),
    label: z.string().min(1),
    params: z.record(z.string(), z.unknown()).optional(),
    required_params: z.array(z.string()).optional(),
    param_schema: z.record(z.string(), z.unknown()).optional(),
    param_constraints: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const karakuriWorldNotificationSchema = z
  .object({
    schema_version: z.literal(1),
    kind: z.string().min(1),
    summary: z.string(),
    choices: z.array(karakuriWorldNotificationChoiceSchema),
    payload: z.record(z.string(), z.unknown()).optional(),
    perception: z.unknown().optional(),
  })
  .passthrough();

export const karakuriWorldNotificationResponseSchema = z
  .object({
    ok: z.literal(true),
    notification_id: z.string().min(1),
    created_at: z.number(),
    expires_at: z.number(),
    stale: z.boolean(),
    notification: karakuriWorldNotificationSchema,
  })
  .passthrough();

const errorResponseSchema = z
  .object({
    error: z.string().min(1),
    message: z.string().min(1),
    details: z.unknown().optional(),
  })
  .strict();

export type KarakuriWorldCommandInput = z.infer<typeof karakuriWorldCommandInputSchema>;
export type KarakuriWorldNotificationResponse = z.infer<typeof karakuriWorldNotificationResponseSchema>;

type KarakuriWorldOperation = 'get_notification' | 'command';

export interface CreateKarakuriWorldToolsOptions extends ApiCredentials {
  notificationId: string;
  allowedCommands?: readonly string[];
  fetch?: typeof fetch;
}

export interface FetchKarakuriWorldNotificationOptions extends ApiCredentials {
  fetch?: typeof fetch;
}

interface RequestContext {
  apiBaseUrl: string;
  apiKey: string;
  fetchImpl: typeof fetch;
}

type JsonResponseSchema = z.ZodTypeAny;

interface JsonRequestOptions<TSchema extends JsonResponseSchema> extends RequestContext {
  operation: KarakuriWorldOperation;
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
const BUSY_INSTRUCTION = '同じ通知で別 command を連続実行せず、次の通知を待ってください。';

function normalizeApiBaseUrl(apiBaseUrl: string): string {
  return apiBaseUrl.replace(/\/+$/, '');
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function buildApiUrl(apiBaseUrl: string, path: string): string {
  return new URL(path.replace(/^\/+/, ''), ensureTrailingSlash(normalizeApiBaseUrl(apiBaseUrl))).toString();
}

function normalizeAllowedCommands(allowedCommands: readonly string[] | undefined): string[] {
  return [...new Set((allowedCommands ?? [])
    .map((command) => command.trim())
    .filter((command) => command.length > 0))];
}

function createCommandInputSchemaForChoices(allowedCommands: readonly string[]): z.ZodTypeAny {
  const firstCommand = allowedCommands[0];
  if (firstCommand == null) {
    return karakuriWorldCommandInputSchema;
  }

  const commandEnumSchema = z
    .enum([firstCommand, ...allowedCommands.slice(1)] as [string, ...string[]])
    .describe('取得済み通知の notification.choices[] に含まれる command をそのまま指定する。');

  return z
    .object({
      command: commandEnumSchema,
      params: paramsSchema,
      comment: commentSchema,
    })
    .strict();
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
  readonly operation: KarakuriWorldOperation;
  readonly url: string;
  readonly attempts: number;

  constructor(operation: KarakuriWorldOperation, url: string, attempts: number, cause: unknown) {
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
  readonly operation: KarakuriWorldOperation;
  readonly url: string;
  readonly status: number;
  readonly code: string | undefined;
  readonly apiMessage: string;
  readonly details: unknown;

  constructor(
    operation: KarakuriWorldOperation,
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
  readonly operation: KarakuriWorldOperation;
  readonly url: string;
  readonly status: number;
  readonly details: unknown;

  constructor(
    operation: KarakuriWorldOperation,
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
  const url = buildApiUrl(apiBaseUrl, path);
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
    logger.debug('API request', { operation, method, url, attempt: attempts });

    let response: Response;
    try {
      response = await fetchImpl(url, requestInit);
    } catch (error) {
      lastError = error;
      if (method === 'GET' && attempts <= MAX_NETWORK_RETRIES && isRetryableFetchError(error)) {
        logger.warn('Retrying API request', { operation, attempt: attempts, errorCode: getErrorCode(error) });
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
        logger.warn('Retrying API request (body read failed)', { operation, attempt: attempts });
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

      logger.error('API error response', { operation, status: response.status, code: undefined });
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

function isBusyError(error: unknown): error is KarakuriWorldApiError {
  return (
    error instanceof KarakuriWorldApiError
    && error.operation === 'command'
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

export function isKarakuriWorldNotificationFetchError(error: unknown): error is KarakuriWorldApiError {
  return error instanceof KarakuriWorldApiError && error.operation === 'get_notification';
}

export async function fetchKarakuriWorldNotification({
  apiBaseUrl,
  apiKey,
  fetch: fetchImpl = (...args) => globalThis.fetch(...args),
}: FetchKarakuriWorldNotificationOptions, notificationId: string): Promise<KarakuriWorldNotificationResponse> {
  const context: RequestContext = { apiBaseUrl, apiKey, fetchImpl };
  return requestJson({
    ...context,
    operation: 'get_notification',
    method: 'GET',
    path: `agents/notifications/${encodeURIComponent(notificationId)}`,
    responseSchema: karakuriWorldNotificationResponseSchema,
  });
}

async function executeKarakuriWorldCommand(
  notificationId: string,
  input: Record<string, unknown>,
  context: RequestContext,
  allowedCommands: ReadonlySet<string> | null,
): Promise<unknown> {
  try {
    const parsed = karakuriWorldCommandInputSchema.parse(input);
    if (allowedCommands != null && !allowedCommands.has(parsed.command)) {
      logger.error('Command is not present in fetched notification choices', {
        notificationId,
        command: parsed.command,
        allowedCommands: [...allowedCommands],
      });
      throw new Error(`karakuri-world command is not allowed by this notification: ${parsed.command}`);
    }

    return await requestJson({
      ...context,
      operation: 'command',
      method: 'POST',
      path: 'agents/command',
      body: {
        notification_id: notificationId,
        command: parsed.command,
        params: parsed.params,
      },
      responseSchema: z.unknown(),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.error('Tool input validation failed', { operation: 'command', issues: error.issues });
      throw error;
    }

    if (isBusyError(error)) {
      logger.info('Agent is busy, returning informational response', {
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
        status: error.status,
        code: error.code,
      });
      return {
        status: 'not_logged_in',
        message: error.apiMessage,
      };
    }

    logger.error('Tool execution failed', { operation: 'command', error });
    throw error;
  }
}

export function createKarakuriWorldTools({
  apiBaseUrl,
  apiKey,
  notificationId,
  allowedCommands,
  fetch: fetchImpl = (...args) => globalThis.fetch(...args),
}: CreateKarakuriWorldToolsOptions): ToolSet {
  const context: RequestContext = { apiBaseUrl, apiKey, fetchImpl };
  const normalizedAllowedCommands = normalizeAllowedCommands(allowedCommands);
  const allowedCommandSet = normalizedAllowedCommands.length > 0 ? new Set(normalizedAllowedCommands) : null;
  const allowedCommandDescription = normalizedAllowedCommands.length > 0
    ? ` Allowed command values for this notification: ${normalizedAllowedCommands.join(', ')}.`
    : '';
  const inputSchema = createCommandInputSchemaForChoices(normalizedAllowedCommands);

  return {
    karakuri_world_command: tool({
      description:
        'get_notification 済みの保存済み通知に対して、notification.choices[] から選んだ command を最大1回だけ実行する。notification_id はシステム側で固定されるため入力しない。params は JSON object にする。'
        + allowedCommandDescription,
      inputSchema,
      execute: async (input) => executeKarakuriWorldCommand(notificationId, input, context, allowedCommandSet),
    }),
  };
}
