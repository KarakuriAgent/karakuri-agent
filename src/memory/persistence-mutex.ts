/**
 * Shared persistence mutex that serializes memory writes across the maintenance
 * pipeline and post-response evaluators. Maintenance holds this lock for the
 * entire read → LLM → overwrite cycle; evaluators acquire it only for the
 * append/write apply stage.
 */
import { createLogger } from '../utils/logger.js';
import { KeyedMutex } from '../utils/mutex.js';

const logger = createLogger('MemoryPersistenceMutex');
const mutex = new KeyedMutex();
const WARN_WAIT_MS = 500;

export function runExclusiveMemoryPersistence<T>(task: () => Promise<T>): Promise<T> {
  const requestedAt = Date.now();
  return mutex.runExclusive('memory-persistence', async () => {
    const waitMs = Date.now() - requestedAt;
    const details = { memory_persistence_lock_wait_ms: waitMs };
    if (waitMs > WARN_WAIT_MS) {
      logger.warn('Memory persistence lock wait exceeded threshold', details);
    } else {
      logger.debug('Memory persistence lock acquired', details);
    }
    return task();
  });
}
