import { describe, expect, it } from 'vitest';

import { KeyedMutex } from '../src/utils/mutex.js';

describe('KeyedMutex', () => {
  it('serializes tasks on the same key', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];

    await Promise.all([
      mutex.runExclusive('key', async () => {
        order.push('start:A');
        await new Promise((r) => setTimeout(r, 50));
        order.push('end:A');
      }),
      mutex.runExclusive('key', async () => {
        order.push('start:B');
        await new Promise((r) => setTimeout(r, 10));
        order.push('end:B');
      }),
    ]);

    expect(order).toEqual(['start:A', 'end:A', 'start:B', 'end:B']);
  });

  it('allows concurrent tasks on different keys', async () => {
    const mutex = new KeyedMutex();
    const order: string[] = [];

    await Promise.all([
      mutex.runExclusive('key-1', async () => {
        order.push('start:A');
        await new Promise((r) => setTimeout(r, 50));
        order.push('end:A');
      }),
      mutex.runExclusive('key-2', async () => {
        order.push('start:B');
        await new Promise((r) => setTimeout(r, 50));
        order.push('end:B');
      }),
    ]);

    expect(order[0]).toBe('start:A');
    expect(order[1]).toBe('start:B');
  });

  it('propagates errors without blocking subsequent tasks', async () => {
    const mutex = new KeyedMutex();

    await expect(
      mutex.runExclusive('key', async () => {
        throw new Error('fail');
      }),
    ).rejects.toThrow('fail');

    const result = await mutex.runExclusive('key', () => 'ok');
    expect(result).toBe('ok');
  });

  it('cleans up the key after the last queued task completes', async () => {
    const mutex = new KeyedMutex();

    await mutex.runExclusive('key', () => 'done');

    // Internal map should not leak entries
    expect((mutex as unknown as { tails: Map<string, unknown> }).tails.size).toBe(0);
  });
});
