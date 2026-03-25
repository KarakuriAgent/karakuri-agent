import { generateText, stepCountIs, type LanguageModel, type ModelMessage } from 'ai';

import type { Config } from '../config.js';
import { createConfiguredOpenAiModelFactory, type LlmModelSelector } from '../llm/model-selector.js';
import type { IMemoryStore } from '../memory/types.js';
import type { IMessageSink, ISchedulerStore } from '../scheduler/types.js';
import type { ISessionManager } from '../session/types.js';
import type { ISkillStore } from '../skill/types.js';
import { evaluatePostResponse } from '../user/post-response-evaluator.js';
import type { IUserStore } from '../user/types.js';
import { createLogger } from '../utils/logger.js';
import { KeyedMutex } from '../utils/mutex.js';
import { createAgentTools } from './tools/index.js';
import { hasAdminToolAccess } from './tools/admin-auth.js';
import { filterSkillsToAvailableTools } from './tools/gated-tools.js';
import type { IPromptContextStore } from './prompt-context.js';
import {
  buildSystemPrompt,
  countAdditionalContextTokens,
  sanitizeTagContent,
} from './prompt.js';

const logger = createLogger('Agent');

const DEFAULT_RECENT_DIARY_COUNT = 3;
const DEFAULT_RECENT_TURN_COUNT = 4;

export interface AgentLifecycleCallbacks {
  onThinking(): void;
  onToolCallStart(toolName: string): void;
  onToolCallFinish(toolName: string): void;
}

export interface HandleMessageOptions {
  lifecycle?: AgentLifecycleCallbacks | undefined;
  extraSystemPrompt?: string | undefined;
  userId?: string | undefined;
}

export interface IAgent {
  handleMessage(
    sessionId: string,
    userMessage: string,
    userName: string,
    options?: HandleMessageOptions,
  ): Promise<string>;
  summarizeSession(sessionId: string): Promise<string>;
}

export interface KarakuriAgentOptions {
  config: Config;
  memoryStore: IMemoryStore;
  sessionManager: ISessionManager;
  skillStore?: ISkillStore | undefined;
  promptContextStore?: IPromptContextStore | undefined;
  schedulerStore?: ISchedulerStore | undefined;
  messageSink?: IMessageSink | undefined;
  userStore?: IUserStore | undefined;
  generateTextFn?: typeof generateText;
  modelFactory?: (selector: LlmModelSelector) => LanguageModel;
  keepRecentTurns?: number;
  recentDiaryCount?: number;
}

export class KarakuriAgent implements IAgent {
  private readonly config: Config;
  private readonly memoryStore: IMemoryStore;
  private readonly sessionManager: ISessionManager;
  private readonly skillStore: ISkillStore | undefined;
  private readonly promptContextStore: IPromptContextStore | undefined;
  private readonly schedulerStore: ISchedulerStore | undefined;
  private readonly messageSink: IMessageSink | undefined;
  private readonly userStore: IUserStore | undefined;
  private readonly generateTextFn: typeof generateText;
  private readonly modelFactory: (selector: LlmModelSelector) => LanguageModel;
  private readonly postResponseModelFactory: ((selector: LlmModelSelector) => LanguageModel) | undefined;
  private readonly keepRecentTurns: number;
  private readonly recentDiaryCount: number;
  private readonly evaluationMutex = new KeyedMutex();
  private readonly pendingEvaluations = new Set<Promise<void>>();

  constructor({
    config,
    memoryStore,
    sessionManager,
    skillStore,
    promptContextStore,
    schedulerStore,
    messageSink,
    userStore,
    generateTextFn = generateText,
    modelFactory,
    keepRecentTurns = DEFAULT_RECENT_TURN_COUNT,
    recentDiaryCount = DEFAULT_RECENT_DIARY_COUNT,
  }: KarakuriAgentOptions) {
    this.config = config;
    this.memoryStore = memoryStore;
    this.sessionManager = sessionManager;
    this.skillStore = skillStore;
    this.promptContextStore = promptContextStore;
    this.schedulerStore = schedulerStore;
    this.messageSink = messageSink;
    this.userStore = userStore;
    this.generateTextFn = generateTextFn;
    this.keepRecentTurns = keepRecentTurns;
    this.recentDiaryCount = recentDiaryCount;

    this.modelFactory = modelFactory ?? createConfiguredOpenAiModelFactory({
      apiKey: config.llmApiKey,
      ...(config.llmBaseUrl != null ? { baseURL: config.llmBaseUrl } : {}),
    });
    this.postResponseModelFactory = config.postResponseLlmApiKey != null || config.postResponseLlmBaseUrl != null
      ? createConfiguredOpenAiModelFactory({
          apiKey: config.postResponseLlmApiKey ?? config.llmApiKey,
          ...((config.postResponseLlmBaseUrl ?? config.llmBaseUrl) != null
            ? { baseURL: config.postResponseLlmBaseUrl ?? config.llmBaseUrl }
            : {}),
        })
      : undefined;
  }

  async handleMessage(
    sessionId: string,
    userMessage: string,
    userName: string,
    options?: HandleMessageOptions,
  ): Promise<string> {
    logger.info('handleMessage', { sessionId, userMessageLength: userMessage.length });
    const userId = options?.userId;
    const isRealUser = userId != null && userId !== 'system';
    const ensuredUserPromise = isRealUser && this.userStore != null
      ? this.userStore.ensureUser(userId, userName).catch((error) => {
          logger.warn('Failed to ensure user record', error, { userId });
          return null;
        })
      : Promise.resolve(null);

    let session = await this.sessionManager.addMessages(sessionId, [
      {
        role: 'user',
        content: formatUserMessage(userName, userMessage),
      },
    ]);

    const isSystemUser = userId === 'system';
    const [coreMemory, recentDiaries, promptContext, skills, ensuredUser] = await Promise.all([
      this.memoryStore.readCoreMemory(),
      this.memoryStore.getRecentDiaries(this.recentDiaryCount),
      this.promptContextStore?.read() ?? Promise.resolve({ agentInstructions: null, rules: null }),
      this.skillStore?.listSkills(isSystemUser ? { includeSystemOnly: true } : undefined) ?? Promise.resolve([]),
      ensuredUserPromise,
    ]);

    const promptUserName = isRealUser ? ensuredUser?.displayName ?? userName : undefined;
    const promptUserProfile = isRealUser ? ensuredUser?.profile ?? null : undefined;
    const hasAdminAccess = hasAdminToolAccess(userId, this.config.adminUserIds ?? []);
    const hasPostMessage = hasAdminAccess
      && (this.config.postMessageChannelIds?.length ?? 0) > 0
      && this.messageSink != null;
    const hasManageCron = hasAdminAccess && this.schedulerStore != null;
    const hasUserLookup = this.userStore != null;
    const effectiveSkills = filterSkillsToAvailableTools(skills, {
      karakuriWorld: this.config.karakuriWorld,
      sns: this.config.sns,
    });

    const additionalTokens = countAdditionalContextTokens(coreMemory, recentDiaries, {
      agentInstructions: promptContext.agentInstructions,
      rules: promptContext.rules,
      ...(isRealUser
        ? {
            userName: promptUserName ?? userName,
            userId,
            userProfile: promptUserProfile,
          }
        : {}),
      skills: effectiveSkills,
      hasWebSearch: this.config.braveApiKey != null,
      hasUserLookup,
      hasPostMessage,
      hasManageCron,
      extraSystemPrompt: options?.extraSystemPrompt,
    });

    if (this.sessionManager.needsSummarization(session, additionalTokens)) {
      logger.info('Session needs summarization', { sessionId });
      const summary = await this.summarizeSession(sessionId);
      logger.info('Session summarized', { sessionId, summaryLength: summary.length });
      session = await this.sessionManager.applySummary(
        sessionId,
        summary,
        this.keepRecentTurns,
      );
    }

    const systemPrompt = buildSystemPrompt({
      agentInstructions: promptContext.agentInstructions,
      rules: promptContext.rules,
      coreMemory,
      ...(isRealUser
        ? {
            userName: promptUserName ?? userName,
            userId,
            userProfile: promptUserProfile,
          }
        : {}),
      recentDiaries,
      summary: session.summary,
      skills: effectiveSkills,
      hasWebSearch: this.config.braveApiKey != null,
      hasUserLookup,
      hasPostMessage,
      hasManageCron,
      extraSystemPrompt: options?.extraSystemPrompt,
    });
    logger.debug('Calling LLM', {
      sessionId,
      model: this.config.llmModel,
      provider: this.config.llmModelSelector.provider,
      api: this.config.llmModelSelector.api,
      messageCount: session.messages.length,
    });
    logger.debug(`System prompt:\n${systemPrompt}`);
    const tools = createAgentTools({
      memoryStore: this.memoryStore,
      braveApiKey: this.config.braveApiKey,
      karakuriWorld: this.config.karakuriWorld,
      sns: this.config.sns,
      postMessageEnabled: hasPostMessage,
      postMessageChannelIds: this.config.postMessageChannelIds,
      reportChannelId: this.config.reportChannelId,
      adminUserIds: this.config.adminUserIds,
      userId,
      userStore: this.userStore,
      ...(this.skillStore != null ? { skillStore: this.skillStore } : {}),
      ...(this.schedulerStore != null ? { schedulerStore: this.schedulerStore } : {}),
      ...(this.messageSink != null ? { messageSink: this.messageSink } : {}),
      skills: effectiveSkills,
      includeSystemOnly: isSystemUser,
    });
    const lifecycle = options?.lifecycle;
    const result = await this.generateTextFn({
      model: this.modelFactory(this.config.llmModelSelector),
      system: systemPrompt,
      messages: session.messages,
      tools,
      stopWhen: stepCountIs(this.config.maxSteps),
      ...(lifecycle != null
        ? {
            experimental_onStepStart: () => {
              lifecycle.onThinking();
            },
            experimental_onToolCallStart: (event) => {
              lifecycle.onToolCallStart(String(event.toolCall.toolName));
            },
            experimental_onToolCallFinish: (event) => {
              lifecycle.onToolCallFinish(String(event.toolCall.toolName));
            },
          }
        : {}),
    });

    logger.debug('LLM responded', { sessionId, responseLength: result.text.length, stepCount: result.steps.length });
    for (const [i, step] of result.steps.entries()) {
      for (const toolCall of step.toolCalls) {
        logger.debug('Tool call', { step: i, toolName: toolCall?.toolName, input: JSON.stringify(toolCall?.input) });
      }
      for (const toolResult of step.toolResults) {
        logger.debug('Tool result', { step: i, toolName: toolResult?.toolName, output: JSON.stringify(toolResult?.output) });
      }
    }
    logger.debug(`Response text:\n${result.text}`);
    await this.sessionManager.addMessages(sessionId, result.response.messages);

    if (isRealUser) {
      this.enqueuePostResponseEvaluation({
        userId,
        userName,
        userMessage,
        assistantResponse: result.text,
      });
    }

    logger.info('handleMessage complete', { sessionId, responseLength: result.text.length });
    return result.text;
  }

  async summarizeSession(sessionId: string): Promise<string> {
    const session = await this.sessionManager.loadSession(sessionId);
    const transcript = session.messages.map(formatTranscriptLine).join('\n');

    const prompt = [
      'Summarize the following conversation for future turns.',
      'Keep the summary concise but preserve durable facts, decisions, open questions, user preferences, and promised follow-up actions.',
      session.summary != null && session.summary.trim().length > 0
        ? `<existing-summary>\n${sanitizeTagContent(session.summary.trim())}\n</existing-summary>`
        : '',
      `<conversation>\n${sanitizeTagContent(transcript || '(no messages yet)')}\n</conversation>`,
    ]
      .filter((section) => section.length > 0)
      .join('\n\n');

    const result = await this.generateTextFn({
      model: this.modelFactory(this.config.llmModelSelector),
      prompt,
    });

    const summary = result.text.trim();
    return summary.length > 0 ? summary : session.summary ?? 'No durable summary available yet.';
  }

  async drainPendingEvaluations(): Promise<void> {
    await Promise.allSettled([...this.pendingEvaluations]);
  }

  private enqueuePostResponseEvaluation({
    userId,
    userName,
    userMessage,
    assistantResponse,
  }: {
    userId: string;
    userName: string;
    userMessage: string;
    assistantResponse: string;
  }): void {
    const task = this.evaluationMutex.runExclusive(`eval:${userId}`, async () => {
      try {
        const [currentUser, currentCoreMemory] = await Promise.all([
          this.userStore?.getUser(userId) ?? Promise.resolve(null),
          this.memoryStore.readCoreMemory(),
        ]);
        const modelFactory = this.postResponseModelFactory ?? this.modelFactory;
        const modelSelector = this.config.postResponseLlmModelSelector ?? this.config.llmModelSelector;
        const userStoreIfKnown = currentUser != null ? this.userStore : undefined;

        await evaluatePostResponse({
          model: modelFactory(modelSelector),
          memoryStore: this.memoryStore,
          userStore: userStoreIfKnown,
          userId,
          userName,
          savedDisplayName: currentUser?.displayName,
          userMessage,
          assistantResponse,
          currentProfile: currentUser?.profile,
          currentCoreMemory,
          timezone: this.config.timezone,
          generateTextFn: this.generateTextFn,
        });
      } catch (error) {
        logger.warn('Post-response evaluation task failed', error, { userId });
      }
    });

    this.pendingEvaluations.add(task);
    void task.finally(() => {
      this.pendingEvaluations.delete(task);
    });
  }
}

function formatUserMessage(userName: string, userMessage: string): string {
  const normalizedName = userName.trim();
  const normalizedMessage = userMessage.trim();
  return normalizedName.length > 0 ? `${normalizedName}: ${normalizedMessage}` : normalizedMessage;
}

function formatTranscriptLine(message: ModelMessage): string {
  return `${message.role.toUpperCase()}: ${serializeModelContent(message.content)}`;
}

function serializeModelContent(content: ModelMessage['content']): string {
  if (typeof content === 'string') {
    return content;
  }

  return content
    .map((part) => {
      switch (part.type) {
        case 'text':
        case 'reasoning':
          return part.text;
        case 'tool-call':
          return `tool-call ${part.toolName} ${JSON.stringify(part.input)}`;
        case 'tool-result':
          return `tool-result ${part.toolName} ${JSON.stringify(part.output)}`;
        default:
          return JSON.stringify(part);
      }
    })
    .join('\n');
}
