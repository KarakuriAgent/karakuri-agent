import { KeyedMutex } from '../utils/mutex.js';

const actionMutex = new KeyedMutex();

export function buildReplyLockKey(replyToId: string): string {
  return `reply:${replyToId}`;
}

export function buildQuoteLockKey(quotePostId: string): string {
  return `quote:${quotePostId}`;
}

export function buildLikeLockKey(postId: string): string {
  return `like:${postId}`;
}

export function buildRepostLockKey(postId: string): string {
  return `repost:${postId}`;
}

export async function runWithSnsActionLocks<T>(keys: string[], task: () => Promise<T>): Promise<T> {
  const uniqueKeys = [...new Set(keys.filter((key) => key.length > 0))].sort();

  const execute = async (index: number): Promise<T> => {
    if (index >= uniqueKeys.length) {
      return task();
    }

    return actionMutex.runExclusive(uniqueKeys[index]!, () => execute(index + 1));
  };

  return execute(0);
}
