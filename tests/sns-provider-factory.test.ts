import { describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  xCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock('../src/sns/x.js', () => ({
  XProvider: vi.fn(function XProvider(this: unknown, config: Record<string, unknown>) {
    mockState.xCalls.push(config);
    return { kind: 'x' };
  }),
}));

import { createSnsProvider } from '../src/sns/index.js';

describe('createSnsProvider', () => {
  it('passes dataDir through to the X provider', () => {
    createSnsProvider({
      provider: 'x',
      accessToken: 'token',
      clientId: 'client-id',
      refreshToken: 'refresh-token',
      dataDir: '/example/data',
    });

    expect(mockState.xCalls).toEqual([expect.objectContaining({
      accessToken: 'token',
      clientId: 'client-id',
      refreshToken: 'refresh-token',
      dataDir: '/example/data',
    })]);
  });
});
