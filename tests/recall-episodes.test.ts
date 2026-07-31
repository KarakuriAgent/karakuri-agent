import { describe, expect, it, vi } from 'vitest';

import { createRecallEpisodesTool } from '../src/agent/tools/recall-episodes.js';
import type { EpisodeRetrievalService } from '../src/life/retrieval.js';

function createRetrievalServiceStub(
  search: (...args: unknown[]) => Promise<unknown>,
): { service: EpisodeRetrievalService; search: ReturnType<typeof vi.fn> } {
  const searchMock = vi.fn(search);
  return {
    service: { search: searchMock } as unknown as EpisodeRetrievalService,
    search: searchMock,
  };
}

const NOW = new Date('2026-07-05T03:00:00.000Z');
const TIMEZONE = 'Asia/Tokyo';

describe('recallEpisodes tool', () => {
  it('returns matching episodes as date + body pairs', async () => {
    const { service, search } = createRetrievalServiceStub(async () => [
      {
        episode: {
          id: 1,
          occurredAt: '2026-06-30T16:30:00.000Z', // JST では 7/1 深夜（ローカル日で表示されることを固定する）
          channel: 'kw:bot-1',
          body: '映画館でBさんと映画を観た。',
        },
        score: 0.9,
      },
    ]);
    const tool = createRecallEpisodesTool({ retrievalService: service, timezone: TIMEZONE, now: () => NOW });

    const result = await tool.execute!(
      { query: '映画館', limit: 5 },
      { toolCallId: 'c1', messages: [], abortSignal: undefined as never },
    );

    expect(result).toEqual({
      episodes: [{ date: '2026-07-01', body: '映画館でBさんと映画を観た。' }],
    });
    expect(search).toHaveBeenCalledWith({ text: '映画館', now: NOW, limit: 5 });
  });

  it('returns an empty list when nothing matches', async () => {
    const { service } = createRetrievalServiceStub(async () => []);
    const tool = createRecallEpisodesTool({ retrievalService: service, timezone: TIMEZONE, now: () => NOW });

    const result = await tool.execute!(
      { query: '存在しない出来事', limit: 3 },
      { toolCallId: 'c1', messages: [], abortSignal: undefined as never },
    );

    expect(result).toEqual({ episodes: [] });
  });

  it('returns an error object instead of throwing when retrieval fails', async () => {
    const { service } = createRetrievalServiceStub(async () => {
      throw new Error('db is locked');
    });
    const tool = createRecallEpisodesTool({ retrievalService: service, timezone: TIMEZONE, now: () => NOW });

    const result = await tool.execute!(
      { query: '映画館', limit: 5 },
      { toolCallId: 'c1', messages: [], abortSignal: undefined as never },
    );

    expect(result).toEqual({ error: 'db is locked' });
  });
});
