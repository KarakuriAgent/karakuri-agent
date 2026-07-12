import { createLogger } from './utils/logger.js';

const logger = createLogger('StatusReaction');

export const STATUS_EMOJI = {
  queued: '👀',
  thinking: '💭',
  memory: '📝',
  web: '🔍',
  skill: '📖',
  message: '📣',
  scheduler: '⏰',
  done: '✅',
  error: '❌',
} as const;

export const DONE_REACTION_DURATION_MS = 2_000;
export const DEBOUNCE_MS = 700;
export const TERMINAL_RECONCILE_MAX_RETRIES = 3;
/** terminal リコンサイル再試行の基準待ち時間（回数に比例して伸ばす — 429 への配慮） */
export const TERMINAL_RETRY_BASE_DELAY_MS = 1_000;

export interface ReactionAdapter {
  addReaction(threadId: string, messageId: string, emoji: string): Promise<void>;
  removeReaction(threadId: string, messageId: string, emoji: string): Promise<void>;
}

export interface StatusReactionControllerOptions {
  adapter: ReactionAdapter;
  threadId: string;
  messageId: string;
  doneDisplayMs?: number;
}

type TerminalStatus = 'done' | 'error' | null;

export function resolveToolEmoji(toolName: string): string | null {
  if (toolName.startsWith('karakuri_world_')) {
    return STATUS_EMOJI.skill;
  }

  switch (toolName) {
    case 'recallDiary':
    case 'userLookup':
      return STATUS_EMOJI.memory;
    case 'webFetch':
    case 'webSearch':
      return STATUS_EMOJI.web;
    case 'loadSkill':
      return STATUS_EMOJI.skill;
    case 'postMessage':
      return STATUS_EMOJI.message;
    case 'manageCron':
      return STATUS_EMOJI.scheduler;
    default:
      return null;
  }
}

export class StatusReactionController {
  private appliedEmoji: string | null = null;
  private desiredEmoji: string | null = null;
  private reconcilePromise: Promise<void> | null = null;
  private terminalStatus: TerminalStatus = null;
  private terminalRetryCount = 0;
  private doneTimer: ReturnType<typeof setTimeout> | null = null;
  private doneTimerPromise: Promise<void> | null = null;
  private resolveDoneTimer: (() => void) | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private debouncePromise: Promise<void> | null = null;
  private resolveDebounce: (() => void) | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryPromise: Promise<void> | null = null;
  private resolveRetry: (() => void) | null = null;

  constructor(
    private readonly adapter: ReactionAdapter,
    private readonly threadId: string,
    private readonly messageId: string,
    private readonly doneDisplayMs = DONE_REACTION_DURATION_MS,
    private readonly debounceMs = DEBOUNCE_MS,
    /**
     * false で全操作を no-op にする（#104）。KW の高頻度 system turn では
     * 進行状態を見る人間がいない一方、ターンごとのリアクション付け外しが
     * Discord のレート制限（429）と恒常的に衝突するため無効化する
     */
    private readonly enabled = true,
  ) {}

  setQueued(): void {
    this.setDesiredEmoji(STATUS_EMOJI.queued);
  }

  setThinking(): void {
    this.setDesiredEmoji(STATUS_EMOJI.thinking);
  }

  setTool(toolName: string): void {
    const emoji = resolveToolEmoji(toolName);
    if (emoji == null) {
      return;
    }

    this.setDesiredEmoji(emoji);
  }

  done(): void {
    if (!this.enabled || this.terminalStatus === 'done' || this.terminalStatus === 'error') {
      return;
    }

    this.terminalStatus = 'done';
    this.cancelDoneTimer();
    this.cancelDebounce();
    this.cancelRetryTimer();
    this.desiredEmoji = STATUS_EMOJI.done;
    this.triggerReconcile();
  }

  error(): void {
    if (!this.enabled || this.terminalStatus === 'error') {
      return;
    }

    this.terminalStatus = 'error';
    this.cancelDoneTimer();
    this.cancelDebounce();
    this.cancelRetryTimer();
    this.desiredEmoji = STATUS_EMOJI.error;
    this.triggerReconcile();
  }

  async waitForCompletion(): Promise<void> {
    while (true) {
      const tasks: Promise<void>[] = [];
      if (this.reconcilePromise != null) {
        tasks.push(this.reconcilePromise);
      }
      if (this.doneTimerPromise != null) {
        tasks.push(this.doneTimerPromise);
      }
      if (this.debouncePromise != null) {
        tasks.push(this.debouncePromise);
      }
      if (this.retryPromise != null) {
        tasks.push(this.retryPromise);
      }

      if (tasks.length === 0) {
        return;
      }

      await Promise.all(tasks);
    }
  }

  private setDesiredEmoji(emoji: string): void {
    if (!this.enabled || this.terminalStatus != null || this.desiredEmoji === emoji) {
      return;
    }

    this.desiredEmoji = emoji;
    this.scheduleReconcile();
  }

  private scheduleReconcile(): void {
    this.cancelDebounce();

    if (this.appliedEmoji == null && this.reconcilePromise == null) {
      this.triggerReconcile();
      return;
    }

    this.debouncePromise = new Promise<void>((resolve) => {
      this.resolveDebounce = resolve;
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        this.debouncePromise = null;
        this.resolveDebounce = null;
        this.triggerReconcile();
        resolve();
      }, this.debounceMs);
    });
  }

  private cancelDebounce(): void {
    if (this.debounceTimer == null) {
      return;
    }

    clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    this.debouncePromise = null;
    const resolveDebounce = this.resolveDebounce;
    this.resolveDebounce = null;
    resolveDebounce?.();
  }

  private triggerReconcile(): void {
    if (this.reconcilePromise != null) {
      return;
    }

    this.cancelDebounce();
    this.reconcilePromise = this.reconcile()
      .catch((error) => {
        logger.error('Unexpected status reaction reconcile failure', error, {
          messageId: this.messageId,
          threadId: this.threadId,
        });
      })
      .finally(() => {
        this.reconcilePromise = null;
        if (this.desiredEmoji !== this.appliedEmoji) {
          if (this.terminalStatus != null) {
            this.terminalRetryCount += 1;
            if (this.terminalRetryCount > TERMINAL_RECONCILE_MAX_RETRIES) {
              logger.error('Terminal status reaction reconcile exceeded max retries, giving up', undefined, {
                messageId: this.messageId,
                threadId: this.threadId,
                terminalStatus: this.terminalStatus,
              });
              this.desiredEmoji = this.appliedEmoji;
              return;
            }
            // 即時再試行はレート制限（429）を叩き続けるため、回数比例で間を空ける
            this.startTerminalRetryDelay(this.terminalRetryCount * TERMINAL_RETRY_BASE_DELAY_MS);
            return;
          }
          this.triggerReconcile();
        } else {
          this.terminalRetryCount = 0;
        }
      });
  }

  private async reconcile(): Promise<void> {
    while (this.desiredEmoji !== this.appliedEmoji) {
      if (this.appliedEmoji != null) {
        const previousEmoji = this.appliedEmoji;
        const desiredEmojiBeforeRemove = this.desiredEmoji;
        try {
          await this.adapter.removeReaction(this.threadId, this.messageId, previousEmoji);
        } catch (error) {
          logger.error('Failed to remove status reaction', error, {
            emoji: previousEmoji,
            messageId: this.messageId,
            threadId: this.threadId,
          });
          if (this.terminalStatus == null) {
            this.restoreAppliedStateIfDesiredUnchanged(desiredEmojiBeforeRemove);
          }
          return;
        }

        this.appliedEmoji = null;
        continue;
      }

      if (this.desiredEmoji != null) {
        const nextEmoji = this.desiredEmoji;
        try {
          await this.adapter.addReaction(this.threadId, this.messageId, nextEmoji);
        } catch (error) {
          logger.error('Failed to add status reaction', error, {
            emoji: nextEmoji,
            messageId: this.messageId,
            threadId: this.threadId,
          });
          if (this.terminalStatus == null) {
            this.restoreAppliedStateIfDesiredUnchanged(nextEmoji);
          }
          return;
        }

        this.appliedEmoji = nextEmoji;
        if (this.terminalStatus === 'done' && nextEmoji === STATUS_EMOJI.done) {
          this.startDoneTimer();
        }
      }
    }
  }

  private restoreAppliedStateIfDesiredUnchanged(expectedDesiredEmoji: string | null): void {
    if (this.desiredEmoji === expectedDesiredEmoji) {
      this.desiredEmoji = this.appliedEmoji;
    }
  }

  private startTerminalRetryDelay(delayMs: number): void {
    // 旧タイマーの取り残し（早すぎる再試行・waitForCompletion の取りこぼし）を防ぐ
    this.cancelRetryTimer();
    this.retryPromise = new Promise<void>((resolve) => {
      this.resolveRetry = resolve;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.retryPromise = null;
        this.resolveRetry = null;
        this.triggerReconcile();
        resolve();
      }, delayMs);
    });
  }

  private cancelRetryTimer(): void {
    if (this.retryTimer == null) {
      return;
    }

    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryPromise = null;
    const resolveRetry = this.resolveRetry;
    this.resolveRetry = null;
    resolveRetry?.();
  }

  private startDoneTimer(): void {
    this.doneTimerPromise = new Promise<void>((resolve) => {
      this.resolveDoneTimer = resolve;
      this.doneTimer = setTimeout(() => {
        this.doneTimer = null;
        this.doneTimerPromise = null;
        this.resolveDoneTimer = null;
        this.desiredEmoji = null;
        this.triggerReconcile();
        resolve();
      }, this.doneDisplayMs);
    });
  }

  private cancelDoneTimer(): void {
    if (this.doneTimer == null) {
      return;
    }

    clearTimeout(this.doneTimer);
    this.doneTimer = null;
    this.doneTimerPromise = null;
    const resolveDoneTimer = this.resolveDoneTimer;
    this.resolveDoneTimer = null;
    resolveDoneTimer?.();
  }
}
