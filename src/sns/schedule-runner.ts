import { formatError } from '../utils/error.js';
import { createLogger } from '../utils/logger.js';
import { getSnsActionLockKeys, runWithSnsActionLocks } from './action-locks.js';
import type { ActivityRecord, ISnsActivityStore, ISnsScheduleStore, ScheduledAction, SnsProvider } from './types.js';

const logger = createLogger('SnsScheduleRunner');
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_MAX_ACTIONS_PER_POLL = 5;
const DEFAULT_ACTION_SPACING_MS = 1_000;
const DEFAULT_EXECUTING_RECOVERY_DELAY_MS = 60_000;
const MAX_RECOVERY_AGE_MS = 10 * 60 * 1_000;

type SleepFn = (milliseconds: number) => Promise<void>;

export interface SnsScheduleRunnerOptions {
  scheduleStore: ISnsScheduleStore;
  activityStore: ISnsActivityStore;
  snsProvider: SnsProvider;
  pollIntervalMs?: number;
  maxActionsPerPoll?: number;
  actionSpacingMs?: number;
  executingRecoveryDelayMs?: number;
  reportError?: ((message: string) => void) | undefined;
  now?: () => Date;
  sleep?: SleepFn;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

export class SnsScheduleRunner {
  private readonly now: () => Date;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly pollIntervalMs: number;
  private readonly maxActionsPerPoll: number;
  private readonly actionSpacingMs: number;
  private readonly executingRecoveryDelayMs: number;
  private readonly reportError: ((message: string) => void) | undefined;
  private readonly sleep: SleepFn;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private started = false;
  private closed = false;

  constructor(private readonly options: SnsScheduleRunnerOptions) {
    this.now = options.now ?? (() => new Date());
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
    this.pollIntervalMs = Math.max(1, Math.floor(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS));
    this.maxActionsPerPoll = Math.max(1, Math.floor(options.maxActionsPerPoll ?? DEFAULT_MAX_ACTIONS_PER_POLL));
    this.actionSpacingMs = Math.max(0, Math.floor(options.actionSpacingMs ?? DEFAULT_ACTION_SPACING_MS));
    this.executingRecoveryDelayMs = Math.max(1, Math.floor(options.executingRecoveryDelayMs ?? DEFAULT_EXECUTING_RECOVERY_DELAY_MS));
    this.reportError = options.reportError;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => {
      this.setTimeoutFn(resolve, milliseconds);
    }));
  }

  start(): void {
    if (this.started || this.closed) {
      return;
    }

    this.started = true;
    const startup = this.runStartup();
    this.inFlight = startup;
    void startup.finally(() => {
      if (this.inFlight === startup) {
        this.inFlight = null;
      }
      if (!this.closed) {
        this.scheduleNext(0);
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer != null) {
      this.clearTimeoutFn(this.timer);
      this.timer = null;
    }
    await this.inFlight;
  }

  private scheduleNext(delayMs = this.pollIntervalMs): void {
    if (this.closed || this.timer != null) {
      return;
    }

    this.timer = this.setTimeoutFn(() => {
      this.timer = null;
      const poll = this.pollDueActions();
      this.inFlight = poll;
      void poll.finally(() => {
        if (this.inFlight === poll) {
          this.inFlight = null;
        }
        if (!this.closed) {
          this.scheduleNext();
        }
      });
    }, delayMs);
  }

  private async runStartup(): Promise<void> {
    try {
      const recovered = await this.options.scheduleStore.recoverStaleExecuting();
      if (recovered > 0) {
        logger.warn('Recovered stale scheduled SNS actions', { count: recovered });
      }
      await this.executeDueActions();
    } catch (error) {
      logger.error('Failed to initialize SNS schedule runner', error);
      this.reportError?.(`⚠️ Failed to initialize SNS schedule runner: ${formatError(error)}`);
    }
  }

  private async pollDueActions(): Promise<void> {
    try {
      await this.executeDueActions();
    } catch (error) {
      logger.error('SNS schedule poll failed', error);
      this.reportError?.(`⚠️ SNS scheduled action poll failed: ${formatError(error)}`);
    }
  }

  private async executeDueActions(): Promise<void> {
    const recovered = await this.options.scheduleStore.recoverStaleExecuting(
      new Date(this.now().getTime() - this.executingRecoveryDelayMs),
    );
    if (recovered > 0) {
      logger.warn('Recovered stale executing scheduled SNS actions during polling', { count: recovered });
    }
    const actions = await this.options.scheduleStore.claimPendingActions(this.now(), this.maxActionsPerPoll);
    for (const [index, action] of actions.entries()) {
      if (index > 0 && this.actionSpacingMs > 0) {
        await this.sleep(this.actionSpacingMs);
      }
      try {
        await this.executeAction(action);
      } catch (error) {
        logger.error('Unexpected error in executeAction wrapper', error, {
          actionId: action.id,
          actionType: action.actionType,
        });
      }
    }
  }

  private async executeAction(action: ScheduledAction): Promise<void> {
    await runWithSnsActionLocks(getSnsActionLockKeys(action), async () => {
      let remoteActionSucceeded = false;
      try {
        const duplicateReason = await this.getDuplicateReason(action);
        if (duplicateReason != null) {
          await this.options.scheduleStore.markFailed(action.id, duplicateReason);
          logger.info('Skipped scheduled SNS action because it was already completed elsewhere', {
            actionId: action.id,
            actionType: action.actionType,
            reason: duplicateReason,
          });
          return;
        }

        const recoveredRecord = await this.getRecoveredRecord(action);
        if (recoveredRecord != null) {
          await this.options.scheduleStore.completeWithRecord(action.id, recoveredRecord);
          logger.info('Recovered scheduled SNS action from remote state', {
            actionId: action.id,
            actionType: action.actionType,
          });
          return;
        }

        switch (action.actionType) {
          case 'post': {
            const executedAt = this.now();
            const result = await this.options.snsProvider.post({
              ...action.params,
              idempotencyKey: buildScheduledPostIdempotencyKey(action),
            });
            remoteActionSucceeded = true;
            await this.options.scheduleStore.completeWithRecord(action.id, {
              type: 'post',
              postId: result.id,
              text: action.params.text,
              ...(action.params.replyToId != null ? { replyToId: action.params.replyToId } : {}),
              ...(action.params.quotePostId != null ? { quotePostId: action.params.quotePostId } : {}),
              createdAt: parseCreatedAt(result.createdAt) ?? executedAt,
            });
            return;
          }
          case 'like': {
            const executedAt = this.now();
            await this.options.snsProvider.like(action.params.postId);
            remoteActionSucceeded = true;
            await this.options.scheduleStore.completeWithRecord(action.id, {
              type: 'like',
              postId: action.params.postId,
              createdAt: executedAt,
            });
            return;
          }
          case 'repost': {
            const executedAt = this.now();
            await this.options.snsProvider.repost(action.params.postId);
            remoteActionSucceeded = true;
            await this.options.scheduleStore.completeWithRecord(action.id, {
              type: 'repost',
              postId: action.params.postId,
              createdAt: executedAt,
            });
            return;
          }
        }
      } catch (error) {
        logger.error('Scheduled SNS action failed', error, { actionId: action.id, actionType: action.actionType });
        const recoveryReason = getRecoveryReason(action, error, remoteActionSucceeded, this.now());
        if (recoveryReason != null) {
          const reason = `Scheduled SNS action #${action.id} ${recoveryReason}: ${formatError(error)}`;
          logger.warn(reason, { actionId: action.id, actionType: action.actionType });
          this.reportError?.(`⚠️ ${reason}`);
          return;
        }
        try {
          await this.options.scheduleStore.markFailed(action.id, formatError(error));
        } catch (markFailedError) {
          logger.error('Failed to mark scheduled SNS action as failed', markFailedError, { actionId: action.id });
          this.reportError?.(`⚠️ Failed to persist scheduled SNS action failure for #${action.id}: ${formatError(markFailedError)}`);
        }
        this.reportError?.(`⚠️ Scheduled SNS action #${action.id} failed: ${formatError(error)}`);
      }
    });
  }

  private async getDuplicateReason(action: ScheduledAction): Promise<string | null> {
    switch (action.actionType) {
      case 'post': {
        if (action.params.replyToId != null && await this.options.activityStore.hasReplied(action.params.replyToId)) {
          return `already_replied:${action.params.replyToId}`;
        }
        if (action.params.quotePostId != null && await this.options.activityStore.hasQuoted(action.params.quotePostId)) {
          return `already_quoted:${action.params.quotePostId}`;
        }
        return null;
      }
      case 'like':
        return await this.options.activityStore.hasLiked(action.params.postId)
          ? `already_liked:${action.params.postId}`
          : null;
      case 'repost':
        return await this.options.activityStore.hasReposted(action.params.postId)
          ? `already_reposted:${action.params.postId}`
          : null;
    }
  }

  private async getRecoveredRecord(action: ScheduledAction): Promise<Exclude<ActivityRecord, { type: 'post' }> | null> {
    if (!action.recoveredFromExecuting) {
      return null;
    }

    switch (action.actionType) {
      case 'post':
        return null;
      case 'like': {
        const post = await this.options.snsProvider.getPost(action.params.postId);
        return post.liked === true
          ? {
              type: 'like',
              postId: action.params.postId,
              createdAt: this.now(),
            }
          : null;
      }
      case 'repost': {
        const post = await this.options.snsProvider.getPost(action.params.postId);
        return post.reposted === true
          ? {
              type: 'repost',
              postId: action.params.postId,
              createdAt: this.now(),
            }
          : null;
      }
    }
  }
}

function parseCreatedAt(value: string): Date | undefined {
  const createdAt = new Date(value);
  return Number.isNaN(createdAt.getTime()) ? undefined : createdAt;
}

function buildScheduledPostIdempotencyKey(action: Extract<ScheduledAction, { actionType: 'post' }>): string {
  return `sns-scheduled-post:${action.id}`;
}

function getRecoveryReason(action: ScheduledAction, error: unknown, remoteActionSucceeded: boolean, now: Date): string | null {
  if (remoteActionSucceeded) {
    return 'completed remotely but local persistence failed and will stay executing for recovery';
  }
  const age = now.getTime() - action.scheduledAt.getTime();
  if (age > MAX_RECOVERY_AGE_MS) {
    return null;
  }
  if (action.recoveredFromExecuting && shouldRetryRecoveredAction(action, error)) {
    return 'hit a transient recovery check failure and will stay executing for retry';
  }
  return shouldRetryAfterRecovery(action, error)
    ? 'hit an ambiguous post failure and will stay executing for crash-safe recovery'
    : null;
}

function shouldRetryAfterRecovery(action: ScheduledAction, error: unknown): boolean {
  if (action.actionType !== 'post' || !(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return error.name === 'AbortError'
    || error.name === 'TimeoutError'
    || message.includes('timeout')
    || message.includes('fetch failed')
    || message.includes('network');
}

function shouldRetryRecoveredAction(action: ScheduledAction, error: unknown): boolean {
  if ((action.actionType !== 'like' && action.actionType !== 'repost') || !(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return error.name === 'AbortError'
    || error.name === 'TimeoutError'
    || message.includes('timeout')
    || message.includes('fetch failed')
    || message.includes('network')
    || message.includes('5xx')
    || message.includes('503')
    || message.includes('502')
    || message.includes('500');
}
