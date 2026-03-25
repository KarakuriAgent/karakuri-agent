import { resolve } from 'node:path';

import { config as loadDotEnv } from 'dotenv';
import { ZodError, z } from 'zod';

import {
  DEFAULT_LLM_MODEL,
  parseModelSelector,
  type LlmModelSelector,
} from './llm/model-selector.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('Config');

const configSchema = z.object({
  discordApplicationId: z.string().trim().min(1, 'DISCORD_APPLICATION_ID is required'),
  discordBotToken: z.string().trim().min(1, 'DISCORD_BOT_TOKEN is required'),
  discordPublicKey: z.string().trim().min(1, 'DISCORD_PUBLIC_KEY is required'),
  llmApiKey: z.string({
    required_error: 'LLM_API_KEY is required (OPENAI_API_KEY is also accepted)',
    invalid_type_error: 'LLM_API_KEY is required (OPENAI_API_KEY is also accepted)',
  }).trim().min(1, 'LLM_API_KEY is required (OPENAI_API_KEY is also accepted)'),
  llmBaseUrl: z.string().trim().optional(),
  llmModel: z.string().trim().default(DEFAULT_LLM_MODEL),
  postResponseLlmApiKey: z.string().trim().optional(),
  postResponseLlmBaseUrl: z.string().trim().optional(),
  postResponseLlmModel: z.string().trim().optional(),
  braveApiKey: z.string().trim().min(1).optional(),
  karakuriWorldApiBaseUrl: z.string().trim().min(1).optional(),
  karakuriWorldApiKey: z.string().trim().min(1).optional(),
  snsProvider: z.enum(['mastodon']).optional(),
  snsInstanceUrl: z.string().trim().min(1).optional(),
  snsAccessToken: z.string().trim().min(1).optional(),
  dataDir: z.string().trim().default('./data'),
  timezone: z.string().trim().default('Asia/Tokyo'),
  maxSteps: z.coerce.number().int().positive().default(10),
  tokenBudget: z.coerce.number().int().positive().default(8_000),
  port: z.coerce.number().int().min(1).max(65_535).default(3_000),
  heartbeatIntervalMinutes: z.coerce.number().positive().default(30),
  allowedChannelIds: z.string().optional(),
  reportChannelId: z.string().trim().min(1).optional(),
  adminUserIds: z.string().optional(),
});

export interface ApiCredentials {
  apiBaseUrl: string;
  apiKey: string;
}

export type SnsProviderType = 'mastodon';

export interface SnsCredentials {
  provider: SnsProviderType;
  instanceUrl: string;
  accessToken: string;
}

export interface Config {
  discordApplicationId: string;
  discordBotToken: string;
  discordPublicKey: string;
  llmApiKey: string;
  llmBaseUrl?: string | undefined;
  llmModel: string;
  llmModelSelector: LlmModelSelector;
  postResponseLlmApiKey?: string | undefined;
  postResponseLlmBaseUrl?: string | undefined;
  postResponseLlmModel?: string | undefined;
  postResponseLlmModelSelector?: LlmModelSelector | undefined;
  braveApiKey?: string | undefined;
  karakuriWorld?: ApiCredentials | undefined;
  sns?: SnsCredentials | undefined;
  dataDir: string;
  timezone: string;
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
    llmApiKey: resolveEnvAliases(env.LLM_API_KEY, env.OPENAI_API_KEY),
    llmBaseUrl: resolveEnvAliases(env.LLM_BASE_URL, env.OPENAI_BASE_URL),
    llmModel: resolveEnvAliases(env.LLM_MODEL, env.OPENAI_MODEL, env.AGENT_MODEL),
    postResponseLlmApiKey: env.POST_RESPONSE_LLM_API_KEY,
    postResponseLlmBaseUrl: env.POST_RESPONSE_LLM_BASE_URL,
    postResponseLlmModel: env.POST_RESPONSE_LLM_MODEL,
    braveApiKey: env.BRAVE_API_KEY || undefined,
    karakuriWorldApiBaseUrl: normalizeOptionalString(env.KARAKURI_WORLD_API_BASE_URL),
    karakuriWorldApiKey: normalizeOptionalString(env.KARAKURI_WORLD_API_KEY),
    snsProvider: normalizeOptionalString(env.SNS_PROVIDER),
    snsInstanceUrl: normalizeOptionalString(env.SNS_INSTANCE_URL),
    snsAccessToken: normalizeOptionalString(env.SNS_ACCESS_TOKEN),
    dataDir: env.DATA_DIR,
    timezone: env.TIMEZONE,
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
    const llmBaseUrl = normalizeBaseUrl(parsed.llmBaseUrl);
    const postResponseLlmBaseUrl = normalizeBaseUrl(parsed.postResponseLlmBaseUrl, 'POST_RESPONSE_LLM_BASE_URL');
    const karakuriWorldApiBaseUrl = normalizeBaseUrl(parsed.karakuriWorldApiBaseUrl, 'KARAKURI_WORLD_API_BASE_URL');
    const karakuriWorldApiKey = normalizeOptionalString(parsed.karakuriWorldApiKey);
    const snsInstanceUrl = normalizeBaseUrl(parsed.snsInstanceUrl, 'SNS_INSTANCE_URL');
    const snsAccessToken = normalizeOptionalString(parsed.snsAccessToken);

    const llmModelSelector = parseModelSelector(parsed.llmModel);
    const postResponseLlmModel = normalizeOptionalString(parsed.postResponseLlmModel);
    const postResponseLlmModelSelector = postResponseLlmModel != null
      ? parseModelSelector(postResponseLlmModel)
      : undefined;
    const postMessageChannelIds = parseIdList(parsed.allowedChannelIds);
    const reportChannelId = normalizeOptionalString(parsed.reportChannelId);
    const mergedAllowedChannelIds = reportChannelId != null
      ? [...new Set([...(postMessageChannelIds ?? []), reportChannelId])]
      : postMessageChannelIds;
    if ((karakuriWorldApiBaseUrl != null) !== (karakuriWorldApiKey != null)) {
      throw new Error(
        'Partial karakuri-world configuration: both KARAKURI_WORLD_API_BASE_URL and KARAKURI_WORLD_API_KEY must be set. '
        + `Currently set: ${karakuriWorldApiBaseUrl != null ? 'KARAKURI_WORLD_API_BASE_URL' : 'KARAKURI_WORLD_API_KEY'}`,
      );
    }
    const karakuriWorld = karakuriWorldApiBaseUrl != null && karakuriWorldApiKey != null
      ? { apiBaseUrl: karakuriWorldApiBaseUrl, apiKey: karakuriWorldApiKey }
      : undefined;
    const snsFields = [parsed.snsProvider, snsInstanceUrl, snsAccessToken];
    const snsSetCount = snsFields.filter((value) => value != null).length;
    if (snsSetCount > 0 && snsSetCount < 3) {
      throw new Error(
        'Partial SNS configuration: all of SNS_PROVIDER, SNS_INSTANCE_URL, and SNS_ACCESS_TOKEN must be set.',
      );
    }
    const sns = parsed.snsProvider != null && snsInstanceUrl != null && snsAccessToken != null
      ? {
          provider: parsed.snsProvider,
          instanceUrl: snsInstanceUrl,
          accessToken: snsAccessToken,
        }
      : undefined;
    const config = {
      ...parsed,
      llmBaseUrl,
      llmModel: llmModelSelector.selector,
      llmModelSelector,
      postResponseLlmApiKey: normalizeOptionalString(parsed.postResponseLlmApiKey),
      postResponseLlmBaseUrl,
      postResponseLlmModel,
      postResponseLlmModelSelector,
      dataDir: resolve(parsed.dataDir),
      postMessageChannelIds,
      allowedChannelIds: mergedAllowedChannelIds,
      reportChannelId,
      adminUserIds: parseIdList(parsed.adminUserIds),
      ...(karakuriWorld != null ? { karakuriWorld } : {}),
      ...(sns != null ? { sns } : {}),
    };
    logger.debug('Config parsed', {
      dataDir: config.dataDir,
      timezone: config.timezone,
      model: config.llmModel,
      llmProvider: config.llmModelSelector.provider,
      llmApi: config.llmModelSelector.api,
      hasPostResponseModel: config.postResponseLlmModelSelector != null,
      hasKarakuriWorld: config.karakuriWorld != null,
      hasSns: config.sns != null,
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

function normalizeBaseUrl(value: string | undefined, label = 'LLM_BASE_URL'): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (normalized == null) {
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${label} must use http or https`);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error(`${label} must not include credentials`);
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new Error(`${label} must not include query parameters or fragments`);
  }

  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function resolveEnvAliases(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const normalized = normalizeOptionalString(value);
    if (normalized != null) {
      return normalized;
    }
  }

  return undefined;
}
