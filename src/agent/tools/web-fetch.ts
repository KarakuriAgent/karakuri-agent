import { Readability } from '@mozilla/readability';
import { tool } from 'ai';
import { DOMParser } from 'linkedom';
import TurndownService from 'turndown';
import { z } from 'zod';

import {
  fetchWithValidatedRedirects,
  httpUrlSchema,
  type LookupFn,
} from '../../utils/safe-fetch.js';

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 2_000_000;
const MAX_OUTPUT_CHARS = 20_000;
const READABILITY_FALLBACK_CONTENT = '(Could not extract readable content)';
const SUPPORTED_CONTENT_TYPES = new Set(['text/html', 'application/xhtml+xml']);

export interface WebFetchToolOptions {
  fetchFn?: typeof globalThis.fetch;
  lookupFn?: LookupFn;
}

export function createWebFetchTool({
  fetchFn = globalThis.fetch,
  lookupFn,
}: WebFetchToolOptions = {}) {
  return tool({
    description: 'Fetch a URL and extract readable content as Markdown.',
    inputSchema: z.object({
      url: httpUrlSchema.describe('The URL to fetch. Only http and https are supported.'),
    }),
    execute: async ({ url }) => {
      try {
        const { requestUrl, response, bodyBytes } = await fetchWithValidatedRedirects(url, {
          fetchFn,
          ...(lookupFn != null ? { lookupFn } : {}),
          requestInit: {
            headers: {
              Accept: 'text/html,application/xhtml+xml',
            },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          },
          maxResponseBytes: MAX_BODY_BYTES,
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

        const html = decodeResponseBody(bodyBytes);
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

function decodeResponseBody(bodyBytes?: Uint8Array): string {
  return bodyBytes != null ? new TextDecoder().decode(bodyBytes) : '';
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
