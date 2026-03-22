export interface ShutdownBatch {
  closeServer: () => Promise<void>;
  shutdownBot: () => Promise<void>;
  closeScheduler: () => Promise<void>;
  closeStores: () => Promise<void>[];
}

export async function performGracefulShutdown({
  closeServer,
  shutdownBot,
  closeScheduler,
  closeStores,
}: ShutdownBatch): Promise<PromiseSettledResult<void>[]> {
  const firstBatchResults = await Promise.allSettled([
    closeServer(),
    closeScheduler(),
    shutdownBot(),
  ]);
  const storeResults = await Promise.allSettled(closeStores());
  return [...firstBatchResults, ...storeResults];
}
