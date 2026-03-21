import { tool } from 'ai';
import { z } from 'zod';

const BRAVE_SEARCH_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const DEFAULT_RESULT_COUNT = 5;
const REQUEST_TIMEOUT_MS = 15_000;

const braveSearchResponseSchema = z.object({
  web: z.object({
    results: z.array(z.object({
      title: z.string().optional(),
      url: z.string().optional(),
      description: z.string().optional(),
    })),
  }),
});

export interface WebSearchToolOptions {
  braveApiKey: string;
  fetchFn?: typeof globalThis.fetch;
}

export function createWebSearchTool({
  braveApiKey,
  fetchFn = globalThis.fetch,
}: WebSearchToolOptions) {
  return tool({
    description: 'Search the web via Brave Search and return relevant results.',
    inputSchema: z.object({
      query: z.string().trim().min(1).max(400).describe('The search query to run.'),
      count: z.number().int().min(1).max(10).optional().describe('How many results to return. Defaults to 5.'),
    }),
    execute: async ({ query, count }) => {
      const requestUrl = new URL(BRAVE_SEARCH_ENDPOINT);
      requestUrl.searchParams.set('q', query);
      requestUrl.searchParams.set('count', String(count ?? DEFAULT_RESULT_COUNT));

      try {
        const response = await fetchFn(requestUrl.toString(), {
          headers: {
            Accept: 'application/json',
            'X-Subscription-Token': braveApiKey,
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (!response.ok) {
          return { error: `Brave Search request failed with status ${response.status}.` };
        }

        const parsed = braveSearchResponseSchema.safeParse(await response.json());
        if (!parsed.success) {
          return { error: 'Brave Search returned an unexpected response.' };
        }

        const results = (parsed.data.web?.results ?? []).flatMap((result) => {
          const title = result.title?.trim();
          const url = result.url?.trim();

          if (title == null || title.length === 0 || url == null || url.length === 0) {
            return [];
          }

          return [{
            title,
            url,
            snippet: result.description?.trim() ?? '',
          }];
        });

        return { results };
      } catch (error) {
        return { error: formatWebSearchError(error) };
      }
    },
  });
}

function formatWebSearchError(error: unknown): string {
  if (error instanceof Error) {
    return `Failed to search the web: ${error.message}`;
  }

  return 'Failed to search the web.';
}
