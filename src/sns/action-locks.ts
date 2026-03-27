import type { ScheduledAction } from './types.js';
import { KeyedMutex } from '../utils/mutex.js';

// Module-level singleton so that both SnsScheduleRunner and sns_* tool handlers
// share the same lock space, preventing concurrent duplicate actions across
// immediate tool execution and scheduled execution.
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

export function getSnsActionLockKeys(action: ScheduledAction): string[] {
  switch (action.actionType) {
    case 'post':
      // Plain posts (no reply/quote) intentionally have no lock keys because
      // there is no resource to protect against duplicate interaction.
      return [
        action.params.replyToId != null ? buildReplyLockKey(action.params.replyToId) : '',
        action.params.quotePostId != null ? buildQuoteLockKey(action.params.quotePostId) : '',
      ];
    case 'like':
      return [buildLikeLockKey(action.params.postId)];
    case 'repost':
      return [buildRepostLockKey(action.params.postId)];
  }
}
