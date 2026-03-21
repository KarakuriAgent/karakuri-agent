import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

import { Readability } from '@mozilla/readability';
import { tool } from 'ai';
import { DOMParser } from 'linkedom';
import TurndownService from 'turndown';
import { z } from 'zod';

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 2_000_000;
const MAX_OUTPUT_CHARS = 20_000;
const MAX_REDIRECTS = 5;
const READABILITY_FALLBACK_CONTENT = '(Could not extract readable content)';
const BLOCKED_TARGET_ERROR = 'Blocked URL target: private, loopback, and link-local addresses are not allowed.';
const SUPPORTED_CONTENT_TYPES = new Set(['text/html', 'application/xhtml+xml']);
const blockedAddressList = createBlockedAddressList();

const httpUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  }, 'url must use http or https');

export interface WebFetchToolOptions {
  fetchFn?: typeof globalThis.fetch;
  lookupFn?: LookupFn;
}

interface LookupAddress {
  address: string;
  family: number;
}

type LookupFn = (
  hostname: string,
  options: { all: true; verbatim: boolean },
) => Promise<LookupAddress[]>;

export function createWebFetchTool({
  fetchFn = globalThis.fetch,
  lookupFn = lookup as LookupFn,
}: WebFetchToolOptions = {}) {
  return tool({
    description: 'Fetch a URL and extract readable content as Markdown.',
    inputSchema: z.object({
      url: httpUrlSchema.describe('The URL to fetch. Only http and https are supported.'),
    }),
    execute: async ({ url }) => {
      try {
        const { requestUrl, response } = await fetchWithValidatedRedirects(url, {
          fetchFn,
          lookupFn,
        });
        const resolvedUrl = response.url || requestUrl;

        if (!response.ok) {
          return {
            success: false as const,
            url: resolvedUrl,
            error: `Failed to fetch URL: ${response.status}${response.statusText.length > 0 ? ` ${response.statusText}` : ''}`,
          };
        }

        const contentType = response.headers.get('content-type');
        if (!isSupportedContentType(contentType)) {
          return {
            success: false as const,
            url: resolvedUrl,
            error: `Unsupported content type: ${contentType ?? 'unknown'}`,
          };
        }

        const contentLengthHeader = response.headers.get('content-length');
        if (contentLengthHeader != null) {
          const contentLength = Number.parseInt(contentLengthHeader, 10);
          if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
            return {
              success: false as const,
              url: resolvedUrl,
              error: `Response body exceeds ${MAX_BODY_BYTES} bytes.`,
            };
          }
        }

        const html = await readResponseBody(response, MAX_BODY_BYTES);
        const document = new DOMParser().parseFromString(html, 'text/html');
        const article = new Readability(document).parse();

        if (article == null || article.content == null || article.content.trim().length === 0) {
          return {
            success: true as const,
            url: resolvedUrl,
            title: null,
            content: READABILITY_FALLBACK_CONTENT,
            truncated: false,
          };
        }

        const markdown = new TurndownService({
          codeBlockStyle: 'fenced',
          headingStyle: 'atx',
        }).turndown(article.content).trim();

        if (markdown.length === 0) {
          return {
            success: true as const,
            url: resolvedUrl,
            title: article.title?.trim() || null,
            content: READABILITY_FALLBACK_CONTENT,
            truncated: false,
          };
        }

        const { content, truncated } = truncateContent(markdown, MAX_OUTPUT_CHARS);
        return {
          success: true as const,
          url: resolvedUrl,
          title: article.title?.trim() || null,
          content,
          truncated,
        };
      } catch (error) {
        return {
          success: false as const,
          url,
          error: formatWebFetchError(error),
        };
      }
    },
  });
}

async function fetchWithValidatedRedirects(
  initialUrl: string,
  options: {
    fetchFn: typeof globalThis.fetch;
    lookupFn: LookupFn;
  },
): Promise<{ requestUrl: string; response: Response }> {
  let currentUrl = initialUrl;
  const visitedUrls = new Set<string>();

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const parsedUrl = await validateFetchTarget(currentUrl, options.lookupFn);
    const normalizedUrl = parsedUrl.toString();

    if (visitedUrls.has(normalizedUrl)) {
      throw new Error('Redirect loop detected while fetching URL.');
    }

    visitedUrls.add(normalizedUrl);

    const response = await options.fetchFn(normalizedUrl, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!isRedirectStatus(response.status)) {
      return {
        requestUrl: normalizedUrl,
        response,
      };
    }

    if (redirectCount === MAX_REDIRECTS) {
      throw new Error('Too many redirects while fetching URL.');
    }

    const location = response.headers.get('location');
    if (location == null || location.trim().length === 0) {
      throw new Error('Redirect response missing Location header.');
    }

    currentUrl = new URL(location, normalizedUrl).toString();
  }

  throw new Error('Too many redirects while fetching URL.');
}

async function validateFetchTarget(url: string, lookupFn: LookupFn): Promise<URL> {
  const parsedUrl = new URL(url);
  const hostname = normalizeHostname(parsedUrl.hostname);

  if (hostname.length === 0) {
    throw new Error('URL must include a hostname.');
  }

  if (isBlockedHostname(hostname) || isBlockedIpAddress(hostname)) {
    throw new Error(BLOCKED_TARGET_ERROR);
  }

  const hostType = isIP(hostname);
  if (hostType === 0) {
    const addresses = await lookupFn(hostname, { all: true, verbatim: true });
    if (addresses.some(({ address }) => isBlockedIpAddress(address))) {
      throw new Error(BLOCKED_TARGET_ERROR);
    }
  }

  return parsedUrl;
}

async function readResponseBody(response: Response, maxBytes: number): Promise<string> {
  if (response.body == null) {
    return '';
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let text = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new Error(`Response body exceeds ${maxBytes} bytes.`);
    }

    text += decoder.decode(value, { stream: true });
  }

  text += decoder.decode();
  return text;
}

function isSupportedContentType(contentType: string | null): boolean {
  const normalized = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  return normalized != null && SUPPORTED_CONTENT_TYPES.has(normalized);
}

function truncateContent(content: string, maxChars: number): { content: string; truncated: boolean } {
  if (content.length <= maxChars) {
    return { content, truncated: false };
  }

  return {
    content: content.slice(0, maxChars),
    truncated: true,
  };
}

function formatWebFetchError(error: unknown): string {
  if (error instanceof Error) {
    return `Failed to fetch URL: ${error.message}`;
  }

  return 'Failed to fetch URL.';
}

function createBlockedAddressList(): BlockList {
  const blockList = new BlockList();

  blockList.addSubnet('0.0.0.0', 8, 'ipv4');
  blockList.addSubnet('10.0.0.0', 8, 'ipv4');
  blockList.addSubnet('100.64.0.0', 10, 'ipv4');
  blockList.addSubnet('127.0.0.0', 8, 'ipv4');
  blockList.addSubnet('169.254.0.0', 16, 'ipv4');
  blockList.addSubnet('172.16.0.0', 12, 'ipv4');
  blockList.addSubnet('192.0.0.0', 24, 'ipv4');
  blockList.addSubnet('192.0.2.0', 24, 'ipv4');
  blockList.addSubnet('192.168.0.0', 16, 'ipv4');
  blockList.addSubnet('198.18.0.0', 15, 'ipv4');
  blockList.addSubnet('198.51.100.0', 24, 'ipv4');
  blockList.addSubnet('203.0.113.0', 24, 'ipv4');
  blockList.addSubnet('240.0.0.0', 4, 'ipv4');
  blockList.addSubnet('::', 128, 'ipv6');
  blockList.addSubnet('::1', 128, 'ipv6');
  blockList.addSubnet('fc00::', 7, 'ipv6');
  blockList.addSubnet('fe80::', 10, 'ipv6');

  return blockList;
}

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.$/, '')
    .toLowerCase();
}

function isBlockedHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname.endsWith('.localhost');
}

function isBlockedIpAddress(address: string): boolean {
  const normalizedAddress = normalizeHostname(address);
  const ipVersion = isIP(normalizedAddress);

  if (ipVersion === 0) {
    return false;
  }

  if (ipVersion === 6) {
    const mappedIPv4 = extractMappedIPv4(normalizedAddress);
    if (mappedIPv4 != null) {
      return blockedAddressList.check(mappedIPv4, 'ipv4');
    }
  }

  return blockedAddressList.check(normalizedAddress, ipVersion === 4 ? 'ipv4' : 'ipv6');
}

function extractMappedIPv4(ipv6: string): string | null {
  if (!ipv6.startsWith('::ffff:')) {
    return null;
  }

  const suffix = ipv6.slice('::ffff:'.length);

  if (isIP(suffix) === 4) {
    return suffix;
  }

  const match = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(suffix);
  if (match != null) {
    const high = Number.parseInt(match[1]!, 16);
    const low = Number.parseInt(match[2]!, 16);
    return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
  }

  return null;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
