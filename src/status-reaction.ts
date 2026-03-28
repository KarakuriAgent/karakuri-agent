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

  constructor(
    private readonly adapter: ReactionAdapter,
    private readonly threadId: string,
    private readonly messageId: string,
    private readonly doneDisplayMs = DONE_REACTION_DURATION_MS,
    private readonly debounceMs = DEBOUNCE_MS,
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
    if (this.terminalStatus === 'done' || this.terminalStatus === 'error') {
      return;
    }

    this.terminalStatus = 'done';
    this.cancelDoneTimer();
    this.cancelDebounce();
    this.desiredEmoji = STATUS_EMOJI.done;
    this.triggerReconcile();
  }

  error(): void {
    if (this.terminalStatus === 'error') {
      return;
    }

    this.terminalStatus = 'error';
    this.cancelDoneTimer();
    this.cancelDebounce();
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

      if (tasks.length === 0) {
        return;
      }

      await Promise.all(tasks);
    }
  }

  private setDesiredEmoji(emoji: string): void {
    if (this.terminalStatus != null || this.desiredEmoji === emoji) {
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
