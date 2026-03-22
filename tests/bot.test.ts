import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBot } from '../src/bot.js';
import type { IAgent } from '../src/agent/core.js';
import type { Config } from '../src/config.js';
import { DONE_REACTION_DURATION_MS, STATUS_EMOJI } from '../src/status-reaction.js';

const { initializeMock, shutdownMock, startGatewayListenerMock } = vi.hoisted(() => ({
  initializeMock: vi.fn(async () => {}),
  shutdownMock: vi.fn(async () => {}),
  startGatewayListenerMock: vi.fn(),
}));

vi.mock('@chat-adapter/discord', () => ({
  createDiscordAdapter: vi.fn(() => ({
    startGatewayListener: startGatewayListenerMock,
  })),
}));

vi.mock('chat', () => {
  type MessageHandler = (thread: unknown, message: unknown) => Promise<void>;

  class Chat {
    webhooks = {};
    private mentionHandlers: MessageHandler[] = [];
    private newMessageHandlers: MessageHandler[] = [];
    private subscribedMessageHandlers: MessageHandler[] = [];

    constructor(private readonly options: { adapters: Record<string, unknown> }) {}

    async initialize(): Promise<void> {
      await initializeMock();
    }

    onNewMention(handler: MessageHandler): void {
      this.mentionHandlers.push(handler);
    }

    onNewMessage(_pattern: RegExp, handler: MessageHandler): void {
      this.newMessageHandlers.push(handler);
    }

    onSubscribedMessage(handler: MessageHandler): void {
      this.subscribedMessageHandlers.push(handler);
    }

    getAdapter(name: string): unknown {
      return this.options.adapters[name];
    }

    async shutdown(): Promise<void> {
      await shutdownMock();
    }

    /** テスト用: 登録済みハンドラーを取得 */
    _getMentionHandlers(): MessageHandler[] {
      return this.mentionHandlers;
    }

    _getNewMessageHandlers(): MessageHandler[] {
      return this.newMessageHandlers;
    }

    _getSubscribedMessageHandlers(): MessageHandler[] {
      return this.subscribedMessageHandlers;
    }
  }

  return { Chat };
});

const baseConfig: Config = {
  discordApplicationId: 'app',
  discordBotToken: 'token',
  discordPublicKey: 'public',
  openaiApiKey: 'openai',
  dataDir: '/tmp/karakuri-agent-test',
  timezone: 'Asia/Tokyo',
  openaiModel: 'gpt-4o',
  maxSteps: 4,
  tokenBudget: 200,
  port: 3000,
};

const agentStub: IAgent = {
  async handleMessage(): Promise<string> {
    return 'ok';
  },
  async summarizeSession(): Promise<string> {
    return 'summary';
  },
};

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });

  return { promise, resolve };
}

function createMockThread() {
  const reactionEvents: string[] = [];
  const adapter = {
    addReaction: vi.fn(async (threadId: string, messageId: string, emoji: string) => {
      reactionEvents.push(`add:${threadId}:${messageId}:${emoji}`);
    }),
    removeReaction: vi.fn(async (threadId: string, messageId: string, emoji: string) => {
      reactionEvents.push(`remove:${threadId}:${messageId}:${emoji}`);
    }),
  };

  return {
    reactionEvents,
    thread: {
      adapter,
      subscribe: vi.fn(),
      startTyping: vi.fn(),
      post: vi.fn(),
    },
  };
}

function createMessage(overrides: Partial<{
  id: string;
  threadId: string;
  text: string;
  attachments: Array<{ url: string }>;
  author: { fullName: string; userId: string };
}> = {}) {
  return {
    id: 'message-1',
    threadId: 'thread-1',
    text: 'hello',
    attachments: [] as Array<{ url: string }>,
    author: { fullName: 'User', userId: 'user-1' },
    ...overrides,
  };
}

describe('createBot', () => {
  beforeEach(() => {
    startGatewayListenerMock.mockReset();
    initializeMock.mockClear();
    shutdownMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries gateway startup after a non-ok response', async () => {
    vi.useFakeTimers();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    startGatewayListenerMock
      .mockResolvedValueOnce(new Response('gateway failed', { status: 500 }))
      .mockImplementationOnce(
        async (
          handlers: { waitUntil(task: Promise<unknown>): void },
          _durationMs: number,
          signal: AbortSignal,
        ) => {
          handlers.waitUntil(
            new Promise<void>((resolve) => {
              signal.addEventListener('abort', () => resolve(), { once: true });
            }),
          );

          return new Response(null, { status: 200 });
        },
      );

    const bot = createBot(baseConfig, agentStub);
    await bot.startGatewayLoop();

    expect(startGatewayListenerMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(startGatewayListenerMock).toHaveBeenCalledTimes(2);
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Discord gateway listener failed to start'),
      expect.any(Error),
    );

    await bot.shutdown();
  });

  it('serializes concurrent messages on the same thread', async () => {
    vi.useFakeTimers();
    const executionOrder: string[] = [];

    const agent: IAgent = {
      async handleMessage(_threadId, text): Promise<string> {
        executionOrder.push(`start:${text}`);
        await new Promise((r) => setTimeout(r, 50));
        executionOrder.push(`end:${text}`);
        return `reply:${text}`;
      },
      async summarizeSession(): Promise<string> {
        return 'summary';
      },
    };

    const bot = createBot(baseConfig, agent);
    const chat = bot.chat as unknown as {
      _getSubscribedMessageHandlers(): ((thread: unknown, message: unknown) => Promise<void>)[];
    };
    const handlers = chat._getSubscribedMessageHandlers();
    expect(handlers).toHaveLength(1);
    const handler = handlers[0]!;

    const { thread } = createMockThread();

    const msgA = createMessage({ id: 'message-a', text: 'A' });
    const msgB = createMessage({ id: 'message-b', text: 'B' });

    // Fire both messages concurrently on the same thread
    const pendingResults = Promise.all([
      handler(thread, msgA),
      handler(thread, msgB),
    ]);
    await vi.runAllTimersAsync();
    const [resultA, resultB] = await pendingResults;

    // Both should complete without error
    expect(resultA).toBeUndefined();
    expect(resultB).toBeUndefined();

    // A must fully complete before B starts
    expect(executionOrder).toEqual(['start:A', 'end:A', 'start:B', 'end:B']);
  });


  it('passes author userId into agent.handleMessage options', async () => {
    const handleMessage = vi.fn(async () => 'reply');
    const agent: IAgent = {
      handleMessage,
      async summarizeSession(): Promise<string> {
        return 'summary';
      },
    };
    const bot = createBot(baseConfig, agent);
    const chat = bot.chat as unknown as {
      _getSubscribedMessageHandlers(): ((thread: unknown, message: unknown) => Promise<void>)[];
    };
    const handler = chat._getSubscribedMessageHandlers()[0]!;
    const { thread } = createMockThread();

    await handler(thread, createMessage({ author: { fullName: 'User', userId: 'admin-1' } }));

    expect(handleMessage).toHaveBeenCalledWith(
      'thread-1',
      'hello',
      'User',
      expect.objectContaining({ userId: 'admin-1' }),
    );
  });

  it('reports new-message handler errors to the report channel', async () => {
    const messageSink = { postMessage: vi.fn(async () => {}) };
    const agent: IAgent = {
      async handleMessage(): Promise<string> {
        throw new Error('boom detail');
      },
      async summarizeSession(): Promise<string> {
        return 'summary';
      },
    };

    const bot = createBot({ ...baseConfig, reportChannelId: 'report' }, agent, { messageSink });
    const chat = bot.chat as unknown as {
      _getNewMessageHandlers(): ((thread: unknown, message: unknown) => Promise<void>)[];
    };
    const handler = chat._getNewMessageHandlers()[0]!;
    const { thread } = createMockThread();

    await expect(handler(thread, createMessage())).resolves.toBeUndefined();

    expect(thread.post).toHaveBeenCalledWith(expect.stringContaining('エラーが発生しました'));
    expect(messageSink.postMessage).toHaveBeenCalledWith(
      'report',
      '❌ Chat error (message: message-1)\nboom detail',
    );
  });

  it('reports subscribed-message handler errors to the report channel', async () => {
    const messageSink = { postMessage: vi.fn(async () => {}) };
    const agent: IAgent = {
      async handleMessage(): Promise<string> {
        throw new Error('boom detail');
      },
      async summarizeSession(): Promise<string> {
        return 'summary';
      },
    };

    const bot = createBot({ ...baseConfig, reportChannelId: 'report' }, agent, { messageSink });
    const chat = bot.chat as unknown as {
      _getSubscribedMessageHandlers(): ((thread: unknown, message: unknown) => Promise<void>)[];
    };
    const handler = chat._getSubscribedMessageHandlers()[0]!;
    const { thread } = createMockThread();

    await expect(handler(thread, createMessage())).resolves.toBeUndefined();

    expect(thread.post).toHaveBeenCalledWith(expect.stringContaining('エラーが発生しました'));
    expect(messageSink.postMessage).toHaveBeenCalledWith(
      'report',
      '❌ Chat error (message: message-1)\nboom detail',
    );
  });

  it('reports chat errors even when posting the user-facing error reply fails', async () => {
    const messageSink = { postMessage: vi.fn(async () => {}) };
    const agent: IAgent = {
      async handleMessage(): Promise<string> {
        throw new Error('boom detail');
      },
      async summarizeSession(): Promise<string> {
        return 'summary';
      },
    };

    const bot = createBot({ ...baseConfig, reportChannelId: 'report' }, agent, { messageSink });
    const chat = bot.chat as unknown as {
      _getSubscribedMessageHandlers(): ((thread: unknown, message: unknown) => Promise<void>)[];
    };
    const handler = chat._getSubscribedMessageHandlers()[0]!;
    const { thread } = createMockThread();
    thread.post.mockRejectedValueOnce(new Error('post failed'));

    await expect(handler(thread, createMessage())).resolves.toBeUndefined();

    expect(messageSink.postMessage).toHaveBeenCalledWith(
      'report',
      '❌ Chat error (message: message-1)\nboom detail',
    );
  });

  it('does not crash when reporting a chat error fails', async () => {
    const messageSink = { postMessage: vi.fn(async () => { throw new Error('report failed'); }) };
    const agent: IAgent = {
      async handleMessage(): Promise<string> {
        throw new Error('boom detail');
      },
      async summarizeSession(): Promise<string> {
        return 'summary';
      },
    };

    const bot = createBot({ ...baseConfig, reportChannelId: 'report' }, agent, { messageSink });
    const chat = bot.chat as unknown as {
      _getSubscribedMessageHandlers(): ((thread: unknown, message: unknown) => Promise<void>)[];
    };
    const handler = chat._getSubscribedMessageHandlers()[0]!;
    const { thread } = createMockThread();

    await expect(handler(thread, createMessage())).resolves.toBeUndefined();
    expect(thread.post).toHaveBeenCalledWith(expect.stringContaining('エラーが発生しました'));
  });

  it('replies with attachment-only message when text is empty', async () => {
    const agent: IAgent = {
      async handleMessage(): Promise<string> {
        throw new Error('should not be called');
      },
      async summarizeSession(): Promise<string> {
        return 'summary';
      },
    };

    const bot = createBot(baseConfig, agent);
    const chat = bot.chat as unknown as {
      _getNewMessageHandlers(): ((thread: unknown, message: unknown) => Promise<void>)[];
      _getSubscribedMessageHandlers(): ((thread: unknown, message: unknown) => Promise<void>)[];
    };

    const { thread } = createMockThread();

    // Test onNewMessage handler
    const newHandler = chat._getNewMessageHandlers()[0]!;
    const attachmentOnlyMsg = createMessage({
      id: 'message-new',
      threadId: 'thread-new',
      text: '',
      attachments: [{ url: 'file.png' }],
    });

    await newHandler(thread, attachmentOnlyMsg);
    expect(thread.post).toHaveBeenCalledWith(
      expect.stringContaining('テキストメッセージのみ'),
    );

    // Test onSubscribedMessage handler
    thread.post.mockClear();
    const subHandler = chat._getSubscribedMessageHandlers()[0]!;
    await subHandler(thread, attachmentOnlyMsg);
    expect(thread.post).toHaveBeenCalledWith(
      expect.stringContaining('テキストメッセージのみ'),
    );
  });

  it('sends attachment warning when message has both text and attachments', async () => {
    vi.useFakeTimers();
    const agent: IAgent = {
      async handleMessage(): Promise<string> {
        return 'response';
      },
      async summarizeSession(): Promise<string> {
        return 'summary';
      },
    };

    const bot = createBot(baseConfig, agent);
    const chat = bot.chat as unknown as {
      _getSubscribedMessageHandlers(): ((thread: unknown, message: unknown) => Promise<void>)[];
    };
    const handler = chat._getSubscribedMessageHandlers()[0]!;

    const { thread } = createMockThread();
    const msgWithAttachment = createMessage({
      attachments: [{ url: 'file.png' }],
    });

    const task = handler(thread, msgWithAttachment);
    await vi.runAllTimersAsync();
    await task;
    expect(thread.post).toHaveBeenCalledWith(
      expect.stringContaining('添付ファイルは現在未対応'),
    );
    expect(thread.post).toHaveBeenCalledWith('response');
  });

  it('does not subscribe when new message has no processable text', async () => {
    const bot = createBot(baseConfig, agentStub);
    const chat = bot.chat as unknown as {
      _getNewMessageHandlers(): ((thread: unknown, message: unknown) => Promise<void>)[];
    };
    const handler = chat._getNewMessageHandlers()[0]!;

    const { thread } = createMockThread();

    // Attachment-only message should not trigger subscribe
    await handler(thread, createMessage({
      id: 'message-new',
      threadId: 'thread-new',
      text: '',
      attachments: [{ url: 'file.png' }],
    }));
    expect(thread.subscribe).not.toHaveBeenCalled();

    // Whitespace-only message should not trigger subscribe
    await handler(thread, createMessage({
      id: 'message-new2',
      threadId: 'thread-new2',
      text: '   ',
    }));
    expect(thread.subscribe).not.toHaveBeenCalled();
  });

  it('allows concurrent messages on different threads', async () => {
    vi.useFakeTimers();
    const executionOrder: string[] = [];

    const agent: IAgent = {
      async handleMessage(_threadId, text): Promise<string> {
        executionOrder.push(`start:${text}`);
        await new Promise((r) => setTimeout(r, 50));
        executionOrder.push(`end:${text}`);
        return `reply:${text}`;
      },
      async summarizeSession(): Promise<string> {
        return 'summary';
      },
    };

    const bot = createBot(baseConfig, agent);
    const chat = bot.chat as unknown as {
      _getSubscribedMessageHandlers(): ((thread: unknown, message: unknown) => Promise<void>)[];
    };
    const handler = chat._getSubscribedMessageHandlers()[0]!;

    const { thread } = createMockThread();

    const pendingResults = Promise.all([
      handler(thread, createMessage({ id: 'message-a', threadId: 'thread-1', text: 'A' })),
      handler(thread, createMessage({ id: 'message-b', threadId: 'thread-2', text: 'B' })),
    ]);
    await vi.runAllTimersAsync();
    await pendingResults;

    // Different threads should run concurrently: both start before either ends
    expect(executionOrder[0]).toBe('start:A');
    expect(executionOrder[1]).toBe('start:B');
  });

  it('shows the status reaction lifecycle for a successful response', async () => {
    vi.useFakeTimers();
    const agent: IAgent = {
      async handleMessage(_threadId, _text, _userName, options): Promise<string> {
        await new Promise((resolve) => setTimeout(resolve, 10));
        options?.lifecycle?.onToolCallStart('webFetch');
        await new Promise((resolve) => setTimeout(resolve, 10));
        options?.lifecycle?.onToolCallFinish('webFetch');
        await new Promise((resolve) => setTimeout(resolve, 10));
        return 'response';
      },
      async summarizeSession(): Promise<string> {
        return 'summary';
      },
    };

    const bot = createBot(baseConfig, agent);
    const chat = bot.chat as unknown as {
      _getSubscribedMessageHandlers(): ((thread: unknown, message: unknown) => Promise<void>)[];
    };
    const handler = chat._getSubscribedMessageHandlers()[0]!;
    const { thread, reactionEvents } = createMockThread();

    const task = handler(thread, createMessage());
    await vi.runAllTimersAsync();
    await task;

    expect(reactionEvents).toEqual([
      `add:thread-1:message-1:${STATUS_EMOJI.queued}`,
      `remove:thread-1:message-1:${STATUS_EMOJI.queued}`,
      `add:thread-1:message-1:${STATUS_EMOJI.thinking}`,
      `remove:thread-1:message-1:${STATUS_EMOJI.thinking}`,
      `add:thread-1:message-1:${STATUS_EMOJI.web}`,
      `remove:thread-1:message-1:${STATUS_EMOJI.web}`,
      `add:thread-1:message-1:${STATUS_EMOJI.thinking}`,
      `remove:thread-1:message-1:${STATUS_EMOJI.thinking}`,
      `add:thread-1:message-1:${STATUS_EMOJI.done}`,
      `remove:thread-1:message-1:${STATUS_EMOJI.done}`,
    ]);
    expect(thread.startTyping).toHaveBeenCalledTimes(1);
    expect(thread.post).toHaveBeenCalledWith('response');
  });

  it('leaves the error reaction applied when handling fails', async () => {
    vi.useFakeTimers();
    const agent: IAgent = {
      async handleMessage(): Promise<string> {
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new Error('boom');
      },
      async summarizeSession(): Promise<string> {
        return 'summary';
      },
    };

    const bot = createBot(baseConfig, agent);
    const chat = bot.chat as unknown as {
      _getSubscribedMessageHandlers(): ((thread: unknown, message: unknown) => Promise<void>)[];
    };
    const handler = chat._getSubscribedMessageHandlers()[0]!;
    const { thread, reactionEvents } = createMockThread();

    const task = handler(thread, createMessage());
    await vi.runAllTimersAsync();
    await task;
    await vi.advanceTimersByTimeAsync(DONE_REACTION_DURATION_MS * 2);

    expect(reactionEvents).toEqual([
      `add:thread-1:message-1:${STATUS_EMOJI.queued}`,
      `remove:thread-1:message-1:${STATUS_EMOJI.queued}`,
      `add:thread-1:message-1:${STATUS_EMOJI.thinking}`,
      `remove:thread-1:message-1:${STATUS_EMOJI.thinking}`,
      `add:thread-1:message-1:${STATUS_EMOJI.error}`,
    ]);
    expect(thread.post).toHaveBeenCalledWith(
      expect.stringContaining('エラーが発生しました'),
    );
  });

  it('shows queued immediately for messages waiting on the thread mutex', async () => {
    vi.useFakeTimers();
    const firstMessageGate = createDeferred();
    const agent: IAgent = {
      async handleMessage(_threadId, text): Promise<string> {
        if (text === 'A') {
          await firstMessageGate.promise;
        }
        return `reply:${text}`;
      },
      async summarizeSession(): Promise<string> {
        return 'summary';
      },
    };

    const bot = createBot(baseConfig, agent);
    const chat = bot.chat as unknown as {
      _getSubscribedMessageHandlers(): ((thread: unknown, message: unknown) => Promise<void>)[];
    };
    const handler = chat._getSubscribedMessageHandlers()[0]!;
    const { thread, reactionEvents } = createMockThread();

    const taskA = handler(thread, createMessage({ id: 'message-a', text: 'A' }));
    await Promise.resolve();

    const taskB = handler(thread, createMessage({ id: 'message-b', text: 'B' }));
    await Promise.resolve();

    expect(reactionEvents).toContain(
      `add:thread-1:message-b:${STATUS_EMOJI.queued}`,
    );

    firstMessageGate.resolve();
    await vi.runAllTimersAsync();
    await Promise.all([taskA, taskB]);
  });
});
