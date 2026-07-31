import { describe, expect, it, vi } from 'vitest';

import { DiscordMessageSink } from '../src/scheduler/message-sink.js';

describe('DiscordMessageSink', () => {
  it('rejects allowlist misses', async () => {
    const sink = new DiscordMessageSink({
      botToken: 'token',
      allowedChannelIds: ['allowed'],
      fetchFn: vi.fn() as unknown as typeof fetch,
    });

    await expect(sink.postMessage('blocked', 'hello')).rejects.toThrow(/allowlist/);
  });

  it('posts split messages to the Discord API', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const sink = new DiscordMessageSink({
      botToken: 'token',
      allowedChannelIds: ['allowed'],
      fetchFn,
    });

    await sink.postMessage('allowed', `${'x'.repeat(1999)}yy`);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn).toHaveBeenNthCalledWith(1, 'https://discord.com/api/v10/channels/allowed/messages', expect.objectContaining({ method: 'POST' }));
  });

  it('retries once on a 429 response', async () => {
    const sleep = vi.fn(async () => {});
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"retry_after":0.01}', { status: 429, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 })) as unknown as typeof fetch;

    const sink = new DiscordMessageSink({
      botToken: 'token',
      allowedChannelIds: ['allowed'],
      fetchFn,
      sleep,
    });

    await sink.postMessage('allowed', 'hello');

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it('treats Retry-After header values as seconds', async () => {
    const sleep = vi.fn(async () => {});
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '120' } }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 })) as unknown as typeof fetch;

    const sink = new DiscordMessageSink({
      botToken: 'token',
      allowedChannelIds: ['allowed'],
      fetchFn,
      sleep,
    });

    await sink.postMessage('allowed', 'hello');

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(120_000);
  });

  it('supports Retry-After HTTP date headers', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00.000Z'));

    const sleep = vi.fn(async () => {});
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': 'Wed, 01 Jan 2025 00:00:05 GMT' } }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 })) as unknown as typeof fetch;

    const sink = new DiscordMessageSink({
      botToken: 'token',
      allowedChannelIds: ['allowed'],
      fetchFn,
      sleep,
    });

    await sink.postMessage('allowed', 'hello');

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(5_000);
  });

  it('posts replies to the channel embedded in a Chat SDK Discord thread id', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const sink = new DiscordMessageSink({
      botToken: 'token',
      allowedChannelIds: [],
      fetchFn,
    });

    await sink.postReply('discord:1467356661617528863:1473562574791643353', 'hello');

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith(
      'https://discord.com/api/v10/channels/1473562574791643353/messages',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('posts replies to the Discord thread channel when the Chat SDK id contains one', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const sink = new DiscordMessageSink({
      botToken: 'token',
      allowedChannelIds: [],
      fetchFn,
    });

    await sink.postReply('discord:1467356661617528863:1473562574791643353:1473563000000000000', 'hello');

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith(
      'https://discord.com/api/v10/channels/1473563000000000000/messages',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('rejects malformed Chat SDK Discord thread ids before calling the Discord API', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const sink = new DiscordMessageSink({
      botToken: 'token',
      allowedChannelIds: [],
      fetchFn,
    });

    await expect(sink.postReply('discord:guild:not-a-snowflake', 'hello')).rejects.toThrow(/snowflake/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
