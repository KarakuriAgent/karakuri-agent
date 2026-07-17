import { APICallError, type LanguageModel, type ModelMessage } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { countAdditionalContextTokens } from '../src/agent/prompt.js';
import { KarakuriAgent } from '../src/agent/core.js';
import { formatDateTimeInTimezone } from '../src/utils/date.js';
import type { PromptContext } from '../src/agent/prompt-context.js';
import type { Config } from '../src/config.js';
import { DEFAULT_LLM_MODEL, createOpenAiModelFactory, parseModelSelector } from '../src/llm/model-selector.js';
import type { AppraisalService } from '../src/life/appraisal.js';
import { InnerStateService, type IInnerStateStore, type InnerState } from '../src/life/inner-state.js';
import { LoopDetector } from '../src/life/loop-detector.js';
import { ExperienceRecorder } from '../src/life/recorder.js';
import type { IExperienceLogStore } from '../src/life/types.js';
import { PerceptionBuffer } from '../src/life/perception-buffer.js';
import type { IMessageSink, ISchedulerStore } from '../src/scheduler/types.js';
import { pruneRepetitiveToolCallsFromMessages } from '../src/session/prune-repetitive-tool-calls.js';
import type { ISessionManager, PruneRepetitiveToolCallsResult, SessionData } from '../src/session/types.js';
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
  worldActionCommands: {},
  snsRateLimits: {
    defaults: { postPerHour: 3, postPerDay: 20, postMinIntervalMinutes: 15, replyPerHour: 10, likePerHour: 30, repostPerHour: 10 },
    perProvider: {},
    fetchIntervals: { notificationsMinutes: 10, timelineMinutes: 30, trendsMinutes: 60 },
  },
  llmEnableThinking: true,
  llmDisableThinkingRequestParam: false,
  kwPerceptionBufferEnabled: true,
  loopWarningEnabled: true,
  loopDetectorThreshold: 3,
  repetitiveToolCallRecoveryEnabled: true,
  appraisalEnabled: true,
  innerStateInjectionEnabled: true,
  embeddingDimensions: 1536,
  recallInjectionEnabled: true,
  reflectionEnabled: true,
  selfImageInjectionEnabled: true,
  drivesInjectionEnabled: true,
  prospectsInjectionEnabled: true,
};

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
  users = new Map<string, UserRecord>();
  aliases = new Map<string, string>();
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
      if (displayName.trim().length > 0) {
        existing.displayName = displayName.trim();
      }
      existing.updatedAt = new Date('2025-01-01T00:00:01.000Z').toISOString();
      return { ...existing };
    }

    const created: UserRecord = {
      userId,
      displayName,
      createdAt: new Date('2025-01-01T00:00:00.000Z').toISOString(),
      updatedAt: new Date('2025-01-01T00:00:00.000Z').toISOString(),
    };
    this.users.set(userId, created);
    return { ...created };
  }

  async searchUsers(query: string, options?: UserSearchOptions): Promise<UserRecord[]> {
    const normalized = query.toLowerCase();
    const users = [...this.users.values()].filter((user) =>
      user.displayName.toLowerCase().includes(normalized),
    );
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? users.length;
    return users.slice(offset, offset + limit);
  }

  async resolveAlias(userId: string): Promise<{ primaryUserId: string; aliasOf: null | { aliasUserId: string; primaryUserId: string; linkedAt: string; linkedBy: string | null; note: string | null } }> {
    const primaryUserId = this.aliases.get(userId);
    if (primaryUserId == null) {
      return { primaryUserId: userId, aliasOf: null };
    }
    return {
      primaryUserId,
      aliasOf: {
        aliasUserId: userId,
        primaryUserId,
        linkedAt: new Date('2025-01-01T00:00:00.000Z').toISOString(),
        linkedBy: null,
        note: null,
      },
    };
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
  pruneRepetitiveToolCallsCalls = 0;

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

  async pruneRepetitiveToolCalls(sessionId: string): Promise<PruneRepetitiveToolCallsResult> {
    this.pruneRepetitiveToolCallsCalls++;
    const { messages, prunedCount, prunedToolCallIds } = pruneRepetitiveToolCallsFromMessages(this.session.messages);
    this.session = { ...this.session, sessionId, messages };
    return { session: this.session, prunedCount, prunedToolCallIds };
  }
}

function assistantMessage(content: string): ModelMessage {
  return { role: 'assistant', content };
}

function assistantToolCallMessage(toolCallId: string): ModelMessage {
  return {
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId, toolName: 'recallEpisodes', input: { target: 'core' } }],
  };
}

function toolResultMessage(toolCallId: string): ModelMessage {
  return {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId, toolName: 'recallEpisodes', output: { type: 'text', value: 'saved' } }],
  };
}

function duplicateToolCallMessages(): ModelMessage[] {
  return [
    assistantToolCallMessage('call-1'),
    toolResultMessage('call-1'),
    assistantToolCallMessage('call-2'),
    toolResultMessage('call-2'),
  ];
}

function makeRepetitiveToolCallError(): APICallError {
  return new APICallError({
    message: 'Repetitive tool calls detected in the conversation history.',
    url: 'https://example.com',
    requestBodyValues: {},
    statusCode: 400,
  });
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
  const toolInput = comment == null ? { command: 'get_map', params: {} } : { command: 'get_map', params: {}, comment };
  return {
    text: 'ignored kw mode text',
    steps: [{
      toolCalls: [{
        toolName: 'karakuri_world_command',
        input: toolInput,
      }],
      toolResults: [{
        toolName: 'karakuri_world_command',
        output: { ok: true, message: 'Map request accepted.', command: 'get_map', data: {} },
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
              toolName: 'karakuri_world_command',
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
              toolName: 'karakuri_world_command',
              output: { ok: true, message: 'Map request accepted.', command: 'get_map', data: {} },
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
          toolName: 'karakuri_world_command',
          input: { command: 'get_map', params: {}, comment: '周囲を確認します。' },
        },
        {
          toolName: 'karakuri_world_command',
          input: { command: 'move', params: { target_node_id: '1-2' }, comment: '門へ向かいます。' },
        },
      ],
      toolResults: [
        {
          toolName: 'karakuri_world_command',
          output: { ok: true, message: 'Map request accepted.', command: 'get_map', data: {} },
        },
        {
          toolName: 'karakuri_world_command',
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
  const toolInput = { command: 'move', params: { target_node_id: '1-2' }, comment };
  return {
    text: 'ignored kw mode text',
    steps: [{
      toolCalls: [{
        toolName: 'karakuri_world_command',
        input: toolInput,
      }],
      toolResults: [{
        toolName: 'karakuri_world_command',
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
              toolName: 'karakuri_world_command',
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
              toolName: 'karakuri_world_command',
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
  'karakuri_world_command',
] as const;

function makeKarakuriWorldNotificationResponse(overrides: Record<string, unknown> = {}) {
  const base = {
    ok: true,
    notification_id: 'notif-123',
    created_at: 1,
    expires_at: 9_999_999,
    stale: false,
    notification: {
      schema_version: 1,
      kind: 'idle_reminder',
      summary: '次の行動を選んでください。',
      choices: [
        { command: 'get_map', label: '地図を見る', params: {} },
        { command: 'move', label: '門へ移動する', params: { target_node_id: '1-2' } },
      ],
      perception: {
        nearby_nodes: [],
        nodes_omitted_count: 0,
        nearby_agent_count: 0,
        nearby_npcs: [],
        nearby_buildings: [],
        nearby_conversation_count: 0,
        server_event_count: 0,
        item_count: 0,
      },
    },
  };
  return {
    ...base,
    ...overrides,
    notification: {
      ...base.notification,
      ...((overrides.notification as Record<string, unknown> | undefined) ?? {}),
    },
  };
}

function stubKarakuriWorldNotificationFetch(overrides: Record<string, unknown> = {}) {
  const response = makeKarakuriWorldNotificationResponse(overrides);
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(response), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, response };
}

const FAKE_NOW = new Date('2026-03-27T06:30:00Z');

describe('KarakuriAgent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FAKE_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('passes prompt-ready context tokens into the summarization decision', async () => {
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
      sessionManager,
      promptContextStore,
      skillStore,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await agent.handleMessage('session-1', 'hello', 'Alice');

    expect(sessionManager.lastAdditionalTokens).toBe(
      countAdditionalContextTokens({
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
    const sessionManager = new SessionManagerStub();
    sessionManager.forceSummarization = true;

    const generateTextFn = vi
      .fn()
      .mockResolvedValueOnce(makeGenerateTextResult('summary text', []))
      .mockResolvedValueOnce(makeGenerateTextResult('final reply', [assistantMessage('final reply')])) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: baseConfig,
      sessionManager,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await expect(agent.handleMessage('session-1', 'compress this', 'Alice')).resolves.toBe('final reply');

    expect(sessionManager.appliedSummary).toBe('summary text');
    expect(vi.mocked(generateTextFn)).toHaveBeenCalledTimes(2);
  });

  it('keeps ephemeral turns in memory only', async () => {
    const sessionManager = new SessionManagerStub();
    sessionManager.forceSummarization = true;
    const generateTextFn = vi.fn(async () =>
      makeGenerateTextResult('ephemeral reply', [assistantMessage('ephemeral reply')]),
    ) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: baseConfig,
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
    const sessionManager = new SessionManagerStub();
    sessionManager.session.summary = 'previous summary';

    let capturedSystem = '';
    const generateTextFn = vi.fn(async (options: { system?: string }) => {
      capturedSystem = options.system ?? '';
      return makeGenerateTextResult('reply', [assistantMessage('reply')]);
    }) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: baseConfig,
      sessionManager,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await agent.handleMessage('session-1', 'hi', 'Alice');

    expect(capturedSystem).toContain('<summary>');
    expect(sessionManager.session.messages).toContainEqual(assistantMessage('reply'));
  });


  it('hides system-only skills from normal users', async () => {
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
    const sessionManager = new SessionManagerStub();
    let capturedSystem = '';

    const generateTextFn = vi.fn(async (options: { system?: string }) => {
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
    const sessionManager = new SessionManagerStub();
    let capturedSystem = '';

    const generateTextFn = vi.fn(async (options: { system?: string }) => {
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

  describe('repetitive tool call recovery', () => {
    it('prunes duplicate tool calls from the session and retries once after a repetitive tool call error', async () => {
      const sessionManager = new SessionManagerStub();
      sessionManager.session.messages = duplicateToolCallMessages();

      const generateTextFn = vi
        .fn()
        .mockRejectedValueOnce(makeRepetitiveToolCallError())
        .mockResolvedValueOnce(makeGenerateTextResult('recovered reply', [assistantMessage('recovered reply')])) as unknown as typeof import('ai').generateText;

      const agent = new KarakuriAgent({
        config: baseConfig,
        sessionManager,
        generateTextFn,
        modelFactory: () => ({}) as LanguageModel,
      });

      await expect(agent.handleMessage('session-1', 'hello', 'Alice')).resolves.toBe('recovered reply');

      expect(vi.mocked(generateTextFn)).toHaveBeenCalledTimes(2);
      expect(sessionManager.pruneRepetitiveToolCallsCalls).toBe(1);
      expect(sessionManager.session.messages).not.toContainEqual(assistantToolCallMessage('call-1'));
      expect(sessionManager.session.messages).toContainEqual(assistantToolCallMessage('call-2'));
    });

    it('rethrows immediately when no duplicate tool calls are found to prune', async () => {
      const sessionManager = new SessionManagerStub();

      const generateTextFn = vi.fn(async () => {
        throw makeRepetitiveToolCallError();
      }) as unknown as typeof import('ai').generateText;

      const agent = new KarakuriAgent({
        config: baseConfig,
        sessionManager,
        generateTextFn,
        modelFactory: () => ({}) as LanguageModel,
      });

      await expect(agent.handleMessage('session-1', 'hello', 'Alice')).rejects.toThrow(
        'Repetitive tool calls detected',
      );

      expect(vi.mocked(generateTextFn)).toHaveBeenCalledTimes(1);
      expect(sessionManager.pruneRepetitiveToolCallsCalls).toBe(1);
    });

    it('skips recovery for ephemeral turns and rejects without pruning', async () => {
      const sessionManager = new SessionManagerStub();
      sessionManager.session.messages = duplicateToolCallMessages();

      const generateTextFn = vi.fn(async () => {
        throw makeRepetitiveToolCallError();
      }) as unknown as typeof import('ai').generateText;

      const agent = new KarakuriAgent({
        config: baseConfig,
        sessionManager,
        generateTextFn,
        modelFactory: () => ({}) as LanguageModel,
      });

      await expect(agent.handleMessage('heartbeat:2025-01-01T00:00:00.000Z', '(heartbeat tick)', 'heartbeat', {
        userId: 'system',
        ephemeral: true,
      })).rejects.toThrow('Repetitive tool calls detected');

      expect(vi.mocked(generateTextFn)).toHaveBeenCalledTimes(1);
      expect(sessionManager.pruneRepetitiveToolCallsCalls).toBe(0);
    });

    it('recovers in karakuri-world mode the same way as normal mode', async () => {
      const sessionManager = new SessionManagerStub();
      sessionManager.session.messages = duplicateToolCallMessages();
      const userStore = new UserStoreStub();

      const generateTextFn = vi
        .fn()
        .mockRejectedValueOnce(makeRepetitiveToolCallError())
        .mockResolvedValueOnce(makeKwModeGenerateTextResult('周囲を確認します。')) as unknown as typeof import('ai').generateText;

      const agent = new KarakuriAgent({
        config: {
          ...baseConfig,
          karakuriWorldBotIds: ['kw-bot-1'],
          karakuriWorld: {
            apiBaseUrl: 'https://example.com/world',
            apiKey: 'world-key',
          },
        },
        sessionManager,
        userStore,
        generateTextFn,
        modelFactory: () => ({}) as LanguageModel,
      });

      stubKarakuriWorldNotificationFetch();

      await expect(agent.handleMessage('session-1', 'notification_id: notif-123', 'Admin', { userId: 'kw-bot-1' })).resolves.toBe('周囲を確認します。');

      expect(vi.mocked(generateTextFn)).toHaveBeenCalledTimes(2);
      expect(sessionManager.pruneRepetitiveToolCallsCalls).toBe(1);
    });

    it('retries at most once, rejecting with the retry error if pruning does not fix the underlying issue', async () => {
      const sessionManager = new SessionManagerStub();
      sessionManager.session.messages = duplicateToolCallMessages();

      const generateTextFn = vi
        .fn()
        .mockRejectedValueOnce(makeRepetitiveToolCallError())
        .mockRejectedValueOnce(makeRepetitiveToolCallError()) as unknown as typeof import('ai').generateText;

      const agent = new KarakuriAgent({
        config: baseConfig,
        sessionManager,
        generateTextFn,
        modelFactory: () => ({}) as LanguageModel,
      });

      await expect(agent.handleMessage('session-1', 'hello', 'Alice')).rejects.toThrow(
        'Repetitive tool calls detected',
      );

      expect(vi.mocked(generateTextFn)).toHaveBeenCalledTimes(2);
      expect(sessionManager.pruneRepetitiveToolCallsCalls).toBe(1);
    });

    it('skips recovery entirely when disabled via config', async () => {
      const sessionManager = new SessionManagerStub();
      sessionManager.session.messages = duplicateToolCallMessages();

      const generateTextFn = vi.fn(async () => {
        throw makeRepetitiveToolCallError();
      }) as unknown as typeof import('ai').generateText;

      const agent = new KarakuriAgent({
        config: { ...baseConfig, repetitiveToolCallRecoveryEnabled: false },
        sessionManager,
        generateTextFn,
        modelFactory: () => ({}) as LanguageModel,
      });

      await expect(agent.handleMessage('session-1', 'hello', 'Alice')).rejects.toThrow(
        'Repetitive tool calls detected',
      );

      expect(vi.mocked(generateTextFn)).toHaveBeenCalledTimes(1);
      expect(sessionManager.pruneRepetitiveToolCallsCalls).toBe(0);
    });

    it('does not attempt recovery for unrelated errors', async () => {
      const sessionManager = new SessionManagerStub();
      sessionManager.session.messages = duplicateToolCallMessages();

      const generateTextFn = vi.fn(async () => {
        throw new Error('some other failure');
      }) as unknown as typeof import('ai').generateText;

      const agent = new KarakuriAgent({
        config: baseConfig,
        sessionManager,
        generateTextFn,
        modelFactory: () => ({}) as LanguageModel,
      });

      await expect(agent.handleMessage('session-1', 'hello', 'Alice')).rejects.toThrow('some other failure');

      expect(vi.mocked(generateTextFn)).toHaveBeenCalledTimes(1);
      expect(sessionManager.pruneRepetitiveToolCallsCalls).toBe(0);
    });
  });

  it('does not inject builtin sns skill for non-system non-admin users', async () => {
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
    expect(capturedTools).not.toHaveProperty('karakuri_world_command');
  });

  it('does not expose legacy karakuri-world skills without allowedTools for normal users', async () => {
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
    const sessionManager = new SessionManagerStub();
    sessionManager.session.summary = 'previous summary';
    const userStore = new UserStoreStub();
    let capturedSystem = '';
    let capturedTools: Record<string, unknown> = {};
    let capturedToolChoice: unknown;

    let capturedProviderOptions: unknown;

    const generateTextFn = vi.fn(async (options: { system?: string; tools?: Record<string, unknown>; toolChoice?: unknown; providerOptions?: unknown }) => {
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

    stubKarakuriWorldNotificationFetch();

    await expect(agent.handleMessage('session-1', 'notification_id: notif-123', 'Admin', { userId: 'kw-bot-1' })).resolves.toBe('周囲を確認します。');
    await agent.drainPendingEvaluations();

    expect(userStore.ensureCalls).toEqual([]);
    expect(Object.keys(capturedTools).sort()).toEqual([...EXPECTED_KW_TOOL_NAMES].sort());
    expect(capturedToolChoice).toEqual({ type: 'tool', toolName: 'karakuri_world_command' });
    expect(capturedProviderOptions).toEqual({ openai: { reasoningEffort: 'low' } });
    expect(capturedSystem).toContain('You are custom.');
    expect(capturedSystem).toContain('Be precise.');
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
          toolName: 'karakuri_world_command',
          input: { command: 'get_map', params: {}, comment: '周囲を確認します。' },
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
          toolName: 'karakuri_world_command',
          output: { ok: true, message: 'Map request accepted.', command: 'get_map', data: {} },
        },
      ],
    });
  });

  it('notifies phone integration on custom commands and injects phone status (M8)', async () => {
    const sessionManager = new SessionManagerStub();
    let capturedSystem = '';
    const toolInput = { command: 'check_phone', params: {}, comment: 'スマホを見ます。' };
    const generateTextFn = vi.fn(async (options: { system?: string }) => {
      capturedSystem = options.system ?? '';
      return {
        text: 'ignored kw mode text',
        steps: [{
          toolCalls: [{ toolName: 'karakuri_world_command', input: toolInput }],
          toolResults: [{ toolName: 'karakuri_world_command', output: { ok: true, status: 'started', action_id: 'check_phone' } }],
        }],
        response: { id: 'response-id', modelId: 'gpt-4o', timestamp: new Date(), messages: [] },
      } as const;
    }) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: {
        ...baseConfig,
        karakuriWorldBotIds: ['kw-bot-1'],
        karakuriWorld: {
          apiBaseUrl: 'https://example.com/world',
          apiKey: 'world-key',
        },
        worldActionCommands: { checkPhone: 'check_phone' },
      },
      sessionManager,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });
    const onWorldCommand = vi.fn();
    agent.setPhoneIntegration({
      onWorldCommand,
      buildStatusSection: async () => '<phone-status>\nチャット未読: 2 件\n</phone-status>',
      oldestPendingReceivedAt: async () => null,
    });

    stubKarakuriWorldNotificationFetch();

    await agent.handleMessage('session-1', 'notification_id: notif-123', 'Admin', { userId: 'kw-bot-1' });
    await agent.drainPendingEvaluations();

    expect(onWorldCommand).toHaveBeenCalledWith('check_phone');
    expect(capturedSystem).toContain('<phone-status>');
    expect(capturedSystem).toContain('チャット未読: 2 件');
  });

  it('does not fire phone integration when the world command was rejected (busy) (M8 review fix)', async () => {
    const sessionManager = new SessionManagerStub();
    const toolInput = { command: 'check_phone', params: {}, comment: 'スマホを見ます。' };
    const generateTextFn = vi.fn(async () => {
      return {
        text: 'ignored kw mode text',
        steps: [{
          toolCalls: [{ toolName: 'karakuri_world_command', input: toolInput }],
          toolResults: [{ toolName: 'karakuri_world_command', output: { status: 'busy', message: 'state_conflict' } }],
        }],
        response: { id: 'response-id', modelId: 'gpt-4o', timestamp: new Date(), messages: [] },
      } as const;
    }) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: {
        ...baseConfig,
        karakuriWorldBotIds: ['kw-bot-1'],
        karakuriWorld: {
          apiBaseUrl: 'https://example.com/world',
          apiKey: 'world-key',
        },
        worldActionCommands: { checkPhone: 'check_phone' },
      },
      sessionManager,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });
    const onWorldCommand = vi.fn();
    agent.setPhoneIntegration({
      onWorldCommand,
      buildStatusSection: async () => null,
      oldestPendingReceivedAt: async () => null,
    });

    stubKarakuriWorldNotificationFetch();

    await agent.handleMessage('session-1', 'notification_id: notif-123', 'Admin', { userId: 'kw-bot-1' });
    await agent.drainPendingEvaluations();

    expect(onWorldCommand).not.toHaveBeenCalled();
  });

  it('records own_action only when the world command actually started (偽記憶防止)', async () => {
    // 409 拒否・バリデーション失敗で実行されなかったコマンドを記録すると
    // 「待機した」等の偽の記憶が experience_log と頻度台帳へ蓄積される（実機で確認）
    const makeAgent = (store: IExperienceLogStore, result: unknown) => {
      const agent = new KarakuriAgent({
        config: {
          ...baseConfig,
          karakuriWorldBotIds: ['kw-bot-1'],
          karakuriWorld: { apiBaseUrl: 'https://example.com/world', apiKey: 'world-key' },
        },
        sessionManager: new SessionManagerStub(),
        experienceRecorder: new ExperienceRecorder({ store }),
        generateTextFn: vi.fn(async () => result) as unknown as typeof import('ai').generateText,
        modelFactory: () => ({}) as LanguageModel,
      });
      stubKarakuriWorldNotificationFetch();
      return agent;
    };
    const recordedKinds = (store: IExperienceLogStore): string[] =>
      (store.append as ReturnType<typeof vi.fn>).mock.calls.map((call) => (call[0] as { kind: string }).kind);

    const startedStore = createExperienceLogStoreStub(1);
    const startedAgent = makeAgent(startedStore, makeKwModeGenerateTextResult('地図を見るよ。'));
    await startedAgent.handleMessage('session-1', 'notification_id: notif-123', 'KWBot', { userId: 'kw-bot-1' });
    await startedAgent.drainPendingEvaluations();
    expect(recordedKinds(startedStore)).toContain('own_action');

    const rejectedStore = createExperienceLogStoreStub(2);
    const rejectedAgent = makeAgent(rejectedStore, makeBusyKwModeGenerateTextResult('移動を試すよ。'));
    await rejectedAgent.handleMessage('session-1', 'notification_id: notif-123', 'KWBot', { userId: 'kw-bot-1' });
    await rejectedAgent.drainPendingEvaluations();
    expect(recordedKinds(rejectedStore)).not.toContain('own_action');
  });

  it('falls back to a default completion reply when a karakuri-world tool call input has no comment', async () => {
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
      sessionManager,
      generateTextFn: vi.fn(async () =>
        makeKwModeGenerateTextResult(undefined),
      ) as unknown as typeof import('ai').generateText,
      modelFactory: () => ({}) as LanguageModel,
    });

    stubKarakuriWorldNotificationFetch();

    await expect(agent.handleMessage('session-1', 'notification_id: notif-123', 'Admin', { userId: 'kw-bot-1' })).resolves.toBe('(行動完了)');
  });

  it('returns the command selection comment when a karakuri-world command result is busy', async () => {
    const sessionManager = new SessionManagerStub();

    const generateTextFn = vi.fn(async () =>
      makeBusyKwModeGenerateTextResult('門へ向かいます。'),
    ) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: {
        ...baseConfig,
        karakuriWorldBotIds: ['kw-bot-1'],
        karakuriWorld: {
          apiBaseUrl: 'https://example.com/world',
          apiKey: 'world-key',
        },
      },
      sessionManager,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    stubKarakuriWorldNotificationFetch();

    await expect(agent.handleMessage('session-1', 'notification_id: notif-123', 'KWBot', { userId: 'kw-bot-1' })).resolves.toBe('門へ向かいます。');
    await agent.drainPendingEvaluations();

    expect(sessionManager.session.messages.length).toBeGreaterThanOrEqual(2);
  });

  it('returns an empty string without notifying the agent when a karakuri-world logout notice has no notification_id', async () => {
    const sessionManager = new SessionManagerStub();

    const generateTextFn = vi.fn(async () =>
      makeNotLoggedInKwModeGenerateTextResult('門へ向かいます。'),
    ) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: {
        ...baseConfig,
        karakuriWorldBotIds: ['kw-bot-1'],
        karakuriWorld: {
          apiBaseUrl: 'https://example.com/world',
          apiKey: 'world-key',
        },
      },
      sessionManager,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await expect(agent.handleMessage('session-1', 'からくりワールドアプリ: ログアウトしました。', 'KWBot', { userId: 'kw-bot-1' })).resolves.toBe('');
    await agent.drainPendingEvaluations();

    expect(sessionManager.session.messages).toHaveLength(0);
    expect(generateTextFn).not.toHaveBeenCalled();
  });

  it('skips karakuri-world notifications when get_notification returns an API error', async () => {
    const sessionManager = new SessionManagerStub();
    const generateTextFn = vi.fn(async () =>
      makeKwModeGenerateTextResult('呼ばれない'),
    ) as unknown as typeof import('ai').generateText;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'not_logged_in',
      message: 'Agent is not logged in.',
    }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    })));

    const agent = new KarakuriAgent({
      config: {
        ...baseConfig,
        karakuriWorldBotIds: ['kw-bot-1'],
        karakuriWorld: {
          apiBaseUrl: 'https://example.com/world',
          apiKey: 'world-key',
        },
      },
      sessionManager,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await expect(agent.handleMessage('session-1', 'notification_id: notif-logout', 'KWBot', { userId: 'kw-bot-1' })).resolves.toBe('');

    expect(sessionManager.session.messages).toHaveLength(0);
    expect(generateTextFn).not.toHaveBeenCalled();
  });

  it('rejects multiple karakuri-world actions in a single notification', async () => {
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
      sessionManager,
      generateTextFn: vi.fn(async () =>
        makeInvalidMultiActionKwModeGenerateTextResult(),
      ) as unknown as typeof import('ai').generateText,
      modelFactory: () => ({}) as LanguageModel,
    });

    stubKarakuriWorldNotificationFetch();

    await expect(agent.handleMessage('session-1', 'notification_id: notif-123', 'Admin', { userId: 'kw-bot-1' }))
      .rejects.toThrow('KarakuriWorld mode expected exactly one action, but received 2.');
    expect(sessionManager.session.messages).toHaveLength(1);
  });

  it('rejects missing karakuri-world actions in a single notification', async () => {
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
      sessionManager,
      generateTextFn: vi.fn(async () =>
        makeInvalidZeroActionKwModeGenerateTextResult(),
      ) as unknown as typeof import('ai').generateText,
      modelFactory: () => ({}) as LanguageModel,
    });

    stubKarakuriWorldNotificationFetch();

    await expect(agent.handleMessage('session-1', 'notification_id: notif-123', 'Admin', { userId: 'kw-bot-1' }))
      .rejects.toThrow('KarakuriWorld mode expected exactly one action, but received 0.');
    expect(sessionManager.session.messages).toHaveLength(1);
  });

  it('keeps normal users on the standard tool path even when karakuri-world is configured', async () => {
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
      sessionManager,
      userStore: new UserStoreStub(),
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await agent.handleMessage('session-1', 'hi', 'Alice', { userId: 'user-1' });

    expect(capturedToolChoice).toBeUndefined();
    expect(capturedTools).toHaveProperty('webFetch');
    expect(capturedTools).not.toHaveProperty('karakuri_world_command');
    expect(capturedSystem).not.toContain('KarakuriWorld mode is active.');
    expect(capturedSystem).toContain('- webFetch: fetch a URL and extract its readable content as Markdown.');
  });

  it('keeps admin users on the standard user-profile path when karakuri-world is disabled', async () => {
    const sessionManager = new SessionManagerStub();
    const userStore = new UserStoreStub([
      {
        userId: 'admin-user',
        displayName: 'Admin Old',
        createdAt: new Date('2025-01-01T00:00:00.000Z').toISOString(),
        updatedAt: new Date('2025-01-01T00:00:00.000Z').toISOString(),
      },
    ]);
    let capturedSystem = '';

    const generateTextFn = vi.fn(async (options: { system?: string }) => {
      capturedSystem = options.system ?? '';
      return makeGenerateTextResult('reply', [assistantMessage('reply')]);
    }) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: {
        ...baseConfig,
        adminUserIds: ['admin-user'],
      },
      sessionManager,
      userStore,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await expect(agent.handleMessage('session-1', 'hi', 'Admin', { userId: 'admin-user' })).resolves.toBe('reply');

    expect(userStore.ensureCalls).toEqual([{ userId: 'admin-user', displayName: 'Admin' }]);
    expect(capturedSystem).toContain('<user-profile>');
    expect(capturedSystem).toContain('Display name: Admin');
    expect(capturedSystem).toContain('User ID: admin-user');
    expect(capturedSystem).not.toContain('KarakuriWorld mode is active.');
  });

  it('omits unavailable gated tools from prompts and loadSkill results', async () => {
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
    const sessionManager = new SessionManagerStub();
    const lifecycleEvents: string[] = [];

    const generateTextFn = vi.fn(async (options: {
      experimental_onStepStart?: (event: unknown) => void;
      experimental_onToolCallStart?: (event: { toolCall: { toolName: string } }) => void;
      experimental_onToolCallFinish?: (event: { toolCall: { toolName: string } }) => void;
    }) => {
      options.experimental_onStepStart?.({} as never);
      options.experimental_onToolCallStart?.({ toolCall: { toolName: 'recallEpisodes' } } as never);
      options.experimental_onToolCallFinish?.({ toolCall: { toolName: 'recallEpisodes' } } as never);
      return makeGenerateTextResult('reply', [assistantMessage('reply')]);
    }) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: baseConfig,
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
      'start:recallEpisodes',
      'finish:recallEpisodes',
    ]);
  });

  it('does not register lifecycle callbacks when options are omitted', async () => {
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

  it('registers real users, refreshes display names, injects profile context, and exposes userLookup', async () => {
    const sessionManager = new SessionManagerStub();
    const userStore = new UserStoreStub([
      {
        userId: 'user-1',
        displayName: 'Alice Old',
        createdAt: '',
        updatedAt: '',
      },
    ]);
    let capturedSystem = '';
    let capturedTools: Record<string, unknown> = {};

    const generateTextFn = vi.fn(async (options: { system?: string; tools?: Record<string, unknown> }) => {
      capturedSystem = options.system ?? '';
      capturedTools = options.tools ?? {};
      return makeGenerateTextResult('reply', [assistantMessage('reply')]);
    }) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: baseConfig,
      sessionManager,
      userStore,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await expect(agent.handleMessage('session-1', 'hi', 'Alice', { userId: 'user-1' })).resolves.toBe('reply');

    expect(userStore.ensureCalls).toEqual([{ userId: 'user-1', displayName: 'Alice' }]);
    expect(userStore.users.get('user-1')?.displayName).toBe('Alice');
    expect(capturedSystem).toContain('<user-profile>');
    expect(capturedSystem).toContain('Display name: Alice');
    expect(capturedSystem).toContain('User ID: user-1');
    expect(capturedSystem).toContain('- userLookup: search saved user profiles when asked about other users.');
    expect(capturedTools).toHaveProperty('userLookup');
  });

  it('skips user registration and profile injection for system users', async () => {
    const sessionManager = new SessionManagerStub();
    const userStore = new UserStoreStub();
    let capturedSystem = '';

    const generateTextFn = vi.fn(async (options: { system?: string }) => {
      capturedSystem = options.system ?? '';
      return makeGenerateTextResult('reply', [assistantMessage('reply')]);
    }) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: baseConfig,
      sessionManager,
      userStore,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await agent.handleMessage('session-1', 'hi', 'Alice', { userId: 'system' });

    expect(userStore.ensureCalls).toEqual([]);
    expect(capturedSystem).not.toContain('\n\n<user-profile>\n');
    expect(vi.mocked(generateTextFn)).toHaveBeenCalledTimes(1);
  });

  it('continues the main reply when ensureUser fails', async () => {
    const sessionManager = new SessionManagerStub();
    const userStore = new UserStoreStub();
    userStore.failEnsure = true;

    const agent = new KarakuriAgent({
      config: baseConfig,
      sessionManager,
      userStore,
      generateTextFn: vi.fn(async () =>
        makeGenerateTextResult('reply', [assistantMessage('reply')]),
      ) as unknown as typeof import('ai').generateText,
      modelFactory: () => ({}) as LanguageModel,
    });

    await expect(agent.handleMessage('session-1', 'hi', 'Alice', { userId: 'user-1' })).resolves.toBe('reply');
  });

  it('passes the parsed selector into the configured model factory', async () => {
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
    const sessionManager = new SessionManagerStub();
    let capturedProviderOptions: unknown;

    const generateTextFn = vi.fn(async (options: { providerOptions?: unknown }) => {
      capturedProviderOptions = options.providerOptions;
      return makeGenerateTextResult('reply', [assistantMessage('reply')]);
    }) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: { ...baseConfig, llmEnableThinking: false },
      sessionManager,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await agent.handleMessage('session-1', 'hello', 'Alice');

    expect(capturedProviderOptions).toEqual({ openai: { reasoningEffort: 'low' } });
  });

  it('sets empty providerOptions when llmEnableThinking is false with chat api', async () => {
    const sessionManager = new SessionManagerStub();
    let capturedProviderOptions: unknown;

    const generateTextFn = vi.fn(async (options: { providerOptions?: unknown }) => {
      capturedProviderOptions = options.providerOptions;
      return makeGenerateTextResult('reply', [assistantMessage('reply')]);
    }) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: { ...baseConfig, llmEnableThinking: false, llmModel: 'openai/chat/gpt-4o', llmModelSelector: parseModelSelector('openai/chat/gpt-4o') },
      sessionManager,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await agent.handleMessage('session-1', 'hello', 'Alice');

    expect(capturedProviderOptions).toEqual({});
  });

  it('does not set providerOptions when llmEnableThinking is true in normal mode', async () => {
    const sessionManager = new SessionManagerStub();
    let capturedProviderOptions: unknown;

    const generateTextFn = vi.fn(async (options: { providerOptions?: unknown }) => {
      capturedProviderOptions = options.providerOptions;
      return makeGenerateTextResult('reply', [assistantMessage('reply')]);
    }) as unknown as typeof import('ai').generateText;

    const agent = new KarakuriAgent({
      config: { ...baseConfig, llmEnableThinking: true },
      sessionManager,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await agent.handleMessage('session-1', 'hello', 'Alice');

    expect(capturedProviderOptions).toBeUndefined();
  });

  it('sets providerOptions in summary when llmEnableThinking is false', async () => {
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
      sessionManager,
      generateTextFn,
      modelFactory: () => ({}) as LanguageModel,
    });

    await agent.handleMessage('session-1', 'hi', 'Alice');

    expect(summaryProviderOptions).toEqual({ openai: { reasoningEffort: 'low' } });
  });

  it('does not set providerOptions in summary when llmEnableThinking is true', async () => {
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

  describe('KW perception buffer and loop detector (M1)', () => {
    function createKwAgent(overrides: {
      perceptionBuffer?: PerceptionBuffer;
      loopDetector?: LoopDetector;
      config?: Partial<Config>;
      generateTextFn?: unknown;
      sessionManager?: SessionManagerStub;
      onSystem?: (system: string) => void;
    } = {}) {
      const sessionManager = overrides.sessionManager ?? new SessionManagerStub();
      const generateTextFn = overrides.generateTextFn ?? vi.fn(async (options: { system?: string }) => {
        // KW モードの応答呼び出しだけを対象にし、KW ターンの system だけを捕捉する
        if (options.system != null && options.system.includes('KarakuriWorld mode is active.')) {
          overrides.onSystem?.(options.system);
        }
        return makeKwModeGenerateTextResult('了解した。');
      });
      const agent = new KarakuriAgent({
        config: {
          ...baseConfig,
          karakuriWorldBotIds: ['kw-bot-1'],
          karakuriWorld: {
            apiBaseUrl: 'https://example.com/world',
            apiKey: 'world-key',
          },
          ...overrides.config,
        },
        sessionManager,
        ...(overrides.perceptionBuffer != null ? { perceptionBuffer: overrides.perceptionBuffer } : {}),
        ...(overrides.loopDetector != null ? { loopDetector: overrides.loopDetector } : {}),
        generateTextFn: generateTextFn as unknown as typeof import('ai').generateText,
        modelFactory: () => ({}) as LanguageModel,
      });
      return { agent, sessionManager, generateTextFn };
    }

    it('keeps state notifications out of session history and injects them via the perception section', async () => {
      const perceptionBuffer = new PerceptionBuffer();
      let capturedSystem = '';
      const { agent, sessionManager } = createKwAgent({
        perceptionBuffer,
        onSystem: (system) => {
          capturedSystem = system;
        },
      });
      stubKarakuriWorldNotificationFetch();

      await expect(
        agent.handleMessage('session-1', 'notification_id: notif-123', 'KWBot', { userId: 'kw-bot-1' }),
      ).resolves.toBe('了解した。');
      await agent.drainPendingEvaluations();

      // 世界状態スナップショットはセッション履歴に積まれない
      const userMessages = sessionManager.session.messages.filter((message) => message.role === 'user');
      expect(userMessages).toHaveLength(1);
      const userContent = typeof userMessages[0]!.content === 'string' ? userMessages[0]!.content : '';
      expect(userContent).toContain('world state update');
      expect(userContent).not.toContain('nearby_nodes');
      expect(userContent).not.toContain('notif-123');

      // 最新の世界状態はシステムプロンプトの untrusted タグで注入される
      expect(capturedSystem).toContain('<karakuri-world-perception>');
      expect(capturedSystem).toContain('nearby_nodes');
      expect(perceptionBuffer.getLatest('kw:kw-bot-1')).not.toBeNull();
    });

    it('keeps conversation notifications in session history for multi-turn conversations', async () => {
      const perceptionBuffer = new PerceptionBuffer();
      const { agent, sessionManager } = createKwAgent({ perceptionBuffer });
      stubKarakuriWorldNotificationFetch({
        notification: { kind: 'conversation_message', summary: 'B さん:「映画どうだった？」' },
      });

      await agent.handleMessage('session-1', 'notification_id: notif-123', 'KWBot', { userId: 'kw-bot-1' });
      await agent.drainPendingEvaluations();

      const userMessages = sessionManager.session.messages.filter((message) => message.role === 'user');
      const userContent = typeof userMessages[0]!.content === 'string' ? userMessages[0]!.content : '';
      expect(userContent).toContain('映画どうだった');
      // 会話系通知はバッファを置き換えない（最後の状態系通知が残る）
      expect(perceptionBuffer.getLatest('kw:kw-bot-1')).toBeNull();
    });

    it('falls back to legacy history behavior when the buffer is disabled', async () => {
      const perceptionBuffer = new PerceptionBuffer();
      const { agent, sessionManager } = createKwAgent({
        perceptionBuffer,
        config: { kwPerceptionBufferEnabled: false },
      });
      stubKarakuriWorldNotificationFetch();

      await agent.handleMessage('session-1', 'notification_id: notif-123', 'KWBot', { userId: 'kw-bot-1' });
      await agent.drainPendingEvaluations();

      const userMessages = sessionManager.session.messages.filter((message) => message.role === 'user');
      const userContent = typeof userMessages[0]!.content === 'string' ? userMessages[0]!.content : '';
      expect(userContent).toContain('nearby_nodes');
    });

    it('injects a trusted loop warning after repeating the same action beyond the threshold', async () => {
      const loopDetector = new LoopDetector({ threshold: 3 });
      const systems: string[] = [];
      const { agent } = createKwAgent({
        loopDetector,
        onSystem: (system) => {
          systems.push(system);
        },
      });
      stubKarakuriWorldNotificationFetch();

      for (let i = 0; i < 4; i += 1) {
        await agent.handleMessage('session-1', 'notification_id: notif-123', 'KWBot', { userId: 'kw-bot-1' });
      }
      await agent.drainPendingEvaluations();

      // 1〜3 回目のプロンプトには警告なし（streak は応答後に加算される）
      expect(systems[0]).not.toContain('行動ループ警告');
      expect(systems[2]).not.toContain('行動ループ警告');
      // 3 回連続の後、4 回目のプロンプトに trusted 警告が入る
      expect(systems[3]).toContain('行動ループ警告');
      expect(loopDetector.getConsecutiveCount('kw:kw-bot-1')).toBe(4);
    });

    it('does not inject the loop warning when disabled by config', async () => {
      const loopDetector = new LoopDetector({ threshold: 2 });
      const systems: string[] = [];
      const { agent } = createKwAgent({
        loopDetector,
        config: { loopWarningEnabled: false },
        onSystem: (system) => {
          systems.push(system);
        },
      });
      stubKarakuriWorldNotificationFetch();

      for (let i = 0; i < 3; i += 1) {
        await agent.handleMessage('session-1', 'notification_id: notif-123', 'KWBot', { userId: 'kw-bot-1' });
      }
      await agent.drainPendingEvaluations();

      expect(systems.every((system) => !system.includes('行動ループ警告'))).toBe(true);
    });

    it('injects the inner-state section for KW turns and awaits appraisal before responding (M2)', async () => {
      const innerStateService = new InnerStateService({
        store: new InMemoryInnerStateStore(),
        timezone: 'Asia/Tokyo',
      });
      const order: string[] = [];
      const appraisalService = {
        enqueue: vi.fn(async () => {
          order.push('appraisal');
        }),
        drain: vi.fn(async () => {}),
      } as unknown as AppraisalService;

      let capturedSystem = '';
      const generateTextFn = vi.fn(async (options: { system?: string }) => {
        if (options.system != null && options.system.includes('KarakuriWorld mode is active.')) {
          order.push('response');
          capturedSystem = options.system;
        }
        return makeKwModeGenerateTextResult('了解した。');
      });
      const agent = new KarakuriAgent({
        config: {
          ...baseConfig,
          karakuriWorldBotIds: ['kw-bot-1'],
          karakuriWorld: { apiBaseUrl: 'https://example.com/world', apiKey: 'world-key' },
        },
        sessionManager: new SessionManagerStub(),
        appraisalService,
        innerStateService,
        generateTextFn: generateTextFn as unknown as typeof import('ai').generateText,
        modelFactory: () => ({}) as LanguageModel,
      });
      stubKarakuriWorldNotificationFetch();

      await agent.handleMessage('session-1', 'notification_id: notif-123', 'KWBot', { userId: 'kw-bot-1' });
      await agent.drainPendingEvaluations();

      // KW は appraisal 先行 → 応答
      expect(order).toEqual(['appraisal', 'response']);
      expect(capturedSystem).toContain('<inner-state>');
    });

    it('enqueues Discord appraisal after the response and honors the injection kill switch', async () => {
      const innerStateService = new InnerStateService({
        store: new InMemoryInnerStateStore(),
        timezone: 'Asia/Tokyo',
      });
      const order: string[] = [];
      const appraisalService = {
        enqueue: vi.fn(async () => {
          order.push('appraisal');
        }),
        drain: vi.fn(async () => {}),
      } as unknown as AppraisalService;

      const generateTextFn = vi.fn(async (options: { system?: string }) => {
        if (options.system != null) {
          order.push('response');
        }
        return makeGenerateTextResult('こんにちは！', [assistantMessage('こんにちは！')]);
      });
      const agent = new KarakuriAgent({
        config: { ...baseConfig, innerStateInjectionEnabled: false },
        sessionManager: new SessionManagerStub(),
        appraisalService,
        innerStateService,
        generateTextFn: generateTextFn as unknown as typeof import('ai').generateText,
        modelFactory: () => ({}) as LanguageModel,
      });

      await agent.handleMessage('session-1', 'こんにちは', 'Alice', { userId: 'user-1' });
      await agent.drainPendingEvaluations();

      // Discord は応答先行 → appraisal 事後
      expect(order[0]).toBe('response');
      expect(order).toContain('appraisal');
      // kill switch: <inner-state> は注入されない
      const injectedSystems = generateTextFn.mock.calls
        .map((call) => (call[0] as { system?: string }).system ?? '')
        .filter((system) => system.includes('<inner-state>'));
      expect(injectedSystems).toEqual([]);
    });

    it('applies a deterministic fell_asleep transition when the agent issues a sleep action (#102)', async () => {
      const innerStateStore = new InMemoryInnerStateStore();
      const innerStateService = new InnerStateService({ store: innerStateStore, timezone: 'Asia/Tokyo' });
      const sleepToolInput = { command: 'action', params: { action_id: 'action-sleep', duration_minutes: 360 }, comment: 'おやすみ！' };
      const sleepResult = {
        text: 'ignored kw mode text',
        steps: [{
          toolCalls: [{ toolName: 'karakuri_world_command', input: sleepToolInput }],
          toolResults: [{
            toolName: 'karakuri_world_command',
            output: { ok: true, message: 'Sleep started.', command: 'action', data: {} },
          }],
        }],
        response: { id: 'response-id', modelId: 'gpt-4o', timestamp: new Date(), messages: [] },
      };

      const agent = new KarakuriAgent({
        config: {
          ...baseConfig,
          karakuriWorldBotIds: ['kw-bot-1'],
          karakuriWorld: { apiBaseUrl: 'https://example.com/world', apiKey: 'world-key' },
        },
        sessionManager: new SessionManagerStub(),
        innerStateService,
        generateTextFn: vi.fn(async () => sleepResult) as unknown as typeof import('ai').generateText,
        modelFactory: () => ({}) as LanguageModel,
      });
      stubKarakuriWorldNotificationFetch();

      await agent.handleMessage('session-1', 'notification_id: notif-123', 'KWBot', { userId: 'kw-bot-1' });
      await vi.waitFor(async () => {
        const state = await innerStateStore.get();
        expect(state?.sleeping).toBe(true);
      });
    });

    it('propagates the experience_log id to KW appraisal for provenance', async () => {
      const appraisalService = {
        enqueue: vi.fn(async () => {}),
        drain: vi.fn(async () => {}),
      } as unknown as AppraisalService;
      const recorder = new ExperienceRecorder({ store: createExperienceLogStoreStub(42) });

      const agent = new KarakuriAgent({
        config: {
          ...baseConfig,
          karakuriWorldBotIds: ['kw-bot-1'],
          karakuriWorld: { apiBaseUrl: 'https://example.com/world', apiKey: 'world-key' },
        },
        sessionManager: new SessionManagerStub(),
        appraisalService,
        experienceRecorder: recorder,
        generateTextFn: vi.fn(async () => makeKwModeGenerateTextResult('了解した。')) as unknown as typeof import('ai').generateText,
        modelFactory: () => ({}) as LanguageModel,
      });
      stubKarakuriWorldNotificationFetch();

      await agent.handleMessage('session-1', 'notification_id: notif-123', 'KWBot', { userId: 'kw-bot-1' });
      await agent.drainPendingEvaluations();

      const enqueueMock = (appraisalService.enqueue as ReturnType<typeof vi.fn>).mock;
      expect(enqueueMock.calls.length).toBeGreaterThan(0);
      expect(enqueueMock.calls[0]?.[2]).toBe(42);
    });

    it('propagates the experience_log id to Discord appraisal for provenance', async () => {
      const appraisalService = {
        enqueue: vi.fn(async () => {}),
        drain: vi.fn(async () => {}),
      } as unknown as AppraisalService;
      const recorder = new ExperienceRecorder({ store: createExperienceLogStoreStub(7) });

      const agent = new KarakuriAgent({
        config: baseConfig,
        sessionManager: new SessionManagerStub(),
        appraisalService,
        experienceRecorder: recorder,
        generateTextFn: vi.fn(async () => makeGenerateTextResult('こんにちは！', [assistantMessage('こんにちは！')])) as unknown as typeof import('ai').generateText,
        modelFactory: () => ({}) as LanguageModel,
      });

      await agent.handleMessage('session-1', 'こんにちは', 'Alice', { userId: 'user-1' });
      await agent.drainPendingEvaluations();
      // 事後 appraisal は record の解決を待ってから enqueue される（fire-and-forget）
      await vi.waitFor(() => {
        expect((appraisalService.enqueue as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
      });

      const enqueueMock = (appraisalService.enqueue as ReturnType<typeof vi.fn>).mock;
      expect(enqueueMock.calls[0]?.[2]).toBe(7);
    });
  });
});

function createExperienceLogStoreStub(appendId: number): IExperienceLogStore {
  return {
    append: vi.fn().mockResolvedValue(appendId),
    getRecent: vi.fn().mockResolvedValue([]),
    listBetween: vi.fn().mockResolvedValue([]),
    countBetween: vi.fn().mockResolvedValue(0),
    listChannelsBetween: vi.fn().mockResolvedValue([]),
    maxReceivedAt: vi.fn().mockResolvedValue(null),
    count: vi.fn().mockResolvedValue(0),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

class InMemoryInnerStateStore implements IInnerStateStore {
  private state: InnerState | null = null;
  private readonly history: Array<InnerState & { trigger: string | null }> = [];

  async get(): Promise<InnerState | null> {
    return this.state;
  }

  async set(state: InnerState, trigger?: string): Promise<void> {
    this.state = state;
    this.history.push({ ...state, trigger: trigger ?? null });
  }

  async getHistory(limit: number): Promise<Array<InnerState & { trigger: string | null }>> {
    return this.history.slice(-limit).reverse();
  }

  async close(): Promise<void> {}
}
