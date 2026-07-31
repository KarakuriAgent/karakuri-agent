import { tool } from 'ai';
import { z } from 'zod';

import type { IBeliefStore } from '../../life/beliefs.js';
import { ALIAS_RELATION, type IRelationStore } from '../../life/relations.js';
import type { IUserStore, UserAlias } from '../../user/types.js';

const DEFAULT_USER_LOOKUP_LIMIT = 5;
const MAX_USER_LOOKUP_LIMIT = 10;
const MAX_USER_LOOKUP_OFFSET = 100;
const MAX_USER_LOOKUP_PROFILE_CHARS = 600;

export interface UserLookupToolOptions {
  userStore: IUserStore;
  /** 新ストア（beliefs person_fact）。profile はこちらのみから構築する */
  beliefStore?: IBeliefStore | undefined;
  /** M6: 関係グラフ（relations）。設定時は alias_of と関係エッジもこちらから返す */
  relationStore?: IRelationStore | undefined;
}

export function createUserLookupTool({ userStore, beliefStore, relationStore }: UserLookupToolOptions) {
  return tool({
    description: 'Search for known users by display name. Leave query empty to list recent known users.',
    inputSchema: z.object({
      query: z.string().trim().max(200).optional().default('')
        .describe('Display-name search query. Leave empty to list recent known users.'),
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

      // profile と関係情報は新ストア（beliefs / relations）のみから構築する
      const newStoreInfo = new Map<string, { profile?: string; relations?: string[]; aliasOf?: string }>();
      if (beliefStore != null || relationStore != null) {
        await Promise.all(userIds.map(async (userId) => {
          const info: { profile?: string; relations?: string[]; aliasOf?: string } = {};
          if (beliefStore != null) {
            const beliefs = await beliefStore.listActive({ kind: 'person_fact', subject: userId, limit: 8 })
              .catch(() => []);
            if (beliefs.length > 0) {
              info.profile = beliefs.map((belief) => `- ${belief.body}`).join('\n');
            }
          }
          if (relationStore != null) {
            const edges = await relationStore.listForSubject(userId, 8).catch(() => []);
            const aliasEdge = edges.find((edge) => edge.relation === ALIAS_RELATION && edge.subjectId === userId);
            if (aliasEdge != null) {
              info.aliasOf = aliasEdge.objectId;
            }
            const relationLines = edges
              .filter((edge) => edge.relation !== ALIAS_RELATION)
              .map((edge) => `${edge.subjectId} -${edge.relation}-> ${edge.objectId}`);
            if (relationLines.length > 0) {
              info.relations = relationLines;
            }
          }
          if (Object.keys(info).length > 0) {
            newStoreInfo.set(userId, info);
          }
        }));
      }

      return {
        found: visibleUsers.length,
        offset,
        hasMore,
        nextOffset: hasMore ? offset + visibleUsers.length : null,
        users: visibleUsers.map((user) => {
          const aliases = aliasesByPrimary.get(user.userId) ?? [];
          const aliasOf = aliasOfByUser.get(user.userId);
          const info = newStoreInfo.get(user.userId);
          return {
            userId: user.userId,
            displayName: user.displayName,
            profile: truncateProfile(info?.profile ?? null),
            ...(aliases.length > 0
              ? {
                  aliases: aliases.map((alias: UserAlias) => ({
                    user_id: alias.aliasUserId,
                    ...(alias.note != null ? { note: alias.note } : {}),
                  })),
                }
              : {}),
            ...(info?.aliasOf != null
              ? { alias_of: info.aliasOf }
              : aliasOf != null ? { alias_of: aliasOf } : {}),
            ...(info?.relations != null ? { relations: info.relations } : {}),
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
