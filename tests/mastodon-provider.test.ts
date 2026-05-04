import { describe, expect, it, vi } from 'vitest';

import { MastodonProvider } from '../src/sns/mastodon.js';

function makeAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: 'acct-1',
    display_name: 'Alice',
    username: 'alice',
    acct: 'alice@example.com',
    url: 'https://social.example/@alice',
    followers_count: 10,
    following_count: 5,
    statuses_count: 20,
    note: '<p>bio</p>',
    ...overrides,
  };
}

function makeStatus(id: string) {
  return {
    id,
    content: `<p>${id}</p>`,
    account: makeAccount(),
    created_at: '2025-01-01T00:00:00.000Z',
    url: `https://social.example/@alice/${id}`,
    visibility: 'public',
    reblogs_count: 1,
    favourites_count: 2,
    replies_count: 3,
  };
}

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

  it('returns incomplete notifications on 429 and logs Retry-After', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn(async () => Response.json({ error: 'rate limited' }, {
      status: 429,
      headers: { 'Retry-After': '60' },
    }));
    const provider = new MastodonProvider({
      instanceUrl: 'https://social.example',
      accessToken: 'token',
      fetch: fetchMock,
    });

    await expect(provider.getNotifications({ limit: 5 })).resolves.toEqual({
      notifications: [],
      complete: false,
    });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('retry-after=60'));
    warnSpy.mockRestore();
  });

  it('returns incomplete when client-side notification filtering hits the Mastodon page cap', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      expect(url).toContain('/api/v1/notifications');
      const page = fetchMock.mock.calls.length;
      return Response.json(Array.from({ length: 20 }, (_, index) => ({
        id: `notif-${page}-${index}`,
        type: 'favourite',
        created_at: '2025-01-01T00:00:00.000Z',
        account: makeAccount(),
        status: makeStatus(`status-${page}-${index}`),
      })));
    });
    const provider = new MastodonProvider({
      instanceUrl: 'https://social.example',
      accessToken: 'token',
      fetch: fetchMock,
    });

    await expect(provider.getNotifications({ limit: 5, types: ['other'] })).resolves.toEqual({
      notifications: [],
      complete: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('returns incomplete when client-side notification filtering drops matches from a full page', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      expect(url).toContain('/api/v1/notifications');
      return Response.json(Array.from({ length: 20 }, (_, index) => ({
        id: `notif-${index}`,
        type: 'poll',
        created_at: '2025-01-01T00:00:00.000Z',
        account: makeAccount(),
        status: makeStatus(`status-${index}`),
      })));
    });
    const provider = new MastodonProvider({
      instanceUrl: 'https://social.example',
      accessToken: 'token',
      fetch: fetchMock,
    });

    await expect(provider.getNotifications({ limit: 5, types: ['other'] })).resolves.toEqual({
      notifications: [
        expect.objectContaining({ id: 'notif-0', type: 'other' }),
        expect.objectContaining({ id: 'notif-1', type: 'other' }),
        expect.objectContaining({ id: 'notif-2', type: 'other' }),
        expect.objectContaining({ id: 'notif-3', type: 'other' }),
        expect.objectContaining({ id: 'notif-4', type: 'other' }),
      ],
      complete: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns incomplete when the Mastodon page cap is hit after collecting enough client-side-filtered notifications', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      expect(url).toContain('/api/v1/notifications');
      const page = fetchMock.mock.calls.length;
      return Response.json(Array.from({ length: 20 }, (_, index) => ({
        id: `notif-${page}-${index}`,
        type: page === 5 ? 'poll' : 'favourite',
        created_at: '2025-01-01T00:00:00.000Z',
        account: makeAccount(),
        status: makeStatus(`status-${page}-${index}`),
      })));
    });
    const provider = new MastodonProvider({
      instanceUrl: 'https://social.example',
      accessToken: 'token',
      fetch: fetchMock,
    });

    await expect(provider.getNotifications({ limit: 5, types: ['other'] })).resolves.toEqual({
      notifications: [
        expect.objectContaining({ id: 'notif-5-0', type: 'other' }),
        expect.objectContaining({ id: 'notif-5-1', type: 'other' }),
        expect.objectContaining({ id: 'notif-5-2', type: 'other' }),
        expect.objectContaining({ id: 'notif-5-3', type: 'other' }),
        expect.objectContaining({ id: 'notif-5-4', type: 'other' }),
      ],
      complete: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('implements unlike, follow, profile, metrics, and notification dismissal', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/api/v1/statuses/status-1/unfavourite')) {
        expect(init?.method).toBe('POST');
        return Response.json(makeStatus('status-1'));
      }
      if (url.includes('/api/v1/accounts/lookup')) {
        return Response.json(makeAccount({ id: 'acct-target', acct: 'target@example.com' }));
      }
      if (url.includes('/api/v1/accounts/acct-target/follow')) {
        return Response.json({ id: 'acct-target', following: true });
      }
      if (url.includes('/api/v1/accounts/acct-target/unfollow')) {
        return Response.json({ id: 'acct-target', following: false });
      }
      if (url.includes('/api/v1/accounts/relationships')) {
        expect(url).toContain('id%5B%5D=acct-target');
        return Response.json([{ id: 'acct-target', following: true }]);
      }
      if (url.includes('/api/v1/accounts/verify_credentials')) {
        return Response.json(makeAccount({ id: 'me' }));
      }
      if (url.includes('/api/v2/instance')) {
        return Response.json({ version: '4.2.0' });
      }
      if (url.includes('/api/v1/notifications/n1/dismiss')) {
        return new Response(null, { status: 200 });
      }
      if (url.includes('/api/v1/notifications/n2/dismiss')) {
        return Response.json({ id: 'n2' });
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const provider = new MastodonProvider({
      instanceUrl: 'https://social.example',
      accessToken: 'token',
      fetch: fetchMock,
    });

    await expect(provider.unlike('status-1')).resolves.toEqual(expect.objectContaining({ id: 'status-1' }));
    await expect(provider.follow('@target@example.com')).resolves.toBeUndefined();
    await expect(provider.unfollow('target@example.com')).resolves.toBeUndefined();
    await expect(provider.getUserProfile('target@example.com')).resolves.toEqual(expect.objectContaining({
      id: 'acct-target',
      bio: 'bio',
      followerCount: 10,
      followingCount: 5,
      postCount: 20,
      followedByMe: true,
    }));
    await expect(provider.getMyMetrics()).resolves.toEqual({
      followerCount: 10,
      followingCount: 5,
      postCount: 20,
    });
    await expect(provider.markNotificationsRead(['n1', 'n2'])).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes('/api/v1/accounts/lookup'))).toHaveLength(1);
  });

  it('returns immediately for empty markNotificationsRead without calling the API or instance version', async () => {
    const fetchMock = vi.fn();
    const provider = new MastodonProvider({
      instanceUrl: 'https://social.example',
      accessToken: 'token',
      fetch: fetchMock,
    });
    await expect(provider.markNotificationsRead([])).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('clears the lookup cache after a failed lookup so retries call the API again', async () => {
    let attempts = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/api/v1/accounts/lookup')) {
        attempts += 1;
        if (attempts === 1) {
          return Response.json({ error: 'boom' }, { status: 500 });
        }
        return Response.json(makeAccount({ id: 'acct-target' }));
      }
      if (url.includes('/api/v1/accounts/acct-target/follow')) {
        return Response.json({ id: 'acct-target', following: true });
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const provider = new MastodonProvider({
      instanceUrl: 'https://social.example',
      accessToken: 'token',
      fetch: fetchMock,
    });

    await expect(provider.follow('@target@example.com')).rejects.toThrow('boom');
    await expect(provider.follow('@target@example.com')).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });

  it('throws from getUserProfile when the relationships request fails', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/api/v1/accounts/lookup')) {
        return Response.json(makeAccount({ id: 'acct-target' }));
      }
      if (url.includes('/api/v1/accounts/relationships')) {
        return Response.json({ error: 'boom' }, { status: 500 });
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const provider = new MastodonProvider({
      instanceUrl: 'https://social.example',
      accessToken: 'token',
      fetch: fetchMock,
    });

    await expect(provider.getUserProfile('target@example.com')).rejects.toThrow('boom');
  });

  it('handles partial/all notification dismiss failures and rejects Mastodon before 4.0', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const partialFetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/api/v2/instance')) {
        return Response.json({ version: '4.0.0' });
      }
      if (url.includes('/ok/dismiss')) {
        return Response.json({ id: 'ok' });
      }
      return Response.json({ error: 'boom' }, { status: 500 });
    });
    const partialProvider = new MastodonProvider({
      instanceUrl: 'https://social.example',
      accessToken: 'token',
      fetch: partialFetch,
    });
    await expect(partialProvider.markNotificationsRead(['ok', 'fail'])).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Some Mastodon notification dismiss requests failed'), expect.objectContaining({
      failedIds: ['fail'],
    }));

    const allFailProvider = new MastodonProvider({
      instanceUrl: 'https://social.example',
      accessToken: 'token',
      fetch: vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes('/api/v2/instance')) {
          return Response.json({ version: '4.0.0' });
        }
        return Response.json({ error: 'boom' }, { status: 500 });
      }),
    });
    await expect(allFailProvider.markNotificationsRead(['fail-1'])).rejects.toThrow('boom');

    const oldProvider = new MastodonProvider({
      instanceUrl: 'https://old.example',
      accessToken: 'token',
      fetch: vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes('/api/v2/instance')) {
          return Response.json({ error: 'Record not found' }, { status: 404 });
        }
        if (url.includes('/api/v1/instance')) {
          return Response.json({ version: '3.5.0' });
        }
        throw new Error(`Unexpected URL ${url}`);
      }),
    });
    await expect(oldProvider.markNotificationsRead(['n1'])).rejects.toThrow('notification dismiss requires Mastodon 4.0 or newer');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('notification dismiss requires Mastodon 4.0 or newer'));
  });
});
