import type { SnsProviderType } from './types.js';
import { KeyedMutex } from '../utils/mutex.js';

const actionMutex = new KeyedMutex();


export function buildReplyLockKey(replyToId: string): string;
export function buildReplyLockKey(provider: SnsProviderType, replyToId: string): string;
export function buildReplyLockKey(providerOrId: SnsProviderType | string, replyToId?: string): string {
  return replyToId == null ? `reply:${providerOrId}` : `${providerOrId}:reply:${replyToId}`;
}

export function buildQuoteLockKey(quotePostId: string): string;
export function buildQuoteLockKey(provider: SnsProviderType, quotePostId: string): string;
export function buildQuoteLockKey(providerOrId: SnsProviderType | string, quotePostId?: string): string {
  return quotePostId == null ? `quote:${providerOrId}` : `${providerOrId}:quote:${quotePostId}`;
}

export function buildLikeLockKey(postId: string): string;
export function buildLikeLockKey(provider: SnsProviderType, postId: string): string;
export function buildLikeLockKey(providerOrId: SnsProviderType | string, postId?: string): string {
  return postId == null ? `like:${providerOrId}` : `${providerOrId}:like:${postId}`;
}

export function buildRepostLockKey(postId: string): string;
export function buildRepostLockKey(provider: SnsProviderType, postId: string): string;
export function buildRepostLockKey(providerOrId: SnsProviderType | string, postId?: string): string {
  return postId == null ? `repost:${providerOrId}` : `${providerOrId}:repost:${postId}`;
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
