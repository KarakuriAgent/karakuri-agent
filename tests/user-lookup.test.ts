import type { ZodType } from 'zod';
import { describe, expect, it } from 'vitest';

import { createUserLookupTool } from '../src/agent/tools/user-lookup.js';
import type { IUserStore, UserRecord } from '../src/user/types.js';

interface UserLookupResult {
  found: number;
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
  users: Array<{
    userId: string;
    displayName: string;
    profile: string | null;
  }>;
}

class UserStoreStub implements IUserStore {
  searchCalls: Array<{ query: string; options?: { limit?: number; offset?: number } }> = [];

  constructor(private readonly users: UserRecord[]) {}

  async getUser(): Promise<UserRecord | null> {
    return null;
  }

  async ensureUser(): Promise<UserRecord> {
    throw new Error('not implemented');
  }

  async updateProfile(): Promise<void> {}

  async updateDisplayName(): Promise<void> {}

  async searchUsers(query: string, options?: { limit?: number; offset?: number }): Promise<UserRecord[]> {
    this.searchCalls.push(options != null ? { query, options } : { query });
    const normalized = query.toLowerCase();
    const users = this.users.filter((user) =>
      user.displayName.toLowerCase().includes(normalized)
      || user.profile?.toLowerCase().includes(normalized),
    );
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? users.length;
    return users.slice(offset, offset + limit);
  }

  async close(): Promise<void> {}
}

describe('userLookup tool', () => {
  it('returns matching users', async () => {
    const tool = createUserLookupTool({
      userStore: new UserStoreStub([
        {
          userId: 'user-1',
          displayName: 'Alice',
          profile: 'Works on robotics',
          createdAt: '',
          updatedAt: '',
        },
      ]),
    });

    const result = await tool.execute!(
      { query: 'robot' },
      { toolCallId: 'c1', messages: [], abortSignal: undefined as never },
    );

    expect(result).toEqual({
      found: 1,
      offset: 0,
      hasMore: false,
      nextOffset: null,
      users: [
        {
          userId: 'user-1',
          displayName: 'Alice',
          profile: 'Works on robotics',
        },
      ],
    });
  });

  it('returns an empty list when no users match', async () => {
    const tool = createUserLookupTool({
      userStore: new UserStoreStub([]),
    });

    const result = await tool.execute!(
      { query: 'nobody' },
      { toolCallId: 'c1', messages: [], abortSignal: undefined as never },
    );

    expect(result).toEqual({ found: 0, offset: 0, hasMore: false, nextOffset: null, users: [] });
  });

  it('accepts blank or omitted queries to list recent known users', async () => {
    const userStore = new UserStoreStub([
      {
        userId: 'user-1',
        displayName: 'Alice',
        profile: null,
        createdAt: '',
        updatedAt: '',
      },
    ]);
    const tool = createUserLookupTool({ userStore });

    const schema = tool.inputSchema as ZodType;
    expect(schema.safeParse({ query: '   ' }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ query: 'alice' }).success).toBe(true);

    const result = await tool.execute!(
      { query: '' },
      { toolCallId: 'c1', messages: [], abortSignal: undefined as never },
    );

    expect(userStore.searchCalls).toEqual([{ query: '', options: { limit: 6, offset: 0 } }]);
    expect(result).toEqual({
      found: 1,
      offset: 0,
      hasMore: false,
      nextOffset: null,
      users: [
        {
          userId: 'user-1',
          displayName: 'Alice',
          profile: null,
        },
      ],
    });
  });

  it('caps results and reports pagination metadata', async () => {
    const tool = createUserLookupTool({
      userStore: new UserStoreStub(Array.from({ length: 7 }, (_, index) => ({
        userId: `user-${index}`,
        displayName: `Alice ${index}`,
        profile: 'x'.repeat(700),
        createdAt: '',
        updatedAt: '',
      }))),
    });

    const result = await tool.execute!(
      { query: 'alice', limit: 3, offset: 2 },
      { toolCallId: 'c1', messages: [], abortSignal: undefined as never },
    );
    const lookupResult = result as UserLookupResult;

    expect(lookupResult.found).toBe(3);
    expect(lookupResult.offset).toBe(2);
    expect(lookupResult.hasMore).toBe(true);
    expect(lookupResult.nextOffset).toBe(5);
    expect(lookupResult.users).toHaveLength(3);
    expect(lookupResult.users[0]?.profile).toHaveLength(600);
    expect(lookupResult.users[0]?.profile?.endsWith('…')).toBe(true);
  });
});
