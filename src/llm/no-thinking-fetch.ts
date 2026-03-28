import type { ProviderOptions } from '@ai-sdk/provider-utils';

import type { OpenAiApiKind } from './model-selector.js';

const RESPONSES_NO_THINKING_PROVIDER_OPTIONS: ProviderOptions = {
  openai: { reasoningEffort: 'low' },
};

export function noThinkingProviderOptions(api: OpenAiApiKind): ProviderOptions {
  return api === 'responses' ? RESPONSES_NO_THINKING_PROVIDER_OPTIONS : {};
}

export function createNoThinkingFetch(baseFetch: typeof globalThis.fetch = globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    if (init?.body != null && typeof init.body === 'string') {
      try {
        const json = JSON.parse(init.body) as Record<string, unknown>;
        json.enable_thinking = false;
        init = { ...init, body: JSON.stringify(json) };
      } catch {
        // Not JSON — pass through unchanged
      }
    }

    return baseFetch(input, init);
  };
}
