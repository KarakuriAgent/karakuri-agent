import { tool } from 'ai';
import { z } from 'zod';

import type { IUserStore, UserAlias } from '../../user/types.js';

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
      const userIds = visibleUsers.map((user) => user.userId);
      const aliasesByPrimary = userStore.listAliasesByPrimaryIds != null
        ? await userStore.listAliasesByPrimaryIds(userIds)
        : new Map();
      const aliasResolutions = userStore.resolveAlias != null
        ? await Promise.all(userIds.map((id) => userStore.resolveAlias!(id)))
        : [];
      const aliasOfByUser = new Map(aliasResolutions
        .filter((entry) => entry.aliasOf != null)
        .map((entry) => [entry.aliasOf!.aliasUserId, entry.aliasOf!.primaryUserId]));

      return {
        found: visibleUsers.length,
        offset,
        hasMore,
        nextOffset: hasMore ? offset + visibleUsers.length : null,
        users: visibleUsers.map((user) => {
          const aliases = aliasesByPrimary.get(user.userId) ?? [];
          const aliasOf = aliasOfByUser.get(user.userId);
          return {
            userId: user.userId,
            displayName: user.displayName,
            profile: truncateProfile(user.profile),
            ...(aliases.length > 0
              ? {
                  aliases: aliases.map((alias: UserAlias) => ({
                    user_id: alias.aliasUserId,
                    ...(alias.note != null ? { note: alias.note } : {}),
                  })),
                }
              : {}),
            ...(aliasOf != null ? { alias_of: aliasOf } : {}),
          };
        }),
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
