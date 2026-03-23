import { Output, generateText, type LanguageModel } from 'ai';
import { z } from 'zod';

import type { IMemoryStore } from '../memory/types.js';
import { formatDateInTimezone } from '../utils/date.js';
import { createLogger, type Logger } from '../utils/logger.js';
import type { IUserStore } from './types.js';

const logger = createLogger('PostResponseEvaluator');
export const MAX_PERSISTED_PROFILE_LENGTH = 4_000;

export const postResponseEvaluationSchema = z.object({
  profileAction: z.enum(['none', 'update', 'clear']),
  profile: z.string().max(MAX_PERSISTED_PROFILE_LENGTH),
  displayName: z.string().max(100),
  coreMemoryAppend: z.string().max(4_000),
  diaryEntry: z.string().max(4_000),
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
  currentCoreMemory: string;
  timezone: string;
  now?: () => Date;
  generateTextFn?: typeof generateText;
  logger?: Logger | undefined;
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
  currentCoreMemory,
  timezone,
  now = () => new Date(),
  generateTextFn = generateText,
  logger: customLogger = logger,
}: EvaluatePostResponseOptions): Promise<void> {
  try {
    const displayNameLine = savedDisplayName != null && savedDisplayName !== userName
      ? `Saved display name: ${savedDisplayName}\nTransport display name: ${userName}`
      : `Current display name: ${userName}`;

    const result = await generateTextFn({
      model,
      system: [
        'You evaluate a completed assistant reply and decide what durable information should be persisted.',
        'Return only structured JSON matching the schema.',
        'Merge any profile update into a complete next profile, not a diff.',
        'Profile should contain durable user-specific facts such as interests, expertise, preferences, or ongoing projects.',
        'Core memory should contain durable facts, decisions, or promises that matter beyond this conversation.',
        'Diary should contain concrete events or activities that happened today in this conversation.',
        'Only set displayName when the user explicitly revealed or changed how they should be called.',
        'If nothing should be saved, use profileAction="none" and empty strings for the other fields.',
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
      }),
    });

    const evaluation = result.output as PostResponseEvaluation | undefined;
    if (evaluation == null) {
      customLogger.warn('Post-response evaluation returned no structured output', undefined, { userId });
      return;
    }

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
  } catch (error) {
    customLogger.warn('Post-response evaluation failed', error, { userId });
  }
}
