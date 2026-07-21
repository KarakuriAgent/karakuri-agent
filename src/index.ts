import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { KarakuriAgent } from './agent/core.js';
import { FilePromptContextStore } from './agent/prompt-context.js';
import { createBot, type BotRuntime } from './bot.js';
import { loadConfig, resolveWriteRateLimits, type Config } from './config.js';
import { createConfiguredOpenAiModelFactory } from './llm/model-selector.js';
import { createNoThinkingFetch, noThinkingProviderOptions } from './llm/no-thinking-fetch.js';
import { createScheduler, DiscordMessageSink, FileSchedulerStore } from './scheduler/index.js';
import type { IMessageSink } from './scheduler/types.js';
import { SqliteActionLedgerStore } from './life/action-ledger.js';
import { AppraisalService, buildSelfLabelSet, SqliteAppraisalLogStore } from './life/appraisal.js';
import { SqliteBeliefStore } from './life/beliefs.js';
import { openLifeDatabase } from './life/db.js';
import { SqliteNarrativeStore } from './life/narratives.js';
import { buildReflectionProcVersion, ReflectionEngine } from './life/reflection.js';
import { ReflectionRunner } from './life/reflection-runner.js';
import { importSeedMemories, SEED_MEMORIES_FILE } from './life/seed.js';
import { EpisodeEmbeddingIndex, OpenAiEmbeddingProvider } from './life/embeddings.js';
import { SqliteEpisodeStore } from './life/episodes.js';
import { InnerStateService, SqliteInnerStateStore } from './life/inner-state.js';
import { SqliteProspectStore } from './life/prospects.js';
import { migrateRelationVocabularyOnce, SqliteRelationStore } from './life/relations.js';
import { EpisodeRetrievalService } from './life/retrieval.js';
import { applyTraitsToTuning, loadTraits, satiationThresholdFor, TRAITS_FILE } from './life/traits.js';
import { getLifeMeta, setLifeMeta } from './life/db.js';
import { SegmentationEngine } from './life/segmentation.js';
import { buildAppraisalProcVersion } from './life/tuning.js';
import { logLifeDbCapabilities, verifyLifeDbCapabilities } from './life/db-verification.js';
import { SqliteExperienceLogStore } from './life/experience-log.js';
import { LoopDetector } from './life/loop-detector.js';
import { kwChannel } from './life/normalize.js';
import { PerceptionBuffer } from './life/perception-buffer.js';
import { ExperienceRecorder } from './life/recorder.js';
import { PhoneService } from './phone/service.js';
import { SqlitePhoneUnreadStore } from './phone/unread-store.js';
import { FileSessionManager } from './session/manager.js';
import { createSnsProvider } from './sns/index.js';
import { SnsRateLimiter } from './sns/rate-limiter.js';
import { SnsSkillContextProvider } from './sns/context-provider.js';
import { SqliteSnsActivityStore } from './sns/activity-store.js';
import { migrateLegacySnsActivityDb } from './sns/legacy-migration.js';
import type { SnsProviderType } from './sns/types.js';
import { SkillContextRegistry } from './skill/context-provider.js';
import { FileSkillStore } from './skill/store.js';
import { performGracefulShutdown } from './shutdown.js';
import { SqliteUserStore } from './user/store.js';
import { KeyedMutex } from './utils/mutex.js';
import { createLogger } from './utils/logger.js';
import { reportSafely } from './utils/report.js';

const logger = createLogger('Server');

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  logger.info('Starting karakuri-agent...');
  const config = loadConfig();
  logger.info('Config loaded', {
    dataDir: config.dataDir,
    model: config.llmModel,
    provider: config.llmModelSelector.provider,
    api: config.llmModelSelector.api,
    port: config.port,
  });
  const userStore = new SqliteUserStore({ dataDir: config.dataDir });
  migrateLegacySnsActivityDb({ dataDir: config.dataDir, snsProviders: (config.snsList ?? []).map((sns) => sns.provider), migrateTo: config.snsLegacyDbMigrateTo });
  const snsActivityStores = new Map<SnsProviderType, SqliteSnsActivityStore>();
  const messageSink = config.allowedChannelIds != null && config.allowedChannelIds.length > 0
    ? new DiscordMessageSink({
        botToken: config.discordBotToken,
        allowedChannelIds: config.allowedChannelIds,
        reportChannelId: config.reportChannelId,
      })
    : undefined;
  // 生きたエージェントの記憶基盤（life.db）。体験ログの蓄積は全マイルストーンの起点
  const lifeDb = openLifeDatabase({ dataDir: config.dataDir });
  const lifeDbHealthy = logLifeDbCapabilities(verifyLifeDbCapabilities(lifeDb));
  const experienceLogStore = new SqliteExperienceLogStore({ db: lifeDb });
  const experienceRecorder = new ExperienceRecorder({
    store: experienceLogStore,
    ...(messageSink != null ? { messageSink } : {}),
    ...(config.reportChannelId != null ? { reportChannelId: config.reportChannelId } : {}),
  });
  if (!lifeDbHealthy) {
    void reportSafely(
      messageSink,
      config.reportChannelId,
      '⚠️ life.db の sqlite-vec / FTS5 trigram 検証に失敗しました。体験ログの記録は継続しますが、M3 の想起機能が劣化する可能性があります。',
      logger,
    );
  }
  // #108: 人格系ファイルの欠落を可視化する（従来は無言スキップで気づけなかった）。
  // ログは毎回、report 通知は初回のみ（life_meta マーカー）
  reportMissingPersonaFiles({
    db: lifeDb,
    config,
    messageSink,
  });

  // M1: 知覚分離（Perception Buffer）と反復対策（action_ledger + Loop Detector）
  const perceptionBuffer = new PerceptionBuffer();
  const loopDetector = new LoopDetector({ threshold: config.loopDetectorThreshold });
  const actionLedger = new SqliteActionLedgerStore({ db: lifeDb });
  for (const botId of config.karakuriWorldBotIds ?? []) {
    const channel = kwChannel(botId);
    await perceptionBuffer.restoreChannel(experienceLogStore, channel);
    await loopDetector.restore(experienceLogStore, channel);
  }
  // M6: 気質（traits）。減衰・欲求の係数として全層に効く
  const traits = loadTraits(config.dataDir);
  const lifeTuning = applyTraitsToTuning(traits);
  // M2: 内部状態 + Appraisal Service（役割別モデル: LLM_APPRAISAL_MODEL、未指定は既定へフォールバック）
  const innerStateStore = new SqliteInnerStateStore({ db: lifeDb });
  const innerStateService = new InnerStateService({ store: innerStateStore, timezone: config.timezone, tuning: lifeTuning });
  const appraisalLogStore = new SqliteAppraisalLogStore({ db: lifeDb });
  // M3: エピソード記銘（salience gating + 分節化）とハイブリッド想起
  const episodeStore = new SqliteEpisodeStore({ db: lifeDb });
  const embeddingIndex = config.embeddingModel != null
    ? new EpisodeEmbeddingIndex({
        db: lifeDb,
        provider: new OpenAiEmbeddingProvider({
          model: config.embeddingModel,
          apiKey: config.embeddingApiKey ?? config.llmApiKey,
          baseURL: config.embeddingBaseUrl ?? config.llmBaseUrl,
        }),
        dimensions: config.embeddingDimensions,
      })
    : undefined;
  const appraisalSelectorForProc = config.appraisalLlmModelSelector ?? config.llmModelSelector;
  const segmentationEngine = new SegmentationEngine({
    episodeStore,
    procVersion: buildAppraisalProcVersion(appraisalSelectorForProc.selector, config.appraisalOutputMode),
    ...(embeddingIndex != null
      ? {
          onEpisodeFinalized: (episodeId: number, body: string) => {
            // 埋め込みは非同期 backfill 可（API 失敗・未設定でエピソード確定をブロックしない）
            void embeddingIndex.indexEpisode(episodeId, body)
              .then(() => embeddingIndex.backfillPending())
              .catch((error: unknown) => {
                logger.warn('Episode embedding indexing failed', error);
              });
          },
        }
      : {}),
  });
  await segmentationEngine.recoverStaleDrafts(new Date());
  if (embeddingIndex != null) {
    void embeddingIndex.backfillPending().catch((error: unknown) => {
      logger.warn('Episode embedding backfill failed at startup', error);
    });
  }
  const retrievalService = new EpisodeRetrievalService({
    episodeStore,
    ...(embeddingIndex != null ? { embeddingIndex } : {}),
  });
  // M4: 自伝的階層（narratives）・信念（beliefs）・省察エンジン・seed / 既存データ移行
  const narrativeStore = new SqliteNarrativeStore({ db: lifeDb });
  const beliefStore = new SqliteBeliefStore({ db: lifeDb });
  // M5: 展望記憶（約束・予定・目標）
  const prospectStore = new SqliteProspectStore({ db: lifeDb });
  // M6: 関係グラフ（relations）。既存 alias 機構を alias_of エッジへ一度だけ移行する
  const relationStore = new SqliteRelationStore({ db: lifeDb });
  try {
    if (getLifeMeta(lifeDb, 'alias_migrated') == null && userStore.listAliasesByPrimaryIds != null) {
      const allUsers = await userStore.searchUsers('', { limit: 10_000 });
      const aliasMap = await userStore.listAliasesByPrimaryIds(allUsers.map((user) => user.userId));
      let migrated = 0;
      for (const aliases of aliasMap.values()) {
        for (const alias of aliases) {
          await relationStore.linkAlias(alias.aliasUserId, alias.primaryUserId, [], 'alias-migration-v1');
          migrated += 1;
        }
      }
      setLifeMeta(lifeDb, 'alias_migrated', new Date().toISOString());
      if (migrated > 0) {
        logger.info('Migrated legacy user aliases into relations (alias_of)', { migrated });
      }
    }
  } catch (error) {
    logger.warn('Legacy alias migration failed (continuing startup)', error);
  }
  // #106: 自由記述の関係ラベルを制御語彙へ、自己の表記ゆらぎを 'self' へ一度だけ移行する
  try {
    const migration = migrateRelationVocabularyOnce(lifeDb, {
      selfLabels: buildSelfLabelSet(config.agentSelfNames ?? []),
      procVersion: 'relation-vocab-migration-v1',
    });
    if (migration != null && (migration.rewritten > 0 || migration.merged > 0)) {
      logger.info('Relation vocabulary migration applied', migration);
    }
  } catch (error) {
    logger.warn('Relation vocabulary migration failed (continuing startup)', error);
  }
  try {
    await importSeedMemories({
      db: lifeDb,
      dataDir: config.dataDir,
      experienceLogStore,
      beliefStore,
      narrativeStore,
    });
  } catch (error) {
    logger.warn('Seed import failed (continuing startup)', error);
  }
  const reflectionRunner = config.reflectionEnabled
    ? (() => {
        const reflectionSelector = config.reflectionLlmModelSelector ?? config.llmModelSelector;
        const reflectionModelFactory = createConfiguredOpenAiModelFactory({
          apiKey: config.reflectionLlmApiKey ?? config.llmApiKey,
          ...((config.reflectionLlmBaseUrl ?? config.llmBaseUrl) != null
            ? { baseURL: config.reflectionLlmBaseUrl ?? config.llmBaseUrl }
            : {}),
          fetch: createNoThinkingFetch({
            disableThinkingRequestParam: config.llmDisableThinkingRequestParam,
          }),
        });
        const reflectionEngine = new ReflectionEngine({
          model: reflectionModelFactory(reflectionSelector),
          procVersion: buildReflectionProcVersion(reflectionSelector.selector, config.reflectionOutputMode),
          episodeStore,
          narrativeStore,
          beliefStore,
          innerStateService,
          prospectStore,
          timezone: config.timezone,
          providerOptions: noThinkingProviderOptions(reflectionSelector.api),
          outputMode: config.reflectionOutputMode,
          ...(config.reflectionTimeoutMs != null ? { timeoutMs: config.reflectionTimeoutMs } : {}),
          ...(messageSink != null && config.reportChannelId != null
            ? {
                onDrop: (message: string) => {
                  void reportSafely(
                    messageSink,
                    config.reportChannelId,
                    `⚠️ 省察の出力の一部を破棄しました。不完全な要素は登録していません。\n- ${message}`,
                    logger,
                  );
                },
              }
            : {}),
        });
        return new ReflectionRunner({
          engine: reflectionEngine,
          db: lifeDb,
          timezone: config.timezone,
          ...(messageSink != null ? { messageSink } : {}),
          ...(config.reportChannelId != null ? { reportChannelId: config.reportChannelId } : {}),
        });
      })()
    : undefined;
  const appraisalService = config.appraisalEnabled
    ? (() => {
        const appraisalSelector = config.appraisalLlmModelSelector ?? config.llmModelSelector;
        const appraisalModelFactory = createConfiguredOpenAiModelFactory({
          apiKey: config.appraisalLlmApiKey ?? config.llmApiKey,
          ...((config.appraisalLlmBaseUrl ?? config.llmBaseUrl) != null
            ? { baseURL: config.appraisalLlmBaseUrl ?? config.llmBaseUrl }
            : {}),
          fetch: createNoThinkingFetch({
            disableThinkingRequestParam: config.llmDisableThinkingRequestParam,
          }),
        });
        return new AppraisalService({
          model: appraisalModelFactory(appraisalSelector),
          modelName: appraisalSelector.selector,
          innerStateService,
          logStore: appraisalLogStore,
          procVersion: buildAppraisalProcVersion(appraisalSelector.selector, config.appraisalOutputMode),
          timezone: config.timezone,
          providerOptions: noThinkingProviderOptions(appraisalSelector.api),
          outputMode: config.appraisalOutputMode,
          segmentation: segmentationEngine,
          prospectStore,
          relationStore,
          ...(config.agentSelfNames != null ? { selfAliases: config.agentSelfNames } : {}),
          tuning: lifeTuning,
          ...(config.appraisalTimeoutMs != null ? { timeoutMs: config.appraisalTimeoutMs } : {}),
          ...(messageSink != null ? { messageSink } : {}),
          ...(config.reportChannelId != null ? { reportChannelId: config.reportChannelId } : {}),
        });
      })()
    : undefined;
  const snsReportError = messageSink != null && config.reportChannelId != null
    ? (message: string) => {
        void reportSafely(messageSink, config.reportChannelId, message, {
          error: (_message, err) => {
            logger.error('Failed to report SNS context error', err);
          },
        });
      }
    : undefined;
  const snsProviders = new Map<SnsProviderType, ReturnType<typeof createSnsProvider>>();
  const snsRateLimiters = new Map<SnsProviderType, SnsRateLimiter>();
  const snsContextRegistry = (config.snsList ?? []).length > 0
    ? new SkillContextRegistry()
    : undefined;
  for (const credentials of (config.snsList ?? [])) {
    const provider = credentials.provider;
    const activityStore = new SqliteSnsActivityStore({ dataDir: config.dataDir, provider });
    const snsProvider = createSnsProvider({ ...credentials, dataDir: config.dataDir });
    // M8: 決定論レート制限。書き込みはツール層ゲート、読み取りはフェッチ間隔 + キャッシュ
    const rateLimiter = new SnsRateLimiter({
      limits: resolveWriteRateLimits(config.snsRateLimits, provider),
      fetchIntervals: config.snsRateLimits.fetchIntervals,
      counter: activityStore,
      timezone: config.timezone,
    });
    snsActivityStores.set(provider, activityStore);
    snsProviders.set(provider, snsProvider);
    snsRateLimiters.set(provider, rateLimiter);
    snsContextRegistry?.register(`sns-${provider}`, new SnsSkillContextProvider({
      activityStore,
      snsProvider,
      provider,
      reportError: snsReportError,
      experienceRecorder,
      appraisalService,
      rateLimiter,
    }));
  }
  const sessionManager = new FileSessionManager({
    dataDir: config.dataDir,
    tokenBudget: config.tokenBudget,
  });
  const [promptContextStore, skillStore, schedulerStore] = await Promise.all([
    FilePromptContextStore.create({ dataDir: config.dataDir }),
    FileSkillStore.create({ dataDir: config.dataDir }),
    FileSchedulerStore.create({ dataDir: config.dataDir }),
  ]);
  const agent = new KarakuriAgent({
    config,
    sessionManager,
    promptContextStore,
    skillStore,
    schedulerStore,
    messageSink,
    userStore,
    snsActivityStores,
    snsRateLimiters,
    episodeStore,
    snsContextRegistry,
    experienceRecorder,
    experienceLog: experienceLogStore,
    perceptionBuffer,
    loopDetector,
    actionLedger,
    ...(appraisalService != null ? { appraisalService } : {}),
    innerStateService,
    retrievalService,
    narrativeStore,
    beliefStore,
    prospectStore,
    relationStore,
    satiationThreshold: satiationThresholdFor(traits),
  });
  // M8: 世界内行為としてのチャット・SNS。KW カスタムコマンド（check_phone / browse_sns /
  // post_sns）の実行開始をフックし、実行時間の窓内で未読返信・SNS 活動を行う
  const phoneUnreadStore = new SqlitePhoneUnreadStore({ db: lifeDb });
  // bot の即時処理（admin 等）と check_phone 返信で共有するスレッド単位 mutex
  const chatThreadMutex = new KeyedMutex();
  const phoneService = new PhoneService({
    agent,
    commands: config.worldActionCommands,
    unreadStore: phoneUnreadStore,
    ...(messageSink != null
      ? { postReply: (threadId: string, text: string) => messageSink.postReply(threadId, text) }
      : {}),
    ...(messageSink != null ? { messageSink } : {}),
    ...(config.reportChannelId != null ? { reportChannelId: config.reportChannelId } : {}),
    snsProviders,
    rateLimiters: snsRateLimiters,
    perceptionBuffer,
    experienceLog: experienceLogStore,
    ...(config.karakuriWorldBotIds != null ? { karakuriWorldBotIds: config.karakuriWorldBotIds } : {}),
    // M9 #110: 深夜ゲートと個別共有（send-intent の材料）
    timezone: config.timezone,
    episodeSource: episodeStore,
    threadMutex: chatThreadMutex,
  });
  agent.setPhoneIntegration(phoneService);
  // check_phone が設定されているときだけチャットを未読キュー化する。
  // KW bot（通知）は即時処理が必須なので対象外。admin も含め人間のメッセージはすべて
  // 未読に積む（admin ツールの権限判定は check_phone 処理時の userId で従来どおり効く）
  const unreadDiversion = config.worldActionCommands.checkPhone != null && config.karakuriWorld != null
    ? {
        shouldDivert: (message: { author: { userId: string } }): boolean =>
          !(config.karakuriWorldBotIds ?? []).includes(message.author.userId),
        enqueue: async (message: { threadId: string; id: string; text: string; author: { userId: string; fullName: string } }): Promise<void> => {
          await phoneUnreadStore.enqueue({
            source: 'discord',
            threadId: message.threadId,
            messageId: message.id,
            authorId: message.author.userId,
            authorName: message.author.fullName,
            body: message.text,
            receivedAt: new Date(),
          });
        },
      }
    : undefined;
  const scheduler = await createScheduler({
    agent,
    config,
    messageSink,
    store: schedulerStore,
  });
  const bot = createBot(config, agent, { messageSink, threadMutex: chatThreadMutex, ...(unreadDiversion != null ? { unreadDiversion } : {}) });

  reflectionRunner?.start();
  await bot.initialize();
  logger.debug('Bot initialized');

  const server = createServer((request, response) => {
    void handleRequest(bot, config.port, request, response);
  });

  await listen(server, config.port);
  const localWebhookUrl = `http://127.0.0.1:${config.port}/webhooks/discord`;
  await bot.startGatewayLoop(localWebhookUrl);
  logger.debug('Gateway loop started');

  logger.info(`Karakuri-Agent listening on http://127.0.0.1:${config.port}`);

  const shutdown = async (signal: NodeJS.Signals) => {
    logger.info(`${signal} received, shutting down...`);
    const timeout = setTimeout(() => {
      logger.error('Graceful shutdown timed out');
      process.exitCode = 1;
      process.exit();
    }, SHUTDOWN_TIMEOUT_MS);

    try {
      const results = await performGracefulShutdown({
        closeServer: () => closeServer(server),
        closeScheduler: () => Promise.all([
          scheduler.close(),
          reflectionRunner?.close() ?? Promise.resolve(),
        ]).then(() => undefined),
        shutdownBot: () => bot.shutdown(),
        // recorder を先に flush する: Discord 事後 appraisal は record の解決後に
        // enqueue されるため、並列に drain すると tail のスナップショットが
        // 未登録の appraisal を取りこぼす
        drainEvaluations: () => experienceRecorder.flush()
          .then(() => Promise.all([
            agent.drainPendingEvaluations(),
            phoneService.drain(),
          ]))
          .then(() => undefined),
        closeStores: () => [
          userStore.close(),
          Promise.all([
            experienceLogStore.close(),
            actionLedger.close(),
            innerStateStore.close(),
            appraisalLogStore.close(),
            episodeStore.close(),
            narrativeStore.close(),
            beliefStore.close(),
            prospectStore.close(),
          ]).then(() => {
            if (lifeDb.open) {
              lifeDb.close();
            }
          }),
          ...Array.from(snsActivityStores.values(), (store) => store.close()),
          promptContextStore.close(),
          skillStore.close(),
          schedulerStore.close(),
        ],
      });
      clearTimeout(timeout);
      const failures = results.filter((r) => r.status === 'rejected');
      if (failures.length > 0) {
        for (const failure of failures) {
          logger.warn('Shutdown task failed', (failure as PromiseRejectedResult).reason);
        }
        logger.warn('Shutdown completed with errors');
      } else {
        logger.info('Shutdown complete');
      }
      process.exit();
    } catch (error) {
      clearTimeout(timeout);
      logger.error('Shutdown failed', error);
      process.exitCode = 1;
      process.exit();
    }
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
}

type HttpHandlerBot = Pick<BotRuntime, 'handleWebhook' | 'isGatewayConnected'>;

export async function handleRequest(
  bot: HttpHandlerBot,
  port: number,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const webRequest = await toWebRequest(port, request);
    const url = new URL(webRequest.url);
    logger.debug('Request received', { method: request.method, pathname: url.pathname });

    let webResponse: Response;
    if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/healthz') {
      webResponse = bot.isGatewayConnected()
        ? new Response('ok')
        : new Response('discord gateway unavailable', { status: 503 });
    } else if (url.pathname.startsWith('/webhooks/')) {
      const platform = url.pathname.slice('/webhooks/'.length);
      webResponse = await bot.handleWebhook(platform, webRequest);
    } else {
      webResponse = new Response('Not found', { status: 404 });
    }

    await sendWebResponse(response, webResponse);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      logger.warn('Request body too large');
      response.statusCode = 413;
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.end('Request body too large');
      return;
    }

    logger.error('Request handling failed', error);
    response.statusCode = 500;
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');
    response.end('Internal Server Error');
  }
}

async function toWebRequest(port: number, request: IncomingMessage): Promise<Request> {
  const baseUrl = `http://${request.headers.host ?? `127.0.0.1:${port}`}`;
  const url = new URL(request.url ?? '/', baseUrl);
  const headers = new Headers();
  const method = request.method ?? 'GET';

  for (const [key, value] of Object.entries(request.headers)) {
    if (value == null) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
      continue;
    }

    headers.set(key, value);
  }

  const body = method === 'GET' || method === 'HEAD'
    ? undefined
    : await readRequestBody(request);

  const init: RequestInit = {
    method,
    headers,
  };

  if (body != null) {
    init.body = new Uint8Array(body);
  }

  return new Request(url, init);
}

async function sendWebResponse(response: ServerResponse, webResponse: Response): Promise<void> {
  response.statusCode = webResponse.status;
  response.statusMessage = webResponse.statusText;

  webResponse.headers.forEach((value, key) => {
    response.setHeader(key, value);
  });

  const body = webResponse.body == null ? Buffer.alloc(0) : Buffer.from(await webResponse.arrayBuffer());
  response.end(body);
}

const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    totalBytes += buffer.length;

    if (totalBytes > MAX_REQUEST_BODY_BYTES) {
      request.destroy();
      throw new RequestBodyTooLargeError();
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

class RequestBodyTooLargeError extends Error {
  constructor() {
    super('Request body too large');
  }
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error != null) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

/**
 * 人格系ファイル（traits.json / seed-memories.json / HEARTBEAT.md）の欠落可視化（#108）。
 * どれも「あれば使う」ファイルで欠落は正常系だが、旧 data/ ディレクトリの引き継ぎで
 * 新ファイルが入っていないことに気づけない事故が実機で起きたため、状態を明示する。
 */
function reportMissingPersonaFiles({ db, config, messageSink }: {
  db: import('better-sqlite3').Database;
  config: Config;
  messageSink: IMessageSink | undefined;
}): void {
  const missing: string[] = [];
  if (!existsSync(join(config.dataDir, TRAITS_FILE))) {
    logger.info('traits.json not found; using default traits (all coefficients = 1)', { dataDir: config.dataDir });
    missing.push(`- ${TRAITS_FILE}: 気質はデフォルト値（全係数 1）で稼働します`);
  }
  if (!existsSync(join(config.dataDir, SEED_MEMORIES_FILE)) && getLifeMeta(db, 'seed_imported') == null) {
    logger.info('seed-memories.json not found and no seed has been imported; starting with a blank identity', { dataDir: config.dataDir });
    missing.push(`- ${SEED_MEMORIES_FILE}: seed 記憶なし（自己認識の白紙スタート）。後から置けば次回起動時に一度だけ取り込まれます`);
  }
  const hasPostChannels = (config.postMessageChannelIds?.length ?? 0) > 0;
  if (hasPostChannels && !existsSync(join(config.dataDir, 'HEARTBEAT.md'))) {
    logger.info('HEARTBEAT.md not found; heartbeat is disabled', { dataDir: config.dataDir });
    missing.push('- HEARTBEAT.md: heartbeat は無効です（ファイルを置けば有効化されます）');
  }
  if (missing.length === 0) {
    return;
  }
  // report 通知は初回のみ（毎起動でうるさくしない）
  const NOTICE_KEY = 'persona_files_notice_sent';
  if (getLifeMeta(db, NOTICE_KEY) != null) {
    return;
  }
  setLifeMeta(db, NOTICE_KEY, new Date().toISOString());
  void reportSafely(
    messageSink,
    config.reportChannelId,
    `ℹ️ 人格系ファイルが見つかりません（data.example/ に雛形があります）:\n${missing.join('\n')}`,
    logger,
  );
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    logger.error('Fatal error', error);
    process.exit(1);
  });
}
