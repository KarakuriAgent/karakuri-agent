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

// 実サーバーのエラーボディは {error, message, details, hint, suggestions, ...} 形式。
// 以前は .strict() だったため hint / suggestions 付きのボディがパース失敗し、
// code=undefined に落ちて busy 変換が本番で一度も効かないバグがあった（未知キーは
// 拒否せず受け流す）
const errorResponseSchema = z
  .object({
    error: z.string().min(1),
    message: z.string().min(1),
    details: z.unknown().optional(),
    hint: z.string().optional(),
    suggestions: z.unknown().optional(),
  })
  .passthrough();

export type KarakuriWorldCommandInput = z.infer<typeof karakuriWorldCommandInputSchema>;
export type KarakuriWorldNotificationResponse = z.infer<typeof karakuriWorldNotificationResponseSchema>;

type KarakuriWorldOperation = 'get_notification' | 'command';

export interface CreateKarakuriWorldToolsOptions extends ApiCredentials {
  notificationId: string;
  allowedCommands?: readonly string[];
  fetch?: typeof fetch;
  /** 通知の応答期限（ms epoch）。期限切れなら API を呼ばず案内を返す（#103） */
  expiresAt?: number | undefined;
  /** 現在地（通知の perception 由来）。move の same_node を API を呼ばず検出する（#103） */
  currentNode?: KarakuriWorldCurrentNode | undefined;
  /**
   * コマンド実行の成否フック（失敗ストリーク検出用 — #103）。
   * - 成功 → failed: false（ストリーク解消）
   * - same_node の事前検出・API エラー → failed: true（無効だった試み）
   * - busy / not_logged_in / stale の事前検出 → フックを呼ばない（中立。
   *   正当な状態や積み残し通知の期限切れでストリークを消しも増やしもしない）
   */
  onCommandOutcome?: ((outcome: { command: string; failed: boolean }) => void) | undefined;
  now?: (() => Date) | undefined;
}

export interface KarakuriWorldCurrentNode {
  nodeId?: string | undefined;
  buildingId?: string | undefined;
  label?: string | undefined;
}

/** 通知の perception から現在地を取り出す（無ければ null。構造は変わりうるため安全に辿る） */
export function extractKarakuriWorldCurrentNode(
  notificationResponse: KarakuriWorldNotificationResponse,
): KarakuriWorldCurrentNode | null {
  const perception = notificationResponse.notification.perception;
  if (typeof perception !== 'object' || perception == null) {
    return null;
  }
  const currentNode = (perception as { current_node?: unknown }).current_node;
  if (typeof currentNode !== 'object' || currentNode == null) {
    return null;
  }
  const node = currentNode as { node_id?: unknown; building_id?: unknown; location_label?: unknown; label?: unknown };
  const nodeId = typeof node.node_id === 'string' ? node.node_id : undefined;
  const buildingId = typeof node.building_id === 'string' ? node.building_id : undefined;
  const label = typeof node.location_label === 'string'
    ? node.location_label
    : typeof node.label === 'string' ? node.label : undefined;
  if (nodeId == null && buildingId == null) {
    return null;
  }
  return { nodeId, buildingId, label };
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
const BUSY_INSTRUCTION = 'このコマンドは実行されていません。行動が進行中か、世界の状態が変わったか、通知が新しいものに置き換わっています。同じ通知で command を再実行せず、次の通知で選び直してください。';

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
  /** サーバーが返す対処ヒント（例:「受諾または拒否を選んでください」）。あれば LLM へそのまま見せる */
  readonly hint: string | undefined;

  constructor(
    operation: KarakuriWorldOperation,
    url: string,
    status: number,
    message: string,
    code?: string,
    details?: unknown,
    hint?: string,
  ) {
    super(`karakuri-world API returned ${status} for "${operation}" at ${url}: ${message}`);
    this.name = 'KarakuriWorldApiError';
    this.operation = operation;
    this.url = url;
    this.status = status;
    this.apiMessage = message;
    this.code = code;
    this.details = details;
    this.hint = hint;
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
          hint: parsedError.data.hint,
        });
        throw new KarakuriWorldApiError(
          operation,
          url,
          response.status,
          parsedError.data.message,
          parsedError.data.error,
          parsedError.data.details,
          parsedError.data.hint,
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

/**
 * command への 409 は「世界側の状態と噛み合わなかった」正常系 — 行動の進行中、
 * 会話/譲渡の応答待ち、通知の置き換え・失効（サーバー仕様で notification_id は
 * 最新のもの以外無効になる）など。生の例外として LLM へ見せると「サーバーが
 * 混んでいる」等と誤解釈して待機戦略を学習するため（実機で発生）、code の
 * 有無によらず常に informational な結果へ変換する。
 */
function isCommandConflictError(error: unknown): error is KarakuriWorldApiError {
  return (
    error instanceof KarakuriWorldApiError
    && error.operation === 'command'
    && error.status === 409
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

interface ExecuteCommandGuards {
  expiresAt?: number | undefined;
  currentNode?: KarakuriWorldCurrentNode | undefined;
  onCommandOutcome?: ((outcome: { command: string; failed: boolean }) => void) | undefined;
  now?: (() => Date) | undefined;
}

async function executeKarakuriWorldCommand(
  notificationId: string,
  input: Record<string, unknown>,
  context: RequestContext,
  allowedCommands: ReadonlySet<string> | null,
  guards: ExecuteCommandGuards = {},
): Promise<unknown> {
  const command = typeof input['command'] === 'string' ? input['command'] : 'unknown';
  const reportOutcome = (failed: boolean): void => {
    try {
      guards.onCommandOutcome?.({ command, failed });
    } catch (hookError) {
      logger.warn('Command outcome hook failed', { error: hookError });
    }
  };

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

    // 事前検証（#103）: API を呼ばずに無効な試みを案内へ変換する
    const nowMs = (guards.now?.() ?? new Date()).getTime();
    // expires_at は ms epoch（実 API で確認済み）。単位が疑わしい小さな値は
    // 誤判定（全コマンド停止）を避けるため検査しない
    const expiresAtLooksLikeMs = guards.expiresAt != null && guards.expiresAt > 1_000_000_000_000;
    if (expiresAtLooksLikeMs && nowMs > guards.expiresAt!) {
      logger.info('Notification is already expired, returning informational response', {
        notificationId,
        expiresAt: guards.expiresAt,
      });
      // 積み残し通知の期限切れはエージェントの選択の失敗ではないため中立
      return {
        status: 'stale',
        message: 'この通知は応答期限切れです。この通知への応答は不要です。最新の通知を待って行動してください。',
      };
    }
    if (parsed.command === 'move' && guards.currentNode != null) {
      const targetNode = parsed.params['target_node_id'];
      const targetBuilding = parsed.params['target_building_id'];
      const sameNode = guards.currentNode.nodeId != null && targetNode === guards.currentNode.nodeId;
      // 建物一致は target_node_id の指定が無いときだけ見る（建物内の別ノードへの
      // 移動は正当なため誤ブロックしない）
      const sameBuilding = targetNode == null
        && guards.currentNode.buildingId != null
        && targetBuilding === guards.currentNode.buildingId;
      if (sameNode || sameBuilding) {
        logger.info('Move to the current location prevented, returning informational response', {
          notificationId,
          targetNode,
          targetBuilding,
        });
        reportOutcome(true);
        return {
          status: 'same_node',
          message: `既に${guards.currentNode.label != null ? `「${guards.currentNode.label}」` : 'その場所'}にいます。移動は不要です。get_available_actions で実行可能なアクションを確認するか、現在地と異なる場所を選んでください。`,
        };
      }
    }

    const response = await requestJson({
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
    reportOutcome(false);
    return response;
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.error('Tool input validation failed', { operation: 'command', issues: error.issues });
      reportOutcome(true);
      throw error;
    }

    if (isCommandConflictError(error)) {
      logger.info('Command conflicted with current world state, returning informational response', {
        status: error.status,
        code: error.code,
        hint: error.hint,
      });
      // 進行中・応答待ち・通知置き換えは世界側の正当な状態。中立（ストリークを消しも増やしもしない）。
      // サーバーの hint（「受諾または拒否を選んでください」等）は次の行動選択の
      // 最重要情報なのでそのまま渡す
      return {
        status: 'busy',
        message: error.apiMessage,
        ...(error.hint != null ? { hint: error.hint } : {}),
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
    reportOutcome(true);
    throw error;
  }
}

export function createKarakuriWorldTools({
  apiBaseUrl,
  apiKey,
  notificationId,
  allowedCommands,
  fetch: fetchImpl = (...args) => globalThis.fetch(...args),
  expiresAt,
  currentNode,
  onCommandOutcome,
  now,
}: CreateKarakuriWorldToolsOptions): ToolSet {
  const context: RequestContext = { apiBaseUrl, apiKey, fetchImpl };
  const guards: ExecuteCommandGuards = { expiresAt, currentNode, onCommandOutcome, now };
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
      execute: async (input) => executeKarakuriWorldCommand(notificationId, input, context, allowedCommandSet, guards),
    }),
  };
}
