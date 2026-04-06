/**
 * Shared persistence mutex that serializes memory writes across the maintenance
 * pipeline and post-response evaluators. Maintenance holds this lock for the
 * entire read → LLM → overwrite cycle; evaluators acquire it only for the
 * append/write apply stage.
 */
import { KeyedMutex } from '../utils/mutex.js';

const mutex = new KeyedMutex();

export function runExclusiveMemoryPersistence<T>(task: () => Promise<T>): Promise<T> {
  return mutex.runExclusive('memory-persistence', task);
}
