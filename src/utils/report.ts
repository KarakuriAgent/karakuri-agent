import type { IMessageSink } from '../scheduler/types.js';
import type { Logger } from './logger.js';

export async function reportSafely(
  messageSink: IMessageSink | null | undefined,
  reportChannelId: string | null | undefined,
  text: string,
  loggerInstance: Pick<Logger, 'error'>,
): Promise<void> {
  if (messageSink == null || reportChannelId == null) {
    return;
  }

  try {
    await messageSink.postMessage(reportChannelId, text);
  } catch (error) {
    loggerInstance.error('Failed to send report message', error);
  }
}
