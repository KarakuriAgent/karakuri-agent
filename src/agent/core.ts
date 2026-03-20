import { createOpenAI } from '@ai-sdk/openai';
import { generateText, stepCountIs, type LanguageModel, type ModelMessage } from 'ai';

import type { Config } from '../config.js';
import type { IMemoryStore } from '../memory/types.js';
import type { ISessionManager } from '../session/types.js';
import { createAgentTools } from './tools/index.js';
import {
  buildSystemPrompt,
  countAdditionalContextTokens,
  sanitizeTagContent,
} from './prompt.js';

const DEFAULT_RECENT_DIARY_COUNT = 3;
const DEFAULT_RECENT_TURN_COUNT = 4;

export interface IAgent {
  handleMessage(sessionId: string, userMessage: string, userName: string): Promise<string>;
  summarizeSession(sessionId: string): Promise<string>;
}

export interface KarakuriAgentOptions {
  config: Config;
  memoryStore: IMemoryStore;
  sessionManager: ISessionManager;
  generateTextFn?: typeof generateText;
  modelFactory?: (modelId: string) => LanguageModel;
  keepRecentTurns?: number;
  recentDiaryCount?: number;
}

export class KarakuriAgent implements IAgent {
  private readonly config: Config;
  private readonly memoryStore: IMemoryStore;
  private readonly sessionManager: ISessionManager;
  private readonly generateTextFn: typeof generateText;
  private readonly modelFactory: (modelId: string) => LanguageModel;
  private readonly keepRecentTurns: number;
  private readonly recentDiaryCount: number;

  constructor({
    config,
    memoryStore,
    sessionManager,
    generateTextFn = generateText,
    modelFactory,
    keepRecentTurns = DEFAULT_RECENT_TURN_COUNT,
    recentDiaryCount = DEFAULT_RECENT_DIARY_COUNT,
  }: KarakuriAgentOptions) {
    this.config = config;
    this.memoryStore = memoryStore;
    this.sessionManager = sessionManager;
    this.generateTextFn = generateTextFn;
    this.keepRecentTurns = keepRecentTurns;
    this.recentDiaryCount = recentDiaryCount;

    const openAiProvider = createOpenAI({ apiKey: config.openaiApiKey });
    this.modelFactory =
      modelFactory ??
      ((modelId: string) => openAiProvider.responses(modelId as Parameters<typeof openAiProvider.responses>[0]));
  }

  async handleMessage(sessionId: string, userMessage: string, userName: string): Promise<string> {
    let session = await this.sessionManager.addMessages(sessionId, [
      {
        role: 'user',
        content: formatUserMessage(userName, userMessage),
      },
    ]);

    const [coreMemory, recentDiaries] = await Promise.all([
      this.memoryStore.readCoreMemory(),
      this.memoryStore.getRecentDiaries(this.recentDiaryCount),
    ]);

    const additionalTokens = countAdditionalContextTokens(coreMemory, recentDiaries);

    if (this.sessionManager.needsSummarization(session, additionalTokens)) {
      const summary = await this.summarizeSession(sessionId);
      session = await this.sessionManager.applySummary(
        sessionId,
        summary,
        this.keepRecentTurns,
      );
    }

    const result = await this.generateTextFn({
      model: this.modelFactory(this.config.openaiModel),
      system: buildSystemPrompt({
        coreMemory,
        recentDiaries,
        summary: session.summary,
      }),
      messages: session.messages,
      tools: createAgentTools({
        memoryStore: this.memoryStore,
        timezone: this.config.timezone,
      }),
      stopWhen: stepCountIs(this.config.maxSteps),
    });

    await this.sessionManager.addMessages(sessionId, result.response.messages);
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
      model: this.modelFactory(this.config.openaiModel),
      prompt,
    });

    const summary = result.text.trim();
    return summary.length > 0 ? summary : session.summary ?? 'No durable summary available yet.';
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
