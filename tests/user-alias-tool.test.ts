import { describe, expect, it, vi } from 'vitest';

import { createAgentTools } from '../src/agent/tools/index.js';
import type { IMemoryStore } from '../src/memory/types.js';
import type { IUserStore } from '../src/user/types.js';

const memoryStore = {
  getRecentDiaries: vi.fn(async () => []),
  readCoreMemory: vi.fn(async () => ''),
  writeCoreMemory: vi.fn(async () => {}),
  readDiary: vi.fn(async () => null),
  writeDiary: vi.fn(async () => {}),
  replaceDiary: vi.fn(async () => {}),
  deleteDiary: vi.fn(async () => false),
  listDiaryDates: vi.fn(async () => []),
  close: vi.fn(async () => {}),
} satisfies IMemoryStore;

function createUserStore(): IUserStore {
  return {
    getUser: vi.fn(async () => null),
    ensureUser: vi.fn(async (userId: string, displayName: string) => ({ userId, displayName, profile: null, createdAt: '', updatedAt: '' })),
    updateProfile: vi.fn(async () => {}),
    updateDisplayName: vi.fn(async () => {}),
    searchUsers: vi.fn(async () => []),
    linkUserAlias: vi.fn(async () => {}),
    unlinkUserAlias: vi.fn(async () => {}),
    listAliases: vi.fn(async () => []),
    listAliasesByPrimaryIds: vi.fn(async () => new Map()),
    resolveAlias: vi.fn(async (userId: string) => ({ primaryUserId: userId, aliasOf: null })),
    close: vi.fn(async () => {}),
  };
}

describe('user alias tools', () => {
  it('exposes linkUser/unlinkUser only to non-KW admins', async () => {
    const userStore = createUserStore();
    const tools = createAgentTools({ memoryStore, userStore, adminUserIds: ['admin'], userId: 'admin' });
    expect(tools.linkUser).toBeDefined();
    expect(tools.unlinkUser).toBeDefined();

    await tools.linkUser!.execute!({ alias_user_id: 'sns:mastodon:1', primary_user_id: 'discord:1', note: 'same person' }, { toolCallId: 't1', messages: [] });
    expect(userStore.linkUserAlias).toHaveBeenCalledWith('sns:mastodon:1', 'discord:1', { note: 'same person', linkedBy: 'admin' });

    const kwTools = createAgentTools({ memoryStore, userStore, adminUserIds: ['admin'], userId: 'admin', kwMode: true });
    expect(kwTools.linkUser).toBeUndefined();
  });

  it('does not expose alias tools to non-admin users', () => {
    const tools = createAgentTools({ memoryStore, userStore: createUserStore(), adminUserIds: ['admin'], userId: 'user' });
    expect(tools.linkUser).toBeUndefined();
    expect(tools.unlinkUser).toBeUndefined();
  });

  it('does not expose alias tools to the synthetic system user', () => {
    const tools = createAgentTools({ memoryStore, userStore: createUserStore(), adminUserIds: ['admin'], userId: 'system' });
    expect(tools.linkUser).toBeUndefined();
    expect(tools.unlinkUser).toBeUndefined();
  });

  it('propagates not_linked errors from unlinkUserAlias', async () => {
    const userStore = createUserStore();
    (userStore.unlinkUserAlias as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('not_linked: alias_user_id is not currently linked: sns:x:99'),
    );
    const tools = createAgentTools({ memoryStore, userStore, adminUserIds: ['admin'], userId: 'admin' });
    await expect(
      tools.unlinkUser!.execute!({ alias_user_id: 'sns:x:99' }, { toolCallId: 't1', messages: [] }),
    ).rejects.toThrow('not_linked');
  });
});
