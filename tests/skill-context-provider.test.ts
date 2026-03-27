import { describe, expect, it, vi } from 'vitest';

import { SkillContextRegistry, SkillContextScope } from '../src/skill/context-provider.js';
import type { SkillContextProvider } from '../src/skill/context-provider.js';

function createProvider(overrides: Partial<ReturnType<SkillContextProvider['getContext']> extends Promise<infer R> ? R : never> = {}): SkillContextProvider {
  return {
    getContext: async () => ({
      text: overrides.text ?? 'default context',
      onSuccess: overrides.onSuccess,
      onAbort: overrides.onAbort,
    }),
  };
}

describe('SkillContextScope.commit', () => {
  it('calls all onSuccess callbacks sequentially', async () => {
    const order: string[] = [];
    const providers = new Map<string, SkillContextProvider>([
      ['a', createProvider({ text: 'a', onSuccess: async () => { order.push('a'); } })],
      ['b', createProvider({ text: 'b', onSuccess: async () => { order.push('b'); } })],
    ]);
    const scope = new SkillContextScope(providers);

    await scope.getContext('a');
    await scope.getContext('b');
    await scope.commit();

    expect(order).toEqual(['a', 'b']);
  });

  it('does not call onAbort callbacks', async () => {
    const abortFn = vi.fn();
    const providers = new Map<string, SkillContextProvider>([
      ['s', createProvider({ text: 'ok', onSuccess: async () => {}, onAbort: abortFn })],
    ]);
    const scope = new SkillContextScope(providers);

    await scope.getContext('s');
    await scope.commit();

    expect(abortFn).not.toHaveBeenCalled();
  });

  it('clears callbacks after commit (second commit is no-op)', async () => {
    const successFn = vi.fn();
    const providers = new Map<string, SkillContextProvider>([
      ['s', createProvider({ text: 'ok', onSuccess: successFn })],
    ]);
    const scope = new SkillContextScope(providers);

    await scope.getContext('s');
    await scope.commit();
    await scope.commit();

    expect(successFn).toHaveBeenCalledTimes(1);
  });

  it('one callback failure does not prevent others from running', async () => {
    const order: string[] = [];
    const providers = new Map<string, SkillContextProvider>([
      ['a', createProvider({ text: 'a', onSuccess: async () => { order.push('a'); } })],
      ['b', createProvider({
        text: 'b',
        onSuccess: async () => { throw new Error('boom'); },
      })],
      ['c', createProvider({ text: 'c', onSuccess: async () => { order.push('c'); } })],
    ]);
    const scope = new SkillContextScope(providers);

    await scope.getContext('a');
    await scope.getContext('b');
    await scope.getContext('c');
    await scope.commit();

    expect(order).toEqual(['a', 'c']);
  });
});

describe('SkillContextScope.abort', () => {
  it('calls all onAbort callbacks sequentially', async () => {
    const order: string[] = [];
    const providers = new Map<string, SkillContextProvider>([
      ['a', createProvider({ text: 'a', onAbort: async () => { order.push('a'); } })],
      ['b', createProvider({ text: 'b', onAbort: async () => { order.push('b'); } })],
    ]);
    const scope = new SkillContextScope(providers);

    await scope.getContext('a');
    await scope.getContext('b');
    await scope.abort();

    expect(order).toEqual(['a', 'b']);
  });

  it('does not call onSuccess callbacks', async () => {
    const successFn = vi.fn();
    const providers = new Map<string, SkillContextProvider>([
      ['s', createProvider({ text: 'ok', onSuccess: successFn, onAbort: async () => {} })],
    ]);
    const scope = new SkillContextScope(providers);

    await scope.getContext('s');
    await scope.abort();

    expect(successFn).not.toHaveBeenCalled();
  });

  it('clears callbacks after abort (second abort is no-op)', async () => {
    const abortFn = vi.fn();
    const providers = new Map<string, SkillContextProvider>([
      ['s', createProvider({ text: 'ok', onAbort: abortFn })],
    ]);
    const scope = new SkillContextScope(providers);

    await scope.getContext('s');
    await scope.abort();
    await scope.abort();

    expect(abortFn).toHaveBeenCalledTimes(1);
  });

  it('one callback failure does not prevent others from running', async () => {
    const order: string[] = [];
    const providers = new Map<string, SkillContextProvider>([
      ['a', createProvider({ text: 'a', onAbort: async () => { order.push('a'); } })],
      ['b', createProvider({
        text: 'b',
        onAbort: async () => { throw new Error('boom'); },
      })],
      ['c', createProvider({ text: 'c', onAbort: async () => { order.push('c'); } })],
    ]);
    const scope = new SkillContextScope(providers);

    await scope.getContext('a');
    await scope.getContext('b');
    await scope.getContext('c');
    await scope.abort();

    expect(order).toEqual(['a', 'c']);
  });
});

describe('SkillContextScope.getContext', () => {
  it('returns null for unknown skill names', async () => {
    const scope = new SkillContextScope(new Map());
    const result = await scope.getContext('nonexistent');
    expect(result).toBeNull();
  });

  it('returns provider text and registers callbacks', async () => {
    const successFn = vi.fn();
    const abortFn = vi.fn();
    const providers = new Map<string, SkillContextProvider>([
      ['s', createProvider({ text: 'hello world', onSuccess: successFn, onAbort: abortFn })],
    ]);
    const scope = new SkillContextScope(providers);

    const result = await scope.getContext('s');

    expect(result).toBe('hello world');

    // Verify callbacks were registered by committing
    await scope.commit();
    expect(successFn).toHaveBeenCalledTimes(1);
    // onAbort should not be called on commit
    expect(abortFn).not.toHaveBeenCalled();
  });

  it('returns warning text when provider throws', async () => {
    const providers = new Map<string, SkillContextProvider>([
      ['broken', { getContext: async () => { throw new Error('provider error'); } }],
    ]);
    const scope = new SkillContextScope(providers);

    const result = await scope.getContext('broken');

    expect(result).toContain('[WARNING:');
    expect(result).toContain('broken');
  });
});

describe('SkillContextScope finalization', () => {
  it('returns warning from getContext after commit', async () => {
    const providers = new Map<string, SkillContextProvider>([
      ['s', createProvider({ text: 'data' })],
    ]);
    const scope = new SkillContextScope(providers);

    await scope.getContext('s');
    await scope.commit();
    const result = await scope.getContext('s');

    expect(result).toContain('[WARNING:');
    expect(result).toContain('finalized');
  });

  it('returns warning from getContext after abort', async () => {
    const providers = new Map<string, SkillContextProvider>([
      ['s', createProvider({ text: 'data' })],
    ]);
    const scope = new SkillContextScope(providers);

    await scope.getContext('s');
    await scope.abort();
    const result = await scope.getContext('s');

    expect(result).toContain('[WARNING:');
    expect(result).toContain('finalized');
  });
});

describe('SkillContextRegistry', () => {
  it('register + createScope + getContext flow', async () => {
    const registry = new SkillContextRegistry();
    registry.register('my-skill', createProvider({ text: 'dynamic data' }));

    const scope = registry.createScope();
    const result = await scope.getContext('my-skill');

    expect(result).toBe('dynamic data');
  });

  it('throws on duplicate registration', () => {
    const registry = new SkillContextRegistry();
    registry.register('dup', createProvider({ text: 'first' }));

    expect(() => registry.register('dup', createProvider({ text: 'second' })))
      .toThrow('Context provider already registered for skill "dup"');
  });
});
