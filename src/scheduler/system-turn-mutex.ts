import { KeyedMutex } from '../utils/mutex.js';

// Serializes all system-initiated agent turns (heartbeat ticks and cron jobs).
// Prevents concurrent agent.handleMessage calls from system sources, which could
// corrupt shared session state or produce incoherent outputs.
const mutex = new KeyedMutex();

export function runExclusiveSystemTurn<T>(task: () => Promise<T>): Promise<T> {
  return mutex.runExclusive('system-turn', task);
}
