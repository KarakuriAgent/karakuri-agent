import type { ZodType } from 'zod';
import { describe, expect, it, vi } from 'vitest';

import { createPostMessageTool } from '../src/agent/tools/post-message.js';

describe('postMessage tool', () => {
  it('posts for admin users', async () => {
    const messageSink = {
      postMessage: vi.fn(async () => {}),
    };
    const tool = createPostMessageTool({
      messageSink,
      allowedChannelIds: ['channel-1'],
      adminUserIds: ['admin-1'],
      userId: 'admin-1',
    });

    await expect(tool.execute!(
      { channelId: 'channel-1', text: 'hello' },
      { toolCallId: 'c1', messages: [], abortSignal: undefined as never },
    )).resolves.toEqual({ posted: true, channelId: 'channel-1' });
    expect(messageSink.postMessage).toHaveBeenCalledWith('channel-1', 'hello');
  });

  it('rejects non-admin users', async () => {
    const messageSink = {
      postMessage: vi.fn(async () => {}),
    };
    const tool = createPostMessageTool({
      messageSink,
      allowedChannelIds: ['channel-1'],
      adminUserIds: ['admin-1'],
      userId: 'user-1',
    });

    await expect(tool.execute!(
      { channelId: 'channel-1', text: 'hello' },
      { toolCallId: 'c1', messages: [], abortSignal: undefined as never },
    )).rejects.toThrow(/administrator/);
  });

  it('allows system runs when admin users are not configured', async () => {
    const messageSink = { postMessage: vi.fn(async () => {}) };
    const tool = createPostMessageTool({
      messageSink,
      allowedChannelIds: ['channel-1'],
      adminUserIds: [],
      userId: 'system',
    });

    await expect(tool.execute!(
      { channelId: 'channel-1', text: 'hello' },
      { toolCallId: 'c1', messages: [], abortSignal: undefined as never },
    )).resolves.toEqual({ posted: true, channelId: 'channel-1' });
    expect(messageSink.postMessage).toHaveBeenCalledWith('channel-1', 'hello');
  });

  it('rejects whitespace-only text in the schema', () => {
    const tool = createPostMessageTool({
      messageSink: { postMessage: vi.fn(async () => {}) },
      allowedChannelIds: ['channel-1'],
      adminUserIds: ['admin-1'],
      userId: 'admin-1',
    });

    const schema = tool.inputSchema as ZodType;
    expect(schema.safeParse({ channelId: 'channel-1', text: '   ' }).success).toBe(false);
    expect(schema.safeParse({ channelId: 'channel-1', text: '' }).success).toBe(false);
  });

  it('validates allowlisted channel ids in the schema', () => {
    const tool = createPostMessageTool({
      messageSink: { postMessage: vi.fn(async () => {}) },
      allowedChannelIds: ['channel-1'],
      adminUserIds: ['admin-1'],
      userId: 'admin-1',
    });

    const schema = tool.inputSchema as ZodType;
    expect(schema.safeParse({ channelId: 'channel-1', text: 'ok' }).success).toBe(true);
    expect(schema.safeParse({ channelId: 'other', text: 'ok' }).success).toBe(false);
  });
});
