import type { IMessageSink } from '../scheduler/types.js';
import { formatError } from '../utils/error.js';
import { createLogger } from '../utils/logger.js';
import { reportSafely } from '../utils/report.js';
import type { IExperienceLogStore, NormalizedEvent } from './types.js';

const logger = createLogger('ExperienceRecorder');

export interface ExperienceRecorderOptions {
  store: IExperienceLogStore;
  messageSink?: IMessageSink | undefined;
  reportChannelId?: string | undefined;
}

/**
 * 体験ログへの記録窓口。記録は同期パスをブロックせず、失敗してもチャネル処理を
 * 止めない（fire-and-forget）。ただし一次資料の欠落 = 体験の永久喪失なので、
 * 失敗はエラーログに加えて report 経路（REPORT_CHANNEL_ID）へ通知する。
 */
export class ExperienceRecorder {
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly options: ExperienceRecorderOptions) {}

  record(event: NormalizedEvent): void {
    let task: Promise<void>;
    try {
      task = this.options.store.append(event).then(
        () => undefined,
        (error: unknown) => this.handleFailure(event, error),
      );
    } catch (error) {
      // store.append が同期的に throw しても呼び出し元へ伝播させない
      void this.handleFailure(event, error);
      return;
    }

    this.pending.add(task);
    void task.finally(() => {
      this.pending.delete(task);
    });
  }

  /** graceful shutdown 用。進行中の書き込みを待つ */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  private async handleFailure(event: NormalizedEvent, error: unknown): Promise<void> {
    logger.error('Failed to append experience log entry', error, {
      channel: event.channel,
      kind: event.kind,
    });
    await reportSafely(
      this.options.messageSink,
      this.options.reportChannelId,
      `❌ 体験ログの記録に失敗しました (channel: ${event.channel}, kind: ${event.kind})\n${formatError(error)}`,
      logger,
    );
  }
}
