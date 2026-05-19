import type { ProviderOptions } from '@ai-sdk/provider-utils';

import { createLogger } from '../utils/logger.js';
import type { OpenAiApiKind } from './model-selector.js';

const logger = createLogger('LlmFetch');

const RESPONSES_NO_THINKING_PROVIDER_OPTIONS: ProviderOptions = {
  openai: { reasoningEffort: 'low' },
};

export function noThinkingProviderOptions(api: OpenAiApiKind): ProviderOptions {
  return api === 'responses' ? RESPONSES_NO_THINKING_PROVIDER_OPTIONS : {};
}

export function createNoThinkingFetch(baseFetch: typeof globalThis.fetch = globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    let requestSummary: LlmRequestSummary | null = null;
    if (init?.body != null && typeof init.body === 'string') {
      try {
        const json = JSON.parse(init.body) as Record<string, unknown>;
        requestSummary = summarizeLlmRequest(input, json);
        json.enable_thinking = false;
        init = { ...init, body: JSON.stringify(json) };
      } catch {
        // Not JSON — pass through unchanged
      }
    }

    if (requestSummary != null) {
      logger.debug('LLM HTTP request', requestSummary);
    }

    const response = await baseFetch(input, init);

    if (requestSummary != null) {
      void logLlmResponse(response, requestSummary).catch((error) => {
        logger.warn('Failed to log LLM HTTP response summary', error);
      });
    }

    return response;
  };
}

type LlmRequestSummary = {
  urlPath: string;
  model?: string | undefined;
  messagesCount?: number | undefined;
  toolsCount?: number | undefined;
  toolChoice?: unknown;
  lastUserMessageLength?: number | undefined;
  enableThinkingBefore?: unknown;
};

function summarizeLlmRequest(input: RequestInfo | URL, body: Record<string, unknown>): LlmRequestSummary {
  return {
    urlPath: summarizeUrl(input),
    model: typeof body.model === 'string' ? body.model : undefined,
    messagesCount: Array.isArray(body.messages) ? body.messages.length : undefined,
    toolsCount: Array.isArray(body.tools) ? body.tools.length : undefined,
    toolChoice: body.tool_choice,
    lastUserMessageLength: getLastUserMessageLength(body.messages),
    enableThinkingBefore: body.enable_thinking,
  };
}

function summarizeUrl(input: RequestInfo | URL): string {
  const raw = input instanceof Request ? input.url : String(input);
  try {
    const url = new URL(raw);
    return url.pathname;
  } catch {
    return raw;
  }
}

function getLastUserMessageLength(messages: unknown): number | undefined {
  if (!Array.isArray(messages)) {
    return undefined;
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isRecord(message) || message.role !== 'user') {
      continue;
    }
    return getContentLength(message.content);
  }

  return undefined;
}

function getContentLength(content: unknown): number {
  if (typeof content === 'string') {
    return content.length;
  }
  return JSON.stringify(content)?.length ?? 0;
}

async function logLlmResponse(response: Response, request: LlmRequestSummary): Promise<void> {
  const text = await response.clone().text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    logger.debug('LLM HTTP response', {
      urlPath: request.urlPath,
      status: response.status,
      ok: response.ok,
      nonJsonLength: text.length,
    });
    return;
  }

  logger.debug('LLM HTTP response', {
    urlPath: request.urlPath,
    status: response.status,
    ok: response.ok,
    ...summarizeLlmResponseBody(body),
  });
}

function summarizeLlmResponseBody(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) {
    return { bodyType: typeof body };
  }

  const firstChoice = Array.isArray(body.choices) ? body.choices[0] : undefined;
  const message = isRecord(firstChoice) && isRecord(firstChoice.message) ? firstChoice.message : undefined;
  const toolCalls = message != null && Array.isArray(message.tool_calls) ? message.tool_calls : undefined;
  const content = message?.content;

  return {
    id: typeof body.id === 'string' ? body.id : undefined,
    choicesCount: Array.isArray(body.choices) ? body.choices.length : undefined,
    finishReason: isRecord(firstChoice) ? firstChoice.finish_reason : undefined,
    messageRole: message?.role,
    contentLength: typeof content === 'string' ? content.length : content == null ? 0 : JSON.stringify(content).length,
    toolCallsCount: toolCalls?.length ?? 0,
    toolCallNames: toolCalls?.map((toolCall) => {
      if (!isRecord(toolCall) || !isRecord(toolCall.function)) {
        return undefined;
      }
      return toolCall.function.name;
    }).filter((name): name is string => typeof name === 'string'),
    usage: isRecord(body.usage) ? body.usage : undefined,
    errorType: isRecord(body.error) ? body.error.type : undefined,
    errorCode: isRecord(body.error) ? body.error.code : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null;
}
