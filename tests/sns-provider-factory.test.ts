import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  xCalls: [] as Array<Record<string, unknown>>,
  elythCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock('../src/sns/x.js', () => ({
  XProvider: vi.fn(function XProvider(this: unknown, config: Record<string, unknown>) {
    mockState.xCalls.push(config);
    return { kind: 'x' };
  }),
}));

vi.mock('../src/sns/elyth.js', () => ({
  ElythProvider: vi.fn(function ElythProvider(this: unknown, config: Record<string, unknown>) {
    mockState.elythCalls.push(config);
    return { kind: 'elyth' };
  }),
}));

import { createSnsProvider } from '../src/sns/index.js';

describe('createSnsProvider', () => {
  beforeEach(() => {
    mockState.xCalls.length = 0;
    mockState.elythCalls.length = 0;
  });

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

  it('creates ELYTH providers and passes injectable options through', () => {
    const fetchMock = vi.fn();
    const provider = createSnsProvider({
      provider: 'elyth',
      apiKey: 'elyth-key',
      apiBase: 'https://elythworld.com',
      fetch: fetchMock,
    });

    expect(provider).toEqual({ kind: 'elyth' });
    expect(mockState.elythCalls).toEqual([expect.objectContaining({
      apiKey: 'elyth-key',
      apiBase: 'https://elythworld.com',
      fetch: fetchMock,
    })]);
  });

  it('throws for unknown providers at runtime', () => {
    expect(() => createSnsProvider({ provider: 'unknown' } as never)).toThrow('Unknown SNS provider: unknown');
  });
});
