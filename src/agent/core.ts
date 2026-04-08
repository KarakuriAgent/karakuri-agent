import { generateText, stepCountIs, type LanguageModel, type ModelMessage } from 'ai';

import type { Config } from '../config.js';
import { createConfiguredOpenAiModelFactory, type LlmModelSelector } from '../llm/model-selector.js';
import { createNoThinkingFetch, noThinkingProviderOptions } from '../llm/no-thinking-fetch.js';
import type { IMemoryStore } from '../memory/types.js';
import type { IMessageSink, ISchedulerStore } from '../scheduler/types.js';
import { SESSION_SCHEMA_VERSION } from '../session/manager.js';
import type { ISessionManager, SessionData } from '../session/types.js';
import { createBuiltinSnsSkillDefinition, BUILTIN_SNS_SKILL_NAME } from '../sns/builtin-skill.js';
import type { ISnsActivityStore } from '../sns/types.js';
import type { SkillContextRegistry } from '../skill/context-provider.js';
import type { ISkillStore, SkillDefinition, SkillFilterOptions } from '../skill/types.js';
import { evaluatePostResponse } from '../user/post-response-evaluator.js';
import type { IUserStore } from '../user/types.js';
import { formatDateTimeInTimezone } from '../utils/date.js';
import { createLogger } from '../utils/logger.js';
import { KeyedMutex } from '../utils/mutex.js';
import {
  buildKarakuriWorldModeInstructions,
  KARAKURI_WORLD_TOOL_PREFIX,
  KW_MODE_MAX_STEPS,
} from '../karakuri-world/builtin-instructions.js';
import { createAgentTools } from './tools/index.js';
import { hasAdminToolAccess } from './tools/admin-auth.js';
import { filterSkillsToAvailableTools } from './tools/gated-tools.js';
import { createKarakuriWorldTools } from './tools/karakuri-world.js';
import type { IPromptContextStore } from './prompt-context.js';
import {
  buildSystemPrompt,
  countAdditionalContextTokens,
  sanitizeTagContent,
  type SkillContextEntry,
} from './prompt.js';

const logger = createLogger('Agent');

const DEFAULT_RECENT_DIARY_COUNT = 3;
const DEFAULT_RECENT_TURN_COUNT = 4;
const DEFAULT_KARAKURI_WORLD_MODE_RESPONSE = '(行動完了)';

export interface AgentLifecycleCallbacks {
  onThinking(): void;
  onToolCallStart(toolName: string): void;
  onToolCallFinish(toolName: string): void;
}

export interface HandleMessageOptions {
  lifecycle?: AgentLifecycleCallbacks | undefined;
  extraSystemPrompt?: string | undefined;
  userId?: string | undefined;
  /**
   * When true, the session is not loaded from or persisted to storage, and summarization is skipped.
   */
  ephemeral?: boolean | undefined;
  skillActivityInstructions?: string | undefined;
  autoLoadSnsSkill?: boolean | undefined;
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
  snsActivityStore?: ISnsActivityStore | undefined;
  snsContextRegistry?: SkillContextRegistry | undefined;
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
  private readonly snsActivityStore: ISnsActivityStore | undefined;
  private readonly snsContextRegistry: SkillContextRegistry | undefined;
  private readonly generateTextFn: typeof generateText;
  private readonly modelFactory: (selector: LlmModelSelector) => LanguageModel;
  private readonly noThinkingModelFactory: (selector: LlmModelSelector) => LanguageModel;
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
    snsActivityStore,
    snsContextRegistry,
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
    this.snsActivityStore = snsActivityStore;
    this.snsContextRegistry = snsContextRegistry;
    this.generateTextFn = generateTextFn;
    this.keepRecentTurns = keepRecentTurns;
    this.recentDiaryCount = recentDiaryCount;

    const noThinkingFetch = createNoThinkingFetch();

    this.modelFactory = modelFactory ?? createConfiguredOpenAiModelFactory({
      apiKey: config.llmApiKey,
      ...(config.llmBaseUrl != null ? { baseURL: config.llmBaseUrl } : {}),
      ...(!config.llmEnableThinking ? { fetch: noThinkingFetch } : {}),
    });
    this.noThinkingModelFactory = modelFactory ?? createConfiguredOpenAiModelFactory({
      apiKey: config.llmApiKey,
      ...(config.llmBaseUrl != null ? { baseURL: config.llmBaseUrl } : {}),
      fetch: noThinkingFetch,
    });
    this.postResponseModelFactory = config.postResponseLlmApiKey != null || config.postResponseLlmBaseUrl != null
      ? createConfiguredOpenAiModelFactory({
          apiKey: config.postResponseLlmApiKey ?? config.llmApiKey,
          ...((config.postResponseLlmBaseUrl ?? config.llmBaseUrl) != null
            ? { baseURL: config.postResponseLlmBaseUrl ?? config.llmBaseUrl }
            : {}),
          ...(!config.llmEnableThinking ? { fetch: noThinkingFetch } : {}),
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
    const currentDateTime = formatDateTimeInTimezone(new Date(), this.config.timezone);
    const userId = options?.userId;
    const isRealUser = userId != null && userId !== 'system';
    const isKarakuriWorldBot = isRealUser && (this.config.karakuriWorldBotIds ?? []).includes(userId);
    const isKarakuriWorldMode = isKarakuriWorldBot && this.config.karakuriWorld != null;
    const shouldIncludeUserProfile = isRealUser && !isKarakuriWorldMode;
    const ensuredUserPromise = shouldIncludeUserProfile && this.userStore != null
      ? this.userStore.ensureUser(userId, userName).catch((error) => {
          logger.warn('Failed to ensure user record', error, { userId });
          return null;
        })
      : Promise.resolve(null);

    const ephemeral = options?.ephemeral === true;
    let session = ephemeral
      ? createEphemeralSession(sessionId, [{
          role: 'user',
          content: formatUserMessage(userName, userMessage),
        }])
      : await this.sessionManager.addMessages(sessionId, [
          {
            role: 'user',
            content: formatUserMessage(userName, userMessage),
          },
        ]);

    const isSystemUser = userId === 'system';
    const hasAdminAccess = hasAdminToolAccess(userId, this.config.adminUserIds ?? []);
    const includeSystemOnly = isSystemUser || hasAdminAccess;
    const builtinSkills = !isKarakuriWorldMode && this.config.sns != null && includeSystemOnly
      ? [createBuiltinSnsSkillDefinition()]
      : [];
    const [coreMemory, recentDiaries, promptContext, listedSkills, ensuredUser] = await Promise.all([
      this.memoryStore.readCoreMemory(),
      this.memoryStore.getRecentDiaries(this.recentDiaryCount),
      this.promptContextStore?.read() ?? Promise.resolve({ agentInstructions: null, rules: null }),
      this.skillStore?.listSkills(includeSystemOnly ? { includeSystemOnly: true } : undefined) ?? Promise.resolve([]),
      ensuredUserPromise,
    ]);

    const promptUserName = shouldIncludeUserProfile ? ensuredUser?.displayName ?? userName : undefined;
    const promptUserProfile = shouldIncludeUserProfile ? ensuredUser?.profile ?? null : undefined;
    const hasPostMessage = hasAdminAccess
      && (this.config.postMessageChannelIds?.length ?? 0) > 0
      && this.messageSink != null;
    const hasManageCron = hasAdminAccess && this.schedulerStore != null;
    const hasUserLookup = !isKarakuriWorldMode && this.userStore != null;
    const mergedSkills = mergeBuiltinSkills(listedSkills, builtinSkills);
    const effectiveSkills = isKarakuriWorldMode
      ? []
      : filterSkillsToAvailableTools(mergedSkills, {
        sns: this.config.sns,
        dataDir: this.config.dataDir,
        snsActivityStore: this.snsActivityStore,
        userStore: this.userStore,
      });
    // Auto-load the builtin SNS skill when explicitly requested via autoLoadSnsSkill option
    // so the LLM receives dynamic context (notifications, trends, activity log) and gated
    // tools without needing to call loadSkill. Currently only SnsLoopRunner sets this flag.
    const shouldAutoLoadSnsSkill = options?.autoLoadSnsSkill === true
      && this.snsContextRegistry != null
      && effectiveSkills.some((skill) => skill.name === BUILTIN_SNS_SKILL_NAME);
    const autoLoadedSkills = shouldAutoLoadSnsSkill
      ? effectiveSkills.filter((skill) => skill.name === BUILTIN_SNS_SKILL_NAME)
      : [];
    const visibleSkills = shouldAutoLoadSnsSkill
      ? effectiveSkills.filter((skill) => skill.name !== BUILTIN_SNS_SKILL_NAME)
      : effectiveSkills;
    const skillContextScope = this.snsContextRegistry?.createScope();
    let result: Awaited<ReturnType<typeof this.generateTextFn>>;
    let assistantResponse = '';
    let kwNotLoggedIn = false;
    try {
      const autoLoadedSkillContexts: SkillContextEntry[] = shouldAutoLoadSnsSkill && skillContextScope != null
        ? await Promise.all(autoLoadedSkills.map(async (skill) => {
            const context = await skillContextScope.getContext(skill.name);
            if (context == null) {
              logger.warn('Auto-loaded skill has no dynamic context provider registered', { skillName: skill.name });
            }
            const trimmed = context?.trim();
            return {
              name: skill.name,
              dynamicContext: trimmed != null && trimmed.length > 0 ? trimmed : undefined,
              content: skill.instructions.trim(),
            };
          }))
        : [];
      const skillActivityInstructions = options?.skillActivityInstructions ?? null;
      // When builtins are merged, use a static snapshot so that code-defined skills
      // (not present in FileSkillStore) are visible via loadSkill. For SNS loop turns,
      // the snapshot also excludes auto-loaded skills. For users without builtins,
      // fall through to the live FileSkillStore to preserve fs.watch hot-reload.
      const runtimeSkillStore = builtinSkills.length > 0 && visibleSkills.length > 0
        ? createStaticSkillStore(visibleSkills)
        : undefined;
      const combinedExtraSystemPrompt = [options?.extraSystemPrompt, isKarakuriWorldMode
        ? buildKarakuriWorldModeInstructions()
        : undefined]
        .filter((value): value is string => value != null && value.trim().length > 0)
        .join('\n\n');
      const promptOverrides: Pick<import('./prompt.js').BuildSystemPromptOptions, 'includeSkillList' | 'includeToolGuidance' | 'includeSkillActivity'> = isKarakuriWorldMode
        ? {
            includeSkillList: false,
            includeToolGuidance: false,
            includeSkillActivity: false,
          }
        : {};

      const additionalTokens = countAdditionalContextTokens(coreMemory, recentDiaries, {
        agentInstructions: promptContext.agentInstructions,
        currentDateTime,
        rules: promptContext.rules,
        ...(shouldIncludeUserProfile
          ? {
              userName: promptUserName ?? userName,
              userId,
              userProfile: promptUserProfile,
            }
          : {}),
        skills: visibleSkills,
        autoLoadedSkills,
        skillContexts: autoLoadedSkillContexts,
        skillActivityInstructions,
        hasWebSearch: this.config.braveApiKey != null,
        hasUserLookup,
        hasPostMessage,
        hasManageCron,
        extraSystemPrompt: combinedExtraSystemPrompt,
        ...promptOverrides,
      });

      if (!ephemeral && this.sessionManager.needsSummarization(session, additionalTokens)) {
        logger.info('Session needs summarization', { sessionId });
        const summary = await this.summarizeSession(sessionId);
        logger.info('Session summarized', { sessionId, summaryLength: summary.length });
        session = await this.sessionManager.applySummary(
          sessionId,
          summary,
          this.keepRecentTurns,
        );
      }

      const lifecycle = options?.lifecycle;
      const systemPrompt = buildSystemPrompt({
        agentInstructions: promptContext.agentInstructions,
        currentDateTime,
        rules: promptContext.rules,
        coreMemory,
        ...(shouldIncludeUserProfile
          ? {
              userName: promptUserName ?? userName,
              userId,
              userProfile: promptUserProfile,
            }
          : {}),
        recentDiaries,
        summary: session.summary,
        skills: visibleSkills,
        autoLoadedSkills,
        skillContexts: autoLoadedSkillContexts,
        skillActivityInstructions,
        hasWebSearch: this.config.braveApiKey != null,
        hasUserLookup,
        hasPostMessage,
        hasManageCron,
        extraSystemPrompt: combinedExtraSystemPrompt,
        ...promptOverrides,
      });
      logger.debug('Calling LLM', {
        sessionId,
        model: this.config.llmModel,
        provider: this.config.llmModelSelector.provider,
        api: this.config.llmModelSelector.api,
        messageCount: session.messages.length,
      });
      logger.debug(`System prompt:\n${systemPrompt}`);
      const tools = isKarakuriWorldMode && this.config.karakuriWorld != null
        ? createKarakuriWorldTools(this.config.karakuriWorld)
        : createAgentTools({
          memoryStore: this.memoryStore,
          dataDir: this.config.dataDir,
          braveApiKey: this.config.braveApiKey,
          sns: this.config.sns,
          postMessageEnabled: hasPostMessage,
          postMessageChannelIds: this.config.postMessageChannelIds,
          reportChannelId: this.config.reportChannelId,
          adminUserIds: this.config.adminUserIds,
          userId,
          userStore: this.userStore,
          ...(runtimeSkillStore != null
            ? { skillStore: runtimeSkillStore }
            : this.skillStore != null
              ? { skillStore: this.skillStore }
              : {}),
          ...(this.schedulerStore != null ? { schedulerStore: this.schedulerStore } : {}),
          ...(this.messageSink != null ? { messageSink: this.messageSink } : {}),
          ...(this.snsActivityStore != null ? { snsActivityStore: this.snsActivityStore } : {}),
          ...(skillContextScope != null ? { contextScope: skillContextScope } : {}),
          ...(isSystemUser && this.userStore != null ? {
            evaluateUser: (snsUserId: string, displayName: string, postText: string) => {
              this.enqueueSnsUserEvaluation({ userId: snsUserId, userName: displayName, postText });
            },
          } : {}),
          skills: visibleSkills,
          autoLoadedSkills,
          includeSystemOnly,
        });
      const disableThinking = isKarakuriWorldMode || !this.config.llmEnableThinking;
      const effectiveModelFactory = disableThinking ? this.noThinkingModelFactory : this.modelFactory;

      result = await this.generateTextFn({
        model: effectiveModelFactory(this.config.llmModelSelector),
        system: systemPrompt,
        messages: session.messages,
        tools,
        stopWhen: stepCountIs(isKarakuriWorldMode ? KW_MODE_MAX_STEPS : this.config.maxSteps),
        ...(isKarakuriWorldMode ? { toolChoice: 'required' as const } : {}),
        ...(disableThinking ? { providerOptions: noThinkingProviderOptions(this.config.llmModelSelector.api) } : {}),
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
      kwNotLoggedIn = isKarakuriWorldMode && hasKarakuriWorldNotLoggedIn(result);
      if (isKarakuriWorldMode && !kwNotLoggedIn) {
        assertSingleKarakuriWorldAction(result);
      }
      logger.debug(`Response text:\n${result.text}`);
      if (kwNotLoggedIn) {
        logger.info('KarakuriWorld not_logged_in detected, suppressing response and skipping evaluation', { sessionId });
        assistantResponse = '';
        if (!ephemeral) {
          await this.sessionManager.addMessages(sessionId, [
            { role: 'assistant', content: 'OK' },
          ]);
        }
      } else {
        assistantResponse = isKarakuriWorldMode ? buildKarakuriWorldModeResponse(result) : result.text;
        if (!ephemeral) {
          await this.sessionManager.addMessages(
            sessionId,
            buildPersistedResponseMessages(result.response.messages, assistantResponse, isKarakuriWorldMode),
          );
        }
      }
      await skillContextScope?.commit();
    } catch (error) {
      await skillContextScope?.abort();
      throw error;
    }

    if (!kwNotLoggedIn && isRealUser) {
      this.enqueuePostResponseEvaluation({
        userId,
        userName,
        userMessage,
        assistantResponse,
        ...(isKarakuriWorldMode ? { skipUserStore: true } : {}),
      });
    } else if (!kwNotLoggedIn && isSystemUser) {
      this.enqueuePostResponseEvaluation({
        userId: 'system',
        userName,
        userMessage,
        assistantResponse,
        skipUserStore: true,
      });
    }

    logger.info('handleMessage complete', { sessionId, responseLength: assistantResponse.length });
    return assistantResponse;
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

    const thinkingDisabled = !this.config.llmEnableThinking;

    const result = await this.generateTextFn({
      model: (thinkingDisabled ? this.noThinkingModelFactory : this.modelFactory)(this.config.llmModelSelector),
      prompt,
      ...(thinkingDisabled ? { providerOptions: noThinkingProviderOptions(this.config.llmModelSelector.api) } : {}),
    });

    const summary = result.text.trim();
    return summary.length > 0 ? summary : session.summary ?? 'No durable summary available yet.';
  }

  async drainPendingEvaluations(): Promise<void> {
    await Promise.allSettled([...this.pendingEvaluations]);
  }

  private enqueueSnsUserEvaluation({
    userId,
    userName,
    postText,
  }: {
    userId: string;
    userName: string;
    postText: string;
  }): void {
    const task = this.evaluationMutex.runExclusive(`eval:${userId}`, async () => {
      try {
        const ensuredUser = await (this.userStore?.ensureUser(userId, userName) ?? Promise.resolve(null));
        const modelFactory = this.postResponseModelFactory ?? this.modelFactory;
        const modelSelector = this.config.postResponseLlmModelSelector ?? this.config.llmModelSelector;

        await evaluatePostResponse({
          model: modelFactory(modelSelector),
          memoryStore: this.memoryStore,
          userStore: ensuredUser != null ? this.userStore : undefined,
          userId,
          userName,
          savedDisplayName: ensuredUser?.displayName,
          userMessage: `SNS post observed from ${userName}:\n${postText.trim()}`,
          assistantResponse: 'Recorded SNS user context from the observed post.',
          currentProfile: ensuredUser?.profile,
          timezone: this.config.timezone,
          generateTextFn: this.generateTextFn,
          logger,
          ...(!this.config.llmEnableThinking ? { providerOptions: noThinkingProviderOptions(modelSelector.api) } : {}),
        });
      } catch (error) {
        logger.error('SNS user evaluation task failed', error, { userId });
      }
    });

    this.pendingEvaluations.add(task);
    void task.finally(() => {
      this.pendingEvaluations.delete(task);
    });
  }

  private enqueuePostResponseEvaluation({
    userId,
    userName,
    userMessage,
    assistantResponse,
    skipUserStore,
  }: {
    userId: string;
    userName: string;
    userMessage: string;
    assistantResponse: string;
    skipUserStore?: boolean;
  }): void {
    const task = this.evaluationMutex.runExclusive(`eval:${userId}`, async () => {
      try {
        const currentUser = skipUserStore ? null : await (this.userStore?.getUser(userId) ?? Promise.resolve(null));
        const modelFactory = this.postResponseModelFactory ?? this.modelFactory;
        const modelSelector = this.config.postResponseLlmModelSelector ?? this.config.llmModelSelector;
        const userStoreIfKnown = !skipUserStore && currentUser != null ? this.userStore : undefined;

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
          timezone: this.config.timezone,
          generateTextFn: this.generateTextFn,
          logger,
          ...(!this.config.llmEnableThinking ? { providerOptions: noThinkingProviderOptions(modelSelector.api) } : {}),
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

function createEphemeralSession(sessionId: string, messages: ModelMessage[]): SessionData {
  const now = new Date().toISOString();
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    sessionId,
    messages,
    summary: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Merges builtin skill definitions with file-defined skills. Builtins take priority; any file-defined skill with a matching name is discarded. */
function mergeBuiltinSkills(skills: SkillDefinition[], builtinSkills: SkillDefinition[]): SkillDefinition[] {
  if (builtinSkills.length === 0) {
    return skills;
  }

  const builtinNames = new Set(builtinSkills.map((skill) => skill.name));
  const merged = new Map<string, SkillDefinition>();
  for (const builtinSkill of builtinSkills) {
    merged.set(builtinSkill.name, builtinSkill);
  }
  for (const skill of skills) {
    if (builtinNames.has(skill.name)) {
      logger.info('File-defined skill overridden by builtin', { skillName: skill.name });
      continue;
    }
    merged.set(skill.name, skill);
  }
  return [...merged.values()];
}

function hasToolResultStatus(output: unknown, status: string): boolean {
  return typeof output === 'object' && output != null && 'status' in output
    && (output as Record<string, unknown>).status === status;
}

function hasKarakuriWorldNotLoggedIn(result: Awaited<ReturnType<typeof generateText>>): boolean {
  for (const step of result.steps) {
    for (const toolResult of step.toolResults) {
      if (
        String(toolResult?.toolName).startsWith(KARAKURI_WORLD_TOOL_PREFIX)
        && hasToolResultStatus(toolResult?.output, 'not_logged_in')
      ) {
        return true;
      }
    }
  }
  return false;
}

function buildKarakuriWorldModeResponse(result: Awaited<ReturnType<typeof generateText>>): string {
  // Pass 1 — toolResults: busy レスポンスが返っていたら Discord への返信を抑制する。
  // Pass 2 — toolCalls: LLM が入力した comment を Discord 返信として採用する。
  // busy チェックを優先するため2パスに分離。assertSingleKarakuriWorldAction が先に呼ばれるため KW ツールは常に1つ。
  for (const step of result.steps) {
    for (const toolResult of step.toolResults) {
      if (!String(toolResult?.toolName).startsWith(KARAKURI_WORLD_TOOL_PREFIX)) {
        continue;
      }

      if (hasToolResultStatus(toolResult?.output, 'busy')) {
        logger.info('KarakuriWorld tool returned busy, suppressing comment for Discord reply', {
          toolName: toolResult?.toolName,
        });
        return '';
      }
    }
  }

  for (const step of result.steps) {
    for (const toolCall of step.toolCalls) {
      if (!String(toolCall?.toolName).startsWith(KARAKURI_WORLD_TOOL_PREFIX)) {
        continue;
      }

      const comment = extractToolCallComment(toolCall?.input);
      if (comment == null) {
        logger.warn('KarakuriWorld tool call is missing comment in input, using default response', {
          toolName: toolCall?.toolName,
        });
      }
      return comment ?? DEFAULT_KARAKURI_WORLD_MODE_RESPONSE;
    }
  }

  logger.error('KarakuriWorld tool call had no matching tool call in steps', {
    stepCount: result.steps.length,
  });
  throw new Error('KarakuriWorld mode: tool call was validated but no matching tool call was found in steps.');
}

function assertSingleKarakuriWorldAction(result: Awaited<ReturnType<typeof generateText>>): void {
  const kwToolNames: string[] = [];

  for (const step of result.steps) {
    for (const toolCall of step.toolCalls) {
      if (String(toolCall?.toolName).startsWith(KARAKURI_WORLD_TOOL_PREFIX)) {
        kwToolNames.push(String(toolCall.toolName));
      }
    }
  }

  if (kwToolNames.length === 1) {
    return;
  }

  logger.error('KarakuriWorld mode action count violation', {
    expected: 1,
    actual: kwToolNames.length,
    toolNames: kwToolNames,
  });
  throw new Error(`KarakuriWorld mode expected exactly one action, but received ${kwToolNames.length}.`);
}

function extractToolCallComment(input: unknown): string | null {
  if (typeof input !== 'object' || input == null || !('comment' in input)) {
    return null;
  }

  const comment = input.comment;
  return typeof comment === 'string' && comment.trim().length > 0 ? comment.trim() : null;
}

function buildPersistedResponseMessages(
  messages: ModelMessage[],
  assistantResponse: string,
  replaceAssistantText: boolean,
): ModelMessage[] {
  if (!replaceAssistantText) {
    return messages;
  }

  const lastAssistantIndex = findLastAssistantMessageIndex(messages);
  if (lastAssistantIndex === -1) {
    logger.warn('No assistant message found in response messages, injecting synthetic message', {
      messageCount: messages.length,
    });
    return [...messages, { role: 'assistant', content: assistantResponse }];
  }

  return messages.map((message, index) => {
    if (index !== lastAssistantIndex || message.role !== 'assistant') {
      return message;
    }

    if (Array.isArray(message.content)) {
      return {
        ...message,
        content: [
          ...message.content.filter((part) => part.type !== 'text'),
          { type: 'text', text: assistantResponse },
        ],
      };
    }

    return {
      ...message,
      content: assistantResponse,
    };
  });
}

function findLastAssistantMessageIndex(messages: ModelMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'assistant') {
      return index;
    }
  }

  return -1;
}

/** Creates an in-memory ISkillStore snapshot. Used during SNS loop turns to exclude auto-loaded skills from loadSkill while keeping other skills available. */
function createStaticSkillStore(skills: SkillDefinition[]): ISkillStore {
  const byName = new Map(skills.map((skill) => [
    skill.name,
    { ...skill, ...(skill.allowedTools != null ? { allowedTools: [...skill.allowedTools] } : {}) },
  ]));

  return {
    async listSkills(options?: SkillFilterOptions): Promise<SkillDefinition[]> {
      return [...byName.values()]
        .filter((skill) => options?.includeSystemOnly === true || !skill.systemOnly)
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((skill) => ({ ...skill }));
    },
    async getSkill(name: string, options?: SkillFilterOptions): Promise<SkillDefinition | null> {
      const skill = byName.get(name);
      if (skill == null) {
        return null;
      }
      if (skill.systemOnly && options?.includeSystemOnly !== true) {
        return null;
      }
      return { ...skill };
    },
    async close(): Promise<void> {},
  };
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
