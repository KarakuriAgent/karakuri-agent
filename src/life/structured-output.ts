/**
 * LLM 構造化出力の共有基盤（appraisal / reflection 共通）。
 *
 * 出力取得モード:
 * - json_schema: Output.object（response_format json_schema）。スキーマ強制が
 *   実際に効くバックエンド（OpenAI 本家・vLLM 系）向けで、構造保証つき
 * - tool: 強制 tool call。json_schema を黙って無視するバックエンド
 *   （Featherless 等）向け。強制力はモデルの tool call 訓練に由来する
 *
 * 方針: どの経路でも値の捏造・補完はしない。不完全な配列要素は捨てて
 * drops（→ report 通知）に記録し、中核が壊れていれば失敗として throw する
 * （中途半端な出力を記憶へ入れるより「何も登録しない + 通知」が安全）。
 */

import {
  APICallError,
  NoObjectGeneratedError,
  Output,
  generateText,
  jsonSchema,
  tool,
  zodSchema,
  type LanguageModel,
} from 'ai';
import type { ProviderOptions } from '@ai-sdk/provider-utils';
import { z } from 'zod';

import { createLogger } from '../utils/logger.js';

const logger = createLogger('StructuredOutput');

export type StructuredOutputMode = 'json_schema' | 'tool';

/**
 * レスポンス本文の途中切断（ECONNRESET → "Failed to process successful response"）や
 * 接続失敗など、再試行で解消しうるネットワーク障害かを判定する。
 * abort（タイムアウト）とスキーマ不一致は対象外。
 */
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
]);
const TRANSIENT_NETWORK_MESSAGES = ['terminated', 'fetch failed', 'socket hang up', 'other side closed'];

export function isTransientNetworkError(error: unknown): boolean {
  if (!APICallError.isInstance(error)) {
    return false;
  }
  if (error.isRetryable) {
    return true;
  }
  let cause: unknown = error.cause;
  for (let depth = 0; cause != null && depth < 5; depth += 1) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === 'string' && TRANSIENT_NETWORK_CODES.has(code)) {
      return true;
    }
    if (cause instanceof Error) {
      const message = cause.message.toLowerCase();
      if (TRANSIENT_NETWORK_MESSAGES.some((pattern) => message.includes(pattern))) {
        return true;
      }
    }
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
}

export const DEFAULT_TRANSIENT_RETRY_DELAYS_MS: readonly number[] = [500, 2_000];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** LLM 呼び出しの共通オプション（呼び出し元のサービス設定から渡す） */
export interface StructuredLlmOptions {
  model: LanguageModel;
  generateTextFn?: typeof generateText | undefined;
  providerOptions?: ProviderOptions | undefined;
  abortSignal?: AbortSignal | undefined;
  /** LLM 1 コール（1 attempt）あたりのタイムアウト（ms）。attempt ごとに新しい signal を張る */
  timeoutMs?: number | undefined;
  /** 一時的なネットワーク障害（ECONNRESET 等）の再試行間隔（ms）。要素数 = 追加試行回数 */
  transientRetryDelaysMs?: readonly number[] | undefined;
}

/** attempt ごとに新しいタイムアウト signal を張る（リトライも各回フルの時間を使える） */
function buildAttemptAbortSignal(options: StructuredLlmOptions): AbortSignal | undefined {
  const timeoutSignal = options.timeoutMs != null ? AbortSignal.timeout(options.timeoutMs) : undefined;
  if (options.abortSignal != null && timeoutSignal != null) {
    return AbortSignal.any([options.abortSignal, timeoutSignal]);
  }
  return timeoutSignal ?? options.abortSignal;
}

/**
 * generateText を「一時的なネットワーク障害のみ」短バックオフで再試行しつつ呼ぶ。
 * スキーマ不一致の再試行は別レイヤ（検証フィードバックつきの再コール）で行い、
 * ここでは扱わない — 失敗の意味が違うため
 */
export async function callGenerateTextWithRetries(
  options: StructuredLlmOptions,
  request: Record<string, unknown>,
): Promise<Awaited<ReturnType<typeof generateText>>> {
  const generateTextFn = options.generateTextFn ?? generateText;
  const delays = options.transientRetryDelaysMs ?? DEFAULT_TRANSIENT_RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const abortSignal = buildAttemptAbortSignal(options);
      return await generateTextFn({
        model: options.model,
        ...request,
        ...(options.providerOptions != null ? { providerOptions: options.providerOptions } : {}),
        ...(abortSignal != null ? { abortSignal } : {}),
      } as Parameters<typeof generateText>[0]);
    } catch (error) {
      if (attempt >= delays.length || !isTransientNetworkError(error)) {
        throw error;
      }
      logger.warn('LLM call hit a transient network error; retrying', {
        attempt: attempt + 1,
        message: error instanceof Error ? error.message : String(error),
      });
      await delay(delays[attempt] ?? 0);
    }
  }
}

/**
 * SDK 層の tool input 検証を素通しにするスキーマラッパー。provider へは zod 由来の
 * JSON Schema を渡してモデルを誘導しつつ、検証と不完全要素の drop はこちらで握る
 * （スキーマ強制の無いバックエンドで SDK が例外を投げると要素単位の回収ができないため）
 */
export function passthroughToolSchema(schema: z.ZodTypeAny) {
  return jsonSchema<Record<string, unknown>>(zodSchema(schema).jsonSchema, {
    validate: (value) => ({ success: true, value: value as Record<string, unknown> }),
  });
}

/** 強制 tool call を 1 回実行し、モデルが渡した生の input を返す。tool 未呼び出しは null */
export async function runForcedToolCall(
  options: StructuredLlmOptions,
  request: { toolName: string; description: string; schema: z.ZodTypeAny; system: string; prompt: string },
): Promise<unknown | null> {
  const result = await callGenerateTextWithRetries(options, {
    system: request.system,
    prompt: request.prompt,
    tools: {
      [request.toolName]: tool({
        description: request.description,
        inputSchema: passthroughToolSchema(request.schema),
      }),
    },
    toolChoice: { type: 'tool', toolName: request.toolName },
  });
  const calls = (result as { toolCalls?: Array<{ toolName: string; input?: unknown }> }).toolCalls ?? [];
  const call = calls.find((entry) => entry.toolName === request.toolName);
  return call != null ? call.input ?? null : null;
}

export function formatZodIssues(error: z.ZodError): string {
  return truncateText(
    error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '),
    1_000,
  );
}

function truncateText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

function safeStringifyValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function isZodArraySchema(schema: z.ZodTypeAny): schema is z.ZodArray<z.ZodTypeAny> {
  let current: z.ZodTypeAny = schema;
  for (let depth = 0; depth < 5; depth += 1) {
    if (current instanceof z.ZodArray) {
      return true;
    }
    if (current instanceof z.ZodOptional || current instanceof z.ZodDefault || current instanceof z.ZodNullable) {
      current = current._def.innerType as z.ZodTypeAny;
      continue;
    }
    return false;
  }
  return false;
}

function unwrapZodArray(schema: z.ZodTypeAny): z.ZodArray<z.ZodTypeAny> | null {
  let current: z.ZodTypeAny = schema;
  for (let depth = 0; depth < 5; depth += 1) {
    if (current instanceof z.ZodArray) {
      return current;
    }
    if (current instanceof z.ZodOptional || current instanceof z.ZodDefault || current instanceof z.ZodNullable) {
      current = current._def.innerType as z.ZodTypeAny;
      continue;
    }
    return null;
  }
  return null;
}

/**
 * トップレベル直下の配列フィールドから不完全な要素を捨てる。値の捏造・補完は
 * 一切しない — 中途半端な観測を既定値で埋めて登録すると記憶が汚れるため、
 * 「捨てて drops に記録（呼び出し元が report 通知）」に倒す。
 * 配列であるべき場所に配列以外が来た場合も同様に丸ごと捨てる。
 */
export function dropInvalidArrayElements(
  shape: z.ZodRawShape,
  value: Record<string, unknown>,
  drops: string[],
): Record<string, unknown> {
  const result = { ...value };
  for (const [key, fieldSchema] of Object.entries(shape)) {
    if (!isZodArraySchema(fieldSchema)) {
      continue;
    }
    const raw = result[key];
    if (raw == null) {
      continue;
    }
    if (!Array.isArray(raw)) {
      drops.push(`${key} dropped entirely (not an array): ${truncateText(safeStringifyValue(raw), 200)}`);
      result[key] = [];
      continue;
    }
    const elementSchema = unwrapZodArray(fieldSchema)?.element;
    if (elementSchema == null) {
      continue;
    }
    const kept: unknown[] = [];
    raw.forEach((element, index) => {
      if (elementSchema.safeParse(element).success) {
        kept.push(element);
      } else {
        drops.push(`${key}[${index}] dropped (invalid shape): ${truncateText(safeStringifyValue(element), 200)}`);
      }
    });
    result[key] = kept;
  }
  return result;
}

export interface GenerateStructuredObjectOptions<Shape extends z.ZodRawShape> extends StructuredLlmOptions {
  outputMode?: StructuredOutputMode | undefined;
  schema: z.ZodObject<Shape>;
  /** json_schema モードの output 名 / tool モードの tool 名を兼ねる */
  name: string;
  description: string;
  system: string;
  prompt: string;
  /** スキーマ不一致時の総試行回数（検証フィードバックつき再コール） */
  maxSchemaAttempts?: number | undefined;
  /** 不完全要素の破棄が起きたときの通知フック（report 経路へ接続される） */
  onDrop?: ((message: string) => void) | undefined;
  /** ログ用ラベル（例: 'reflection.daily'） */
  logLabel?: string | undefined;
}

/**
 * 単一 object スキーマの構造化出力を取得する汎用経路（reflection 等の単発コール向け）。
 * - json_schema: Output.object。失敗時は生テキストからのサルベージ
 *   （配列フィールドの欠落 = 空、非配列の必須フィールドは補完しない）→ 要素 drop → 再試行
 * - tool: 強制 tool call → zod 検証 → 再試行 → 最終試行のみ要素 drop で回収
 * どちらも回収不能なら throw（呼び出し元がスキップ + 通知を担う）
 */
export async function generateStructuredObject<Shape extends z.ZodRawShape>(
  options: GenerateStructuredObjectOptions<Shape>,
): Promise<z.infer<z.ZodObject<Shape>>> {
  const mode = options.outputMode ?? 'json_schema';
  const attempts = Math.max(1, options.maxSchemaAttempts ?? 2);
  const label = options.logLabel ?? options.name;
  return mode === 'tool'
    ? generateViaForcedTool(options, attempts, label)
    : generateViaJsonSchema(options, attempts, label);
}

/** 配列フィールドの欠落を空配列で埋める（= 何も登録しない）。非配列は補完しない */
function fillMissingArraysWithEmpty<Shape extends z.ZodRawShape>(
  schema: z.ZodObject<Shape>,
  value: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...value };
  for (const [key, fieldSchema] of Object.entries(schema.shape)) {
    if (result[key] == null && isZodArraySchema(fieldSchema as z.ZodTypeAny)) {
      result[key] = [];
    }
  }
  return result;
}

function validateWithElementDrop<Shape extends z.ZodRawShape>(
  schema: z.ZodObject<Shape>,
  raw: Record<string, unknown>,
  drops: string[],
): z.infer<z.ZodObject<Shape>> | null {
  const withArrays = fillMissingArraysWithEmpty(schema, raw);
  const direct = schema.safeParse(withArrays);
  if (direct.success) {
    return direct.data;
  }
  const collected: string[] = [];
  const pruned = dropInvalidArrayElements(schema.shape, withArrays, collected);
  const retried = schema.safeParse(pruned);
  if (!retried.success) {
    return null;
  }
  drops.push(...collected);
  return retried.data;
}

async function generateViaJsonSchema<Shape extends z.ZodRawShape>(
  options: GenerateStructuredObjectOptions<Shape>,
  attempts: number,
  label: string,
): Promise<z.infer<z.ZodObject<Shape>>> {
  let feedback: string | null = null;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const result = await callGenerateTextWithRetries(options, {
        system: options.system,
        prompt: feedback == null ? options.prompt : `${options.prompt}\n\n${feedback}`,
        output: Output.object({
          schema: options.schema,
          name: options.name,
          description: options.description,
        }),
      });
      const output = (result as { output?: unknown }).output as z.infer<z.ZodObject<Shape>> | undefined;
      if (output != null) {
        return output;
      }
      throw new Error(`${label} returned no structured output`);
    } catch (error) {
      if (!NoObjectGeneratedError.isInstance(error)) {
        throw error;
      }
      // 生テキストからのサルベージ（JSON 抽出 + 要素 drop。値の捏造はしない）
      const text = error.text;
      const start = text?.indexOf('{') ?? -1;
      const end = text?.lastIndexOf('}') ?? -1;
      if (text != null && start >= 0 && end > start) {
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(text.slice(start, end + 1));
        } catch {
          parsed = null;
        }
        if (typeof parsed === 'object' && parsed != null && !Array.isArray(parsed)) {
          const drops: string[] = [];
          const salvaged = validateWithElementDrop(options.schema, parsed as Record<string, unknown>, drops);
          if (salvaged != null) {
            logger.warn('Structured output failed schema validation; salvaged from raw text', {
              label,
              droppedElements: drops.length,
            });
            for (const drop of drops) {
              options.onDrop?.(drop);
            }
            return salvaged;
          }
        }
      }
      if (attempt >= attempts) {
        throw error;
      }
      const causeMessage = error.cause instanceof Error ? error.cause.message : String(error.cause ?? '');
      feedback = `Your previous attempt failed schema validation:\n${truncateText(causeMessage, 1_000)}\nRespond again with a single JSON object using EXACTLY the keys and enum values of the requested schema.`;
      logger.warn('Structured output did not match schema; retrying with validation feedback', {
        label,
        attempt,
        rawText: truncateText(text ?? '(no text)', 500),
      });
    }
  }
}

async function generateViaForcedTool<Shape extends z.ZodRawShape>(
  options: GenerateStructuredObjectOptions<Shape>,
  attempts: number,
  label: string,
): Promise<z.infer<z.ZodObject<Shape>>> {
  const system = `${options.system}\nSubmit the result by calling the tool \`${options.name}\` exactly once, using EXACTLY the field names and enum values from the tool schema.`;
  let feedback: string | null = null;
  for (let attempt = 1; ; attempt += 1) {
    const raw = await runForcedToolCall(options, {
      toolName: options.name,
      description: options.description,
      schema: options.schema,
      system,
      prompt: feedback == null ? options.prompt : `${options.prompt}\n\n${feedback}`,
    });
    const isObject = typeof raw === 'object' && raw != null && !Array.isArray(raw);
    if (isObject) {
      const withArrays = fillMissingArraysWithEmpty(options.schema, raw as Record<string, unknown>);
      const direct = options.schema.safeParse(withArrays);
      if (direct.success) {
        return direct.data;
      }
      // 最終試行のみ不完全要素の drop で回収する（途中の試行は完全な再出力を促す）
      if (attempt >= attempts) {
        const drops: string[] = [];
        const salvaged = validateWithElementDrop(options.schema, raw as Record<string, unknown>, drops);
        if (salvaged != null) {
          for (const drop of drops) {
            options.onDrop?.(drop);
          }
          return salvaged;
        }
        throw new Error(`${label} output failed schema validation: ${formatZodIssues(direct.error)}`);
      }
      feedback = `Your previous attempt failed schema validation:\n${formatZodIssues(direct.error)}\nCall ${options.name} again using EXACTLY the field names and enum values from the tool schema.`;
    } else {
      if (attempt >= attempts) {
        throw new Error(`${label} output failed: the tool ${options.name} was not called with an object`);
      }
      feedback = `Your previous attempt did not call ${options.name} correctly.\nCall it exactly once with the requested fields.`;
    }
    logger.warn('Structured tool output did not match schema; retrying with validation feedback', {
      label,
      attempt,
    });
  }
}
