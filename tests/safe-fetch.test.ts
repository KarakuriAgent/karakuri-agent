import { describe, expect, it, vi } from 'vitest';

import {
  BLOCKED_TARGET_ERROR,
  DISALLOWED_PROTOCOL_ERROR,
  fetchWithValidatedRedirects,
  ResponseTooLargeError,
  validateFetchTarget,
  type LookupAddress,
  type LookupFn,
} from '../src/utils/safe-fetch.js';

function createPublicLookup(): LookupFn {
  return vi.fn(async () => [
    { address: '93.184.216.34', family: 4 },
  ]);
}

function createBlockedLookup(): LookupFn {
  return vi.fn(async () => [
    { address: '127.0.0.1', family: 4 },
  ]);
}

function ok200(body = 'ok'): Response {
  return new Response(body, { status: 200 });
}

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

describe('fetchWithValidatedRedirects', () => {
  it('aborts DNS lookup when the caller signal times out', async () => {
    const controller = new AbortController();
    const timeoutError = Object.assign(new Error('DNS lookup timed out'), { name: 'TimeoutError' });
    const fetchFn = vi.fn<typeof globalThis.fetch>();
    const lookupFn = vi.fn<(
      hostname: string,
      options: { all: true; verbatim: boolean },
    ) => Promise<LookupAddress[]>>(async () => new Promise<LookupAddress[]>(() => {}));

    const pendingFetch = fetchWithValidatedRedirects('https://example.com/article', {
      fetchFn: fetchFn as unknown as typeof globalThis.fetch,
      lookupFn,
      requestInit: {
        signal: controller.signal,
      },
    });

    controller.abort(timeoutError);

    await expect(pendingFetch).rejects.toMatchObject({
      name: 'TimeoutError',
      message: 'DNS lookup timed out',
    });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(lookupFn).toHaveBeenCalledOnce();
  });

  it('detects redirect loops', async () => {
    const lookupFn = createPublicLookup();
    const fetchFn = vi.fn(async () => redirect('https://example.com/a'));

    await expect(fetchWithValidatedRedirects('https://example.com/a', {
      fetchFn: fetchFn as unknown as typeof globalThis.fetch,
      lookupFn,
    })).rejects.toThrow('Redirect loop detected while fetching URL.');
  });

  it('rejects when maximum redirects are exceeded', async () => {
    let counter = 0;
    const lookupFn = createPublicLookup();
    const fetchFn = vi.fn(async () => {
      counter += 1;
      return redirect(`https://example.com/r${counter}`);
    });

    await expect(fetchWithValidatedRedirects('https://example.com/start', {
      fetchFn: fetchFn as unknown as typeof globalThis.fetch,
      lookupFn,
      maxRedirects: 2,
    })).rejects.toThrow('Too many redirects while fetching URL.');
  });

  it('rejects when a redirect response is missing the Location header', async () => {
    const lookupFn = createPublicLookup();
    const fetchFn = vi.fn(async () => new Response(null, { status: 302 }));

    await expect(fetchWithValidatedRedirects('https://example.com/page', {
      fetchFn: fetchFn as unknown as typeof globalThis.fetch,
      lookupFn,
    })).rejects.toThrow('Redirect response missing Location header.');
  });

  it('throws ResponseTooLargeError when streaming body exceeds limit without Content-Length', async () => {
    const largeBody = 'x'.repeat(500);
    const lookupFn = createPublicLookup();
    const fetchFn = vi.fn(async () => new Response(largeBody, { status: 200 }));

    await expect(fetchWithValidatedRedirects('https://example.com/large', {
      fetchFn: fetchFn as unknown as typeof globalThis.fetch,
      lookupFn,
      maxResponseBytes: 100,
    })).rejects.toThrow(ResponseTooLargeError);
  });

  it('throws ResponseTooLargeError when Content-Length header exceeds limit', async () => {
    const lookupFn = createPublicLookup();
    const fetchFn = vi.fn(async () => new Response('short', {
      status: 200,
      headers: { 'content-length': '999999' },
    }));

    await expect(fetchWithValidatedRedirects('https://example.com/large', {
      fetchFn: fetchFn as unknown as typeof globalThis.fetch,
      lookupFn,
      maxResponseBytes: 100,
    })).rejects.toThrow(ResponseTooLargeError);
  });

  it('follows valid redirects and returns the final response', async () => {
    const lookupFn = createPublicLookup();
    const fetchFn = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(redirect('https://example.com/final'))
      .mockResolvedValueOnce(ok200('done'));

    const result = await fetchWithValidatedRedirects('https://example.com/start', {
      fetchFn: fetchFn as unknown as typeof globalThis.fetch,
      lookupFn,
    });

    expect(result.response.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('blocks redirects that resolve to a private IP', async () => {
    let callCount = 0;
    const lookupFn = vi.fn(async () => {
      callCount += 1;
      return callCount === 1
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '127.0.0.1', family: 4 }];
    }) as LookupFn;
    const fetchFn = vi.fn(async () => redirect('https://internal.example.com/secret'));

    await expect(fetchWithValidatedRedirects('https://example.com/start', {
      fetchFn: fetchFn as unknown as typeof globalThis.fetch,
      lookupFn,
    })).rejects.toThrow(BLOCKED_TARGET_ERROR);
  });
});

describe('validateFetchTarget', () => {
  it('blocks localhost hostnames', async () => {
    await expect(validateFetchTarget('https://localhost/path', createPublicLookup()))
      .rejects.toThrow(BLOCKED_TARGET_ERROR);
  });

  it('blocks .localhost subdomains', async () => {
    await expect(validateFetchTarget('https://app.localhost/path', createPublicLookup()))
      .rejects.toThrow(BLOCKED_TARGET_ERROR);
  });

  it('blocks private IP addresses', async () => {
    await expect(validateFetchTarget('https://10.0.0.1/path', createPublicLookup()))
      .rejects.toThrow(BLOCKED_TARGET_ERROR);
  });

  it('blocks DNS results that resolve to private IPs', async () => {
    await expect(validateFetchTarget('https://evil.example.com/path', createBlockedLookup()))
      .rejects.toThrow(BLOCKED_TARGET_ERROR);
  });

  it('rejects ftp protocol', async () => {
    await expect(validateFetchTarget('ftp://example.com/file', createPublicLookup()))
      .rejects.toThrow(DISALLOWED_PROTOCOL_ERROR);
  });

  it('rejects file protocol', async () => {
    await expect(validateFetchTarget('file:///etc/passwd', createPublicLookup()))
      .rejects.toThrow(DISALLOWED_PROTOCOL_ERROR);
  });

  it('rejects when hostname does not resolve', async () => {
    const emptyLookup: LookupFn = vi.fn(async () => []);
    await expect(validateFetchTarget('https://no-such-host.example.com/', emptyLookup))
      .rejects.toThrow('URL hostname did not resolve');
  });

  it('accepts valid public URLs', async () => {
    const url = await validateFetchTarget('https://example.com/page', createPublicLookup());
    expect(url.hostname).toBe('example.com');
  });
});
