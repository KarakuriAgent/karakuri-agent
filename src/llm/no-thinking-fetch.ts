import { randomUUID } from 'node:crypto';

import type { ProviderOptions } from '@ai-sdk/provider-utils';

import type { OpenAiApiKind } from './model-selector.js';

const RESPONSES_NO_THINKING_PROVIDER_OPTIONS: ProviderOptions = {
  openai: { reasoningEffort: 'low' },
};

export interface NoThinkingFetchOptions {
  baseFetch?: typeof globalThis.fetch | undefined;
  disableThinkingRequestParam?: boolean | undefined;
}

export function noThinkingProviderOptions(api: OpenAiApiKind): ProviderOptions {
  return api === 'responses' ? RESPONSES_NO_THINKING_PROVIDER_OPTIONS : {};
}

export function createNoThinkingFetch({
  baseFetch = globalThis.fetch,
  disableThinkingRequestParam = false,
}: NoThinkingFetchOptions = {}): typeof globalThis.fetch {
  return async (input, init) => {
    let forcedToolName: string | null = null;
    if (init?.body != null && typeof init.body === 'string') {
      try {
        const json = JSON.parse(init.body) as Record<string, unknown>;
        forcedToolName = extractForcedToolName(json);
        if (disableThinkingRequestParam) {
          json.enable_thinking = false;
          // バックエンドにより効くパラメータが違う: dashscope はトップレベル
          // enable_thinking、vLLM 系（Featherless の GLM/Qwen 等）は
          // chat_template_kwargs.enable_thinking。両方に付ける（未知側は無視される）。
          // 効いていないと思考が出力トークン上限を食い尽くし、tool call の
          // arguments が途切れて応答検証ごと壊れる
          const templateKwargs = typeof json.chat_template_kwargs === 'object' && json.chat_template_kwargs != null
            ? json.chat_template_kwargs as Record<string, unknown>
            : {};
          json.chat_template_kwargs = { ...templateKwargs, enable_thinking: false };
          init = { ...init, body: JSON.stringify(json) };
        }
      } catch {
        // Not JSON — pass through unchanged
      }
    }

    const response = await baseFetch(input, init);
    // 強制 tool_choice のときだけ応答を正規化する（名前はリクエスト側から確定できる）
    if (forcedToolName != null) {
      return normalizeToolCallResponse(response, forcedToolName);
    }
    return response;
  };
}

function extractForcedToolName(requestBody: Record<string, unknown>): string | null {
  const toolChoice = requestBody.tool_choice;
  if (typeof toolChoice !== 'object' || toolChoice == null) {
    return null;
  }
  const fn = (toolChoice as { function?: { name?: unknown } }).function;
  return typeof fn?.name === 'string' ? fn.name : null;
}

/**
 * 互換バックエンド（Featherless の GLM 等）は強制 tool_choice の応答で
 * tool_calls[].function.name / id を null で返すことがあり、SDK の応答スキーマ
 * 検証（name: string 必須）ごと壊れる。強制 tool_choice ではツール名は
 * リクエスト側で確定しているため、欠落した name / id をここで補完する。
 * 非 JSON・SSE・形状不明の応答はそのまま返す。
 */
async function normalizeToolCallResponse(response: Response, forcedToolName: string): Promise<Response> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return response;
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    return response;
  }
  let normalizedText = text;
  try {
    const json = JSON.parse(text) as {
      choices?: Array<{ message?: { tool_calls?: Array<{ id?: unknown; type?: unknown; function?: { name?: unknown } }> } }>;
    };
    let changed = false;
    for (const choice of json.choices ?? []) {
      for (const call of choice.message?.tool_calls ?? []) {
        if (call.type !== 'function' || typeof call.function !== 'object' || call.function == null) {
          continue;
        }
        if (call.function.name == null) {
          call.function.name = forcedToolName;
          changed = true;
        }
        if (call.id == null) {
          call.id = `call_${randomUUID()}`;
          changed = true;
        }
      }
    }
    if (changed) {
      normalizedText = JSON.stringify(json);
    }
  } catch {
    // 応答が想定形状でなければそのまま返す
  }
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  return new Response(normalizedText, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
