import type { LanguageModel, ModelMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import {
  evaluatePostResponse,
  MAX_PERSISTED_PROFILE_LENGTH,
  postResponseEvaluationSchema,
} from '../src/user/post-response-evaluator.js';
import type { IMemoryStore } from '../src/memory/types.js';
import type { IUserStore, UserRecord } from '../src/user/types.js';

class MemoryStoreStub implements IMemoryStore {
  coreWrites: string[] = [];
  diaryWrites: Array<{ date: string; content: string }> = [];

  async readCoreMemory(): Promise<string> {
    return '';
  }

  async writeCoreMemory(content: string): Promise<void> {
    this.coreWrites.push(content);
  }

  async readDiary(): Promise<string | null> {
    return null;
  }

  async writeDiary(date: string, content: string): Promise<void> {
    this.diaryWrites.push({ date, content });
  }

  async getRecentDiaries() {
    return [];
  }

  async listDiaryDates(): Promise<string[]> {
    return [];
  }

  async close(): Promise<void> {}
}

class UserStoreStub implements IUserStore {
  profileUpdates: Array<string | null> = [];
  displayNameUpdates: string[] = [];

  async getUser(): Promise<UserRecord | null> {
    return null;
  }

  async ensureUser(): Promise<UserRecord> {
    throw new Error('not implemented');
  }

  async updateProfile(_userId: string, profile: string | null): Promise<void> {
    this.profileUpdates.push(profile);
  }

  async updateDisplayName(_userId: string, displayName: string): Promise<void> {
    this.displayNameUpdates.push(displayName);
  }

  async searchUsers(): Promise<UserRecord[]> {
    return [];
  }

  async close(): Promise<void> {}
}

function makeStructuredResult(output: Record<string, string>) {
  return {
    text: JSON.stringify(output),
    output,
    steps: [],
    response: {
      id: 'response-id',
      modelId: 'gpt-4o-mini',
      timestamp: new Date(),
      messages: [] as ModelMessage[],
    },
  } as const;
}

describe('evaluatePostResponse', () => {
  it('applies profile, display name, core memory, and diary updates', async () => {
    const memoryStore = new MemoryStoreStub();
    const userStore = new UserStoreStub();
    const generateTextFn = vi.fn(async () => makeStructuredResult({
      profileAction: 'update',
      profile: 'Prefers concise answers',
      displayName: 'Alicia',
      coreMemoryAppend: 'Promised to send follow-up',
      diaryEntry: 'Discussed the robotics project',
    })) as unknown as typeof import('ai').generateText;

    await evaluatePostResponse({
      model: {} as LanguageModel,
      memoryStore,
      userStore,
      userId: 'user-1',
      userName: 'Alice',
      userMessage: 'remember this',
      assistantResponse: 'ok',
      currentProfile: null,
      currentCoreMemory: '',
      timezone: 'UTC',
      now: () => new Date('2025-03-21T12:00:00.000Z'),
      generateTextFn,
    });

    expect(userStore.profileUpdates).toEqual(['Prefers concise answers']);
    expect(userStore.displayNameUpdates).toEqual(['Alicia']);
    expect(memoryStore.coreWrites).toEqual(['Promised to send follow-up']);
    expect(memoryStore.diaryWrites).toEqual([
      { date: '2025-03-21', content: 'Discussed the robotics project' },
    ]);
  });

  it('clears profile when requested', async () => {
    const memoryStore = new MemoryStoreStub();
    const userStore = new UserStoreStub();

    await evaluatePostResponse({
      model: {} as LanguageModel,
      memoryStore,
      userStore,
      userId: 'user-1',
      userName: 'Alice',
      userMessage: 'clear',
      assistantResponse: 'ok',
      currentProfile: 'old profile',
      currentCoreMemory: '',
      timezone: 'UTC',
      generateTextFn: vi.fn(async () => makeStructuredResult({
        profileAction: 'clear',
        profile: '',
        displayName: '',
        coreMemoryAppend: '',
        diaryEntry: '',
      })) as unknown as typeof import('ai').generateText,
    });

    expect(userStore.profileUpdates).toEqual([null]);
  });

  it('skips user profile writes when no user store is configured', async () => {
    const memoryStore = new MemoryStoreStub();

    await evaluatePostResponse({
      model: {} as LanguageModel,
      memoryStore,
      userId: 'user-1',
      userName: 'Alice',
      userMessage: 'remember this',
      assistantResponse: 'ok',
      currentProfile: null,
      currentCoreMemory: '',
      timezone: 'UTC',
      generateTextFn: vi.fn(async () => makeStructuredResult({
        profileAction: 'update',
        profile: 'Saved profile',
        displayName: 'Alicia',
        coreMemoryAppend: 'Durable fact',
        diaryEntry: '',
      })) as unknown as typeof import('ai').generateText,
    });

    expect(memoryStore.coreWrites).toEqual(['Durable fact']);
  });

  it('swallows LLM failures and logs a warning', async () => {
    const memoryStore = new MemoryStoreStub();
    const userStore = new UserStoreStub();
    const warn = vi.fn();

    await expect(evaluatePostResponse({
      model: {} as LanguageModel,
      memoryStore,
      userStore,
      userId: 'user-1',
      userName: 'Alice',
      userMessage: 'remember this',
      assistantResponse: 'ok',
      currentProfile: null,
      currentCoreMemory: '',
      timezone: 'UTC',
      generateTextFn: vi.fn(async () => {
        throw new Error('boom');
      }) as unknown as typeof import('ai').generateText,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn,
        error: vi.fn(),
      },
    })).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalled();
    expect(userStore.profileUpdates).toEqual([]);
    expect(memoryStore.coreWrites).toEqual([]);
  });

  it('includes saved display name in evaluator prompt when it differs from transport name', async () => {
    const memoryStore = new MemoryStoreStub();
    const userStore = new UserStoreStub();
    let capturedPrompt = '';

    await evaluatePostResponse({
      model: {} as LanguageModel,
      memoryStore,
      userStore,
      userId: 'user-1',
      userName: 'Alice New',
      savedDisplayName: 'Alice Old',
      userMessage: 'hi',
      assistantResponse: 'hello',
      currentProfile: null,
      currentCoreMemory: '',
      timezone: 'UTC',
      generateTextFn: vi.fn(async (options: { prompt?: string }) => {
        capturedPrompt = options.prompt ?? '';
        return makeStructuredResult({
          profileAction: 'none',
          profile: '',
          displayName: '',
          coreMemoryAppend: '',
          diaryEntry: '',
        });
      }) as unknown as typeof import('ai').generateText,
    });

    expect(capturedPrompt).toContain('Saved display name: Alice Old');
    expect(capturedPrompt).toContain('Transport display name: Alice New');
  });

  it('shows single display name line when saved name matches transport name', async () => {
    const memoryStore = new MemoryStoreStub();
    let capturedPrompt = '';

    await evaluatePostResponse({
      model: {} as LanguageModel,
      memoryStore,
      userId: 'user-1',
      userName: 'Alice',
      savedDisplayName: 'Alice',
      userMessage: 'hi',
      assistantResponse: 'hello',
      currentProfile: null,
      currentCoreMemory: '',
      timezone: 'UTC',
      generateTextFn: vi.fn(async (options: { prompt?: string }) => {
        capturedPrompt = options.prompt ?? '';
        return makeStructuredResult({
          profileAction: 'none',
          profile: '',
          displayName: '',
          coreMemoryAppend: '',
          diaryEntry: '',
        });
      }) as unknown as typeof import('ai').generateText,
    });

    expect(capturedPrompt).toContain('Current display name: Alice');
    expect(capturedPrompt).not.toContain('Saved display name');
  });

  it('skips writes when LLM returns no structured output', async () => {
    const memoryStore = new MemoryStoreStub();
    const userStore = new UserStoreStub();
    const warn = vi.fn();

    await evaluatePostResponse({
      model: {} as LanguageModel,
      memoryStore,
      userStore,
      userId: 'user-1',
      userName: 'Alice',
      userMessage: 'hi',
      assistantResponse: 'hello',
      currentProfile: null,
      currentCoreMemory: '',
      timezone: 'UTC',
      generateTextFn: vi.fn(async () => ({
        text: '',
        output: undefined,
        steps: [],
        response: {
          id: 'r',
          modelId: 'gpt-4o-mini',
          timestamp: new Date(),
          messages: [] as ModelMessage[],
        },
      })) as unknown as typeof import('ai').generateText,
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    });

    expect(warn).toHaveBeenCalledWith(
      'Post-response evaluation returned no structured output',
      undefined,
      { userId: 'user-1' },
    );
    expect(userStore.profileUpdates).toEqual([]);
    expect(memoryStore.coreWrites).toEqual([]);
  });

  it('passes providerOptions through to generateText when provided', async () => {
    const memoryStore = new MemoryStoreStub();
    let capturedProviderOptions: unknown;

    await evaluatePostResponse({
      model: {} as LanguageModel,
      memoryStore,
      userId: 'user-1',
      userName: 'Alice',
      userMessage: 'hi',
      assistantResponse: 'hello',
      currentProfile: null,
      currentCoreMemory: '',
      timezone: 'UTC',
      providerOptions: { openai: { reasoningEffort: 'none' } },
      generateTextFn: vi.fn(async (options: { providerOptions?: unknown }) => {
        capturedProviderOptions = options.providerOptions;
        return makeStructuredResult({
          profileAction: 'none',
          profile: '',
          displayName: '',
          coreMemoryAppend: '',
          diaryEntry: '',
        });
      }) as unknown as typeof import('ai').generateText,
    });

    expect(capturedProviderOptions).toEqual({ openai: { reasoningEffort: 'none' } });
  });

  it('does not set providerOptions when not provided', async () => {
    const memoryStore = new MemoryStoreStub();
    let generateTextCall: Record<string, unknown> = {};

    await evaluatePostResponse({
      model: {} as LanguageModel,
      memoryStore,
      userId: 'user-1',
      userName: 'Alice',
      userMessage: 'hi',
      assistantResponse: 'hello',
      currentProfile: null,
      currentCoreMemory: '',
      timezone: 'UTC',
      generateTextFn: vi.fn(async (options: Record<string, unknown>) => {
        generateTextCall = options;
        return makeStructuredResult({
          profileAction: 'none',
          profile: '',
          displayName: '',
          coreMemoryAppend: '',
          diaryEntry: '',
        });
      }) as unknown as typeof import('ai').generateText,
    });

    expect(generateTextCall).not.toHaveProperty('providerOptions');
  });

  it('accepts realistically sized merged profiles in the schema', () => {
    expect(postResponseEvaluationSchema.safeParse({
      profileAction: 'update',
      profile: 'x'.repeat(MAX_PERSISTED_PROFILE_LENGTH),
      displayName: '',
      coreMemoryAppend: '',
      diaryEntry: '',
    }).success).toBe(true);
  });
});
