import type { ZodType } from 'zod';
import { describe, expect, it, vi } from 'vitest';

import { createWebSearchTool } from '../src/agent/tools/web-search.js';

type WebSearchResult =
  | { results: Array<{ title: string; url: string; snippet: string }> }
  | { error: string };

const toolContext = {
  toolCallId: 'c1',
  messages: [],
  abortSignal: undefined as never,
};

describe('webSearch tool', () => {
  it('returns normalized Brave search results', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({
      web: {
        results: [
          {
            title: 'Karakuri Agent',
            url: 'https://example.com/karakuri-agent',
            description: 'Project homepage',
          },
          {
            title: '',
            url: 'https://example.com/ignored',
            description: 'ignored result',
          },
        ],
      },
    }), {
      headers: {
        'content-type': 'application/json',
      },
    }));
    const tool = createWebSearchTool({
      braveApiKey: 'brave-key',
      fetchFn: fetchFn as unknown as typeof globalThis.fetch,
    });

    await expect(tool.execute!(
      { query: 'karakuri agent' },
      toolContext,
    )).resolves.toEqual({
      results: [
        {
          title: 'Karakuri Agent',
          url: 'https://example.com/karakuri-agent',
          snippet: 'Project homepage',
        },
      ],
    });

    expect(fetchFn).toHaveBeenCalledOnce();
    const calls = fetchFn.mock.calls as unknown as Array<[string, RequestInit | undefined]>;
    const call = calls[0];
    expect(call).toBeDefined();
    if (call == null) {
      return;
    }

    const [requestUrl, init] = call;
    expect(requestUrl).toBe('https://api.search.brave.com/res/v1/web/search?q=karakuri+agent&count=5');
    expect(init).toMatchObject({
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': 'brave-key',
      },
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns an error when the fetch fails', async () => {
    const tool = createWebSearchTool({
      braveApiKey: 'brave-key',
      fetchFn: vi.fn(async () => {
        throw new Error('network down');
      }) as unknown as typeof globalThis.fetch,
    });

    const result = await tool.execute!(
      { query: 'karakuri' },
      toolContext,
    ) as WebSearchResult;

    expect(result).toHaveProperty('error');
    if ('error' in result) {
      expect(result.error).toContain('network down');
    }
  });

  it('returns an error for non-ok responses', async () => {
    const tool = createWebSearchTool({
      braveApiKey: 'brave-key',
      fetchFn: vi.fn(async () => new Response('unavailable', {
        status: 503,
        statusText: 'Service Unavailable',
      })) as unknown as typeof globalThis.fetch,
    });

    await expect(tool.execute!(
      { query: 'karakuri' },
      toolContext,
    )).resolves.toEqual({
      error: 'Brave Search request failed with status 503.',
    });
  });

  it('returns an empty results array when Brave has no matches', async () => {
    const tool = createWebSearchTool({
      braveApiKey: 'brave-key',
      fetchFn: vi.fn(async () => new Response(JSON.stringify({ web: { results: [] } }), {
        headers: {
          'content-type': 'application/json',
        },
      })) as unknown as typeof globalThis.fetch,
    });

    await expect(tool.execute!(
      { query: 'karakuri' },
      toolContext,
    )).resolves.toEqual({
      results: [],
    });
  });

  it('returns an error when Brave returns an unexpected response shape', async () => {
    const tool = createWebSearchTool({
      braveApiKey: 'brave-key',
      fetchFn: vi.fn(async () => new Response(JSON.stringify({ error: 'rate limited' }), {
        headers: {
          'content-type': 'application/json',
        },
      })) as unknown as typeof globalThis.fetch,
    });

    await expect(tool.execute!(
      { query: 'karakuri' },
      toolContext,
    )).resolves.toEqual({
      error: 'Brave Search returned an unexpected response.',
    });
  });

  it('validates query and count bounds', () => {
    const tool = createWebSearchTool({ braveApiKey: 'brave-key' });
    const schema = tool.inputSchema as ZodType;

    expect(schema.safeParse({ query: '', count: 1 }).success).toBe(false);
    expect(schema.safeParse({ query: 'ok', count: 0 }).success).toBe(false);
    expect(schema.safeParse({ query: 'ok', count: 11 }).success).toBe(false);
    expect(schema.safeParse({ query: 'ok', count: 5 }).success).toBe(true);
  });
});
