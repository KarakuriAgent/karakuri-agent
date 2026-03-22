import type { LanguageModel, ModelMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import { KarakuriAgent } from '../src/agent/core.js';
import { countAdditionalContextTokens } from '../src/agent/prompt.js';
import type { PromptContext } from '../src/agent/prompt-context.js';
import type { Config } from '../src/config.js';
import type { DiaryEntry, IMemoryStore } from '../src/memory/types.js';
import type { ISessionManager, SessionData } from '../src/session/types.js';
import type { ISkillStore, SkillDefinition } from '../src/skill/types.js';
import type { IMessageSink, ISchedulerStore } from '../src/scheduler/types.js';

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

class MemoryStoreStub implements IMemoryStore {
  constructor(
    private coreMemory = '',
    private diaries: DiaryEntry[] = [],
  ) {}

  async readCoreMemory(): Promise<string> {
    return this.coreMemory;
  }

  async writeCoreMemory(content: string): Promise<void> {
    this.coreMemory += content;
  }

  async readDiary(date: string): Promise<string | null> {
    return this.diaries.find((entry) => entry.date === date)?.content ?? null;
  }

  async writeDiary(date: string, content: string): Promise<void> {
    this.diaries.push({ date, content });
  }

  async getRecentDiaries(days: number): Promise<DiaryEntry[]> {
    return this.diaries.slice(0, days);
  }

  async listDiaryDates(): Promise<string[]> {
    return this.diaries.map((entry) => entry.date);
  }

  async close(): Promise<void> {}
}

class PromptContextStoreStub {
  constructor(private readonly context: PromptContext = { agentInstructions: null, rules: null }) {}

  async read(): Promise<PromptContext> {
    return { ...this.context };
  }

  async close(): Promise<void> {}
}

class SkillStoreStub implements ISkillStore {
  constructor(private readonly skills: SkillDefinition[] = []) {}

  async listSkills(): Promise<SkillDefinition[]> {
    return this.skills.map((skill) => ({ ...skill }));
  }

  async getSkill(name: string): Promise<SkillDefinition | null> {
    return this.skills.find((skill) => skill.name === name) ?? null;
  }

  async close(): Promise<void> {}
}

class SessionManagerStub implements ISessionManager {
  session: SessionData = {
    schemaVersion: 1,
    sessionId: 'session-1',
    messages: [],
    summary: null,
    createdAt: new Date('2025-01-01T00:00:00.000Z').toISOString(),
    updatedAt: new Date('2025-01-01T00:00:00.000Z').toISOString(),
  };
  lastAdditionalTokens = 0;
  forceSummarization = false;
  appliedSummary: string | null = null;

  async loadSession(sessionId: string): Promise<SessionData> {
    return { ...this.session, sessionId };
  }

  async saveSession(session: SessionData): Promise<void> {
    this.session = session;
  }

  async addMessages(sessionId: string, messages: ModelMessage[]): Promise<SessionData> {
    this.session = {
      ...this.session,
      sessionId,
      messages: [...this.session.messages, ...messages],
      updatedAt: new Date('2025-01-01T00:00:00.000Z').toISOString(),
    };
    return this.session;
  }

  needsSummarization(session: SessionData, additionalTokens: number): boolean {
    this.session = session;
    this.lastAdditionalTokens = additionalTokens;
    return this.forceSummarization;
  }

  async applySummary(sessionId: string, summary: string): Promise<SessionData> {
    this.appliedSummary = summary;
    this.session = {
      ...this.session,
      sessionId,
      summary,
      messages: this.session.messages.slice(-1),
    };
    return this.session;
  }
}

function assistantMessage(content: string): ModelMessage {
  return { role: 'assistant', content };
}

function makeGenerateTextResult(text: string, messages: ModelMessage[]) {
  return {
    text,
    steps: [],
    response: {
      id: 'response-id',
      modelId: 'gpt-4o',
      timestamp: new Date(),
      messages,
    },
  } as const;
}

describe('KarakuriAgent', () => {
  it('passes prompt-ready memory and diary tokens into the summarization decision', async () => {
    const memoryStore = new MemoryStoreStub('core memory', [
      { date: '2025-01-02', content: 'diary note' },
    ]);
    const sessionManager = new SessionManagerStub();
    const generateTextFn = vi.fn(async () =>
      makeGenerateTextResult('reply', [assistantMessage('reply')]),
    ) as unknown as typeof import('ai').generateText;
    const promptContextStore = new PromptContextStoreStub({
      agentInstructions: 'Custom agent',
      rules: 'Ask before guessing.',
    });
    const skillStore = new SkillStoreStub([
      {
        name: 'code-review',
        description: 'Review code',
        instructions: 'Check security first.',
        enabled: true,
      },
    ]);

    const agent = new KarakuriAgent({
      config: baseConfig,
      memoryStore,
      sessionManager,
      promptContextStore,
      skillStore,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await agent.handleMessage('session-1', 'hello', 'Alice');

    expect(sessionManager.lastAdditionalTokens).toBe(
      countAdditionalContextTokens('core memory', [{ date: '2025-01-02', content: 'diary note' }], {
        agentInstructions: 'Custom agent',
        rules: 'Ask before guessing.',
        skills: [
          {
            name: 'code-review',
            description: 'Review code',
            instructions: 'Check security first.',
            enabled: true,
          },
        ],
      }),
    );
  });

  it('summarizes before answering when the session manager requests compression', async () => {
    const memoryStore = new MemoryStoreStub('core memory');
    const sessionManager = new SessionManagerStub();
    sessionManager.forceSummarization = true;

    const generateTextFn = vi
      .fn()
      .mockResolvedValueOnce(makeGenerateTextResult('summary text', []))
      .mockResolvedValueOnce(makeGenerateTextResult('final reply', [assistantMessage('final reply')])) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: baseConfig,
      memoryStore,
      sessionManager,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await expect(agent.handleMessage('session-1', 'compress this', 'Alice')).resolves.toBe(
      'final reply',
    );

    expect(sessionManager.appliedSummary).toBe('summary text');
    expect(vi.mocked(generateTextFn)).toHaveBeenCalledTimes(2);
  });

  it('builds a tagged system prompt and persists response messages', async () => {
    const memoryStore = new MemoryStoreStub('persistent fact', [
      { date: '2025-01-02', content: 'recent diary' },
    ]);
    const sessionManager = new SessionManagerStub();
    sessionManager.session.summary = 'previous summary';

    let capturedSystem = '';
    const generateTextFn = vi.fn(async (options: { system?: string }) => {
      capturedSystem = options.system ?? '';
      return makeGenerateTextResult('reply', [assistantMessage('reply')]);
    }) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: baseConfig,
      memoryStore,
      sessionManager,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await agent.handleMessage('session-1', 'hi', 'Alice');

    expect(capturedSystem).toContain('<memory>');
    expect(capturedSystem).toContain('<diary>');
    expect(capturedSystem).toContain('<summary>');
    expect(sessionManager.session.messages).toContainEqual(assistantMessage('reply'));
  });

  it('injects prompt context, skill listings, and the loadSkill tool when skills are available', async () => {
    const memoryStore = new MemoryStoreStub();
    const sessionManager = new SessionManagerStub();
    let capturedSystem = '';
    let capturedTools: Record<string, unknown> = {};

    const generateTextFn = vi.fn(async (options: { system?: string; tools?: Record<string, unknown> }) => {
      capturedSystem = options.system ?? '';
      capturedTools = options.tools ?? {};
      return makeGenerateTextResult('reply', [assistantMessage('reply')]);
    }) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: baseConfig,
      memoryStore,
      sessionManager,
      promptContextStore: new PromptContextStoreStub({
        agentInstructions: 'You are custom.',
        rules: 'Be precise.',
      }),
      skillStore: new SkillStoreStub([
        {
          name: 'code-review',
          description: 'Review code',
          instructions: 'Check security first.',
          enabled: true,
        },
      ]),
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await agent.handleMessage('session-1', 'hi', 'Alice');

    expect(capturedSystem).toContain('You are custom.');
    expect(capturedSystem).toContain('Be precise.');
    expect(capturedSystem).toContain('Available skills:\n- code-review: Review code');
    expect(capturedSystem).toContain('- loadSkill: load the full content of a skill by name.');
    expect(capturedTools).toHaveProperty('loadSkill');
  });

  it('always exposes webFetch and only enables webSearch when BRAVE_API_KEY is configured', async () => {
    const memoryStore = new MemoryStoreStub();
    const sessionManager = new SessionManagerStub();
    let capturedSystem = '';
    let capturedTools: Record<string, unknown> = {};

    const generateTextFn = vi.fn(async (options: { system?: string; tools?: Record<string, unknown> }) => {
      capturedSystem = options.system ?? '';
      capturedTools = options.tools ?? {};
      return makeGenerateTextResult('reply', [assistantMessage('reply')]);
    }) as unknown as typeof import('ai').generateText;

    const agentWithoutSearch = new KarakuriAgent({
      config: baseConfig,
      memoryStore,
      sessionManager,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await agentWithoutSearch.handleMessage('session-1', 'hi', 'Alice');

    expect(capturedTools).toHaveProperty('webFetch');
    expect(capturedTools).not.toHaveProperty('webSearch');
    expect(capturedSystem).toContain('- webFetch: fetch a URL and extract its readable content as Markdown.');
    expect(capturedSystem).not.toContain('- webSearch: search the web via Brave Search.');

    const agentWithSearch = new KarakuriAgent({
      config: { ...baseConfig, braveApiKey: 'brave-key' },
      memoryStore,
      sessionManager,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await agentWithSearch.handleMessage('session-2', 'hi', 'Alice');

    expect(capturedTools).toHaveProperty('webFetch');
    expect(capturedTools).toHaveProperty('webSearch');
    expect(capturedSystem).toContain('- webSearch: search the web via Brave Search.');
  });

  it('wires lifecycle callbacks into generateText when provided', async () => {
    const memoryStore = new MemoryStoreStub();
    const sessionManager = new SessionManagerStub();
    const lifecycleEvents: string[] = [];

    const generateTextFn = vi.fn(async (options: {
      experimental_onStepStart?: (event: unknown) => void;
      experimental_onToolCallStart?: (event: { toolCall: { toolName: string } }) => void;
      experimental_onToolCallFinish?: (event: { toolCall: { toolName: string } }) => void;
    }) => {
      options.experimental_onStepStart?.({} as never);
      options.experimental_onToolCallStart?.({ toolCall: { toolName: 'saveMemory' } } as never);
      options.experimental_onToolCallFinish?.({ toolCall: { toolName: 'saveMemory' } } as never);
      return makeGenerateTextResult('reply', [assistantMessage('reply')]);
    }) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: baseConfig,
      memoryStore,
      sessionManager,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await agent.handleMessage('session-1', 'hi', 'Alice', {
      lifecycle: {
        onThinking: () => {
          lifecycleEvents.push('thinking');
        },
        onToolCallStart: (toolName) => {
          lifecycleEvents.push(`start:${toolName}`);
        },
        onToolCallFinish: (toolName) => {
          lifecycleEvents.push(`finish:${toolName}`);
        },
      },
    });

    expect(lifecycleEvents).toEqual([
      'thinking',
      'start:saveMemory',
      'finish:saveMemory',
    ]);
  });

  it('does not register lifecycle callbacks when options are omitted', async () => {
    const memoryStore = new MemoryStoreStub();
    const sessionManager = new SessionManagerStub();
    let capturedOptions:
      | {
          experimental_onStepStart?: unknown;
          experimental_onToolCallStart?: unknown;
          experimental_onToolCallFinish?: unknown;
        }
      | undefined;

    const generateTextFn = vi.fn(async (options: Record<string, unknown>) => {
      capturedOptions = options as {
        experimental_onStepStart?: unknown;
        experimental_onToolCallStart?: unknown;
        experimental_onToolCallFinish?: unknown;
      };
      return makeGenerateTextResult('reply', [assistantMessage('reply')]);
    }) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: baseConfig,
      memoryStore,
      sessionManager,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await agent.handleMessage('session-1', 'hi', 'Alice');

    expect(capturedOptions?.experimental_onStepStart).toBeUndefined();
    expect(capturedOptions?.experimental_onToolCallStart).toBeUndefined();
    expect(capturedOptions?.experimental_onToolCallFinish).toBeUndefined();
  });


  it('does not expose postMessage without allowed channels', async () => {
    const memoryStore = new MemoryStoreStub();
    const sessionManager = new SessionManagerStub();
    let capturedSystem = '';
    let capturedTools: Record<string, unknown> = {};

    const generateTextFn = vi.fn(async (options: { system?: string; tools?: Record<string, unknown> }) => {
      capturedSystem = options.system ?? '';
      capturedTools = options.tools ?? {};
      return makeGenerateTextResult('reply', [assistantMessage('reply')]);
    }) as unknown as typeof import('ai').generateText;

    const schedulerStore: ISchedulerStore = {
      readHeartbeatInstructions: async () => null,
      listCronJobs: async () => [],
      registerJob: async () => ({
        name: 'job',
        schedule: '* * * * *',
        instructions: 'run',
        enabled: true,
        sessionMode: 'isolated',
        staggerMs: 0,
      }),
      unregisterJob: async () => true,
      setReloadListener: () => {},
      close: async () => {},
    };

    const agent = new KarakuriAgent({
      config: {
        ...baseConfig,
        adminUserIds: ['admin-1'],
      },
      memoryStore,
      sessionManager,
      schedulerStore,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await agent.handleMessage('session-1', 'hi', 'Alice', {
      userId: 'system',
    });

    expect(capturedSystem).not.toContain('- postMessage: post a message to an allowed Discord channel.');
    expect(capturedTools).not.toHaveProperty('postMessage');
    expect(capturedSystem).toContain('- manageCron: register, unregister, or list cron jobs.');
    expect(capturedTools).toHaveProperty('manageCron');
  });

  it('injects extra system prompt and admin tools for system runs', async () => {
    const memoryStore = new MemoryStoreStub();
    const sessionManager = new SessionManagerStub();
    let capturedSystem = '';
    let capturedTools: Record<string, unknown> = {};

    const generateTextFn = vi.fn(async (options: { system?: string; tools?: Record<string, unknown> }) => {
      capturedSystem = options.system ?? '';
      capturedTools = options.tools ?? {};
      return makeGenerateTextResult('reply', [assistantMessage('reply')]);
    }) as unknown as typeof import('ai').generateText;

    const schedulerStore: ISchedulerStore = {
      readHeartbeatInstructions: async () => null,
      listCronJobs: async () => [],
      registerJob: async () => ({
        name: 'job',
        schedule: '* * * * *',
        instructions: 'run',
        enabled: true,
        sessionMode: 'isolated',
        staggerMs: 0,
      }),
      unregisterJob: async () => true,
      setReloadListener: () => {},
      close: async () => {},
    };
    const messageSink: IMessageSink = {
      postMessage: async () => {},
    };

    const agent = new KarakuriAgent({
      config: {
        ...baseConfig,
        postMessageChannelIds: ['channel-1'],
        allowedChannelIds: ['channel-1', 'report-1'],
        reportChannelId: 'report-1',
        adminUserIds: ['admin-1'],
      },
      memoryStore,
      sessionManager,
      schedulerStore,
      messageSink,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await agent.handleMessage('session-1', 'hi', 'Alice', {
      extraSystemPrompt: 'Run background checks.',
      userId: 'system',
    });

    expect(capturedSystem).toContain('Additional runtime instructions:');
    expect(capturedSystem).toContain('Run background checks.');
    expect(capturedSystem).toContain('- postMessage: post a message to an allowed Discord channel.');
    expect(capturedSystem).toContain('- manageCron: register, unregister, or list cron jobs.');
    expect(capturedTools).toHaveProperty('postMessage');
    expect(capturedTools).toHaveProperty('manageCron');

    const postMessageTool = capturedTools.postMessage as { inputSchema: { safeParse: (value: unknown) => { success: boolean } } };
    expect(postMessageTool.inputSchema.safeParse({ channelId: 'channel-1', text: 'ok' }).success).toBe(true);
    expect(postMessageTool.inputSchema.safeParse({ channelId: 'report-1', text: 'ok' }).success).toBe(false);
    expect(postMessageTool.inputSchema.safeParse({ channelId: 'other', text: 'ok' }).success).toBe(false);
  });

  it('exposes scheduler admin-only tools for system runs without configured admins', async () => {
    const memoryStore = new MemoryStoreStub();
    const sessionManager = new SessionManagerStub();
    let capturedSystem = '';
    let capturedTools: Record<string, unknown> = {};

    const generateTextFn = vi.fn(async (options: { system?: string; tools?: Record<string, unknown> }) => {
      capturedSystem = options.system ?? '';
      capturedTools = options.tools ?? {};
      return makeGenerateTextResult('reply', [assistantMessage('reply')]);
    }) as unknown as typeof import('ai').generateText;

    const schedulerStore: ISchedulerStore = {
      readHeartbeatInstructions: async () => null,
      listCronJobs: async () => [],
      registerJob: async () => ({
        name: 'job',
        schedule: '* * * * *',
        instructions: 'run',
        enabled: true,
        sessionMode: 'isolated',
        staggerMs: 0,
      }),
      unregisterJob: async () => true,
      setReloadListener: () => {},
      close: async () => {},
    };
    const messageSink: IMessageSink = {
      postMessage: async () => {},
    };

    const agent = new KarakuriAgent({
      config: {
        ...baseConfig,
        postMessageChannelIds: ['channel-1'],
        allowedChannelIds: ['channel-1'],
      },
      memoryStore,
      sessionManager,
      schedulerStore,
      messageSink,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await agent.handleMessage('session-1', 'hi', 'Alice', {
      userId: 'system',
    });

    expect(capturedSystem).toContain('- postMessage: post a message to an allowed Discord channel.');
    expect(capturedSystem).toContain('- manageCron: register, unregister, or list cron jobs.');
    expect(capturedTools).toHaveProperty('postMessage');
    expect(capturedTools).toHaveProperty('manageCron');
  });

  it('keeps manageCron available when only the report channel is configured', async () => {
    const memoryStore = new MemoryStoreStub();
    const sessionManager = new SessionManagerStub();
    let capturedSystem = '';
    let capturedTools: Record<string, unknown> = {};

    const generateTextFn = vi.fn(async (options: { system?: string; tools?: Record<string, unknown> }) => {
      capturedSystem = options.system ?? '';
      capturedTools = options.tools ?? {};
      return makeGenerateTextResult('reply', [assistantMessage('reply')]);
    }) as unknown as typeof import('ai').generateText;

    const schedulerStore: ISchedulerStore = {
      readHeartbeatInstructions: async () => null,
      listCronJobs: async () => [],
      registerJob: async () => ({
        name: 'job',
        schedule: '* * * * *',
        instructions: 'run',
        enabled: true,
        sessionMode: 'isolated',
        staggerMs: 0,
      }),
      unregisterJob: async () => true,
      setReloadListener: () => {},
      close: async () => {},
    };
    const messageSink: IMessageSink = {
      postMessage: async () => {},
    };

    const agent = new KarakuriAgent({
      config: {
        ...baseConfig,
        allowedChannelIds: ['report-1'],
        reportChannelId: 'report-1',
        adminUserIds: ['admin-1'],
      },
      memoryStore,
      sessionManager,
      schedulerStore,
      messageSink,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await agent.handleMessage('session-1', 'hi', 'Alice', {
      userId: 'system',
    });

    expect(capturedSystem).not.toContain('- postMessage: post a message to an allowed Discord channel.');
    expect(capturedSystem).toContain('- manageCron: register, unregister, or list cron jobs.');
    expect(capturedTools).not.toHaveProperty('postMessage');
    expect(capturedTools).toHaveProperty('manageCron');
  });

});
