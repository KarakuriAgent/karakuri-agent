import { resolve } from 'node:path';

import { config as loadDotEnv } from 'dotenv';
import { ZodError, z } from 'zod';

import { createLogger } from './utils/logger.js';

const logger = createLogger('Config');

const configSchema = z.object({
  discordApplicationId: z.string().trim().min(1, 'DISCORD_APPLICATION_ID is required'),
  discordBotToken: z.string().trim().min(1, 'DISCORD_BOT_TOKEN is required'),
  discordPublicKey: z.string().trim().min(1, 'DISCORD_PUBLIC_KEY is required'),
  openaiApiKey: z.string().trim().min(1, 'OPENAI_API_KEY is required'),
  braveApiKey: z.string().trim().min(1).optional(),
  dataDir: z.string().trim().default('./data'),
  timezone: z.string().trim().default('Asia/Tokyo'),
  openaiModel: z.string().trim().default('gpt-4o'),
  maxSteps: z.coerce.number().int().positive().default(10),
  tokenBudget: z.coerce.number().int().positive().default(8_000),
  port: z.coerce.number().int().min(1).max(65_535).default(3_000),
  heartbeatIntervalMinutes: z.coerce.number().positive().default(30),
  allowedChannelIds: z.string().optional(),
  reportChannelId: z.string().trim().min(1).optional(),
  adminUserIds: z.string().optional(),
});

export interface Config {
  discordApplicationId: string;
  discordBotToken: string;
  discordPublicKey: string;
  openaiApiKey: string;
  braveApiKey?: string | undefined;
  dataDir: string;
  timezone: string;
  openaiModel: string;
  maxSteps: number;
  tokenBudget: number;
  port: number;
  heartbeatIntervalMinutes?: number | undefined;
  postMessageChannelIds?: string[] | undefined;
  allowedChannelIds?: string[] | undefined;
  reportChannelId?: string | undefined;
  adminUserIds?: string[] | undefined;
}

function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error(`Invalid TIMEZONE: ${timezone}`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  loadDotEnv({ quiet: true });

  const rawConfig = {
    discordApplicationId: env.DISCORD_APPLICATION_ID,
    discordBotToken: env.DISCORD_BOT_TOKEN ?? env.DISCORD_TOKEN,
    discordPublicKey: env.DISCORD_PUBLIC_KEY,
    openaiApiKey: env.OPENAI_API_KEY,
    braveApiKey: env.BRAVE_API_KEY || undefined,
    dataDir: env.DATA_DIR,
    timezone: env.TIMEZONE,
    openaiModel: env.OPENAI_MODEL ?? env.AGENT_MODEL,
    maxSteps: env.MAX_STEPS ?? env.AGENT_MAX_STEPS,
    tokenBudget: env.TOKEN_BUDGET ?? env.AGENT_TOKEN_BUDGET,
    port: env.PORT,
    heartbeatIntervalMinutes: env.HEARTBEAT_INTERVAL_MINUTES,
    allowedChannelIds: env.ALLOWED_CHANNEL_IDS,
    reportChannelId: normalizeOptionalString(env.REPORT_CHANNEL_ID),
    adminUserIds: env.ADMIN_USER_IDS,
  };

  try {
    const parsed = configSchema.parse(rawConfig);
    assertValidTimezone(parsed.timezone);

    const postMessageChannelIds = parseIdList(parsed.allowedChannelIds);
    const reportChannelId = normalizeOptionalString(parsed.reportChannelId);
    const mergedAllowedChannelIds = reportChannelId != null
      ? [...new Set([...(postMessageChannelIds ?? []), reportChannelId])]
      : postMessageChannelIds;
    const config = {
      ...parsed,
      dataDir: resolve(parsed.dataDir),
      postMessageChannelIds,
      allowedChannelIds: mergedAllowedChannelIds,
      reportChannelId,
      adminUserIds: parseIdList(parsed.adminUserIds),
    };
    logger.debug('Config parsed', {
      dataDir: config.dataDir,
      timezone: config.timezone,
      model: config.openaiModel,
      port: config.port,
      heartbeatIntervalMinutes: config.heartbeatIntervalMinutes,
      hasAllowedChannels: (config.postMessageChannelIds?.length ?? 0) > 0,
      hasAdminUsers: (config.adminUserIds?.length ?? 0) > 0,
      hasReportChannel: config.reportChannelId != null,
    });
    return config;
  } catch (error) {
    if (error instanceof ZodError) {
      const message = error.issues.map((issue) => issue.message).join('; ');
      throw new Error(`Invalid configuration: ${message}`);
    }

    throw error;
  }
}

function parseIdList(value: string | undefined): string[] | undefined {
  if (value == null) {
    return undefined;
  }

  const parsed = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return parsed.length > 0 ? parsed : undefined;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized != null && normalized.length > 0 ? normalized : undefined;
}
