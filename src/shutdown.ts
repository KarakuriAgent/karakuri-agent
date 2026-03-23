export interface ShutdownBatch {
  closeServer: () => Promise<void>;
  shutdownBot: () => Promise<void>;
  closeScheduler: () => Promise<void>;
  drainEvaluations?: () => Promise<void>;
  closeStores: () => Promise<void>[];
}

export async function performGracefulShutdown({
  closeServer,
  shutdownBot,
  closeScheduler,
  drainEvaluations,
  closeStores,
}: ShutdownBatch): Promise<PromiseSettledResult<void>[]> {
  const firstBatchResults = await Promise.allSettled([
    closeServer(),
    closeScheduler(),
    shutdownBot(),
  ]);
  const evaluationResults = drainEvaluations != null
    ? await Promise.allSettled([drainEvaluations()])
    : [];
  const storeResults = await Promise.allSettled(closeStores());
  return [...firstBatchResults, ...evaluationResults, ...storeResults];
}
