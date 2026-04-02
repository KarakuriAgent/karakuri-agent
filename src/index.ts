import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';

import { KarakuriAgent } from './agent/core.js';
import { FilePromptContextStore } from './agent/prompt-context.js';
import { createBot, type BotRuntime } from './bot.js';
import { loadConfig } from './config.js';
import { createScheduler, DiscordMessageSink, FileSchedulerStore } from './scheduler/index.js';
import { CompositeMemoryStore } from './memory/composite-store.js';
import { SqliteDiaryStore } from './memory/diary-store.js';
import { FileMemoryStore } from './memory/store.js';
import { FileSessionManager } from './session/manager.js';
import { createSnsProvider } from './sns/index.js';
import { SnsSkillContextProvider } from './sns/context-provider.js';
import { SqliteSnsActivityStore } from './sns/activity-store.js';
import { SnsScheduleRunner } from './sns/schedule-runner.js';
import { SkillContextRegistry } from './skill/context-provider.js';
import { FileSkillStore } from './skill/store.js';
import { performGracefulShutdown } from './shutdown.js';
import { SqliteUserStore } from './user/store.js';
import { createLogger } from './utils/logger.js';

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
  const coreMemoryStore = new FileMemoryStore({ dataDir: config.dataDir });
  const diaryStore = new SqliteDiaryStore({ dataDir: config.dataDir, timezone: config.timezone });
  const memoryStore = new CompositeMemoryStore(coreMemoryStore, diaryStore);
  const userStore = new SqliteUserStore({ dataDir: config.dataDir });
  const snsActivityStore = config.sns != null ? new SqliteSnsActivityStore({ dataDir: config.dataDir }) : undefined;
  const messageSink = config.allowedChannelIds != null && config.allowedChannelIds.length > 0
    ? new DiscordMessageSink({
        botToken: config.discordBotToken,
        allowedChannelIds: config.allowedChannelIds,
        reportChannelId: config.reportChannelId,
      })
    : undefined;
  const snsReportError = messageSink != null && config.reportChannelId != null
    ? (message: string) => { void messageSink.postMessage(config.reportChannelId!, message).catch((err) => { logger.error('Failed to report SNS context error', err); }); }
    : undefined;
  const snsProvider = config.sns != null ? createSnsProvider({ ...config.sns, dataDir: config.dataDir }) : undefined;
  const snsContextRegistry = config.sns != null && snsActivityStore != null && snsProvider != null
    ? (() => {
        const registry = new SkillContextRegistry();
        registry.register('sns', new SnsSkillContextProvider({
          activityStore: snsActivityStore,
          scheduleStore: snsActivityStore,
          snsProvider,
          reportError: snsReportError,
        }));
        return registry;
      })()
    : undefined;
  const snsScheduleRunner = config.sns != null && snsActivityStore != null && snsProvider != null
    ? new SnsScheduleRunner({
        scheduleStore: snsActivityStore,
        activityStore: snsActivityStore,
        snsProvider,
        reportError: snsReportError,
      })
    : undefined;
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
    memoryStore,
    sessionManager,
    promptContextStore,
    skillStore,
    schedulerStore,
    messageSink,
    userStore,
    snsActivityStore,
    snsScheduleStore: snsActivityStore,
    snsContextRegistry,
  });
  const scheduler = await createScheduler({
    agent,
    config,
    messageSink,
    store: schedulerStore,
  });
  const bot = createBot(config, agent, { messageSink });

  snsScheduleRunner?.start();
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
          snsScheduleRunner?.close() ?? Promise.resolve(),
        ]).then(() => undefined),
        shutdownBot: () => bot.shutdown(),
        drainEvaluations: () => agent.drainPendingEvaluations(),
        closeStores: () => [
          memoryStore.close(),
          userStore.close(),
          snsActivityStore?.close() ?? Promise.resolve(),
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

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    logger.error('Fatal error', error);
    process.exit(1);
  });
}
