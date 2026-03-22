import { createDiscordAdapter, type DiscordAdapter } from '@chat-adapter/discord';
import { Chat, type Message, type Thread } from 'chat';

import type { Config } from './config.js';
import type { AgentLifecycleCallbacks, IAgent } from './agent/core.js';
import { StatusReactionController } from './status-reaction.js';
import { createFileStateAdapter } from './state/file-state.js';
import { createLogger } from './utils/logger.js';
import { splitMessageForDiscord } from './utils/message-splitter.js';
import { KeyedMutex } from './utils/mutex.js';

const logger = createLogger('Bot');

const GATEWAY_LISTENER_DURATION_MS = 10 * 60 * 1_000;
const GATEWAY_RESTART_DELAY_MS = 1_000;
const ATTACHMENT_WARNING =
  '添付ファイルは現在未対応のため、テキスト部分のみを処理しました。';
const ATTACHMENT_ONLY_MESSAGE =
  '現在はテキストメッセージのみ対応しています。テキストで送ってください。';
const ERROR_MESSAGE =
  'エラーが発生しました。時間をおいて再度お試しください。';

type KarakuriAdapters = {
  discord: DiscordAdapter;
};

type KarakuriChat = Chat<KarakuriAdapters>;

export interface BotRuntime {
  chat: KarakuriChat;
  initialize(): Promise<void>;
  handleWebhook(platform: string, request: Request): Promise<Response>;
  startGatewayLoop(): Promise<void>;
  shutdown(): Promise<void>;
}

export function createBot(config: Config, agent: IAgent): BotRuntime {
  const threadMutex = new KeyedMutex();
  const inFlightHandlers = new Set<Promise<void>>();
  const chat = new Chat<KarakuriAdapters>({
    userName: 'karakuri-agent',
    adapters: {
      discord: createDiscordAdapter({
        applicationId: config.discordApplicationId,
        botToken: config.discordBotToken,
        publicKey: config.discordPublicKey,
        userName: 'karakuri-agent',
      }),
    },
    state: createFileStateAdapter({
      dataDir: config.dataDir,
    }),
  });

  let gatewayAbortController: AbortController | null = null;
  let gatewayLoopPromise: Promise<void> | null = null;
  let initializePromise: Promise<void> | null = null;

  const initialize = async (): Promise<void> => {
    initializePromise ??= chat.initialize();
    await initializePromise;
  };

  const trackHandler = (task: Promise<void>): Promise<void> => {
    const tracked = task.finally(() => inFlightHandlers.delete(tracked));
    inFlightHandlers.add(tracked);
    return tracked;
  };

  const handleNewThread = async (thread: Thread, message: Message): Promise<void> => {
    const controller = createStatusReactionController(thread, message);
    if (hasProcessableText(message)) {
      controller.setQueued();
    }

    await threadMutex.runExclusive(message.threadId, async () => {
      try {
        logger.info('Handling new message', { threadId: message.threadId });
        if (hasProcessableText(message)) {
          await thread.subscribe();
          logger.debug('Subscribed to thread', { threadId: message.threadId });
        }
        await handleThreadMessage(agent, thread, message, controller);
      } catch (error) {
        controller.error();
        logger.error('Failed to handle new message', error);
        await safePost(thread, ERROR_MESSAGE);
      }
    });
    await controller.waitForCompletion();
  };

  chat.onNewMessage(/.*/, async (thread, message) => {
    await trackHandler(handleNewThread(thread, message));
  });

  chat.onSubscribedMessage(async (thread, message) => {
    const controller = createStatusReactionController(thread, message);
    if (hasProcessableText(message)) {
      controller.setQueued();
    }

    await trackHandler(
      threadMutex.runExclusive(message.threadId, async () => {
        try {
          logger.info('Handling subscribed message', { threadId: message.threadId });
          await handleThreadMessage(agent, thread, message, controller);
        } catch (error) {
          controller.error();
          logger.error('Failed to handle subscribed message', error);
          await safePost(thread, ERROR_MESSAGE);
        }
      }).then(() => controller.waitForCompletion()),
    );
  });

  return {
    chat,
    async initialize(): Promise<void> {
      await initialize();
    },
    async handleWebhook(platform: string, request: Request): Promise<Response> {
      const webhookHandler = chat.webhooks[platform as keyof typeof chat.webhooks];
      if (webhookHandler == null) {
        return new Response(`Unknown platform: ${platform}`, { status: 404 });
      }

      if (request.method === 'GET') {
        const url = new URL(request.url);
        if (url.searchParams.has('hub.mode') || url.searchParams.has('hub.verify_token')) {
          return webhookHandler(request);
        }

        return new Response(`${platform} webhook endpoint is active`, {
          status: 200,
        });
      }

      return webhookHandler(request);
    },
    async startGatewayLoop(): Promise<void> {
      await initialize();
      logger.debug('Starting gateway listener');

      if (gatewayLoopPromise != null) {
        return;
      }

      gatewayAbortController = new AbortController();
      gatewayLoopPromise = runGatewayLoop(
        chat,
        gatewayAbortController.signal,
      ).finally(() => {
        gatewayLoopPromise = null;
        gatewayAbortController = null;
      });
    },
    async shutdown(): Promise<void> {
      logger.info('Shutting down bot...');
      gatewayAbortController?.abort();
      await gatewayLoopPromise;
      await Promise.allSettled([...inFlightHandlers]);
      await chat.shutdown();
      logger.info('Bot shutdown complete');
    },
  };
}

async function runGatewayLoop(chat: KarakuriChat, signal: AbortSignal): Promise<void> {
  const adapter = chat.getAdapter('discord');

  while (!signal.aborted) {
    try {
      let listenerTask: Promise<unknown> | undefined;

      const response = await adapter.startGatewayListener(
        {
          waitUntil(task) {
            listenerTask = task;
          },
        },
        GATEWAY_LISTENER_DURATION_MS,
        signal,
      );

      if (!response.ok) {
        if (signal.aborted) {
          break;
        }

        logger.error(
          'Discord gateway listener failed to start',
          new Error(`Discord gateway listener failed: ${await response.text()}`),
        );
        await delay(GATEWAY_RESTART_DELAY_MS, signal);
        continue;
      }

      if (listenerTask == null) {
        logger.error('Discord gateway listener did not return a background task');
        await delay(GATEWAY_RESTART_DELAY_MS, signal);
        continue;
      }

      await listenerTask;
      logger.debug('Gateway listener session ended normally');
    } catch (error) {
      if (signal.aborted) {
        break;
      }

      logger.error('Discord gateway listener crashed', error);
      await delay(GATEWAY_RESTART_DELAY_MS, signal);
    }
  }
}

async function handleThreadMessage(
  agent: IAgent,
  thread: Thread,
  message: Message,
  controller: StatusReactionController,
): Promise<void> {
  if (message.attachments.length > 0 && message.text.trim().length === 0) {
    logger.debug('Skipped attachment-only message', { threadId: message.threadId });
    await safePost(thread, ATTACHMENT_ONLY_MESSAGE);
    return;
  }

  const text = message.text.trim();
  if (text.length === 0) {
    logger.debug('Skipped empty message', { threadId: message.threadId });
    return;
  }

  controller.setThinking();
  await thread.startTyping();
  logger.debug('Calling agent.handleMessage', { threadId: message.threadId, textLength: text.length });
  const lifecycle: AgentLifecycleCallbacks = {
    onThinking: () => {
      controller.setThinking();
    },
    onToolCallStart: (toolName) => {
      controller.setTool(toolName);
    },
    onToolCallFinish: () => {
      controller.setThinking();
    },
  };

  try {
    const responseText = await agent.handleMessage(
      message.threadId,
      text,
      message.author.fullName,
      {
        lifecycle,
        userId: message.author.userId,
      },
    );

    if (message.attachments.length > 0) {
      await safePost(thread, ATTACHMENT_WARNING);
    }

    const chunks = splitMessageForDiscord(responseText);
    logger.debug('Agent responded', { threadId: message.threadId, responseLength: responseText.length, chunks: chunks.length });
    for (const chunk of chunks) {
      await safePost(thread, chunk);
    }

    controller.done();
  } catch (error) {
    controller.error();
    throw error;
  }
}

function hasProcessableText(message: Message): boolean {
  return message.text.trim().length > 0;
}

function createStatusReactionController(thread: Thread, message: Message): StatusReactionController {
  return new StatusReactionController(thread.adapter, message.threadId, message.id);
}

async function safePost(thread: Thread, text: string): Promise<void> {
  if (text.trim().length === 0) {
    return;
  }

  await thread.post(text);
}

async function delay(durationMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, durationMs);

    const onAbort = () => {
      clearTimeout(timeout);
      resolve();
    };

    signal.addEventListener('abort', onAbort, { once: true });
  });
}
