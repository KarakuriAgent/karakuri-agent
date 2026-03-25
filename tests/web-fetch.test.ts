import type { ZodType } from 'zod';
import { describe, expect, it, vi } from 'vitest';

import { createWebFetchTool } from '../src/agent/tools/web-fetch.js';

type WebFetchResult =
  | { success: true; url: string; title: string | null; content: string; truncated: boolean }
  | { success: false; url: string; error: string };

function createPublicLookup() {
  return vi.fn(async () => [
    { address: '93.184.216.34', family: 4 },
  ]);
}

const toolContext = {
  toolCallId: 'c1',
  messages: [],
  abortSignal: undefined as never,
};

describe('webFetch tool', () => {
  it('fetches HTML and converts readable content to markdown', async () => {
    const fetchFn = vi.fn(async () => new Response(`
      <html>
        <head><title>Example Page</title></head>
        <body>
          <article>
            <h1>Fetched headline</h1>
            <p>Hello <strong>world</strong>.</p>
          </article>
        </body>
      </html>
    `, {
      headers: {
        'content-type': 'text/html; charset=UTF-8',
      },
    }));
    const tool = createWebFetchTool({
      fetchFn: fetchFn as unknown as typeof globalThis.fetch,
      lookupFn: createPublicLookup(),
    });

    const result = await tool.execute!(
      { url: 'https://example.com/post' },
      toolContext,
    ) as WebFetchResult;

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.url).toBe('https://example.com/post');
    expect(result.title).toBe('Example Page');
    expect(result.content).toContain('## Fetched headline');
    expect(result.content).toContain('Hello **world**.');
    expect(result.truncated).toBe(false);

    expect(fetchFn).toHaveBeenCalledOnce();
    const calls = fetchFn.mock.calls as unknown as Array<[string, RequestInit | undefined]>;
    const call = calls[0];
    expect(call).toBeDefined();
    if (call == null) {
      return;
    }

    const [requestUrl, init] = call;
    expect(requestUrl).toBe('https://example.com/post');
    expect(init).toMatchObject({
      headers: {
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.dispatcher).toBeDefined();
  });

  it('validates that only http and https URLs are accepted', () => {
    const tool = createWebFetchTool();
    const schema = tool.inputSchema as ZodType;

    expect(schema.safeParse({ url: 'ftp://example.com/file.txt' }).success).toBe(false);
    expect(schema.safeParse({ url: 'file:///tmp/example.html' }).success).toBe(false);
    expect(schema.safeParse({ url: 'https://example.com' }).success).toBe(true);
  });

  it('returns an error when the fetch fails', async () => {
    const tool = createWebFetchTool({
      fetchFn: vi.fn(async () => {
        throw new Error('network down');
      }) as unknown as typeof globalThis.fetch,
      lookupFn: createPublicLookup(),
    });

    const result = await tool.execute!(
      { url: 'https://example.com/post' },
      toolContext,
    ) as WebFetchResult;

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }

    expect(result.error).toContain('network down');
  });

  it('rejects non-html responses', async () => {
    const tool = createWebFetchTool({
      fetchFn: vi.fn(async () => new Response('{"ok":true}', {
        headers: {
          'content-type': 'application/json',
        },
      })) as unknown as typeof globalThis.fetch,
      lookupFn: createPublicLookup(),
    });

    await expect(tool.execute!(
      { url: 'https://example.com/post' },
      toolContext,
    )).resolves.toEqual({
      success: false,
      url: 'https://example.com/post',
      error: 'Unsupported content type: application/json',
    });
  });

  it('rejects oversized responses', async () => {
    const oversizedHtml = `<html><body><article><p>${'x'.repeat(2_000_100)}</p></article></body></html>`;
    const tool = createWebFetchTool({
      fetchFn: vi.fn(async () => new Response(oversizedHtml, {
        headers: {
          'content-type': 'text/html',
        },
      })) as unknown as typeof globalThis.fetch,
      lookupFn: createPublicLookup(),
    });

    const result = await tool.execute!(
      { url: 'https://example.com/post' },
      toolContext,
    ) as WebFetchResult;

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }

    expect(result.error).toContain('Response body exceeds 2000000 bytes.');
  });

  it('falls back when Readability cannot extract content', async () => {
    const tool = createWebFetchTool({
      fetchFn: vi.fn(async () => new Response(`
        <html>
          <head><title>Empty</title></head>
          <body><div></div></body>
        </html>
      `, {
        headers: {
          'content-type': 'text/html',
        },
      })) as unknown as typeof globalThis.fetch,
      lookupFn: createPublicLookup(),
    });

    await expect(tool.execute!(
      { url: 'https://example.com/post' },
      toolContext,
    )).resolves.toEqual({
      success: true,
      url: 'https://example.com/post',
      title: null,
      content: '(Could not extract readable content)',
      truncated: false,
    });
  });

  it('truncates extracted markdown beyond 20000 characters', async () => {
    const longText = 'x'.repeat(20_500);
    const tool = createWebFetchTool({
      fetchFn: vi.fn(async () => new Response(`
        <html>
          <head><title>Long Page</title></head>
          <body>
            <article><p>${longText}</p></article>
          </body>
        </html>
      `, {
        headers: {
          'content-type': 'text/html',
        },
      })) as unknown as typeof globalThis.fetch,
      lookupFn: createPublicLookup(),
    });

    const result = await tool.execute!(
      { url: 'https://example.com/post' },
      toolContext,
    ) as WebFetchResult;

    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }

    expect(result.title).toBe('Long Page');
    expect(result.truncated).toBe(true);
    expect(result.content).toHaveLength(20_000);
  });

  it('rejects private network targets before issuing a fetch', async () => {
    const fetchFn = vi.fn();
    const tool = createWebFetchTool({
      fetchFn: fetchFn as unknown as typeof globalThis.fetch,
    });

    const result = await tool.execute!(
      { url: 'http://127.0.0.1/internal' },
      toolContext,
    ) as WebFetchResult;

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }

    expect(result.error).toContain('Blocked URL target');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects hostnames that resolve to private addresses', async () => {
    const fetchFn = vi.fn();
    const lookupFn = vi.fn(async () => [
      { address: '10.0.0.15', family: 4 },
    ]);
    const tool = createWebFetchTool({
      fetchFn: fetchFn as unknown as typeof globalThis.fetch,
      lookupFn,
    });

    const result = await tool.execute!(
      { url: 'https://internal.example/post' },
      toolContext,
    ) as WebFetchResult;

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }

    expect(result.error).toContain('Blocked URL target');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects IPv4-mapped IPv6 loopback addresses', async () => {
    const fetchFn = vi.fn();
    const tool = createWebFetchTool({
      fetchFn: fetchFn as unknown as typeof globalThis.fetch,
    });

    const result = await tool.execute!(
      { url: 'http://[::ffff:127.0.0.1]/internal' },
      toolContext,
    ) as WebFetchResult;

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }

    expect(result.error).toContain('Blocked URL target');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects DNS results that return IPv4-mapped IPv6 private addresses', async () => {
    const fetchFn = vi.fn();
    const lookupFn = vi.fn(async () => [
      { address: '::ffff:10.0.0.1', family: 6 },
    ]);
    const tool = createWebFetchTool({
      fetchFn: fetchFn as unknown as typeof globalThis.fetch,
      lookupFn,
    });

    const result = await tool.execute!(
      { url: 'https://sneaky.example/post' },
      toolContext,
    ) as WebFetchResult;

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }

    expect(result.error).toContain('Blocked URL target');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('rejects redirects that point to blocked addresses', async () => {
    const fetchFn = vi.fn(async () => new Response(null, {
      status: 302,
      headers: {
        location: 'http://127.0.0.1/internal',
      },
    }));
    const tool = createWebFetchTool({
      fetchFn: fetchFn as unknown as typeof globalThis.fetch,
      lookupFn: createPublicLookup(),
    });

    const result = await tool.execute!(
      { url: 'https://example.com/post' },
      toolContext,
    ) as WebFetchResult;

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }

    expect(result.error).toContain('Blocked URL target');
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('rejects redirects that switch to disallowed schemes', async () => {
    const fetchFn = vi.fn(async () => new Response(null, {
      status: 302,
      headers: {
        location: 'ftp://example.com/archive.zip',
      },
    }));
    const tool = createWebFetchTool({
      fetchFn: fetchFn as unknown as typeof globalThis.fetch,
      lookupFn: createPublicLookup(),
    });

    const result = await tool.execute!(
      { url: 'https://example.com/post' },
      toolContext,
    ) as WebFetchResult;

    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }

    expect(result.error).toContain('http or https');
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});
