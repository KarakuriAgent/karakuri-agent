import { splitMessageForDiscord } from '../utils/message-splitter.js';
import { createLogger } from '../utils/logger.js';
import type { IMessageSink } from './types.js';

const logger = createLogger('MessageSink');

const DISCORD_API_BASE_URL = 'https://discord.com/api/v10';
const MAX_RATE_LIMIT_RETRIES = 3;
const DEFAULT_RETRY_AFTER_MS = 1_000;
const MAX_RETRY_AFTER_MS = 15 * 60 * 1_000;

export interface DiscordMessageSinkOptions {
  botToken: string;
  allowedChannelIds: string[];
  reportChannelId?: string | undefined;
  apiBaseUrl?: string;
  fetchFn?: typeof fetch;
  sleep?: (durationMs: number) => Promise<void>;
}

export class DiscordMessageSink implements IMessageSink {
  private readonly allowedChannelIds: Set<string>;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (durationMs: number) => Promise<void>;
  private readonly apiBaseUrl: string;

  constructor({
    botToken,
    allowedChannelIds,
    reportChannelId,
    apiBaseUrl = DISCORD_API_BASE_URL,
    fetchFn = fetch,
    sleep = defaultSleep,
  }: DiscordMessageSinkOptions) {
    this.botToken = botToken;
    this.allowedChannelIds = new Set(allowedChannelIds);
    if (reportChannelId != null && reportChannelId.length > 0) {
      this.allowedChannelIds.add(reportChannelId);
    }
    this.apiBaseUrl = apiBaseUrl.replace(/\/$/, '');
    this.fetchFn = fetchFn;
    this.sleep = sleep;
  }

  private readonly botToken: string;

  async postMessage(channelId: string, text: string): Promise<void> {
    if (!this.allowedChannelIds.has(channelId)) {
      throw new Error(`Channel ${channelId} is not in the allowlist`);
    }

    const chunks = splitMessageForDiscord(text.trim());
    if (chunks.length === 0) {
      return;
    }

    for (const chunk of chunks) {
      await this.postChunk(channelId, chunk);
    }
  }

  private async postChunk(channelId: string, chunk: string): Promise<void> {
    const url = `${this.apiBaseUrl}/channels/${encodeURIComponent(channelId)}/messages`;

    for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
      const response = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          Authorization: `Bot ${this.botToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: chunk }),
      });

      if (response.status !== 429) {
        if (!response.ok) {
          throw new Error(`Discord API request failed: ${response.status} ${await safeReadText(response)}`.trim());
        }
        return;
      }

      if (attempt === MAX_RATE_LIMIT_RETRIES) {
        throw new Error('Discord API rate limit retries exhausted');
      }

      const retryAfterMs = await resolveRetryAfterMs(response);
      logger.warn('Discord API rate limited, retrying', { channelId, retryAfterMs, attempt: attempt + 1 });
      await this.sleep(retryAfterMs);
    }
  }
}

async function resolveRetryAfterMs(response: Response): Promise<number> {
  const headerValue = response.headers.get('retry-after');
  if (headerValue != null) {
    const numericDelayMs = parseRetryAfterHeader(headerValue);
    if (numericDelayMs != null) {
      return clampRetryAfterMs(numericDelayMs);
    }
  }

  try {
    const payload = await response.clone().json() as { retry_after?: number };
    if (typeof payload.retry_after === 'number' && Number.isFinite(payload.retry_after) && payload.retry_after >= 0) {
      return clampRetryAfterMs(Math.ceil(payload.retry_after * 1_000));
    }
  } catch {
    // Ignore JSON parse errors.
  }

  return DEFAULT_RETRY_AFTER_MS;
}

function parseRetryAfterHeader(value: string): number | null {
  const numericSeconds = Number.parseFloat(value);
  if (Number.isFinite(numericSeconds) && numericSeconds >= 0) {
    return Math.ceil(numericSeconds * 1_000);
  }

  const retryAtMs = Date.parse(value);
  if (Number.isNaN(retryAtMs)) {
    return null;
  }

  return Math.max(0, retryAtMs - Date.now());
}

function clampRetryAfterMs(durationMs: number): number {
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, durationMs));
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function defaultSleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}
