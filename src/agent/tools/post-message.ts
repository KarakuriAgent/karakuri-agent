import { tool } from 'ai';
import { z } from 'zod';

import type { IMessageSink } from '../../scheduler/types.js';
import { assertAdminUser } from './admin-auth.js';

export interface PostMessageToolOptions {
  messageSink: IMessageSink;
  allowedChannelIds: string[];
  adminUserIds: string[];
  userId?: string | undefined;
}

export function createPostMessageTool({
  messageSink,
  allowedChannelIds,
  adminUserIds,
  userId,
}: PostMessageToolOptions) {
  const allowedSet = new Set(allowedChannelIds);
  const listedChannels = allowedChannelIds.join(', ');

  return tool({
    description: `Post a message to a Discord channel. Available channels: ${listedChannels}`,
    inputSchema: z.object({
      channelId: z.string().refine((value) => allowedSet.has(value), 'channelId must be in the configured allowlist'),
      text: z.string().trim().min(1).max(4_000),
    }),
    execute: async ({ channelId, text }) => {
      assertAdminUser(userId, adminUserIds);
      await messageSink.postMessage(channelId, text);
      return { posted: true, channelId };
    },
  });
}
