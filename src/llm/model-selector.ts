import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';

export const DEFAULT_LLM_MODEL = 'openai/gpt-4o';

export type OpenAiApiKind = 'responses' | 'chat';

export interface OpenAiModelSelector {
  readonly provider: 'openai';
  readonly api: OpenAiApiKind;
  readonly modelId: string;
  readonly selector: string;
}

export type LlmModelSelector = OpenAiModelSelector;

export interface OpenAiModelProvider {
  responses(modelId: string): LanguageModel;
  chat(modelId: string): LanguageModel;
}

export interface OpenAiProviderOptions {
  apiKey: string;
  baseURL?: string | undefined;
}

export function parseModelSelector(value: string): LlmModelSelector {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error('LLM_MODEL must not be empty');
  }

  if (normalized === 'openai' || normalized === 'openai/chat') {
    throw new Error('LLM_MODEL must include a model name after the OpenAI selector prefix');
  }

  if (normalized.startsWith('openai/chat/')) {
    return createOpenAiSelector('chat', normalized.slice('openai/chat/'.length));
  }

  if (normalized.startsWith('openai/')) {
    return createOpenAiSelector('responses', normalized.slice('openai/'.length));
  }

  if (!normalized.includes('/')) {
    return createOpenAiSelector('responses', normalized);
  }

  throw new Error(
    'LLM_MODEL must use an OpenAI selector like "openai/<model>" or "openai/chat/<model>"',
  );
}

export function formatModelSelector(selector: LlmModelSelector): string {
  return selector.api === 'chat'
    ? `${selector.provider}/chat/${selector.modelId}`
    : `${selector.provider}/${selector.modelId}`;
}

export function createOpenAiModelFactory(provider: OpenAiModelProvider) {
  return (selector: LlmModelSelector): LanguageModel => {
    switch (selector.api) {
      case 'chat':
        return provider.chat(selector.modelId);
      case 'responses':
        return provider.responses(selector.modelId);
      default:
        return assertNever(selector.api);
    }
  };
}

export function createConfiguredOpenAiModelFactory(options: OpenAiProviderOptions) {
  return createOpenAiModelFactory(createOpenAI({
    apiKey: options.apiKey,
    ...(options.baseURL != null ? { baseURL: options.baseURL } : {}),
  }));
}

function createOpenAiSelector(api: OpenAiApiKind, modelId: string): OpenAiModelSelector {
  const normalizedModelId = modelId.trim();
  if (normalizedModelId.length === 0) {
    throw new Error('LLM_MODEL must include a model name after the OpenAI selector prefix');
  }
  if (normalizedModelId.split('/').some((segment) => segment.length === 0)) {
    throw new Error('LLM_MODEL must not contain empty path segments');
  }

  const selector: OpenAiModelSelector = {
    provider: 'openai',
    api,
    modelId: normalizedModelId,
    selector: '',
  };

  return {
    ...selector,
    selector: formatModelSelector(selector),
  };
}

function assertNever(value: never): never {
  throw new Error(`Unsupported OpenAI API: ${String(value)}`);
}
