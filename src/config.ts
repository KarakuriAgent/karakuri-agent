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
  appraisalLlmApiKey: z.string().trim().optional(),
  appraisalLlmBaseUrl: z.string().trim().optional(),
  appraisalLlmModel: z.string().trim().optional(),
  reflectionLlmApiKey: z.string().trim().optional(),
  reflectionLlmBaseUrl: z.string().trim().optional(),
  reflectionLlmModel: z.string().trim().optional(),
  braveApiKey: z.string().trim().min(1).optional(),
  karakuriWorldApiBaseUrl: z.string().trim().min(1).optional(),
  karakuriWorldApiKey: z.string().trim().min(1).optional(),
  mastodonInstanceUrl: z.string().trim().min(1).optional(),
  mastodonAccessToken: z.string().trim().min(1).optional(),
  xAccessToken: z.string().trim().min(1).optional(),
  xClientId: z.string().trim().min(1).optional(),
  xClientSecret: z.string().trim().min(1).optional(),
  xRefreshToken: z.string().trim().min(1).optional(),
  xApiKey: z.string().trim().min(1).optional(),
  xApiSecret: z.string().trim().min(1).optional(),
  xAccessTokenSecret: z.string().trim().min(1).optional(),
  elythApiKey: z.string().trim().min(1).optional(),
  elythApiBase: z.string().trim().min(1).optional(),
  snsLegacyDbMigrateTo: z.enum(['mastodon', 'x', 'elyth', 'skip']).optional(),
  dataDir: z.string().trim().default('./data'),
  timezone: z.string().trim().default('Asia/Tokyo'),
  maxSteps: z.coerce.number().int().positive().default(10),
  tokenBudget: z.coerce.number().int().positive().default(80_000),
  port: z.coerce.number().int().min(1).max(65_535).default(3_000),
  heartbeatIntervalMinutes: z.coerce.number().positive().default(120),
  memoryMaintenanceIntervalMinutes: z.coerce.number().positive().optional(),
  memoryMaintenanceRecentDiaryDays: z.coerce.number().int().positive().optional(),
  snsLoopMinIntervalMinutes: z.coerce.number().positive().default(60),
  snsLoopMaxIntervalMinutes: z.coerce.number().positive().default(180),
  allowedChannelIds: z.string().optional(),
  reportChannelId: z.string().trim().min(1).optional(),
  adminUserIds: z.string().optional(),
  karakuriWorldBotIds: z.string().optional(),
  llmEnableThinking: z.string().trim().optional(),
  kwPerceptionBufferEnabled: z.string().trim().optional(),
  loopWarningEnabled: z.string().trim().optional(),
  loopDetectorThreshold: z.coerce.number().int().min(2).default(3),
  appraisalEnabled: z.string().trim().optional(),
  innerStateInjectionEnabled: z.string().trim().optional(),
  embeddingModel: z.string().trim().optional(),
  embeddingApiKey: z.string().trim().optional(),
  embeddingBaseUrl: z.string().trim().optional(),
  embeddingDimensions: z.coerce.number().int().positive().default(1_536),
  recallInjectionEnabled: z.string().trim().optional(),
  reflectionEnabled: z.string().trim().optional(),
  selfImageInjectionEnabled: z.string().trim().optional(),
  drivesInjectionEnabled: z.string().trim().optional(),
  prospectsInjectionEnabled: z.string().trim().optional(),
});

export interface ApiCredentials {
  apiBaseUrl: string;
  apiKey: string;
}

export type SnsCredentials =
  | { provider: 'mastodon'; instanceUrl: string; accessToken: string }
  | {
      provider: 'x';
      accessToken: string;
      clientId?: string | undefined;
      clientSecret?: string | undefined;
      refreshToken?: string | undefined;
      apiKey?: string | undefined;
      apiSecret?: string | undefined;
      accessTokenSecret?: string | undefined;
    }
  | { provider: 'elyth'; apiKey: string; apiBase: string };

export type SnsProviderType = SnsCredentials['provider'];

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
  /** M2: appraisal 役割のモデル指定（未指定は既定モデルへフォールバック。軽量モデルを既定の想定とする） */
  appraisalLlmApiKey?: string | undefined;
  appraisalLlmBaseUrl?: string | undefined;
  appraisalLlmModel?: string | undefined;
  appraisalLlmModelSelector?: LlmModelSelector | undefined;
  /** M4: 省察役割のモデル指定（信念・自己像という長く残るものを書くため品質優先。未指定は既定へ） */
  reflectionLlmApiKey?: string | undefined;
  reflectionLlmBaseUrl?: string | undefined;
  reflectionLlmModel?: string | undefined;
  reflectionLlmModelSelector?: LlmModelSelector | undefined;
  braveApiKey?: string | undefined;
  karakuriWorld?: ApiCredentials | undefined;
  snsList?: SnsCredentials[] | undefined;
  /** @deprecated Use snsList. Kept only for legacy test fixtures; loadConfig no longer sets it. */
  sns?: SnsCredentials | undefined;
  snsLegacyDbMigrateTo?: SnsProviderType | 'skip' | undefined;
  dataDir: string;
  timezone: string;
  maxSteps: number;
  tokenBudget: number;
  port: number;
  heartbeatIntervalMinutes?: number | undefined;
  memoryMaintenanceIntervalMinutes?: number | undefined;
  memoryMaintenanceRecentDiaryDays?: number | undefined;
  snsLoopMinIntervalMinutes: number;
  snsLoopMaxIntervalMinutes: number;
  postMessageChannelIds?: string[] | undefined;
  allowedChannelIds?: string[] | undefined;
  reportChannelId?: string | undefined;
  adminUserIds?: string[] | undefined;
  karakuriWorldBotIds?: string[] | undefined;
  llmEnableThinking: boolean;
  /** M1: 行動選択用通知をセッション履歴に積まず Perception Buffer で扱う（切り分け・ロールバック用） */
  kwPerceptionBufferEnabled: boolean;
  /** M1: ループ警告の trusted 注入（切り分け・ロールバック用） */
  loopWarningEnabled: boolean;
  /** M1: 同一行動 × 同一対象の連続回数がこの値以上で警告を注入する */
  loopDetectorThreshold: number;
  /** M2: appraisal（統合判定）の有効化（切り分け・ロールバック用） */
  appraisalEnabled: boolean;
  /** M2: 内部状態の自然言語注入の有効化（切り分け・ロールバック用） */
  innerStateInjectionEnabled: boolean;
  /** M3: 埋め込みモデル（OpenAI 互換で差し替え可能。未設定なら FTS のみで想起） */
  embeddingModel?: string | undefined;
  embeddingApiKey?: string | undefined;
  embeddingBaseUrl?: string | undefined;
  embeddingDimensions: number;
  /** M3: 自動想起のプロンプト注入の有効化（切り分け・ロールバック用） */
  recallInjectionEnabled: boolean;
  /** M4: 省察エンジン（日次/週次/月次）の有効化 */
  reflectionEnabled: boolean;
  /** M4: 自己像（self beliefs）の自己語り注入の有効化 */
  selfImageInjectionEnabled: boolean;
  /** M5: 欲求・飽き圧注入の有効化 */
  drivesInjectionEnabled: boolean;
  /** M5: 展望記憶（約束・予定・目標）注入の有効化 */
  prospectsInjectionEnabled: boolean;
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
    appraisalLlmApiKey: env.LLM_APPRAISAL_API_KEY,
    appraisalLlmBaseUrl: env.LLM_APPRAISAL_BASE_URL,
    appraisalLlmModel: env.LLM_APPRAISAL_MODEL,
    reflectionLlmApiKey: env.LLM_REFLECTION_API_KEY,
    reflectionLlmBaseUrl: env.LLM_REFLECTION_BASE_URL,
    reflectionLlmModel: env.LLM_REFLECTION_MODEL,
    braveApiKey: env.BRAVE_API_KEY || undefined,
    karakuriWorldApiBaseUrl: normalizeOptionalString(env.KARAKURI_WORLD_API_BASE_URL),
    karakuriWorldApiKey: normalizeOptionalString(env.KARAKURI_WORLD_API_KEY),
    mastodonInstanceUrl: normalizeOptionalString(env.MASTODON_INSTANCE_URL),
    mastodonAccessToken: normalizeOptionalString(env.MASTODON_ACCESS_TOKEN),
    xAccessToken: normalizeOptionalString(env.X_ACCESS_TOKEN),
    xClientId: normalizeOptionalString(env.X_CLIENT_ID),
    xClientSecret: normalizeOptionalString(env.X_CLIENT_SECRET),
    xRefreshToken: normalizeOptionalString(env.X_REFRESH_TOKEN),
    xApiKey: normalizeOptionalString(env.X_API_KEY),
    xApiSecret: normalizeOptionalString(env.X_API_SECRET),
    xAccessTokenSecret: normalizeOptionalString(env.X_ACCESS_TOKEN_SECRET),
    elythApiKey: normalizeOptionalString(env.ELYTH_API_KEY),
    elythApiBase: normalizeOptionalString(env.ELYTH_API_BASE),
    snsLegacyDbMigrateTo: normalizeOptionalString(env.SNS_LEGACY_DB_MIGRATE_TO),
    dataDir: env.DATA_DIR,
    timezone: env.TIMEZONE,
    maxSteps: env.MAX_STEPS ?? env.AGENT_MAX_STEPS,
    tokenBudget: env.TOKEN_BUDGET ?? env.AGENT_TOKEN_BUDGET,
    port: env.PORT,
    heartbeatIntervalMinutes: env.HEARTBEAT_INTERVAL_MINUTES,
    memoryMaintenanceIntervalMinutes: normalizeOptionalString(env.MEMORY_MAINTENANCE_INTERVAL_MINUTES),
    memoryMaintenanceRecentDiaryDays: normalizeOptionalString(env.MEMORY_MAINTENANCE_RECENT_DIARY_DAYS),
    snsLoopMinIntervalMinutes: env.SNS_LOOP_MIN_INTERVAL_MINUTES,
    snsLoopMaxIntervalMinutes: env.SNS_LOOP_MAX_INTERVAL_MINUTES,
    allowedChannelIds: env.ALLOWED_CHANNEL_IDS,
    reportChannelId: normalizeOptionalString(env.REPORT_CHANNEL_ID),
    adminUserIds: env.ADMIN_USER_IDS,
    karakuriWorldBotIds: env.KARAKURI_WORLD_BOT_IDS,
    llmEnableThinking: env.LLM_ENABLE_THINKING,
    kwPerceptionBufferEnabled: env.KW_PERCEPTION_BUFFER_ENABLED,
    loopWarningEnabled: env.LOOP_WARNING_ENABLED,
    loopDetectorThreshold: env.LOOP_DETECTOR_THRESHOLD,
    appraisalEnabled: env.APPRAISAL_ENABLED,
    innerStateInjectionEnabled: env.INNER_STATE_INJECTION_ENABLED,
    embeddingModel: normalizeOptionalString(env.EMBEDDING_MODEL),
    embeddingApiKey: normalizeOptionalString(env.EMBEDDING_API_KEY),
    embeddingBaseUrl: normalizeOptionalString(env.EMBEDDING_BASE_URL),
    embeddingDimensions: env.EMBEDDING_DIMENSIONS,
    recallInjectionEnabled: env.RECALL_INJECTION_ENABLED,
    reflectionEnabled: env.REFLECTION_ENABLED,
    selfImageInjectionEnabled: env.SELF_IMAGE_INJECTION_ENABLED,
    drivesInjectionEnabled: env.DRIVES_INJECTION_ENABLED,
    prospectsInjectionEnabled: env.PROSPECTS_INJECTION_ENABLED,
  };

  try {
    const parsed = configSchema.parse(rawConfig);
    assertValidTimezone(parsed.timezone);
    const llmBaseUrl = normalizeBaseUrl(parsed.llmBaseUrl);
    const postResponseLlmBaseUrl = normalizeBaseUrl(parsed.postResponseLlmBaseUrl, 'POST_RESPONSE_LLM_BASE_URL');
    const karakuriWorldApiBaseUrl = normalizeKarakuriWorldApiBaseUrl(parsed.karakuriWorldApiBaseUrl);
    const karakuriWorldApiKey = normalizeOptionalString(parsed.karakuriWorldApiKey);
    const mastodonInstanceUrl = normalizeBaseUrl(parsed.mastodonInstanceUrl, 'MASTODON_INSTANCE_URL');
    const mastodonAccessToken = normalizeOptionalString(parsed.mastodonAccessToken);
    const xAccessToken = normalizeOptionalString(parsed.xAccessToken);
    const xClientId = normalizeOptionalString(parsed.xClientId);
    const xClientSecret = normalizeOptionalString(parsed.xClientSecret);
    const xRefreshToken = normalizeOptionalString(parsed.xRefreshToken);
    const xApiKey = normalizeOptionalString(parsed.xApiKey);
    const xApiSecret = normalizeOptionalString(parsed.xApiSecret);
    const xAccessTokenSecret = normalizeOptionalString(parsed.xAccessTokenSecret);
    const elythApiKey = normalizeOptionalString(parsed.elythApiKey);
    const elythApiBaseRaw = normalizeOptionalString(parsed.elythApiBase);

    const llmModelSelector = parseModelSelector(parsed.llmModel);
    const postResponseLlmModel = normalizeOptionalString(parsed.postResponseLlmModel);
    const postResponseLlmModelSelector = postResponseLlmModel != null
      ? parseModelSelector(postResponseLlmModel)
      : undefined;
    const appraisalLlmModel = normalizeOptionalString(parsed.appraisalLlmModel);
    const appraisalLlmModelSelector = appraisalLlmModel != null
      ? parseModelSelector(appraisalLlmModel)
      : undefined;
    const appraisalLlmBaseUrl = normalizeBaseUrl(parsed.appraisalLlmBaseUrl, 'LLM_APPRAISAL_BASE_URL');
    const reflectionLlmModel = normalizeOptionalString(parsed.reflectionLlmModel);
    const reflectionLlmModelSelector = reflectionLlmModel != null
      ? parseModelSelector(reflectionLlmModel)
      : undefined;
    const reflectionLlmBaseUrl = normalizeBaseUrl(parsed.reflectionLlmBaseUrl, 'LLM_REFLECTION_BASE_URL');
    const postMessageChannelIds = parseIdList(parsed.allowedChannelIds);
    const reportChannelId = normalizeOptionalString(parsed.reportChannelId);
    const mergedAllowedChannelIds = reportChannelId != null
      ? [...new Set([...(postMessageChannelIds ?? []), reportChannelId])]
      : postMessageChannelIds;
    if (parsed.snsLoopMinIntervalMinutes > parsed.snsLoopMaxIntervalMinutes) {
      throw new Error('SNS_LOOP_MIN_INTERVAL_MINUTES must be less than or equal to SNS_LOOP_MAX_INTERVAL_MINUTES');
    }
    if ((karakuriWorldApiBaseUrl != null) !== (karakuriWorldApiKey != null)) {
      throw new Error(
        'Partial karakuri-world configuration: both KARAKURI_WORLD_API_BASE_URL and KARAKURI_WORLD_API_KEY must be set. '
        + `Currently set: ${karakuriWorldApiBaseUrl != null ? 'KARAKURI_WORLD_API_BASE_URL' : 'KARAKURI_WORLD_API_KEY'}`,
      );
    }
    const karakuriWorld = karakuriWorldApiBaseUrl != null && karakuriWorldApiKey != null
      ? { apiBaseUrl: karakuriWorldApiBaseUrl, apiKey: karakuriWorldApiKey }
      : undefined;
    const karakuriWorldBotIds = parseIdList(parsed.karakuriWorldBotIds);
    if (karakuriWorld != null && (karakuriWorldBotIds == null || karakuriWorldBotIds.length === 0)) {
      logger.warn(
        'KARAKURI_WORLD_API_BASE_URL and KARAKURI_WORLD_API_KEY are set, but KARAKURI_WORLD_BOT_IDS is empty. '
        + 'KW mode will not activate for any user.',
      );
    }
    if (karakuriWorldBotIds != null && karakuriWorldBotIds.length > 0 && karakuriWorld == null) {
      logger.warn(
        'KARAKURI_WORLD_BOT_IDS is set, but KARAKURI_WORLD_API_BASE_URL / KARAKURI_WORLD_API_KEY are not configured. '
        + 'KW mode will not activate.',
      );
    }
    const snsList: SnsCredentials[] = [];
    const hasMastodonConfig = mastodonInstanceUrl != null || mastodonAccessToken != null;
    if (hasMastodonConfig) {
      if (mastodonInstanceUrl == null || mastodonAccessToken == null) {
        throw new Error('Partial Mastodon configuration: both MASTODON_INSTANCE_URL and MASTODON_ACCESS_TOKEN must be set.');
      }
      snsList.push({ provider: 'mastodon', instanceUrl: mastodonInstanceUrl, accessToken: mastodonAccessToken });
    }

    const xFields = [xAccessToken, xClientId, xClientSecret, xRefreshToken, xApiKey, xApiSecret, xAccessTokenSecret];
    const hasXConfig = xFields.some((value) => value != null);
    if (hasXConfig) {
      if (xAccessToken == null) {
        throw new Error('Partial X configuration: X_ACCESS_TOKEN must be set when any X_* SNS setting is set.');
      }
      const oauth1SetCount = [xApiKey, xApiSecret, xAccessTokenSecret].filter((v) => v != null).length;
      if (oauth1SetCount > 0 && oauth1SetCount < 3) {
        logger.warn(
          'Partial X OAuth 1.0a configuration: all of X_API_KEY, X_API_SECRET, and X_ACCESS_TOKEN_SECRET must be set together. '
          + 'Falling back to bearer token mode.',
        );
      }
      if (xClientId != null && xRefreshToken == null) {
        logger.warn('X_CLIENT_ID is set but X_REFRESH_TOKEN is missing; OAuth2 token refresh will not work.');
      }
      snsList.push({
        provider: 'x',
        accessToken: xAccessToken,
        ...(xClientId != null ? { clientId: xClientId } : {}),
        ...(xClientSecret != null ? { clientSecret: xClientSecret } : {}),
        ...(xRefreshToken != null ? { refreshToken: xRefreshToken } : {}),
        ...(xApiKey != null ? { apiKey: xApiKey } : {}),
        ...(xApiSecret != null ? { apiSecret: xApiSecret } : {}),
        ...(xAccessTokenSecret != null ? { accessTokenSecret: xAccessTokenSecret } : {}),
      });
    }

    const elythApiBase = normalizeBaseUrl(elythApiBaseRaw, 'ELYTH_API_BASE');
    const hasElythConfig = elythApiKey != null || elythApiBase != null;
    if (hasElythConfig) {
      if (elythApiKey == null || elythApiBase == null) {
        throw new Error('Partial ELYTH configuration: both ELYTH_API_KEY and ELYTH_API_BASE must be set.');
      }
      snsList.push({ provider: 'elyth', apiKey: elythApiKey, apiBase: elythApiBase });
    }

    const config = {
      ...parsed,
      llmBaseUrl,
      llmModel: llmModelSelector.selector,
      llmModelSelector,
      postResponseLlmApiKey: normalizeOptionalString(parsed.postResponseLlmApiKey),
      postResponseLlmBaseUrl,
      postResponseLlmModel,
      postResponseLlmModelSelector,
      appraisalLlmApiKey: normalizeOptionalString(parsed.appraisalLlmApiKey),
      appraisalLlmBaseUrl,
      appraisalLlmModel,
      appraisalLlmModelSelector,
      reflectionLlmApiKey: normalizeOptionalString(parsed.reflectionLlmApiKey),
      reflectionLlmBaseUrl,
      reflectionLlmModel,
      reflectionLlmModelSelector,
      dataDir: resolve(parsed.dataDir),
      postMessageChannelIds,
      allowedChannelIds: mergedAllowedChannelIds,
      reportChannelId,
      adminUserIds: parseIdList(parsed.adminUserIds),
      karakuriWorldBotIds,
      ...(karakuriWorld != null ? { karakuriWorld } : {}),
      snsList,
      ...(parsed.snsLegacyDbMigrateTo != null ? { snsLegacyDbMigrateTo: parsed.snsLegacyDbMigrateTo } : {}),
      llmEnableThinking: parseBooleanEnv(parsed.llmEnableThinking, 'LLM_ENABLE_THINKING', true),
      kwPerceptionBufferEnabled: parseBooleanEnv(parsed.kwPerceptionBufferEnabled, 'KW_PERCEPTION_BUFFER_ENABLED', true),
      loopWarningEnabled: parseBooleanEnv(parsed.loopWarningEnabled, 'LOOP_WARNING_ENABLED', true),
      appraisalEnabled: parseBooleanEnv(parsed.appraisalEnabled, 'APPRAISAL_ENABLED', true),
      innerStateInjectionEnabled: parseBooleanEnv(parsed.innerStateInjectionEnabled, 'INNER_STATE_INJECTION_ENABLED', true),
      embeddingModel: normalizeOptionalString(parsed.embeddingModel),
      embeddingApiKey: normalizeOptionalString(parsed.embeddingApiKey),
      embeddingBaseUrl: normalizeBaseUrl(parsed.embeddingBaseUrl, 'EMBEDDING_BASE_URL'),
      recallInjectionEnabled: parseBooleanEnv(parsed.recallInjectionEnabled, 'RECALL_INJECTION_ENABLED', true),
      reflectionEnabled: parseBooleanEnv(parsed.reflectionEnabled, 'REFLECTION_ENABLED', true),
      selfImageInjectionEnabled: parseBooleanEnv(parsed.selfImageInjectionEnabled, 'SELF_IMAGE_INJECTION_ENABLED', true),
      drivesInjectionEnabled: parseBooleanEnv(parsed.drivesInjectionEnabled, 'DRIVES_INJECTION_ENABLED', true),
      prospectsInjectionEnabled: parseBooleanEnv(parsed.prospectsInjectionEnabled, 'PROSPECTS_INJECTION_ENABLED', true),
    };
    logger.debug('Config parsed', {
      dataDir: config.dataDir,
      timezone: config.timezone,
      model: config.llmModel,
      llmProvider: config.llmModelSelector.provider,
      llmApi: config.llmModelSelector.api,
      hasPostResponseModel: config.postResponseLlmModelSelector != null,
      hasKarakuriWorld: config.karakuriWorld != null,
      snsProviders: config.snsList.map((sns) => sns.provider),
      port: config.port,
      heartbeatIntervalMinutes: config.heartbeatIntervalMinutes,
      memoryMaintenanceIntervalMinutes: config.memoryMaintenanceIntervalMinutes,
      memoryMaintenanceRecentDiaryDays: config.memoryMaintenanceRecentDiaryDays,
      hasAllowedChannels: (config.postMessageChannelIds?.length ?? 0) > 0,
      hasAdminUsers: (config.adminUserIds?.length ?? 0) > 0,
      hasKarakuriWorldBots: (config.karakuriWorldBotIds?.length ?? 0) > 0,
      hasReportChannel: config.reportChannelId != null,
      llmEnableThinking: config.llmEnableThinking,
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

function normalizeKarakuriWorldApiBaseUrl(value: string | undefined): string | undefined {
  const baseUrl = normalizeBaseUrl(value, 'KARAKURI_WORLD_API_BASE_URL');
  if (baseUrl == null) {
    return undefined;
  }

  const url = new URL(baseUrl);
  const pathname = url.pathname.replace(/\/+$/, '');
  if (pathname === '/api' || pathname.endsWith('/api')) {
    return baseUrl;
  }

  return `${baseUrl}/api`;
}

function parseBooleanEnv(value: string | undefined, label: string, defaultValue: boolean): boolean {
  if (value == null || value.trim().length === 0) return defaultValue;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes'].includes(normalized)) return true;
  if (['false', '0', 'no'].includes(normalized)) return false;
  throw new Error(`Invalid ${label} value: "${value}" (expected true/false/1/0/yes/no)`);
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
