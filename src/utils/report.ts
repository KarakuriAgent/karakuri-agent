import type { IMessageSink } from '../scheduler/types.js';
import type { Logger } from './logger.js';

export interface ReportSafelyOptions {
  suppressDiscordMentions?: boolean | undefined;
}

export async function reportSafely(
  messageSink: IMessageSink | null | undefined,
  reportChannelId: string | null | undefined,
  text: string,
  loggerInstance: Pick<Logger, 'error'>,
  options?: ReportSafelyOptions,
): Promise<void> {
  if (messageSink == null || reportChannelId == null) {
    return;
  }

  try {
    await messageSink.postMessage(
      reportChannelId,
      options?.suppressDiscordMentions === false ? text : suppressDiscordMentions(text),
    );
  } catch (error) {
    loggerInstance.error('Failed to send report message', error);
  }
}

function suppressDiscordMentions(text: string): string {
  return text
    .replace(/@(everyone|here)\b/gu, '@\u200b$1')
    .replace(/<@([!&]?\d+)>/gu, '<@\u200b$1>')
    .replace(/<#(\d+)>/gu, '<#\u200b$1>');
}
