import { Output, generateText, type LanguageModel } from 'ai';
import type { ProviderOptions } from '@ai-sdk/provider-utils';
import { z } from 'zod';

import { runExclusiveMemoryPersistence } from '../memory/persistence-mutex.js';
import type { IMemoryStore } from '../memory/types.js';
import { formatDateInTimezone } from '../utils/date.js';
import { createLogger, type Logger } from '../utils/logger.js';
import type { IUserStore } from './types.js';

const logger = createLogger('PostResponseEvaluator');
export const MAX_PERSISTED_PROFILE_LENGTH = 4_000;

export const postResponseEvaluationSchema = z.object({
  profileAction: z.enum(['none', 'update', 'clear'])
    .describe('"none" if no profile change, "update" to set/replace profile, "clear" to erase it'),
  profile: z.string().max(MAX_PERSISTED_PROFILE_LENGTH)
    .describe('Complete next profile text when profileAction is "update", otherwise empty string'),
  displayName: z.string().max(100)
    .describe('New display name only when the user explicitly asked to be called differently, otherwise empty string'),
  coreMemoryAppend: z.string().max(4_000)
    .describe('Text to append to core memory (durable facts/decisions), or empty string'),
  diaryEntry: z.string().max(4_000)
    .describe('Diary note about noteworthy events worth sharing — discoveries, emotions, encounters, story turning points. Empty string if nothing noteworthy happened.'),
});

export type PostResponseEvaluation = z.infer<typeof postResponseEvaluationSchema>;

export interface EvaluatePostResponseOptions {
  model: LanguageModel;
  memoryStore: IMemoryStore;
  userStore?: IUserStore | undefined;
  userId: string;
  userName: string;
  savedDisplayName?: string | undefined;
  userMessage: string;
  assistantResponse: string;
  currentProfile?: string | null | undefined;
  timezone: string;
  now?: () => Date;
  generateTextFn?: typeof generateText;
  providerOptions?: ProviderOptions | undefined;
  logger?: Logger | undefined;
}

interface GeneratePostResponseEvaluationFromSnapshotOptions {
  model: LanguageModel;
  userId: string;
  userName: string;
  savedDisplayName?: string | undefined;
  userMessage: string;
  assistantResponse: string;
  currentProfile?: string | null | undefined;
  currentCoreMemory: string;
  generateTextFn?: typeof generateText;
  providerOptions?: ProviderOptions | undefined;
}

interface ApplyPostResponseEvaluationUnlockedOptions {
  evaluation: PostResponseEvaluation;
  memoryStore: IMemoryStore;
  userStore?: IUserStore | undefined;
  userId: string;
  timezone: string;
  now?: () => Date;
}

async function generatePostResponseEvaluationFromSnapshot({
  model,
  userId,
  userName,
  savedDisplayName,
  userMessage,
  assistantResponse,
  currentProfile,
  currentCoreMemory,
  generateTextFn = generateText,
  providerOptions,
}: GeneratePostResponseEvaluationFromSnapshotOptions): Promise<PostResponseEvaluation | null> {
  const displayNameLine = savedDisplayName != null && savedDisplayName !== userName
    ? `Saved display name: ${savedDisplayName}\nTransport display name: ${userName}`
    : `Current display name: ${userName}`;

  const result = await generateTextFn({
    model,
    system: [
      'You evaluate a completed assistant reply and decide what durable information should be persisted.',
      'Return a JSON object with EXACTLY these five keys (use these exact key names):',
      '  "profileAction": "none" | "update" | "clear"',
      '  "profile": string — complete merged profile text when updating, otherwise ""',
      '  "displayName": string — new name only when user explicitly asked, otherwise ""',
      '  "coreMemoryAppend": string — durable facts/decisions to append, otherwise ""',
      '  "diaryEntry": string — noteworthy events worth sharing or remembering (e.g. discoveries, emotional moments, interesting encounters, new information learned). Skip routine status checks, system reports, and repetitive game-state updates with no story progression. Use "" if nothing noteworthy happened.',
      'All values must be plain strings, never objects or arrays.',
      'Merge any profile update into a complete next profile, not a diff.',
      'coreMemoryAppend must contain distilled facts only, not conversation descriptions. Good: "Weekly meeting: every Tuesday 10:00". Bad: "User said the meeting is on Tuesdays".',
      'diaryEntry is used as material for future SNS posts and conversation topics. Only record events that would be interesting to talk about later — feelings, surprises, personal interactions, story turning points. Omit routine operations, waiting, and status confirmations. Use the user\'s display name (not "ユーザー") to refer to people in diaryEntry.',
      'If nothing should be saved, set profileAction to "none" and all other fields to "".',
    ].join('\n'),
    prompt: [
      `User ID: ${userId}`,
      displayNameLine,
      `Current profile:\n${currentProfile?.trim().length ? currentProfile.trim() : '(none)'}`,
      `Current core memory:\n${currentCoreMemory.trim().length ? currentCoreMemory.trim() : '(empty)'}`,
      `Latest user message:\n${userMessage.trim()}`,
      `Latest assistant response:\n${assistantResponse.trim()}`,
    ].join('\n\n'),
    output: Output.object({
      schema: postResponseEvaluationSchema,
      name: 'post_response_evaluation',
      description: 'Post-response evaluation with profileAction, profile, displayName, coreMemoryAppend, and diaryEntry fields.',
    }),
    ...(providerOptions != null ? { providerOptions } : {}),
  });

  return (result.output as PostResponseEvaluation | undefined) ?? null;
}

async function applyPostResponseEvaluationUnlocked({
  evaluation,
  memoryStore,
  userStore,
  userId,
  timezone,
  now = () => new Date(),
}: ApplyPostResponseEvaluationUnlockedOptions): Promise<void> {
  if (userStore != null) {
    if (evaluation.profileAction === 'update' && evaluation.profile.trim().length > 0) {
      await userStore.updateProfile(userId, evaluation.profile.trim());
    }
    if (evaluation.profileAction === 'clear') {
      await userStore.updateProfile(userId, null);
    }
    if (evaluation.displayName.trim().length > 0) {
      await userStore.updateDisplayName(userId, evaluation.displayName.trim());
    }
  }

  if (evaluation.coreMemoryAppend.trim().length > 0) {
    await memoryStore.writeCoreMemory(evaluation.coreMemoryAppend.trim(), 'append');
  }

  if (evaluation.diaryEntry.trim().length > 0) {
    await memoryStore.writeDiary(
      formatDateInTimezone(now(), timezone),
      evaluation.diaryEntry.trim(),
    );
  }
}

export async function evaluatePostResponse({
  model,
  memoryStore,
  userStore,
  userId,
  userName,
  savedDisplayName,
  userMessage,
  assistantResponse,
  currentProfile,
  timezone,
  now = () => new Date(),
  generateTextFn = generateText,
  providerOptions,
  logger: customLogger = logger,
}: EvaluatePostResponseOptions): Promise<void> {
  try {
    const currentCoreMemory = await memoryStore.readCoreMemory();
    const evaluation = await generatePostResponseEvaluationFromSnapshot({
      model,
      userId,
      userName,
      savedDisplayName,
      userMessage,
      assistantResponse,
      currentProfile,
      currentCoreMemory,
      generateTextFn,
      providerOptions,
    });

    if (evaluation == null) {
      customLogger.warn('Post-response evaluation returned no structured output', undefined, { userId });
      return;
    }

    await runExclusiveMemoryPersistence(async () => {
      await applyPostResponseEvaluationUnlocked({
        evaluation,
        memoryStore,
        userStore,
        userId,
        timezone,
        now,
      });
    });
  } catch (error) {
    customLogger.error('Post-response evaluation failed', error, { userId });
  }
}
