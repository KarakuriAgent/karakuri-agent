import { describe, expect, it, vi } from 'vitest';

import { performGracefulShutdown } from '../src/shutdown.js';

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('performGracefulShutdown', () => {
  it('closes the scheduler in the first shutdown batch before closing stores', async () => {
    const events: string[] = [];
    const server = createDeferred();
    const scheduler = createDeferred();
    const bot = createDeferred();

    const shutdownPromise = performGracefulShutdown({
      closeServer: vi.fn(() => {
        events.push('close-server');
        return server.promise;
      }),
      closeScheduler: vi.fn(() => {
        events.push('close-scheduler');
        return scheduler.promise;
      }),
      shutdownBot: vi.fn(() => {
        events.push('shutdown-bot');
        return bot.promise;
      }),
      closeStores: vi.fn(() => {
        events.push('close-stores');
        return [Promise.resolve()];
      }),
    });

    await Promise.resolve();
    expect(events).toEqual(['close-server', 'close-scheduler', 'shutdown-bot']);

    scheduler.resolve();
    await Promise.resolve();
    expect(events).toEqual(['close-server', 'close-scheduler', 'shutdown-bot']);

    server.resolve();
    bot.resolve();
    await shutdownPromise;

    expect(events).toEqual(['close-server', 'close-scheduler', 'shutdown-bot', 'close-stores']);
  });
});
