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
    if (!disableThinkingRequestParam) {
      return baseFetch(input, init);
    }

    if (init?.body != null && typeof init.body === 'string') {
      try {
        const json = JSON.parse(init.body) as Record<string, unknown>;
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
      } catch {
        // Not JSON — pass through unchanged
      }
    }

    return baseFetch(input, init);
  };
}
