import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBot } from '../src/bot.js';
import type { IAgent } from '../src/agent/core.js';
import type { Config } from '../src/config.js';

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
      'Discord gateway listener failed to start',
      expect.any(Error),
    );

    await bot.shutdown();
  });

  it('serializes concurrent messages on the same thread', async () => {
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

    const mockThread = {
      subscribe: vi.fn(),
      startTyping: vi.fn(),
      post: vi.fn(),
    };

    const msgA = { threadId: 'thread-1', text: 'A', attachments: [], author: { fullName: 'User' } };
    const msgB = { threadId: 'thread-1', text: 'B', attachments: [], author: { fullName: 'User' } };

    // Fire both messages concurrently on the same thread
    const [resultA, resultB] = await Promise.all([
      handler(mockThread, msgA),
      handler(mockThread, msgB),
    ]);

    // Both should complete without error
    expect(resultA).toBeUndefined();
    expect(resultB).toBeUndefined();

    // A must fully complete before B starts
    expect(executionOrder).toEqual(['start:A', 'end:A', 'start:B', 'end:B']);
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

    const mockThread = {
      subscribe: vi.fn(),
      startTyping: vi.fn(),
      post: vi.fn(),
    };

    // Test onNewMessage handler
    const newHandler = chat._getNewMessageHandlers()[0]!;
    const attachmentOnlyMsg = {
      threadId: 'thread-new',
      text: '',
      attachments: [{ url: 'file.png' }],
      author: { fullName: 'User' },
    };

    await newHandler(mockThread, attachmentOnlyMsg);
    expect(mockThread.post).toHaveBeenCalledWith(
      expect.stringContaining('テキストメッセージのみ'),
    );

    // Test onSubscribedMessage handler
    mockThread.post.mockClear();
    const subHandler = chat._getSubscribedMessageHandlers()[0]!;
    await subHandler(mockThread, attachmentOnlyMsg);
    expect(mockThread.post).toHaveBeenCalledWith(
      expect.stringContaining('テキストメッセージのみ'),
    );
  });

  it('sends attachment warning when message has both text and attachments', async () => {
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

    const mockThread = {
      subscribe: vi.fn(),
      startTyping: vi.fn(),
      post: vi.fn(),
    };

    const msgWithAttachment = {
      threadId: 'thread-1',
      text: 'hello',
      attachments: [{ url: 'file.png' }],
      author: { fullName: 'User' },
    };

    await handler(mockThread, msgWithAttachment);
    expect(mockThread.post).toHaveBeenCalledWith(
      expect.stringContaining('添付ファイルは現在未対応'),
    );
    expect(mockThread.post).toHaveBeenCalledWith('response');
  });

  it('does not subscribe when new message has no processable text', async () => {
    const bot = createBot(baseConfig, agentStub);
    const chat = bot.chat as unknown as {
      _getNewMessageHandlers(): ((thread: unknown, message: unknown) => Promise<void>)[];
    };
    const handler = chat._getNewMessageHandlers()[0]!;

    const mockThread = {
      subscribe: vi.fn(),
      startTyping: vi.fn(),
      post: vi.fn(),
    };

    // Attachment-only message should not trigger subscribe
    await handler(mockThread, {
      threadId: 'thread-new',
      text: '',
      attachments: [{ url: 'file.png' }],
      author: { fullName: 'User' },
    });
    expect(mockThread.subscribe).not.toHaveBeenCalled();

    // Whitespace-only message should not trigger subscribe
    await handler(mockThread, {
      threadId: 'thread-new2',
      text: '   ',
      attachments: [],
      author: { fullName: 'User' },
    });
    expect(mockThread.subscribe).not.toHaveBeenCalled();
  });

  it('allows concurrent messages on different threads', async () => {
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

    const mockThread = {
      subscribe: vi.fn(),
      startTyping: vi.fn(),
      post: vi.fn(),
    };

    const msgA = { threadId: 'thread-1', text: 'A', attachments: [], author: { fullName: 'User' } };
    const msgB = { threadId: 'thread-2', text: 'B', attachments: [], author: { fullName: 'User' } };

    await Promise.all([
      handler(mockThread, msgA),
      handler(mockThread, msgB),
    ]);

    // Different threads should run concurrently: both start before either ends
    expect(executionOrder[0]).toBe('start:A');
    expect(executionOrder[1]).toBe('start:B');
  });
});
