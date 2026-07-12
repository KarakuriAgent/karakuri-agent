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
  kwCommandCheckPhone: z.string().trim().min(1).optional(),
  kwCommandBrowseSns: z.string().trim().min(1).optional(),
  kwCommandPostSns: z.string().trim().min(1).optional(),
  snsRateLimitPostPerHour: z.coerce.number().int().min(0).default(3),
  snsRateLimitPostPerDay: z.coerce.number().int().min(0).default(20),
  snsRateLimitPostMinIntervalMinutes: z.coerce.number().min(0).default(15),
  snsRateLimitReplyPerHour: z.coerce.number().int().min(0).default(10),
  snsRateLimitLikePerHour: z.coerce.number().int().min(0).default(30),
  snsRateLimitRepostPerHour: z.coerce.number().int().min(0).default(10),
  snsFetchMinIntervalNotificationsMinutes: z.coerce.number().min(0).default(10),
  snsFetchMinIntervalTimelineMinutes: z.coerce.number().min(0).default(30),
  snsFetchMinIntervalTrendsMinutes: z.coerce.number().min(0).default(60),
  allowedChannelIds: z.string().optional(),
  reportChannelId: z.string().trim().min(1).optional(),
  adminUserIds: z.string().optional(),
  karakuriWorldBotIds: z.string().optional(),
  agentSelfNames: z.string().optional(),
  llmEnableThinking: z.string().trim().optional(),
  llmDisableThinkingRequestParam: z.string().trim().optional(),
  kwPerceptionBufferEnabled: z.string().trim().optional(),
  loopWarningEnabled: z.string().trim().optional(),
  loopDetectorThreshold: z.coerce.number().int().min(2).default(3),
  repetitiveToolCallRecoveryEnabled: z.string().trim().optional(),
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

/** M8: 書き込み系 SNS アクションの決定論レート制限（0 は「そのアクションを行わない」） */
export interface SnsWriteRateLimits {
  postPerHour: number;
  postPerDay: number;
  /** 同種アクションの最小間隔（ウィンドウ境界バースト防止） */
  postMinIntervalMinutes: number;
  replyPerHour: number;
  likePerHour: number;
  repostPerHour: number;
}

/** M8: 読み取り系フェッチの最小間隔（API 保護。間隔内はキャッシュ返却） */
export interface SnsFetchIntervals {
  notificationsMinutes: number;
  timelineMinutes: number;
  trendsMinutes: number;
}

export interface SnsRateLimitConfig {
  /** 共通既定（SNS_RATE_LIMIT_*） */
  defaults: SnsWriteRateLimits;
  /** provider 別上書き（X_RATE_LIMIT_* / MASTODON_RATE_LIMIT_* / ELYTH_RATE_LIMIT_*） */
  perProvider: Partial<Record<SnsProviderType, Partial<SnsWriteRateLimits>>>;
  fetchIntervals: SnsFetchIntervals;
}

export function resolveWriteRateLimits(config: SnsRateLimitConfig, provider: SnsProviderType): SnsWriteRateLimits {
  return { ...config.defaults, ...config.perProvider[provider] };
}

/**
 * M8: KW カスタムコマンド名 → 世界内行為ハンドラのマッピング。
 * KW コンソール側で登録した command 名を指定する。設定されたものだけ有効。
 */
export interface WorldActionCommands {
  checkPhone?: string | undefined;
  browseSns?: string | undefined;
  postSns?: string | undefined;
}

export interface Config {
  discordApplicationId: string;
  discordBotToken: string;
  discordPublicKey: string;
  llmApiKey: string;
  llmBaseUrl?: string | undefined;
  llmModel: string;
  llmModelSelector: LlmModelSelector;
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
  /** M8: KW カスタムコマンド統合（設定されたコマンドだけ有効。checkPhone 設定でチャット未読キュー化が有効になる） */
  worldActionCommands: WorldActionCommands;
  /** M8: SNS 書き込み・読み取りの決定論レート制限 */
  snsRateLimits: SnsRateLimitConfig;
  postMessageChannelIds?: string[] | undefined;
  allowedChannelIds?: string[] | undefined;
  reportChannelId?: string | undefined;
  adminUserIds?: string[] | undefined;
  karakuriWorldBotIds?: string[] | undefined;
  /** 自己を指す別名（エージェント名など）。relations の自己 ID 正規化に使う（#106） */
  agentSelfNames?: string[] | undefined;
  llmEnableThinking: boolean;
  /** OpenAI 互換サーバー固有の `enable_thinking: false` リクエストパラメータを送る */
  llmDisableThinkingRequestParam: boolean;
  /** M1: 行動選択用通知をセッション履歴に積まず Perception Buffer で扱う（切り分け・ロールバック用） */
  kwPerceptionBufferEnabled: boolean;
  /** M1: ループ警告の trusted 注入（切り分け・ロールバック用） */
  loopWarningEnabled: boolean;
  /** M1: 同一行動 × 同一対象の連続回数がこの値以上で警告を注入する */
  loopDetectorThreshold: number;
  /** LLMプロバイダの「同一tool-callの連続」検知エラー発生時に、セッション履歴から重複 tool-call/tool-result ペアを除去して1回だけリトライする機能の有効化（切り分け・ロールバック用） */
  repetitiveToolCallRecoveryEnabled: boolean;
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

/**
 * 廃止済み env の検出（#108）: 設定されていても効果が無い変数を起動時に警告する。
 * 「設定したのに効かない」を無言にしない
 */
const DEPRECATED_ENV_KEYS: Record<string, string> = {
  SNS_PROVIDER: 'Multi provider 化で廃止。MASTODON_* / X_* / ELYTH_* を使う',
  SNS_LOOP_MIN_INTERVAL_MINUTES: 'M8 で SNS ループは削除済み（SNS 活動は世界内行為 post_sns / browse_sns / check_phone へ統合）',
  SNS_LOOP_MAX_INTERVAL_MINUTES: 'M8 で SNS ループは削除済み（SNS 活動は世界内行為 post_sns / browse_sns / check_phone へ統合）',
  MEMORY_MAINTENANCE_INTERVAL_MINUTES: '旧メモリ系（core memory / diary）の削除で廃止。記憶の整理・日記生成は省察エンジン（REFLECTION_ENABLED / LLM_REFLECTION_*）が担う',
  MEMORY_MAINTENANCE_RECENT_DIARY_DAYS: '旧メモリ系（core memory / diary）の削除で廃止。日記は life.db の narratives(kind=diary) として省察エンジンが生成する',
  POST_RESPONSE_LLM_API_KEY: '旧 post-response evaluator の削除で廃止。役割別モデルは LLM_APPRAISAL_* / LLM_REFLECTION_* で指定する',
  POST_RESPONSE_LLM_BASE_URL: '旧 post-response evaluator の削除で廃止。役割別モデルは LLM_APPRAISAL_* / LLM_REFLECTION_* で指定する',
  POST_RESPONSE_LLM_MODEL: '旧 post-response evaluator の削除で廃止。役割別モデルは LLM_APPRAISAL_* / LLM_REFLECTION_* で指定する',
  POST_RESPONSE_EVALUATOR_ENABLED: '旧 post-response evaluator は削除済み。ユーザーに関する記憶は appraisal（relations）と省察（beliefs person_fact）が life.db へ記録する',
};

function warnDeprecatedEnv(env: NodeJS.ProcessEnv): void {
  for (const [key, note] of Object.entries(DEPRECATED_ENV_KEYS)) {
    if (env[key] != null && env[key]!.trim().length > 0) {
      logger.warn(`Deprecated environment variable is set and has no effect: ${key} — ${note}`);
    }
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  loadDotEnv({ quiet: true });
  warnDeprecatedEnv(env);

  const rawConfig = {
    discordApplicationId: env.DISCORD_APPLICATION_ID,
    discordBotToken: env.DISCORD_BOT_TOKEN ?? env.DISCORD_TOKEN,
    discordPublicKey: env.DISCORD_PUBLIC_KEY,
    llmApiKey: resolveEnvAliases(env.LLM_API_KEY, env.OPENAI_API_KEY),
    llmBaseUrl: resolveEnvAliases(env.LLM_BASE_URL, env.OPENAI_BASE_URL),
    llmModel: resolveEnvAliases(env.LLM_MODEL, env.OPENAI_MODEL, env.AGENT_MODEL),
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
    kwCommandCheckPhone: normalizeOptionalString(env.KW_COMMAND_CHECK_PHONE),
    kwCommandBrowseSns: normalizeOptionalString(env.KW_COMMAND_BROWSE_SNS),
    kwCommandPostSns: normalizeOptionalString(env.KW_COMMAND_POST_SNS),
    snsRateLimitPostPerHour: env.SNS_RATE_LIMIT_POST_PER_HOUR,
    snsRateLimitPostPerDay: env.SNS_RATE_LIMIT_POST_PER_DAY,
    snsRateLimitPostMinIntervalMinutes: env.SNS_RATE_LIMIT_POST_MIN_INTERVAL_MINUTES,
    snsRateLimitReplyPerHour: env.SNS_RATE_LIMIT_REPLY_PER_HOUR,
    snsRateLimitLikePerHour: env.SNS_RATE_LIMIT_LIKE_PER_HOUR,
    snsRateLimitRepostPerHour: env.SNS_RATE_LIMIT_REPOST_PER_HOUR,
    snsFetchMinIntervalNotificationsMinutes: env.SNS_FETCH_MIN_INTERVAL_NOTIFICATIONS_MINUTES,
    snsFetchMinIntervalTimelineMinutes: env.SNS_FETCH_MIN_INTERVAL_TIMELINE_MINUTES,
    snsFetchMinIntervalTrendsMinutes: env.SNS_FETCH_MIN_INTERVAL_TRENDS_MINUTES,
    allowedChannelIds: env.ALLOWED_CHANNEL_IDS,
    reportChannelId: normalizeOptionalString(env.REPORT_CHANNEL_ID),
    adminUserIds: env.ADMIN_USER_IDS,
    karakuriWorldBotIds: env.KARAKURI_WORLD_BOT_IDS,
    agentSelfNames: env.AGENT_SELF_NAMES,
    llmEnableThinking: env.LLM_ENABLE_THINKING,
    llmDisableThinkingRequestParam: env.LLM_DISABLE_THINKING_REQUEST_PARAM,
    kwPerceptionBufferEnabled: env.KW_PERCEPTION_BUFFER_ENABLED,
    loopWarningEnabled: env.LOOP_WARNING_ENABLED,
    loopDetectorThreshold: env.LOOP_DETECTOR_THRESHOLD,
    repetitiveToolCallRecoveryEnabled: env.REPETITIVE_TOOL_CALL_RECOVERY_ENABLED,
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

    const worldActionCommands: WorldActionCommands = {
      ...(parsed.kwCommandCheckPhone != null ? { checkPhone: parsed.kwCommandCheckPhone } : {}),
      ...(parsed.kwCommandBrowseSns != null ? { browseSns: parsed.kwCommandBrowseSns } : {}),
      ...(parsed.kwCommandPostSns != null ? { postSns: parsed.kwCommandPostSns } : {}),
    };
    const configuredWorldCommands = Object.values(worldActionCommands).filter((value) => value != null);
    if (configuredWorldCommands.length > 0 && karakuriWorld == null) {
      throw new Error(
        'KW_COMMAND_* is set, but KARAKURI_WORLD_API_BASE_URL / KARAKURI_WORLD_API_KEY are not configured. '
        + 'World action commands require karakuri-world integration.',
      );
    }
    if (new Set(configuredWorldCommands).size !== configuredWorldCommands.length) {
      throw new Error('KW_COMMAND_CHECK_PHONE / KW_COMMAND_BROWSE_SNS / KW_COMMAND_POST_SNS must be distinct command names.');
    }
    // check_phone は未読を消費して返信を投稿する。投稿経路（Discord REST sink）が無い構成で
    // 迂回だけ有効になると、全ユーザーメッセージが応答されないまま消費される
    if (worldActionCommands.checkPhone != null && (mergedAllowedChannelIds == null || mergedAllowedChannelIds.length === 0)) {
      throw new Error(
        'KW_COMMAND_CHECK_PHONE requires a Discord message sink: set ALLOWED_CHANNEL_IDS or REPORT_CHANNEL_ID '
        + '(otherwise diverted chat messages could never be replied to).',
      );
    }

    const snsRateLimits: SnsRateLimitConfig = {
      defaults: {
        postPerHour: parsed.snsRateLimitPostPerHour,
        postPerDay: parsed.snsRateLimitPostPerDay,
        postMinIntervalMinutes: parsed.snsRateLimitPostMinIntervalMinutes,
        replyPerHour: parsed.snsRateLimitReplyPerHour,
        likePerHour: parsed.snsRateLimitLikePerHour,
        repostPerHour: parsed.snsRateLimitRepostPerHour,
      },
      perProvider: parseProviderRateLimitOverrides(env),
      fetchIntervals: {
        notificationsMinutes: parsed.snsFetchMinIntervalNotificationsMinutes,
        timelineMinutes: parsed.snsFetchMinIntervalTimelineMinutes,
        trendsMinutes: parsed.snsFetchMinIntervalTrendsMinutes,
      },
    };

    const config = {
      ...parsed,
      llmBaseUrl,
      llmModel: llmModelSelector.selector,
      llmModelSelector,
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
      agentSelfNames: parseIdList(parsed.agentSelfNames),
      ...(karakuriWorld != null ? { karakuriWorld } : {}),
      worldActionCommands,
      snsRateLimits,
      snsList,
      ...(parsed.snsLegacyDbMigrateTo != null ? { snsLegacyDbMigrateTo: parsed.snsLegacyDbMigrateTo } : {}),
      llmEnableThinking: parseBooleanEnv(parsed.llmEnableThinking, 'LLM_ENABLE_THINKING', true),
      llmDisableThinkingRequestParam: parseBooleanEnv(parsed.llmDisableThinkingRequestParam, 'LLM_DISABLE_THINKING_REQUEST_PARAM', false),
      kwPerceptionBufferEnabled: parseBooleanEnv(parsed.kwPerceptionBufferEnabled, 'KW_PERCEPTION_BUFFER_ENABLED', true),
      loopWarningEnabled: parseBooleanEnv(parsed.loopWarningEnabled, 'LOOP_WARNING_ENABLED', true),
      repetitiveToolCallRecoveryEnabled: parseBooleanEnv(
        parsed.repetitiveToolCallRecoveryEnabled,
        'REPETITIVE_TOOL_CALL_RECOVERY_ENABLED',
        true,
      ),
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
      hasKarakuriWorld: config.karakuriWorld != null,
      snsProviders: config.snsList.map((sns) => sns.provider),
      port: config.port,
      heartbeatIntervalMinutes: config.heartbeatIntervalMinutes,
      hasAllowedChannels: (config.postMessageChannelIds?.length ?? 0) > 0,
      hasAdminUsers: (config.adminUserIds?.length ?? 0) > 0,
      hasKarakuriWorldBots: (config.karakuriWorldBotIds?.length ?? 0) > 0,
      hasReportChannel: config.reportChannelId != null,
      llmEnableThinking: config.llmEnableThinking,
      llmDisableThinkingRequestParam: config.llmDisableThinkingRequestParam,
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

const RATE_LIMIT_PROVIDER_PREFIXES: Record<SnsProviderType, string> = {
  mastodon: 'MASTODON',
  x: 'X',
  elyth: 'ELYTH',
};

const RATE_LIMIT_ENV_KEYS: Record<keyof SnsWriteRateLimits, { suffix: string; integer: boolean }> = {
  postPerHour: { suffix: 'POST_PER_HOUR', integer: true },
  postPerDay: { suffix: 'POST_PER_DAY', integer: true },
  postMinIntervalMinutes: { suffix: 'POST_MIN_INTERVAL_MINUTES', integer: false },
  replyPerHour: { suffix: 'REPLY_PER_HOUR', integer: true },
  likePerHour: { suffix: 'LIKE_PER_HOUR', integer: true },
  repostPerHour: { suffix: 'REPOST_PER_HOUR', integer: true },
};

/** provider 別レート制限上書き（`X_RATE_LIMIT_POST_PER_DAY` 等）を読む */
function parseProviderRateLimitOverrides(env: NodeJS.ProcessEnv): Partial<Record<SnsProviderType, Partial<SnsWriteRateLimits>>> {
  const result: Partial<Record<SnsProviderType, Partial<SnsWriteRateLimits>>> = {};
  for (const [provider, prefix] of Object.entries(RATE_LIMIT_PROVIDER_PREFIXES) as Array<[SnsProviderType, string]>) {
    const overrides: Partial<SnsWriteRateLimits> = {};
    for (const [field, { suffix, integer }] of Object.entries(RATE_LIMIT_ENV_KEYS) as Array<[keyof SnsWriteRateLimits, { suffix: string; integer: boolean }]>) {
      const envName = `${prefix}_RATE_LIMIT_${suffix}`;
      const raw = normalizeOptionalString(env[envName]);
      if (raw == null) {
        continue;
      }
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) {
        throw new Error(`Invalid ${envName} value: "${raw}" (expected a non-negative ${integer ? 'integer' : 'number'})`);
      }
      overrides[field] = value;
    }
    if (Object.keys(overrides).length > 0) {
      result[provider] = overrides;
    }
  }
  return result;
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
