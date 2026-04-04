import { describe, expect, it, vi } from 'vitest';

import { MastodonProvider } from '../src/sns/mastodon.js';

describe('MastodonProvider', () => {
  it('maps quote notifications and supports filtering them', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

      expect(url).toContain('/api/v1/notifications');
      expect(url).toContain('types%5B%5D=quote');

      return new Response(JSON.stringify([
        {
          id: 'notif-1',
          type: 'quote',
          created_at: '2025-01-01T00:00:00.000Z',
          account: {
            id: 'acct-1',
            display_name: 'Alice',
            username: 'alice',
            acct: 'alice@example.com',
            url: 'https://social.example/@alice',
          },
          status: {
            id: 'status-1',
            content: '<p>Quoted you</p>',
            account: {
              id: 'acct-1',
              display_name: 'Alice',
              username: 'alice',
              acct: 'alice@example.com',
              url: 'https://social.example/@alice',
            },
            created_at: '2025-01-01T00:00:00.000Z',
            url: 'https://social.example/@alice/status-1',
            visibility: 'public',
            reblogs_count: 1,
            favourites_count: 2,
            replies_count: 3,
          },
        },
      ]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const provider = new MastodonProvider({
      instanceUrl: 'https://social.example',
      accessToken: 'token',
      fetch: fetchMock,
    });

    await expect(provider.getNotifications({ limit: 5, types: ['quote'] })).resolves.toEqual({
      notifications: [
        expect.objectContaining({
          id: 'notif-1',
          type: 'quote',
          post: expect.objectContaining({ id: 'status-1', text: 'Quoted you' }),
        }),
      ],
      complete: true,
    });
  });
});
