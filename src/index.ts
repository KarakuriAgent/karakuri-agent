import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { KarakuriAgent } from './agent/core.js';
import { FilePromptContextStore } from './agent/prompt-context.js';
import { createBot } from './bot.js';
import { loadConfig } from './config.js';
import { FileMemoryStore } from './memory/store.js';
import { FileSessionManager } from './session/manager.js';
import { FileSkillStore } from './skill/store.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('Server');

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function main(): Promise<void> {
  logger.info('Starting karakuri-agent...');
  const config = loadConfig();
  logger.info('Config loaded', { dataDir: config.dataDir, model: config.openaiModel, port: config.port });
  const memoryStore = new FileMemoryStore({ dataDir: config.dataDir, timezone: config.timezone });
  const sessionManager = new FileSessionManager({
    dataDir: config.dataDir,
    tokenBudget: config.tokenBudget,
  });
  const [promptContextStore, skillStore] = await Promise.all([
    FilePromptContextStore.create({ dataDir: config.dataDir }),
    FileSkillStore.create({ dataDir: config.dataDir }),
  ]);
  const agent = new KarakuriAgent({
    config,
    memoryStore,
    sessionManager,
    promptContextStore,
    skillStore,
  });
  const bot = createBot(config, agent);

  await bot.initialize();
  logger.debug('Bot initialized');

  const server = createServer((request, response) => {
    void handleRequest(bot, config.port, request, response);
  });

  await listen(server, config.port);
  await bot.startGatewayLoop();
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
      const results = await Promise.allSettled([
        closeServer(server),
        bot.shutdown(),
        memoryStore.close(),
        promptContextStore.close(),
        skillStore.close(),
      ]);
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

async function handleRequest(
  bot: ReturnType<typeof createBot>,
  port: number,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const webRequest = await toWebRequest(port, request);
    const url = new URL(webRequest.url);
    logger.debug('Request received', { method: request.method, pathname: url.pathname });

    let webResponse: Response;
    if (request.method === 'GET' && url.pathname === '/healthz') {
      webResponse = new Response('ok');
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

void main().catch((error) => {
  logger.error('Fatal error', error);
  process.exit(1);
});
