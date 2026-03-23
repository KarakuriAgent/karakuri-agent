import { tool } from 'ai';
import { z } from 'zod';

import type { IUserStore } from '../../user/types.js';

const DEFAULT_USER_LOOKUP_LIMIT = 5;
const MAX_USER_LOOKUP_LIMIT = 10;
const MAX_USER_LOOKUP_OFFSET = 100;
const MAX_USER_LOOKUP_PROFILE_CHARS = 600;

export interface UserLookupToolOptions {
  userStore: IUserStore;
}

export function createUserLookupTool({ userStore }: UserLookupToolOptions) {
  return tool({
    description: 'Search for known users by name or keyword. Leave query empty to list recent known users.',
    inputSchema: z.object({
      query: z.string().trim().max(200).optional().default('')
        .describe('Search query (name or keyword). Leave empty to list recent known users.'),
      limit: z.number().int().min(1).max(MAX_USER_LOOKUP_LIMIT).optional()
        .describe(`Maximum users to return (default ${DEFAULT_USER_LOOKUP_LIMIT}, hard max ${MAX_USER_LOOKUP_LIMIT})`),
      offset: z.number().int().min(0).max(MAX_USER_LOOKUP_OFFSET).optional()
        .describe('Result offset for pagination'),
    }),
    execute: async ({ query, limit, offset = 0 }) => {
      const requestedLimit = limit ?? DEFAULT_USER_LOOKUP_LIMIT;
      const users = await userStore.searchUsers(query, {
        limit: requestedLimit + 1,
        offset,
      });
      const hasMore = users.length > requestedLimit;
      const visibleUsers = users.slice(0, requestedLimit);

      return {
        found: visibleUsers.length,
        offset,
        hasMore,
        nextOffset: hasMore ? offset + visibleUsers.length : null,
        users: visibleUsers.map((user) => ({
          userId: user.userId,
          displayName: user.displayName,
          profile: truncateProfile(user.profile),
        })),
      };
    },
  });
}

function truncateProfile(profile: string | null): string | null {
  if (profile == null || profile.length <= MAX_USER_LOOKUP_PROFILE_CHARS) {
    return profile;
  }

  return `${profile.slice(0, MAX_USER_LOOKUP_PROFILE_CHARS - 1)}…`;
}
