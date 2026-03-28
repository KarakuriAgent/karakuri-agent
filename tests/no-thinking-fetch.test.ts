import { describe, expect, it, vi } from 'vitest';

import { createNoThinkingFetch, NO_THINKING_PROVIDER_OPTIONS } from '../src/llm/no-thinking-fetch.js';

describe('createNoThinkingFetch', () => {
  it('injects enable_thinking: false into JSON request bodies', async () => {
    const baseFetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('ok'));
    const fetch = createNoThinkingFetch(baseFetch);

    await fetch('https://api.example.com/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'qwen3.5-plus', messages: [] }),
    });

    expect(baseFetch).toHaveBeenCalledTimes(1);
    const init = baseFetch.mock.calls[0]![1]!;
    const body = JSON.parse(init.body as string);
    expect(body.enable_thinking).toBe(false);
    expect(body.model).toBe('qwen3.5-plus');
    expect(body.messages).toEqual([]);
  });

  it('preserves existing fields in the JSON body', async () => {
    const baseFetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('ok'));
    const fetch = createNoThinkingFetch(baseFetch);

    await fetch('https://api.example.com/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'test', temperature: 0.7, stream: true }),
    });

    const init = baseFetch.mock.calls[0]![1]!;
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('test');
    expect(body.temperature).toBe(0.7);
    expect(body.stream).toBe(true);
    expect(body.enable_thinking).toBe(false);
  });

  it('passes non-JSON bodies through unchanged', async () => {
    const baseFetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('ok'));
    const fetch = createNoThinkingFetch(baseFetch);

    const rawBody = 'not-json-content';
    await fetch('https://api.example.com/v1/chat/completions', {
      method: 'POST',
      body: rawBody,
    });

    const init = baseFetch.mock.calls[0]![1]!;
    expect(init.body).toBe(rawBody);
  });

  it('passes requests without body through unchanged', async () => {
    const baseFetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response('ok'));
    const fetch = createNoThinkingFetch(baseFetch);

    await fetch('https://api.example.com/v1/models');

    expect(baseFetch).toHaveBeenCalledWith('https://api.example.com/v1/models', undefined);
  });
});

describe('NO_THINKING_PROVIDER_OPTIONS', () => {
  it('contains reasoningEffort none for openai', () => {
    expect(NO_THINKING_PROVIDER_OPTIONS).toEqual({
      openai: { reasoningEffort: 'none' },
    });
  });
});
