import { tool } from 'ai';
import { z } from 'zod';

import type { IUserStore } from '../../user/types.js';
import { assertAdminUser } from './admin-auth.js';

const linkUserSchema = z.object({
  alias_user_id: z.string().trim().min(1),
  primary_user_id: z.string().trim().min(1),
  note: z.string().trim().max(500).optional(),
}).strict();

const unlinkUserSchema = z.object({
  alias_user_id: z.string().trim().min(1),
}).strict();

export interface UserAliasToolOptions {
  userStore: IUserStore;
  adminUserIds: string[];
  userId?: string | undefined;
}

export function createLinkUserTool({ userStore, adminUserIds, userId }: UserAliasToolOptions) {
  return tool({
    description: '同一人物が複数アカウントを持つ場合に、alias_user_id を primary_user_id の別名として登録する。primary の選び方: Discord ID (discord: prefix) を優先。Discord アカウントが片方にしかない場合は、最も継続的に観測されているアカウント（KW モードなら KW 側、SNS のみなら最初に観測した SNS account）を primary にする。両ユーザーが users テーブルに存在しないと not_found エラーになるため、先に両者が観測（ensureUser）されるまで待つこと。修正や primary 入れ替えは unlinkUser → linkUser の 2 ステップで行う。',
    inputSchema: linkUserSchema,
    execute: async ({ alias_user_id, primary_user_id, note }) => {
      assertAdminUser(userId, adminUserIds);
      if (userStore.linkUserAlias == null) {
        throw new Error('User alias store support is not configured.');
      }
      await userStore.linkUserAlias(alias_user_id, primary_user_id, {
        ...(note != null ? { note } : {}),
        ...(userId != null ? { linkedBy: userId } : {}),
      });
      return { linked: true, alias_user_id, primary_user_id };
    },
  });
}

export function createUnlinkUserTool({ userStore, adminUserIds, userId }: UserAliasToolOptions) {
  return tool({
    description: 'ユーザー alias 登録を解除する。修正や primary 入れ替えは unlinkUser の後に linkUser で登録し直す。',
    inputSchema: unlinkUserSchema,
    execute: async ({ alias_user_id }) => {
      assertAdminUser(userId, adminUserIds);
      if (userStore.unlinkUserAlias == null) {
        throw new Error('User alias store support is not configured.');
      }
      await userStore.unlinkUserAlias(alias_user_id);
      return { unlinked: true, alias_user_id };
    },
  });
}
