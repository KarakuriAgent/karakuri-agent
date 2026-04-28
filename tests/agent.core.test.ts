import type { LanguageModel, ModelMessage } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  runExclusiveMemoryPersistence: vi.fn(async <T>(task: () => Promise<T>) => await task()),
}));

vi.mock('../src/memory/persistence-mutex.js', () => ({
  runExclusiveMemoryPersistence: mockState.runExclusiveMemoryPersistence,
}));

import { countAdditionalContextTokens } from '../src/agent/prompt.js';
import { KarakuriAgent } from '../src/agent/core.js';
import { formatDateTimeInTimezone } from '../src/utils/date.js';
import { KeyedMutex } from '../src/utils/mutex.js';
import type { PromptContext } from '../src/agent/prompt-context.js';
import type { Config } from '../src/config.js';
import { DEFAULT_LLM_MODEL, createOpenAiModelFactory, parseModelSelector } from '../src/llm/model-selector.js';
import type { DiaryEntry, IMemoryStore } from '../src/memory/types.js';
import type { IMessageSink, ISchedulerStore } from '../src/scheduler/types.js';
import type { ISessionManager, SessionData } from '../src/session/types.js';
import { SkillContextRegistry } from '../src/skill/context-provider.js';
import type { ISkillStore, SkillDefinition, SkillFilterOptions } from '../src/skill/types.js';
import type { IUserStore, UserRecord, UserSearchOptions } from '../src/user/types.js';

const baseConfig: Config = {
  discordApplicationId: 'app',
  discordBotToken: 'token',
  discordPublicKey: 'public',
  llmApiKey: 'openai',
  dataDir: '/tmp/karakuri-agent-test',
  timezone: 'Asia/Tokyo',
  llmModel: DEFAULT_LLM_MODEL,
  llmModelSelector: parseModelSelector(DEFAULT_LLM_MODEL),
  maxSteps: 4,
  tokenBudget: 200,
  port: 3000,
  snsLoopMinIntervalMinutes: 60,
  snsLoopMaxIntervalMinutes: 180,
  llmEnableThinking: true,
};

class MemoryStoreStub implements IMemoryStore {
  coreWrites: string[] = [];
  diaryWrites: Array<{ date: string; content: string }> = [];

  constructor(
    private coreMemory = '',
    private diaries: DiaryEntry[] = [],
  ) {}

  async readCoreMemory(): Promise<string> {
    return this.coreMemory;
  }

  async writeCoreMemory(content: string, mode: 'append' | 'overwrite'): Promise<void> {
    this.coreWrites.push(content);
    if (mode === 'overwrite') {
      this.coreMemory = content;
      return;
    }
    this.coreMemory += content;
  }

  async readDiary(date: string): Promise<string | null> {
    return this.diaries.find((entry) => entry.date === date)?.content ?? null;
  }

  async writeDiary(date: string, content: string): Promise<void> {
    this.diaryWrites.push({ date, content });
    this.diaries.push({ date, content });
  }

  async replaceDiary(date: string, content: string): Promise<void> {
    this.diaries = this.diaries.filter((entry) => entry.date !== date);
    this.diaries.push({ date, content });
  }

  async deleteDiary(date: string): Promise<boolean> {
    const before = this.diaries.length;
    this.diaries = this.diaries.filter((entry) => entry.date !== date);
    return this.diaries.length !== before;
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
  listOptions: SkillFilterOptions | undefined;
  getOptions: SkillFilterOptions | undefined;

  constructor(private readonly skills: SkillDefinition[] = []) {}

  async listSkills(options?: SkillFilterOptions): Promise<SkillDefinition[]> {
    this.listOptions = options;
    return this.skills
      .filter((skill) => options?.includeSystemOnly === true || !skill.systemOnly)
      .map((skill) => ({ ...skill }));
  }

  async getSkill(name: string, options?: SkillFilterOptions): Promise<SkillDefinition | null> {
    this.getOptions = options;
    return this.skills.find((skill) => skill.name === name && (options?.includeSystemOnly === true || !skill.systemOnly)) ?? null;
  }

  async close(): Promise<void> {}
}

class UserStoreStub implements IUserStore {
  ensureCalls: Array<{ userId: string; displayName: string }> = [];
  profileUpdates: Array<{ userId: string; profile: string | null }> = [];
  displayNameUpdates: Array<{ userId: string; displayName: string }> = [];
  users = new Map<string, UserRecord>();
  failEnsure = false;
  failGetUser = false;

  constructor(initialUsers: UserRecord[] = []) {
    for (const user of initialUsers) {
      this.users.set(user.userId, { ...user });
    }
  }

  async getUser(userId: string): Promise<UserRecord | null> {
    if (this.failGetUser) {
      throw new Error('boom');
    }
    return this.users.get(userId) ?? null;
  }

  async ensureUser(userId: string, displayName: string): Promise<UserRecord> {
    this.ensureCalls.push({ userId, displayName });
    if (this.failEnsure) {
      throw new Error('boom');
    }
    const existing = this.users.get(userId);
    if (existing != null) {
      existing.updatedAt = new Date('2025-01-01T00:00:01.000Z').toISOString();
      return { ...existing };
    }

    const created: UserRecord = {
      userId,
      displayName,
      profile: null,
      createdAt: new Date('2025-01-01T00:00:00.000Z').toISOString(),
      updatedAt: new Date('2025-01-01T00:00:00.000Z').toISOString(),
    };
    this.users.set(userId, created);
    return { ...created };
  }

  async updateProfile(userId: string, profile: string | null): Promise<void> {
    this.profileUpdates.push({ userId, profile });
    const current = this.users.get(userId);
    if (current != null) {
      current.profile = profile;
    }
  }

  async updateDisplayName(userId: string, displayName: string): Promise<void> {
    this.displayNameUpdates.push({ userId, displayName });
    const current = this.users.get(userId);
    if (current != null) {
      current.displayName = displayName;
    }
  }

  async searchUsers(query: string, options?: UserSearchOptions): Promise<UserRecord[]> {
    const normalized = query.toLowerCase();
    const users = [...this.users.values()].filter((user) =>
      user.displayName.toLowerCase().includes(normalized)
      || user.profile?.toLowerCase().includes(normalized),
    );
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? users.length;
    return users.slice(offset, offset + limit);
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
  addMessagesCalls = 0;

  async loadSession(sessionId: string): Promise<SessionData> {
    return { ...this.session, sessionId };
  }

  async saveSession(session: SessionData): Promise<void> {
    this.session = session;
  }

  async addMessages(sessionId: string, messages: ModelMessage[]): Promise<SessionData> {
    this.addMessagesCalls++;
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

function makeKwModeGenerateTextResult(comment?: string) {
  const toolCallId = 'kw-tool-1';
  const toolInput = comment == null ? {} : { comment };
  return {
    text: 'ignored kw mode text',
    steps: [{
      toolCalls: [{
        toolName: 'karakuri_world_get_map',
        input: toolInput,
      }],
      toolResults: [{
        toolName: 'karakuri_world_get_map',
        output: { ok: true, message: 'Map request accepted.' },
      }],
    }],
    response: {
      id: 'response-id',
      modelId: 'gpt-4o',
      timestamp: new Date(),
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId,
              toolName: 'karakuri_world_get_map',
              input: toolInput,
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId,
              toolName: 'karakuri_world_get_map',
              output: { ok: true, message: 'Map request accepted.' },
            },
          ],
        },
      ],
    },
  } as const;
}

function makeInvalidMultiActionKwModeGenerateTextResult() {
  return {
    text: 'ignored kw mode text',
    steps: [{
      toolCalls: [
        {
          toolName: 'karakuri_world_get_map',
          input: { comment: '周囲を確認します。' },
        },
        {
          toolName: 'karakuri_world_move',
          input: { target_node_id: '1-2', comment: '門へ向かいます。' },
        },
      ],
      toolResults: [
        {
          toolName: 'karakuri_world_get_map',
          output: { ok: true, message: 'Map request accepted.' },
        },
        {
          toolName: 'karakuri_world_move',
          output: { from_node_id: '1-1', to_node_id: '1-2', arrives_at: 42 },
        },
      ],
    }],
    response: {
      id: 'response-id',
      modelId: 'gpt-4o',
      timestamp: new Date(),
      messages: [],
    },
  } as const;
}

function makeKwModeGenerateTextResultWithOutput(comment: string, output: Record<string, unknown>) {
  const toolCallId = 'kw-tool-1';
  return {
    text: 'ignored kw mode text',
    steps: [{
      toolCalls: [{
        toolName: 'karakuri_world_move',
        input: { target_node_id: '1-2', comment },
      }],
      toolResults: [{
        toolName: 'karakuri_world_move',
        output,
      }],
    }],
    response: {
      id: 'response-id',
      modelId: 'gpt-4o',
      timestamp: new Date(),
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId,
              toolName: 'karakuri_world_move',
              input: { target_node_id: '1-2', comment },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId,
              toolName: 'karakuri_world_move',
              output,
            },
          ],
        },
      ],
    },
  } as const;
}

function makeBusyKwModeGenerateTextResult(comment: string) {
  return makeKwModeGenerateTextResultWithOutput(comment, {
    status: 'busy',
    message: 'Agent is not idle',
    instruction: 'Wait for next notification.',
  });
}

function makeNotLoggedInKwModeGenerateTextResult(comment: string) {
  return makeKwModeGenerateTextResultWithOutput(comment, {
    status: 'not_logged_in',
    message: 'Agent is not logged in.',
  });
}

function makeInvalidZeroActionKwModeGenerateTextResult() {
  return {
    text: 'ignored kw mode text',
    steps: [{
      toolCalls: [],
      toolResults: [],
    }],
    response: {
      id: 'response-id',
      modelId: 'gpt-4o',
      timestamp: new Date(),
      messages: [],
    },
  } as const;
}

function makeStructuredEvaluationResult(output: Record<string, string>) {
  return {
    text: JSON.stringify(output),
    output,
    steps: [],
    response: {
      id: 'evaluation-id',
      modelId: 'gpt-4o-mini',
      timestamp: new Date(),
      messages: [] as ModelMessage[],
    },
  } as const;
}

function createSchedulerStore(): ISchedulerStore {
  return {
    readHeartbeatInstructions: async () => null,
    listCronJobs: async () => [],
    registerJob: async () => ({
      name: 'job',
      schedule: '* * * * *',
      instructions: 'run',
      enabled: true,
      sessionMode: 'isolated',
      staggerMs: 0,
      oneshot: false,
    }),
    unregisterJob: async () => true,
    setReloadListener: () => {},
    close: async () => {},
  };
}

const EXPECTED_KW_TOOL_NAMES = [
  'karakuri_world_get_map',
  'karakuri_world_get_world_agents',
  'karakuri_world_move',
  'karakuri_world_action',
  'karakuri_world_use_item',
  'karakuri_world_transfer',
  'karakuri_world_accept_transfer',
  'karakuri_world_reject_transfer',
  'karakuri_world_wait',
  'karakuri_world_conversation_start',
  'karakuri_world_conversation_accept',
  'karakuri_world_conversation_reject',
  'karakuri_world_conversation_join',
  'karakuri_world_conversation_stay',
  'karakuri_world_conversation_leave',
  'karakuri_world_conversation_speak',
  'karakuri_world_end_conversation',
  'karakuri_world_server_event_select',
] as const;

const FAKE_NOW = new Date('2026-03-27T06:30:00Z');

describe('KarakuriAgent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FAKE_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    mockState.runExclusiveMemoryPersistence.mockReset();
    mockState.runExclusiveMemoryPersistence.mockImplementation(async <T>(task: () => Promise<T>) => await task());
  });

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
        systemOnly: false,
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
        currentDateTime: formatDateTimeInTimezone(FAKE_NOW, baseConfig.timezone),
        rules: 'Ask before guessing.',
        skills: [
          {
            name: 'code-review',
            description: 'Review code',
            instructions: 'Check security first.',
            systemOnly: false,
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

    await expect(agent.handleMessage('session-1', 'compress this', 'Alice')).resolves.toBe('final reply');

    expect(sessionManager.appliedSummary).toBe('summary text');
    expect(vi.mocked(generateTextFn)).toHaveBeenCalledTimes(2);
  });

  it('keeps ephemeral turns in memory only', async () => {
    const memoryStore = new MemoryStoreStub('core memory');
    const sessionManager = new SessionManagerStub();
    sessionManager.forceSummarization = true;
    const generateTextFn = vi.fn(async () =>
      makeGenerateTextResult('ephemeral reply', [assistantMessage('ephemeral reply')]),
    ) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: baseConfig,
      memoryStore,
      sessionManager,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await expect(agent.handleMessage('heartbeat:2025-01-01T00:00:00.000Z', '(heartbeat tick)', 'heartbeat', {
      userId: 'system',
      ephemeral: true,
    })).resolves.toBe('ephemeral reply');

    expect(sessionManager.addMessagesCalls).toBe(0);
    expect(sessionManager.appliedSummary).toBeNull();
    expect(sessionManager.session.messages).toEqual([]);
  });

  it('builds a tagged system prompt and persists response messages', async () => {
    const memoryStore = new MemoryStoreStub('persistent fact', [
      { date: '2025-01-02', content: 'recent diary' },
    ]);
    const sessionManager = new SessionManagerStub();
    sessionManager.session.summary = 'previous summary';

    let capturedSystem = '';
    const generateTextFn = vi.fn(async (options: { system?: string; output?: unknown }) => {
      if (options.output != null) {
        return makeStructuredEvaluationResult({
          profileAction: 'none',
          profile: '',
          displayName: '',
          coreMemoryAppend: '',
          diaryEntry: '',
        });
      }
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


  it('hides system-only skills from normal users', async () => {
    const memoryStore = new MemoryStoreStub();
    const sessionManager = new SessionManagerStub();
    let capturedSystem = '';
    let capturedTools: Record<string, unknown> = {};
    const skillStore = new SkillStoreStub([
      {
        name: 'system-skill',
        description: 'System automation',
        instructions: 'Run scheduled maintenance.',
        systemOnly: true,
      },
    ]);

    const generateTextFn = vi.fn(async (options: { system?: string; tools?: Record<string, unknown> }) => {
      capturedSystem = options.system ?? '';
      capturedTools = options.tools ?? {};
      return makeGenerateTextResult('reply', [assistantMessage('reply')]);
    }) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: baseConfig,
      memoryStore,
      sessionManager,
      skillStore,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await agent.handleMessage('session-1', 'hello', 'Alice', { userId: 'user-123' });

    expect(skillStore.listOptions).toBeUndefined();
    expect(capturedSystem).not.toContain('system-skill');
    expect(capturedSystem).not.toContain('Available skills');
    expect(capturedTools).not.toHaveProperty('loadSkill');
  });

  it('includes system-only skills for the system user and allows loading them', async () => {
    const memoryStore = new MemoryStoreStub();
    const sessionManager = new SessionManagerStub();
    let capturedSystem = '';
    let capturedTools: Record<string, unknown> = {};
    const skillStore = new SkillStoreStub([
      {
        name: 'system-skill',
        description: 'System automation',
        instructions: 'Run scheduled maintenance.',
        systemOnly: true,
      },
    ]);

    const generateTextFn = vi.fn(async (options: { system?: string; tools?: Record<string, unknown> }) => {
      capturedSystem = options.system ?? '';
      capturedTools = options.tools ?? {};
      return makeGenerateTextResult('reply', [assistantMessage('reply')]);
    }) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: baseConfig,
      memoryStore,
      sessionManager,
      skillStore,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await agent.handleMessage('session-1', 'run maintenance', 'System', { userId: 'system' });

    expect(skillStore.listOptions).toEqual({ includeSystemOnly: true });
    expect(capturedSystem).toContain('Available skills:\n- system-skill: System automation');
    expect(capturedTools).toHaveProperty('loadSkill');

    const loadSkillTool = capturedTools.loadSkill as { execute: (input: { name: string }, options: unknown) => Promise<unknown> };
    await expect(loadSkillTool.execute(
      { name: 'system-skill' },
      { toolCallId: 'tool-1', messages: [] },
    )).resolves.toEqual({
      loaded: true,
      name: 'system-skill',
      description: 'System automation',
      instructions: 'Run scheduled maintenance.',
    });
    expect(skillStore.getOptions).toEqual({ includeSystemOnly: true });
  });

  it('auto-loads builtin sns skill context and tools when explicitly requested', async () => {
    const memoryStore = new MemoryStoreStub();
    const sessionManager = new SessionManagerStub();
    let capturedSystem = '';
    let capturedTools: Record<string, unknown> = {};
    const registry = new SkillContextRegistry();
    registry.register('sns', {
      getContext: async () => ({ text: '## 新着通知\n- なし' }),
    });

    const generateTextFn = vi.fn(async (options: { system?: string; tools?: Record<string, unknown> }) => {
      capturedSystem = options.system ?? '';
      capturedTools = options.tools ?? {};
      return makeGenerateTextResult('reply', [assistantMessage('reply')]);
    }) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: {
        ...baseConfig,
        sns: {
          provider: 'mastodon',
          instanceUrl: 'https://social.example',
          accessToken: 'sns-token',
        },
        postMessageChannelIds: ['report-1'],
        allowedChannelIds: ['report-1'],
        reportChannelId: 'report-1',
      },
      memoryStore,
      sessionManager,
      skillStore: new SkillStoreStub([
        {
          name: 'code-review',
          description: 'Review code',
          instructions: 'Check security first.',
          systemOnly: false,
        },
      ]),
      snsContextRegistry: registry,
      messageSink: { postMessage: vi.fn(async () => {}) } satisfies IMessageSink,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await agent.handleMessage('sns-loop:2025-01-01T00:00:00.000Z', '(sns loop tick)', 'sns-loop', {
      userId: 'system',
      ephemeral: true,
      autoLoadSnsSkill: true,
      skillActivityInstructions: '## スキル活動\n- SNS_IDLE',
    });

    expect(capturedSystem).toContain('<skill-context>');
    expect(capturedSystem).toContain('### sns');
    expect(capturedSystem).toContain('## 新着通知');
    expect(capturedSystem).toContain('## スキル活動');
    expect(capturedSystem).toContain('Available skills:\n- code-review: Review code');
    expect(capturedSystem).not.toContain('- sns: SNS に投稿・閲覧・エンゲージメント操作を行う');
    expect(capturedSystem).toContain('- sns_post: publish an SNS post, optionally as a reply, quote, or media post.');
    expect(capturedSystem).toContain('- sns_like: like an SNS post immediately.');
    expect(capturedTools).toHaveProperty('sns_post');
    expect(capturedTools).toHaveProperty('sns_like');
    expect(capturedTools).toHaveProperty('sns_repost');
    expect(capturedTools).toHaveProperty('loadSkill');
  });

  it('exposes builtin sns as a normal system skill outside heartbeat auto-load', async () => {
    const memoryStore = new MemoryStoreStub();
    const sessionManager = new SessionManagerStub();
    let capturedSystem = '';
    let loadSkillResult: unknown;
    const registry = new SkillContextRegistry();
    registry.register('sns', {
      getContext: async () => ({ text: '## 新着通知\n- なし' }),
    });

    const generateTextFn = vi.fn(async (options: { system?: string; tools?: Record<string, unknown> }) => {
      capturedSystem = options.system ?? '';
      const tools = options.tools ?? {};
      // Call loadSkill during the LLM turn (before scope is finalized)
      const loadSkillTool = tools.loadSkill as { execute: (input: { name: string }, options: unknown) => Promise<unknown> };
      if (loadSkillTool != null) {
        loadSkillResult = await loadSkillTool.execute(
          { name: 'sns' },
          { toolCallId: 'tool-1', messages: [] },
        );
      }
      return makeGenerateTextResult('reply', [assistantMessage('reply')]);
    }) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: {
        ...baseConfig,
        sns: {
          provider: 'mastodon',
          instanceUrl: 'https://social.example',
          accessToken: 'sns-token',
        },
      },
      memoryStore,
      sessionManager,
      snsContextRegistry: registry,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await agent.handleMessage('cron:job', '(cron tick)', 'system', { userId: 'system' });

    expect(capturedSystem).toContain('Available skills:\n- sns: SNS に投稿・閲覧・エンゲージメント操作を行う (tools: sns_post, sns_get_post, sns_like, sns_repost, sns_upload_media, sns_get_thread)');
    expect(capturedSystem).not.toContain('\n\n<skill-context>\n### sns');
    expect(capturedSystem).not.toContain('## スキル活動');

    expect(loadSkillResult).toEqual(expect.objectContaining({
      loaded: true,
      name: 'sns',
      description: 'SNS に投稿・閲覧・エンゲージメント操作を行う',
      allowedTools: ['sns_post', 'sns_get_post', 'sns_like', 'sns_repost', 'sns_upload_media', 'sns_get_thread'],
      instructions: expect.stringContaining('## 新着通知'),
    }));
  });

  it('does not auto-load builtin sns skill for heartbeat turns without explicit options', async () => {
    const memoryStore = new MemoryStoreStub();
    const sessionManager = new SessionManagerStub();
    let capturedSystem = '';
    let capturedTools: Record<string, unknown> = {};
    const registry = new SkillContextRegistry();
    registry.register('sns', {
      getContext: async () => ({ text: '## 新着通知\n- なし' }),
    });

    const generateTextFn = vi.fn(async (options: { system?: string; tools?: Record<string, unknown> }) => {
      capturedSystem = options.system ?? '';
      capturedTools = options.tools ?? {};
      return makeGenerateTextResult('reply', [assistantMessage('reply')]);
    }) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: {
        ...baseConfig,
        sns: {
          provider: 'mastodon',
          instanceUrl: 'https://social.example',
          accessToken: 'sns-token',
        },
      },
      memoryStore,
      sessionManager,
      snsContextRegistry: registry,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await agent.handleMessage('heartbeat:2025-01-01T00:00:00.000Z', '(heartbeat tick)', 'heartbeat', {
      userId: 'system',
      ephemeral: true,
    });

    expect(capturedSystem).not.toContain('<skill-context>');
    expect(capturedSystem).not.toContain('## スキル活動');
    expect(capturedTools).not.toHaveProperty('sns_post');
  });

  it('ignores file-defined system sns skills so the builtin definition stays authoritative', async () => {
    const memoryStore = new MemoryStoreStub();
    const sessionManager = new SessionManagerStub();
    let capturedSystem = '';

    const generateTextFn = vi.fn(async (options: { system?: string; output?: unknown }) => {
      if (options.output != null) {
        return makeStructuredEvaluationResult({
          profileAction: 'none',
          profile: '',
          displayName: '',
          coreMemoryAppend: '',
          diaryEntry: '',
        });
      }
      capturedSystem = options.system ?? '';
      return makeGenerateTextResult('reply', [assistantMessage('reply')]);
    }) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: {
        ...baseConfig,
        sns: {
          provider: 'mastodon',
          instanceUrl: 'https://social.example',
          accessToken: 'sns-token',
        },
      },
      memoryStore,
      sessionManager,
      skillStore: new SkillStoreStub([
        {
          name: 'sns',
          description: 'Custom SNS',
          instructions: '## 行動ルール\n- custom file skill loses',
          systemOnly: true,
          allowedTools: ['sns_post'],
        },
      ]),
      snsContextRegistry: new SkillContextRegistry(),
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await agent.handleMessage('cron:job', '(cron tick)', 'system', { userId: 'system' });

    expect(capturedSystem).toContain('Available skills:\n- sns: SNS に投稿・閲覧・エンゲージメント操作を行う');
    expect(capturedSystem).not.toContain('Available skills:\n- sns: Custom SNS');
  });


  it('does not let a shared sns skill override the system builtin sns skill', async () => {
    const memoryStore = new MemoryStoreStub();
    const sessionManager = new SessionManagerStub();
    let capturedSystem = '';

    const generateTextFn = vi.fn(async (options: { system?: string; output?: unknown }) => {
      if (options.output != null) {
        return makeStructuredEvaluationResult({
          profileAction: 'none',
          profile: '',
          displayName: '',
          coreMemoryAppend: '',
          diaryEntry: '',
        });
      }
      capturedSystem = options.system ?? '';
      return makeGenerateTextResult('reply', [assistantMessage('reply')]);
    }) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: {
        ...baseConfig,
        sns: {
          provider: 'mastodon',
          instanceUrl: 'https://social.example',
          accessToken: 'sns-token',
        },
      },
      memoryStore,
      sessionManager,
      skillStore: new SkillStoreStub([
        {
          name: 'sns',
          description: 'Shared SNS',
          instructions: '## 行動ルール\n- shared skill for real users',
          systemOnly: false,
          allowedTools: ['sns_post'],
        },
      ]),
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await agent.handleMessage('cron:job', '(cron tick)', 'system', { userId: 'system' });

    expect(capturedSystem).toContain('Available skills:\n- sns: SNS に投稿・閲覧・エンゲージメント操作を行う');
    expect(capturedSystem).not.toContain('Available skills:\n- sns: Shared SNS');
  });

  it('calls abort on skillContextScope when generateTextFn throws', async () => {
    const memoryStore = new MemoryStoreStub();
    const sessionManager = new SessionManagerStub();
    const abortFn = vi.fn();
    const registry = new SkillContextRegistry();
    registry.register('sns', {
      getContext: async () => ({
        text: '## 新着通知\n- なし',
        onSuccess: async () => {},
        onAbort: abortFn,
      }),
    });

    const generateTextFn = vi.fn(async () => {
      throw new Error('LLM call failed');
    }) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: {
        ...baseConfig,
        sns: {
          provider: 'mastodon',
          instanceUrl: 'https://social.example',
          accessToken: 'sns-token',
        },
      },
      memoryStore,
      sessionManager,
      snsContextRegistry: registry,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await expect(agent.handleMessage('sns-loop:2025-01-01T00:00:00.000Z', '(sns loop tick)', 'sns-loop', {
      userId: 'system',
      ephemeral: true,
      autoLoadSnsSkill: true,
      skillActivityInstructions: '## スキル活動\n- SNS_IDLE',
    })).rejects.toThrow('LLM call failed');

    expect(abortFn).toHaveBeenCalledTimes(1);
  });

  it('does not inject builtin sns skill for non-system non-admin users', async () => {
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
      config: {
        ...baseConfig,
        sns: {
          provider: 'mastodon',
          instanceUrl: 'https://social.example',
          accessToken: 'sns-token',
        },
      },
      memoryStore,
      sessionManager,
      userStore: new UserStoreStub(),
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await agent.handleMessage('session-1', 'hello', 'Alice');

    expect(capturedSystem).not.toContain('Available skills:');
    expect(capturedSystem).not.toContain('\n<skill-context>\n');
    expect(capturedSystem).not.toContain('## スキル活動');
    expect(capturedTools).not.toHaveProperty('sns_post');
    expect(capturedTools).not.toHaveProperty('loadSkill');
  });

  it('exposes builtin sns skill to admin users via loadSkill', async () => {
    const memoryStore = new MemoryStoreStub();
    const sessionManager = new SessionManagerStub();
    let capturedSystem = '';
    let loadSkillResult: unknown;

    const generateTextFn = vi.fn(async (options: { system?: string; tools?: Record<string, unknown> }) => {
      capturedSystem = options.system ?? '';
      const tools = options.tools ?? {};
      const loadSkillTool = tools.loadSkill as { execute: (input: { name: string }, options: unknown) => Promise<unknown> } | undefined;
      if (loadSkillTool != null) {
        loadSkillResult = await loadSkillTool.execute(
          { name: 'sns' },
          { toolCallId: 'tool-1', messages: [] },
        );
      }
      return makeGenerateTextResult('reply', [assistantMessage('reply')]);
    }) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: {
        ...baseConfig,
        sns: {
          provider: 'mastodon',
          instanceUrl: 'https://social.example',
          accessToken: 'sns-token',
        },
        adminUserIds: ['admin-user'],
      },
      memoryStore,
      sessionManager,
      userStore: new UserStoreStub(),
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await agent.handleMessage('session-1', 'load sns', 'Admin', { userId: 'admin-user' });

    expect(capturedSystem).toContain('Available skills:\n- sns: SNS に投稿・閲覧・エンゲージメント操作を行う');
    expect(loadSkillResult).toEqual(expect.objectContaining({
      loaded: true,
      name: 'sns',
    }));
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
          systemOnly: false,
        },
      ]),
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await agent.handleMessage('session-1', 'hi', 'Alice');

    expect(capturedSystem).toContain('You are custom.');
    expect(capturedSystem).toContain('Be precise.');
    expect(capturedSystem).toContain('Available skills:\n- code-review: Review code');
    expect(capturedSystem).toContain('- loadSkill: load the full content of a skill by name. Use when a skill is relevant to the user\'s request.');
    expect(capturedTools).toHaveProperty('loadSkill');
  });

  it('does not expose karakuri-world through loadSkill for normal users', async () => {
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
      config: {
        ...baseConfig,
        karakuriWorld: {
          apiBaseUrl: 'https://example.com/world',
          apiKey: 'world-key',
        },
      },
      memoryStore,
      sessionManager,
      skillStore: new SkillStoreStub([
        {
          name: 'karakuri-world',
          description: 'Explore the world',
          instructions: 'Observe first.',
          systemOnly: false,
          allowedTools: ['karakuri_world_get_map'],
        },
      ]),
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await agent.handleMessage('session-1', 'hi', 'Alice');

    expect(capturedSystem).not.toContain('Available skills:');
    expect(capturedSystem).not.toContain('karakuri-world');
    expect(capturedSystem).not.toContain('Some skills unlock additional tools');
    expect(capturedTools).not.toHaveProperty('loadSkill');
    expect(capturedTools).not.toHaveProperty('karakuri_world_get_map');
  });

  it('does not expose legacy karakuri-world skills without allowedTools for normal users', async () => {
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
      config: {
        ...baseConfig,
        karakuriWorld: {
          apiBaseUrl: 'https://example.com/world',
          apiKey: 'world-key',
        },
      },
      memoryStore,
      sessionManager,
      skillStore: new SkillStoreStub([
        {
          name: 'karakuri-world',
          description: 'Explore the world',
          instructions: 'Observe first.',
          systemOnly: false,
        },
      ]),
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await agent.handleMessage('session-1', 'hi', 'Alice');

    expect(capturedSystem).not.toContain('Available skills:');
    expect(capturedSystem).not.toContain('karakuri-world');
    expect(capturedTools).not.toHaveProperty('loadSkill');
  });

  it('switches KW bot users into karakuri-world mode with comment-based replies', async () => {
    const memoryStore = new MemoryStoreStub('core memory', [
      { date: '2025-01-02', content: 'recent diary' },
    ]);
    const sessionManager = new SessionManagerStub();
    sessionManager.session.summary = 'previous summary';
    const userStore = new UserStoreStub();
    let capturedSystem = '';
    let capturedTools: Record<string, unknown> = {};
    let capturedToolChoice: unknown;
    let evaluationPrompt = '';

    let capturedProviderOptions: unknown;

    const generateTextFn = vi.fn(async (options: { system?: string; tools?: Record<string, unknown>; toolChoice?: unknown; output?: unknown; prompt?: string; providerOptions?: unknown }) => {
      if (options.output != null) {
        evaluationPrompt = options.prompt ?? '';
        return makeStructuredEvaluationResult({
          profileAction: 'update',
          profile: 'should be ignored',
          displayName: 'should be ignored',
          coreMemoryAppend: '',
          diaryEntry: '',
        });
      }
      capturedSystem = options.system ?? '';
      capturedTools = options.tools ?? {};
      capturedToolChoice = options.toolChoice;
      capturedProviderOptions = options.providerOptions;
      return makeKwModeGenerateTextResult('周囲を確認します。');
    }) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: {
        ...baseConfig,
        karakuriWorldBotIds: ['kw-bot-1'],
        karakuriWorld: {
          apiBaseUrl: 'https://example.com/world',
          apiKey: 'world-key',
        },
      },
      memoryStore,
      sessionManager,
      promptContextStore: new PromptContextStoreStub({
        agentInstructions: 'You are custom.',
        rules: 'Be precise.',
      }),
      skillStore: new SkillStoreStub([
        {
          name: 'karakuri-world',
          description: 'Explore the world',
          instructions: 'Observe first.',
          systemOnly: false,
          allowedTools: ['karakuri_world_get_map'],
        },
      ]),
      userStore,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await expect(agent.handleMessage('session-1', '状況を見て', 'Admin', { userId: 'kw-bot-1' })).resolves.toBe('周囲を確認します。');
    await agent.drainPendingEvaluations();

    expect(userStore.ensureCalls).toEqual([]);
    expect(Object.keys(capturedTools).sort()).toEqual([...EXPECTED_KW_TOOL_NAMES].sort());
    expect(capturedToolChoice).toBe('required');
    expect(capturedProviderOptions).toEqual({ openai: { reasoningEffort: 'low' } });
    expect(capturedSystem).toContain('You are custom.');
    expect(capturedSystem).toContain('Be precise.');
    expect(capturedSystem).toContain('<memory>');
    expect(capturedSystem).toContain('<diary>');
    expect(capturedSystem).not.toContain('\n<user-profile>\n');
    expect(capturedSystem).toContain('<summary>');
    expect(capturedSystem).not.toContain('Available skills:');
    expect(capturedSystem).not.toContain('Available tools:');
    expect(capturedSystem).toContain('KarakuriWorld mode is active.');
    expect(sessionManager.session.messages).toContainEqual({
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'kw-tool-1',
          toolName: 'karakuri_world_get_map',
          input: { comment: '周囲を確認します。' },
        },
        { type: 'text', text: '周囲を確認します。' },
      ],
    });
    expect(sessionManager.session.messages).toContainEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'kw-tool-1',
          toolName: 'karakuri_world_get_map',
          output: { ok: true, message: 'Map request accepted.' },
        },
      ],
    });
    expect(evaluationPrompt).toContain('Latest assistant response:\n周囲を確認します。');
    expect(userStore.profileUpdates).toEqual([]);
    expect(userStore.displayNameUpdates).toEqual([]);
  });

  it('falls back to a default completion reply when a karakuri-world tool call input has no comment', async () => {
    const memoryStore = new MemoryStoreStub();
    const sessionManager = new SessionManagerStub();

    const agent = new KarakuriAgent({
      config: {
        ...baseConfig,
        karakuriWorldBotIds: ['kw-bot-1'],
        karakuriWorld: {
          apiBaseUrl: 'https://example.com/world',
          apiKey: 'world-key',
        },
      },
      memoryStore,
      sessionManager,
      generateTextFn: vi.fn(async () =>
        makeKwModeGenerateTextResult(undefined),
      ) as unknown as typeof import('ai').generateText,
      modelFactory: () => ({}) as LanguageModel,
    });

    await expect(agent.handleMessage('session-1', '状況を見て', 'Admin', { userId: 'kw-bot-1' })).resolves.toBe('(行動完了)');
  });

  it('returns an empty string for Discord suppression when a karakuri-world tool result is busy', async () => {
    const memoryStore = new MemoryStoreStub();
    const sessionManager = new SessionManagerStub();
    let evaluationPrompt = '';

    const generateTextFn = vi.fn(async (options: { output?: unknown; prompt?: string }) => {
      if (options.output != null) {
        evaluationPrompt = options.prompt ?? '';
        return makeStructuredEvaluationResult({
          profileAction: 'none',
          profile: '',
          displayName: '',
          coreMemoryAppend: '',
          diaryEntry: '',
        });
      }
      return makeBusyKwModeGenerateTextResult('門へ向かいます。');
    }) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: {
        ...baseConfig,
        karakuriWorldBotIds: ['kw-bot-1'],
        karakuriWorld: {
          apiBaseUrl: 'https://example.com/world',
          apiKey: 'world-key',
        },
      },
      memoryStore,
      sessionManager,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await expect(agent.handleMessage('session-1', '移動して', 'KWBot', { userId: 'kw-bot-1' })).resolves.toBe('');
    await agent.drainPendingEvaluations();

    expect(sessionManager.session.messages.length).toBeGreaterThanOrEqual(2);
    expect(evaluationPrompt).toContain('Latest assistant response:\n');
  });

  it('returns an empty string and persists only OK when a karakuri-world tool result is not_logged_in', async () => {
    const memoryStore = new MemoryStoreStub();
    const sessionManager = new SessionManagerStub();
    let evaluationCalled = false;

    const generateTextFn = vi.fn(async (options: { output?: unknown; prompt?: string }) => {
      if (options.output != null) {
        evaluationCalled = true;
        return makeStructuredEvaluationResult({
          profileAction: 'none',
          profile: '',
          displayName: '',
          coreMemoryAppend: '',
          diaryEntry: '',
        });
      }
      return makeNotLoggedInKwModeGenerateTextResult('門へ向かいます。');
    }) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: {
        ...baseConfig,
        karakuriWorldBotIds: ['kw-bot-1'],
        karakuriWorld: {
          apiBaseUrl: 'https://example.com/world',
          apiKey: 'world-key',
        },
      },
      memoryStore,
      sessionManager,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await expect(agent.handleMessage('session-1', 'からくりワールドアプリ: ログアウトしました。', 'KWBot', { userId: 'kw-bot-1' })).resolves.toBe('');
    await agent.drainPendingEvaluations();

    // セッションにはユーザーメッセージ + assistant OK だけ残る（tool-call/tool-result は含まない）
    expect(sessionManager.session.messages).toHaveLength(2);
    expect(sessionManager.session.messages[1]).toEqual({
      role: 'assistant',
      content: 'OK',
    });
    // not_logged_in 時は post-response evaluation をスキップ
    expect(evaluationCalled).toBe(false);
  });

  it('rejects multiple karakuri-world actions in a single notification', async () => {
    const memoryStore = new MemoryStoreStub();
    const sessionManager = new SessionManagerStub();

    const agent = new KarakuriAgent({
      config: {
        ...baseConfig,
        karakuriWorldBotIds: ['kw-bot-1'],
        karakuriWorld: {
          apiBaseUrl: 'https://example.com/world',
          apiKey: 'world-key',
        },
      },
      memoryStore,
      sessionManager,
      generateTextFn: vi.fn(async () =>
        makeInvalidMultiActionKwModeGenerateTextResult(),
      ) as unknown as typeof import('ai').generateText,
      modelFactory: () => ({}) as LanguageModel,
    });

    await expect(agent.handleMessage('session-1', '状況を見て', 'Admin', { userId: 'kw-bot-1' }))
      .rejects.toThrow('KarakuriWorld mode expected exactly one action, but received 2.');
    expect(sessionManager.session.messages).toHaveLength(1);
  });

  it('rejects missing karakuri-world actions in a single notification', async () => {
    const memoryStore = new MemoryStoreStub();
    const sessionManager = new SessionManagerStub();

    const agent = new KarakuriAgent({
      config: {
        ...baseConfig,
        karakuriWorldBotIds: ['kw-bot-1'],
        karakuriWorld: {
          apiBaseUrl: 'https://example.com/world',
          apiKey: 'world-key',
        },
      },
      memoryStore,
      sessionManager,
      generateTextFn: vi.fn(async () =>
        makeInvalidZeroActionKwModeGenerateTextResult(),
      ) as unknown as typeof import('ai').generateText,
      modelFactory: () => ({}) as LanguageModel,
    });

    await expect(agent.handleMessage('session-1', '状況を見て', 'Admin', { userId: 'kw-bot-1' }))
      .rejects.toThrow('KarakuriWorld mode expected exactly one action, but received 0.');
    expect(sessionManager.session.messages).toHaveLength(1);
  });

  it('keeps normal users on the standard tool path even when karakuri-world is configured', async () => {
    const memoryStore = new MemoryStoreStub();
    const sessionManager = new SessionManagerStub();
    let capturedSystem = '';
    let capturedTools: Record<string, unknown> = {};
    let capturedToolChoice: unknown;

    const generateTextFn = vi.fn(async (options: { system?: string; tools?: Record<string, unknown>; toolChoice?: unknown }) => {
      capturedSystem = options.system ?? '';
      capturedTools = options.tools ?? {};
      capturedToolChoice = options.toolChoice;
      return makeGenerateTextResult('reply', [assistantMessage('reply')]);
    }) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: {
        ...baseConfig,
        karakuriWorldBotIds: ['kw-bot-1'],
        karakuriWorld: {
          apiBaseUrl: 'https://example.com/world',
          apiKey: 'world-key',
        },
      },
      memoryStore,
      sessionManager,
      userStore: new UserStoreStub(),
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await agent.handleMessage('session-1', 'hi', 'Alice', { userId: 'user-1' });

    expect(capturedToolChoice).toBeUndefined();
    expect(capturedTools).toHaveProperty('recallDiary');
    expect(capturedTools).not.toHaveProperty('karakuri_world_get_map');
    expect(capturedSystem).not.toContain('KarakuriWorld mode is active.');
    expect(capturedSystem).toContain('- webFetch: fetch a URL and extract its readable content as Markdown.');
  });

  it('keeps admin users on the standard user-profile path when karakuri-world is disabled', async () => {
    const memoryStore = new MemoryStoreStub();
    const sessionManager = new SessionManagerStub();
    const userStore = new UserStoreStub([
      {
        userId: 'admin-user',
        displayName: 'Admin Old',
        profile: 'Knows the world state',
        createdAt: new Date('2025-01-01T00:00:00.000Z').toISOString(),
        updatedAt: new Date('2025-01-01T00:00:00.000Z').toISOString(),
      },
    ]);
    let capturedSystem = '';

    const generateTextFn = vi.fn(async (options: { system?: string; output?: unknown }) => {
      if (options.output != null) {
        return makeStructuredEvaluationResult({
          profileAction: 'none',
          profile: '',
          displayName: '',
          coreMemoryAppend: '',
          diaryEntry: '',
        });
      }
      capturedSystem = options.system ?? '';
      return makeGenerateTextResult('reply', [assistantMessage('reply')]);
    }) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: {
        ...baseConfig,
        adminUserIds: ['admin-user'],
      },
      memoryStore,
      sessionManager,
      userStore,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await expect(agent.handleMessage('session-1', 'hi', 'Admin', { userId: 'admin-user' })).resolves.toBe('reply');

    expect(userStore.ensureCalls).toEqual([{ userId: 'admin-user', displayName: 'Admin' }]);
    expect(capturedSystem).toContain('<user-profile>');
    expect(capturedSystem).toContain('Display name: Admin Old');
    expect(capturedSystem).toContain('User ID: admin-user');
    expect(capturedSystem).not.toContain('KarakuriWorld mode is active.');
  });

  it('omits unavailable gated tools from prompts and loadSkill results', async () => {
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
      skillStore: new SkillStoreStub([
        {
          name: 'karakuri-world',
          description: 'Explore the world',
          instructions: 'Observe first.',
          systemOnly: false,
          allowedTools: ['karakuri_world_get_map'],
        },
      ]),
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await agent.handleMessage('session-1', 'hi', 'Alice');

    expect(capturedSystem).not.toContain('Available skills:');
    expect(capturedSystem).not.toContain('(tools: karakuri_world_get_map)');
    expect(capturedSystem).not.toContain('Some skills unlock additional tools');
    expect(capturedTools).not.toHaveProperty('loadSkill');
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
      options.experimental_onToolCallStart?.({ toolCall: { toolName: 'recallDiary' } } as never);
      options.experimental_onToolCallFinish?.({ toolCall: { toolName: 'recallDiary' } } as never);
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
      'start:recallDiary',
      'finish:recallDiary',
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
      schedulerStore: createSchedulerStore(),
      messageSink: { postMessage: async () => {} },
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

    const agent = new KarakuriAgent({
      config: {
        ...baseConfig,
        postMessageChannelIds: ['channel-1'],
        allowedChannelIds: ['channel-1'],
      },
      memoryStore,
      sessionManager,
      schedulerStore: createSchedulerStore(),
      messageSink: { postMessage: async () => {} },
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

    const agent = new KarakuriAgent({
      config: {
        ...baseConfig,
        allowedChannelIds: ['report-1'],
        reportChannelId: 'report-1',
        adminUserIds: ['admin-1'],
      },
      memoryStore,
      sessionManager,
      schedulerStore: createSchedulerStore(),
      messageSink: { postMessage: async () => {} },
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

  it('registers real users, preserves saved display names, injects profile context, exposes userLookup, and runs background evaluation', async () => {
    const memoryStore = new MemoryStoreStub('core memory');
    const sessionManager = new SessionManagerStub();
    const userStore = new UserStoreStub([
      {
        userId: 'user-1',
        displayName: 'Alice Old',
        profile: 'Enjoys robotics',
        createdAt: '',
        updatedAt: '',
      },
    ]);
    let capturedSystem = '';
    let capturedTools: Record<string, unknown> = {};

    const generateTextFn = vi.fn(async (options: { system?: string; tools?: Record<string, unknown>; output?: unknown }) => {
      if (options.output != null) {
        return makeStructuredEvaluationResult({
          profileAction: 'update',
          profile: 'Enjoys robotics and TypeScript',
          displayName: '',
          coreMemoryAppend: 'Alice likes concise updates',
          diaryEntry: '',
        });
      }
      capturedSystem = options.system ?? '';
      capturedTools = options.tools ?? {};
      return makeGenerateTextResult('reply', [assistantMessage('reply')]);
    }) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: baseConfig,
      memoryStore,
      sessionManager,
      userStore,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await expect(agent.handleMessage('session-1', 'hi', 'Alice', { userId: 'user-1' })).resolves.toBe('reply');
    await agent.drainPendingEvaluations();

    expect(mockState.runExclusiveMemoryPersistence).toHaveBeenCalledTimes(1);
    expect(userStore.ensureCalls).toEqual([{ userId: 'user-1', displayName: 'Alice' }]);
    expect(userStore.users.get('user-1')?.displayName).toBe('Alice Old');
    expect(capturedSystem).toContain('<user-profile>');
    expect(capturedSystem).toContain('Display name: Alice Old');
    expect(capturedSystem).toContain('Enjoys robotics');
    expect(capturedSystem).toContain('User ID: user-1');
    expect(capturedSystem).toContain('- userLookup: search saved user profiles when asked about other users.');
    expect(capturedTools).toHaveProperty('userLookup');
    expect(memoryStore.coreWrites).toEqual(['Alice likes concise updates']);
    expect(userStore.profileUpdates).toEqual([{ userId: 'user-1', profile: 'Enjoys robotics and TypeScript' }]);
  });

  it('skips user persistence but still runs diary/core evaluation for system users', async () => {
    const memoryStore = new MemoryStoreStub();
    const sessionManager = new SessionManagerStub();
    const userStore = new UserStoreStub();
    let capturedSystem = '';

    const generateTextFn = vi.fn(async (options: { system?: string; output?: unknown }) => {
      if (options.output != null) {
        return makeStructuredEvaluationResult({
          profileAction: 'none',
          profile: '',
          displayName: '',
          coreMemoryAppend: 'system fact',
          diaryEntry: 'system diary',
        });
      }
      capturedSystem = options.system ?? '';
      return makeGenerateTextResult('reply', [assistantMessage('reply')]);
    }) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: baseConfig,
      memoryStore,
      sessionManager,
      userStore,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await agent.handleMessage('session-1', 'hi', 'Alice', { userId: 'system' });
    await agent.drainPendingEvaluations();

    expect(mockState.runExclusiveMemoryPersistence).toHaveBeenCalledTimes(1);
    expect(userStore.ensureCalls).toEqual([]);
    expect(capturedSystem).not.toContain('\n\n<user-profile>\n');
    expect(memoryStore.coreWrites).toEqual(['system fact']);
    expect(memoryStore.diaryWrites).toHaveLength(1);
    expect(vi.mocked(generateTextFn)).toHaveBeenCalledTimes(2);
  });

  it('continues the main reply when ensureUser fails and skips profile writes in evaluator', async () => {
    const memoryStore = new MemoryStoreStub();
    const sessionManager = new SessionManagerStub();
    const userStore = new UserStoreStub();
    userStore.failEnsure = true;

    const agent = new KarakuriAgent({
      config: baseConfig,
      memoryStore,
      sessionManager,
      userStore,
      generateTextFn: vi.fn(async (options: { output?: unknown }) => {
        if (options.output != null) {
          return makeStructuredEvaluationResult({
            profileAction: 'update',
            profile: 'Should be ignored',
            displayName: 'Should be ignored',
            coreMemoryAppend: 'Still written to core memory',
            diaryEntry: '',
          });
        }
        return makeGenerateTextResult('reply', [assistantMessage('reply')]);
      }) as unknown as typeof import('ai').generateText,
      modelFactory: () => ({}) as LanguageModel,
    });

    await expect(agent.handleMessage('session-1', 'hi', 'Alice', { userId: 'user-1' })).resolves.toBe('reply');
    await agent.drainPendingEvaluations();

    expect(userStore.profileUpdates).toEqual([]);
    expect(userStore.displayNameUpdates).toEqual([]);
    expect(memoryStore.coreWrites).toEqual(['Still written to core memory']);
  });

  it('returns before background evaluation finishes and drainPendingEvaluations waits for it', async () => {
    const memoryStore = new MemoryStoreStub();
    const sessionManager = new SessionManagerStub();
    const userStore = new UserStoreStub();
    const evaluationGate = (() => {
      let resolve!: () => void;
      const promise = new Promise<void>((res) => {
        resolve = res;
      });
      return { promise, resolve };
    })();

    const generateTextFn = vi.fn(async (options: { output?: unknown }) => {
      if (options.output != null) {
        await evaluationGate.promise;
        return makeStructuredEvaluationResult({
          profileAction: 'none',
          profile: '',
          displayName: '',
          coreMemoryAppend: '',
          diaryEntry: '',
        });
      }
      return makeGenerateTextResult('reply', [assistantMessage('reply')]);
    }) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: baseConfig,
      memoryStore,
      sessionManager,
      userStore,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await expect(agent.handleMessage('session-1', 'hi', 'Alice', { userId: 'user-1' })).resolves.toBe('reply');

    const drainPromise = agent.drainPendingEvaluations();
    let drained = false;
    void drainPromise.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    evaluationGate.resolve();
    await drainPromise;
    expect(drained).toBe(true);
  });

  it('serializes post-response evaluations per user so later runs for the same user see committed core memory', async () => {
    const memoryStore = new MemoryStoreStub();
    const sessionManager = new SessionManagerStub();
    const userStore = new UserStoreStub();
    const evaluationSnapshots: string[] = [];
    let releaseFirstEvaluation!: () => void;
    const firstEvaluationGate = new Promise<void>((resolve) => {
      releaseFirstEvaluation = resolve;
    });

    const generateTextFn = vi.fn(async (options: { prompt?: string; output?: unknown }) => {
      if (options.output != null) {
        const userId = options.prompt?.match(/User ID: ([^\n]+)/)?.[1] ?? 'unknown';
        const currentCoreMemory = options.prompt?.match(/Current core memory:\n([\s\S]*?)\n\nLatest user message:/)?.[1] ?? 'missing';
        evaluationSnapshots.push(`${userId}:${currentCoreMemory}`);
        if (evaluationSnapshots.length === 1) {
          await firstEvaluationGate;
        }
        return makeStructuredEvaluationResult({
          profileAction: 'none',
          profile: '',
          displayName: '',
          coreMemoryAppend: userId === 'user-1' ? 'user-1 fact' : '',
          diaryEntry: '',
        });
      }
      return makeGenerateTextResult('reply', [assistantMessage('reply')]);
    }) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: baseConfig,
      memoryStore,
      sessionManager,
      userStore,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await Promise.all([
      agent.handleMessage('session-1', 'hi', 'Alice', { userId: 'user-1' }),
      agent.handleMessage('session-2', 'again', 'Alice', { userId: 'user-1' }),
    ]);
    await Promise.resolve();
    await Promise.resolve();

    expect(evaluationSnapshots).toEqual(['user-1:(empty)']);

    releaseFirstEvaluation();
    await expect(agent.drainPendingEvaluations()).resolves.toBeUndefined();
    expect(evaluationSnapshots).toEqual([
      'user-1:(empty)',
      'user-1:user-1 fact',
    ]);
    expect(memoryStore.coreWrites).toEqual(['user-1 fact', 'user-1 fact']);
  });

  it('starts post-response generation before waiting on the persistence lock', async () => {
    const memoryStore = new MemoryStoreStub();
    const sessionManager = new SessionManagerStub();
    const userStore = new UserStoreStub();
    const persistenceMutex = new KeyedMutex();
    const startedEvaluations: string[] = [];
    let persistenceCallCount = 0;
    let releasePersistenceLock!: () => void;
    const persistenceLockReleased = new Promise<void>((resolve) => {
      releasePersistenceLock = resolve;
    });
    let signalFirstPersistenceLock!: () => void;
    const firstPersistenceLockEntered = new Promise<void>((resolve) => {
      signalFirstPersistenceLock = resolve;
    });

    mockState.runExclusiveMemoryPersistence.mockImplementation(async <T>(task: () => Promise<T>) =>
      await persistenceMutex.runExclusive('memory-persistence', async () => {
        persistenceCallCount += 1;
        if (persistenceCallCount === 1) {
          signalFirstPersistenceLock();
          await persistenceLockReleased;
        }
        return await task();
      }));

    const generateTextFn = vi.fn(async (options: { prompt?: string; output?: unknown }) => {
      if (options.output != null) {
        const userId = options.prompt?.match(/User ID: ([^\n]+)/)?.[1] ?? 'unknown';
        startedEvaluations.push(userId);
        return makeStructuredEvaluationResult({
          profileAction: 'none',
          profile: '',
          displayName: '',
          coreMemoryAppend: `${userId} fact`,
          diaryEntry: '',
        });
      }
      return makeGenerateTextResult('reply', [assistantMessage('reply')]);
    }) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: baseConfig,
      memoryStore,
      sessionManager,
      userStore,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await Promise.all([
      agent.handleMessage('session-1', 'hi', 'Alice', { userId: 'user-1' }),
      agent.handleMessage('session-2', 'hello', 'Bob', { userId: 'user-2' }),
    ]);

    await firstPersistenceLockEntered;
    await Promise.resolve();
    await Promise.resolve();

    expect(startedEvaluations).toEqual(['user-1', 'user-2']);

    releasePersistenceLock();
    await expect(agent.drainPendingEvaluations()).resolves.toBeUndefined();
  });

  it('swallows background evaluation setup failures after handleMessage returns', async () => {
    const memoryStore = new MemoryStoreStub();
    const sessionManager = new SessionManagerStub();
    const userStore = new UserStoreStub();
    userStore.failGetUser = true;

    const generateTextFn = vi.fn(async (options: { output?: unknown }) => {
      if (options.output != null) {
        return makeStructuredEvaluationResult({
          profileAction: 'none',
          profile: '',
          displayName: '',
          coreMemoryAppend: '',
          diaryEntry: '',
        });
      }
      return makeGenerateTextResult('reply', [assistantMessage('reply')]);
    }) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: baseConfig,
      memoryStore,
      sessionManager,
      userStore,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await expect(agent.handleMessage('session-1', 'hi', 'Alice', { userId: 'user-1' })).resolves.toBe('reply');
    await expect(agent.drainPendingEvaluations()).resolves.toBeUndefined();
    expect(vi.mocked(generateTextFn)).toHaveBeenCalledTimes(1);
  });

  it('runs SNS user evaluation via evaluateUser callback and drains it', async () => {
    const memoryStore = new MemoryStoreStub('core memory');
    const sessionManager = new SessionManagerStub();
    const userStore = new UserStoreStub();
    let capturedTools: Record<string, unknown> = {};
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      id: 'post-1',
      content: '<p>Hello SNS</p>',
      account: {
        id: 'acct-1',
        display_name: 'Alice',
        username: 'alice',
        acct: 'alice@example.com',
        url: 'https://social.example/@alice',
      },
      created_at: '2025-01-01T00:00:00.000Z',
      url: 'https://social.example/@alice/post-1',
      visibility: 'public',
      in_reply_to_id: null,
      reblogs_count: 0,
      favourites_count: 0,
      replies_count: 0,
      media_attachments: [],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    const generateTextFn = vi.fn(async (options: { system?: string; tools?: Record<string, unknown>; output?: unknown }) => {
      if (options.output != null) {
        return makeStructuredEvaluationResult({
          profileAction: 'update',
          profile: 'Friendly SNS user',
          displayName: '',
          coreMemoryAppend: 'SNS user fact',
          diaryEntry: '',
        });
      }
      capturedTools = options.tools ?? {};
      return makeGenerateTextResult('reply', [assistantMessage('reply')]);
    }) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: {
        ...baseConfig,
        sns: {
          provider: 'mastodon',
          instanceUrl: 'https://social.example',
          accessToken: 'token',
        },
      },
      memoryStore,
      sessionManager,
      skillStore: new SkillStoreStub([{
        name: 'sns',
        description: 'SNS skill',
        instructions: 'Use SNS tools.',
        systemOnly: false,
        allowedTools: ['sns_get_post'],
      }]),
      userStore,
      snsActivityStore: {
        recordPost: async () => {},
        recordLike: async () => {},
        recordRepost: async () => {},
        hasLiked: async () => false,
        hasReposted: async () => false,
        hasReplied: async () => false,
        hasQuoted: async () => false,
        getRecentActivities: async () => [],
        getLastNotificationId: async () => null,
        setLastNotificationId: async () => {},
        close: async () => {},
      },
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await agent.handleMessage('session-1', 'hi', 'Alice', { userId: 'system' });

    const loadSkill = capturedTools.loadSkill as { execute?: (...args: unknown[]) => Promise<unknown> };
    expect(loadSkill?.execute).toBeTypeOf('function');
    await loadSkill.execute?.({ name: 'sns' }, { toolCallId: 'tool-load-sns', messages: [] });

    const snsGetPost = capturedTools.sns_get_post as { execute?: (...args: unknown[]) => Promise<unknown> };
    expect(snsGetPost?.execute).toBeTypeOf('function');
    await snsGetPost.execute?.({ post_id: 'post-1' }, { toolCallId: 'tool-1', messages: [] });
    await agent.drainPendingEvaluations();
    expect(mockState.runExclusiveMemoryPersistence).toHaveBeenCalledTimes(2);
    expect(userStore.ensureCalls).toContainEqual({ userId: 'sns:mastodon:acct-1', displayName: 'Alice' });
    expect(userStore.profileUpdates).toContainEqual({ userId: 'sns:mastodon:acct-1', profile: 'Friendly SNS user' });
    expect(memoryStore.coreWrites).toContain('SNS user fact');
    vi.unstubAllGlobals();
  });

  it('starts SNS user evaluation generation before waiting on the persistence lock', async () => {
    const memoryStore = new MemoryStoreStub('core memory');
    const sessionManager = new SessionManagerStub();
    const userStore = new UserStoreStub();
    const persistenceMutex = new KeyedMutex();
    const startedEvaluations: string[] = [];
    let capturedTools: Record<string, unknown> = {};
    let persistenceCallCount = 0;
    let releasePersistenceLock!: () => void;
    const persistenceLockReleased = new Promise<void>((resolve) => {
      releasePersistenceLock = resolve;
    });
    let signalFirstPersistenceLock!: () => void;
    const firstPersistenceLockEntered = new Promise<void>((resolve) => {
      signalFirstPersistenceLock = resolve;
    });

    mockState.runExclusiveMemoryPersistence.mockImplementation(async <T>(task: () => Promise<T>) =>
      await persistenceMutex.runExclusive('memory-persistence', async () => {
        persistenceCallCount += 1;
        if (persistenceCallCount === 1) {
          signalFirstPersistenceLock();
          await persistenceLockReleased;
        }
        return await task();
      }));

    vi.stubGlobal('fetch', vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      const postId = url.endsWith('/post-2') ? 'post-2' : 'post-1';
      const accountId = postId === 'post-2' ? 'acct-2' : 'acct-1';
      const displayName = postId === 'post-2' ? 'Bob' : 'Alice';
      return new Response(JSON.stringify({
        id: postId,
        content: `<p>Hello from ${displayName}</p>`,
        account: {
          id: accountId,
          display_name: displayName,
          username: displayName.toLowerCase(),
          acct: `${displayName.toLowerCase()}@example.com`,
          url: `https://social.example/@${displayName.toLowerCase()}`,
        },
        created_at: '2025-01-01T00:00:00.000Z',
        url: `https://social.example/@${displayName.toLowerCase()}/${postId}`,
        visibility: 'public',
        in_reply_to_id: null,
        reblogs_count: 0,
        favourites_count: 0,
        replies_count: 0,
        media_attachments: [],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }));

    const generateTextFn = vi.fn(async (options: { tools?: Record<string, unknown>; prompt?: string; output?: unknown }) => {
      if (options.output != null) {
        const userId = options.prompt?.match(/User ID: ([^\n]+)/)?.[1] ?? 'unknown';
        startedEvaluations.push(userId);
        return makeStructuredEvaluationResult({
          profileAction: 'none',
          profile: '',
          displayName: '',
          coreMemoryAppend: `${userId} fact`,
          diaryEntry: '',
        });
      }
      capturedTools = options.tools ?? {};
      return makeGenerateTextResult('reply', [assistantMessage('reply')]);
    }) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: {
        ...baseConfig,
        sns: {
          provider: 'mastodon',
          instanceUrl: 'https://social.example',
          accessToken: 'token',
        },
      },
      memoryStore,
      sessionManager,
      skillStore: new SkillStoreStub([{
        name: 'sns',
        description: 'SNS skill',
        instructions: 'Use SNS tools.',
        systemOnly: false,
        allowedTools: ['sns_get_post'],
      }]),
      userStore,
      snsActivityStore: {
        recordPost: async () => {},
        recordLike: async () => {},
        recordRepost: async () => {},
        hasLiked: async () => false,
        hasReposted: async () => false,
        hasReplied: async () => false,
        hasQuoted: async () => false,
        getRecentActivities: async () => [],
        getLastNotificationId: async () => null,
        setLastNotificationId: async () => {},
        close: async () => {},
      },
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    try {
      await agent.handleMessage('session-1', 'hi', 'Alice', { userId: 'system' });

      const loadSkill = capturedTools.loadSkill as { execute?: (...args: unknown[]) => Promise<unknown> };
      expect(loadSkill?.execute).toBeTypeOf('function');
      await loadSkill.execute?.({ name: 'sns' }, { toolCallId: 'tool-load-sns', messages: [] });

      const snsGetPost = capturedTools.sns_get_post as { execute?: (...args: unknown[]) => Promise<unknown> };
      expect(snsGetPost?.execute).toBeTypeOf('function');

      await snsGetPost.execute?.({ post_id: 'post-1' }, { toolCallId: 'tool-1', messages: [] });
      await firstPersistenceLockEntered;

      await snsGetPost.execute?.({ post_id: 'post-2' }, { toolCallId: 'tool-2', messages: [] });
      await Promise.resolve();
      await Promise.resolve();

      expect(startedEvaluations).toEqual(expect.arrayContaining([
        'sns:mastodon:acct-1',
        'sns:mastodon:acct-2',
      ]));

      releasePersistenceLock();
      await expect(agent.drainPendingEvaluations()).resolves.toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('passes the parsed selector into the configured model factory', async () => {
    const memoryStore = new MemoryStoreStub();
    const sessionManager = new SessionManagerStub();
    const seenSelectors: string[] = [];
    const generateTextFn = vi.fn(async () =>
      makeGenerateTextResult('reply', [assistantMessage('reply')]),
    ) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: {
        ...baseConfig,
        llmModel: 'openai/chat/gpt-4o-mini',
        llmModelSelector: parseModelSelector('openai/chat/gpt-4o-mini'),
      },
      memoryStore,
      sessionManager,
      generateTextFn,
      modelFactory: (selector) => {
        seenSelectors.push(selector.selector);
        return {} as LanguageModel;
      },
    });

    await agent.handleMessage('session-1', 'hi', 'Alice');

    expect(seenSelectors).toEqual(['openai/chat/gpt-4o-mini']);
  });

  it('sets providerOptions when llmEnableThinking is false in normal mode', async () => {
    const memoryStore = new MemoryStoreStub();
    const sessionManager = new SessionManagerStub();
    let capturedProviderOptions: unknown;

    const generateTextFn = vi.fn(async (options: { providerOptions?: unknown }) => {
      capturedProviderOptions = options.providerOptions;
      return makeGenerateTextResult('reply', [assistantMessage('reply')]);
    }) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: { ...baseConfig, llmEnableThinking: false },
      memoryStore,
      sessionManager,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await agent.handleMessage('session-1', 'hello', 'Alice');

    expect(capturedProviderOptions).toEqual({ openai: { reasoningEffort: 'low' } });
  });

  it('sets empty providerOptions when llmEnableThinking is false with chat api', async () => {
    const memoryStore = new MemoryStoreStub();
    const sessionManager = new SessionManagerStub();
    let capturedProviderOptions: unknown;

    const generateTextFn = vi.fn(async (options: { providerOptions?: unknown }) => {
      capturedProviderOptions = options.providerOptions;
      return makeGenerateTextResult('reply', [assistantMessage('reply')]);
    }) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: { ...baseConfig, llmEnableThinking: false, llmModel: 'openai/chat/gpt-4o', llmModelSelector: parseModelSelector('openai/chat/gpt-4o') },
      memoryStore,
      sessionManager,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await agent.handleMessage('session-1', 'hello', 'Alice');

    expect(capturedProviderOptions).toEqual({});
  });

  it('does not set providerOptions when llmEnableThinking is true in normal mode', async () => {
    const memoryStore = new MemoryStoreStub();
    const sessionManager = new SessionManagerStub();
    let capturedProviderOptions: unknown;

    const generateTextFn = vi.fn(async (options: { providerOptions?: unknown }) => {
      capturedProviderOptions = options.providerOptions;
      return makeGenerateTextResult('reply', [assistantMessage('reply')]);
    }) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: { ...baseConfig, llmEnableThinking: true },
      memoryStore,
      sessionManager,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await agent.handleMessage('session-1', 'hello', 'Alice');

    expect(capturedProviderOptions).toBeUndefined();
  });

  it('sets providerOptions in summary when llmEnableThinking is false', async () => {
    const memoryStore = new MemoryStoreStub('core memory');
    const sessionManager = new SessionManagerStub();
    sessionManager.forceSummarization = true;

    let summaryProviderOptions: unknown;
    const generateTextFn = vi.fn(async (options: { providerOptions?: unknown; system?: string }) => {
      if (options.system == null) {
        summaryProviderOptions = options.providerOptions;
      }
      return makeGenerateTextResult('reply', [assistantMessage('reply')]);
    }) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: { ...baseConfig, llmEnableThinking: false },
      memoryStore,
      sessionManager,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await agent.handleMessage('session-1', 'hi', 'Alice');

    expect(summaryProviderOptions).toEqual({ openai: { reasoningEffort: 'low' } });
  });

  it('does not set providerOptions in summary when llmEnableThinking is true', async () => {
    const memoryStore = new MemoryStoreStub('core memory');
    const sessionManager = new SessionManagerStub();
    sessionManager.forceSummarization = true;

    let summaryProviderOptions: unknown;
    const generateTextFn = vi.fn(async (options: { providerOptions?: unknown; system?: string }) => {
      if (options.system == null) {
        summaryProviderOptions = options.providerOptions;
      }
      return makeGenerateTextResult('reply', [assistantMessage('reply')]);
    }) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: { ...baseConfig, llmEnableThinking: true },
      memoryStore,
      sessionManager,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await agent.handleMessage('session-1', 'hi', 'Alice');

    expect(summaryProviderOptions).toBeUndefined();
  });

  it('routes OpenAI selectors to the matching provider surface', () => {
    const provider = {
      responses: vi.fn((modelId: string) => ({ kind: `responses:${modelId}` }) as unknown as LanguageModel),
      chat: vi.fn((modelId: string) => ({ kind: `chat:${modelId}` }) as unknown as LanguageModel),
    };
    const modelFactory = createOpenAiModelFactory(provider);

    const responsesModel = modelFactory(parseModelSelector('openai/gpt-4o-mini'));
    const chatModel = modelFactory(parseModelSelector('openai/chat/gpt-4o-mini'));

    expect(provider.responses).toHaveBeenCalledWith('gpt-4o-mini');
    expect(provider.chat).toHaveBeenCalledWith('gpt-4o-mini');
    expect(responsesModel).toEqual({ kind: 'responses:gpt-4o-mini' });
    expect(chatModel).toEqual({ kind: 'chat:gpt-4o-mini' });
  });
});
