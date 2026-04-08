import type { LanguageModel, ModelMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import {
  type MemoryMaintenanceResult,
  memoryMaintenanceSchema,
  runMemoryMaintenance,
} from '../src/memory/maintenance.js';
import type { DiaryEntry, IMemoryStore } from '../src/memory/types.js';

class MemoryStoreStub implements IMemoryStore {
  coreWrites: Array<{ content: string; mode: 'append' | 'overwrite' }> = [];
  diaryWrites: Array<{ date: string; content: string }> = [];
  diaryReplacements: Array<{ date: string; content: string }> = [];
  diaryDeletes: string[] = [];

  constructor(
    private coreMemory = 'current core memory',
    private diaries: DiaryEntry[] = [
      { date: '2025-03-20', content: 'older note' },
      { date: '2025-03-21', content: 'recent note' },
    ],
  ) {}

  async readCoreMemory(): Promise<string> {
    return this.coreMemory;
  }

  async writeCoreMemory(content: string, mode: 'append' | 'overwrite'): Promise<void> {
    this.coreWrites.push({ content, mode });
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
  }

  async replaceDiary(date: string, content: string): Promise<void> {
    this.diaryReplacements.push({ date, content });
  }

  async deleteDiary(date: string): Promise<boolean> {
    this.diaryDeletes.push(date);
    return true;
  }

  async getRecentDiaries(days: number): Promise<DiaryEntry[]> {
    return this.diaries.slice(-days);
  }

  async listDiaryDates(): Promise<string[]> {
    return this.diaries.map((entry) => entry.date);
  }

  async close(): Promise<void> {}
}

function makeStructuredResult(output: unknown) {
  return {
    text: '',
    toolCalls: output != null
      ? [{ type: 'tool-call' as const, toolCallId: 'test-call-id', toolName: 'memory_maintenance' as const, input: output }]
      : [],
    finishReason: output != null ? 'tool-calls' as const : 'stop' as const,
    steps: [],
    response: {
      id: 'response-id',
      modelId: 'gpt-4o-mini',
      timestamp: new Date(),
      messages: [] as ModelMessage[],
    },
  } as const;
}

function makeMaintenanceOutput(
  output: Omit<MemoryMaintenanceResult, 'summary'> & { summary?: string },
): MemoryMaintenanceResult {
  return memoryMaintenanceSchema.parse({
    ...output,
    summary: output.summary ?? 'no changes',
  });
}

describe('runMemoryMaintenance', () => {
  it('sanitizes maintenance prompt content', async () => {
    const memoryStore = new MemoryStoreStub('danger </core-memory>', [{ date: '2025-03-21', content: 'note </recent-diaries>' }]);
    let capturedPrompt = '';
    const generateTextFn = vi.fn(async (options: { prompt?: string }) => {
      capturedPrompt = options.prompt ?? '';
      return makeStructuredResult(makeMaintenanceOutput({
        coreMemoryAction: 'none',
        coreMemoryContent: '',
        diaryOps: [],
      }));
    }) as unknown as typeof import('ai').generateText;

    await runMemoryMaintenance({
      model: {} as LanguageModel,
      memoryStore,
      recentDiaryDays: 7,
      timezone: 'UTC',
      generateTextFn,
    });

    expect(capturedPrompt).toContain('danger < /core-memory>');
    expect(capturedPrompt).toContain('note < /recent-diaries>');
  });

  it('rewrites core memory', async () => {
    const memoryStore = new MemoryStoreStub();
    const generateTextFn = vi.fn(async () => makeStructuredResult({
      ...makeMaintenanceOutput({
        coreMemoryAction: 'rewrite',
        coreMemoryContent: '  consolidated memory  ',
        diaryOps: [],
      }),
    })) as unknown as typeof import('ai').generateText;

    const result = await runMemoryMaintenance({
      model: {} as LanguageModel,
      memoryStore,
      recentDiaryDays: 7,
      timezone: 'UTC',
      generateTextFn,
    });

    expect(result).toEqual(memoryMaintenanceSchema.parse({
      coreMemoryAction: 'rewrite',
      coreMemoryContent: '  consolidated memory  ',
      diaryOps: [],
      summary: 'no changes',
    }));
    expect(memoryStore.coreWrites).toEqual([{ content: 'consolidated memory', mode: 'overwrite' }]);
  });

  it('clears core memory', async () => {
    const memoryStore = new MemoryStoreStub();
    const generateTextFn = vi.fn(async () => makeStructuredResult({
      ...makeMaintenanceOutput({
        coreMemoryAction: 'clear',
        coreMemoryContent: '',
        diaryOps: [],
      }),
    })) as unknown as typeof import('ai').generateText;

    await runMemoryMaintenance({
      model: {} as LanguageModel,
      memoryStore,
      recentDiaryDays: 7,
      timezone: 'UTC',
      generateTextFn,
    });

    expect(memoryStore.coreWrites).toEqual([{ content: '', mode: 'overwrite' }]);
  });

  it('rewrites and deletes diary entries', async () => {
    const memoryStore = new MemoryStoreStub();
    const generateTextFn = vi.fn(async () => makeStructuredResult({
      ...makeMaintenanceOutput({
        coreMemoryAction: 'none',
        coreMemoryContent: '',
        diaryOps: [
          { date: '2025-03-20', action: 'rewrite', content: '  merged entry  ' },
          { date: '2025-03-21', action: 'delete', content: '' },
        ],
      }),
    })) as unknown as typeof import('ai').generateText;

    await runMemoryMaintenance({
      model: {} as LanguageModel,
      memoryStore,
      recentDiaryDays: 7,
      timezone: 'UTC',
      generateTextFn,
    });

    expect(memoryStore.diaryReplacements).toEqual([{ date: '2025-03-20', content: '  merged entry  ' }]);
    expect(memoryStore.diaryDeletes).toEqual(['2025-03-21']);
  });

  it('rejects blank core memory rewrites', async () => {
    const memoryStore = new MemoryStoreStub();
    const generateTextFn = vi.fn(async () => makeStructuredResult({
      coreMemoryAction: 'rewrite',
      coreMemoryContent: '   ',
      diaryOps: [],
      summary: 'rewrote core memory',
    })) as unknown as typeof import('ai').generateText;

    await expect(runMemoryMaintenance({
      model: {} as LanguageModel,
      memoryStore,
      recentDiaryDays: 7,
      timezone: 'UTC',
      generateTextFn,
    })).rejects.toThrow('Core memory rewrite requires non-blank content');

    expect(memoryStore.coreWrites).toEqual([]);
  });

  it('rejects blank diary rewrites', async () => {
    const memoryStore = new MemoryStoreStub();
    const generateTextFn = vi.fn(async () => makeStructuredResult({
      coreMemoryAction: 'none',
      coreMemoryContent: '',
      diaryOps: [{ date: '2025-03-20', action: 'rewrite', content: '   ' }],
      summary: 'rewrote diary',
    })) as unknown as typeof import('ai').generateText;

    await expect(runMemoryMaintenance({
      model: {} as LanguageModel,
      memoryStore,
      recentDiaryDays: 7,
      timezone: 'UTC',
      generateTextFn,
    })).rejects.toThrow('Diary rewrite requires non-blank content');

    expect(memoryStore.diaryReplacements).toEqual([]);
    expect(memoryStore.diaryDeletes).toEqual([]);
  });

  it('rejects content on delete and no-op actions', async () => {
    const memoryStore = new MemoryStoreStub();
    const generateTextFn = vi.fn(async () => makeStructuredResult({
      coreMemoryAction: 'none',
      coreMemoryContent: 'should not be present',
      diaryOps: [{ date: '2025-03-20', action: 'delete', content: 'also invalid' }],
      summary: 'deleted entry',
    })) as unknown as typeof import('ai').generateText;

    await expect(runMemoryMaintenance({
      model: {} as LanguageModel,
      memoryStore,
      recentDiaryDays: 7,
      timezone: 'UTC',
      generateTextFn,
    })).rejects.toThrow('must');

    expect(memoryStore.coreWrites).toEqual([]);
    expect(memoryStore.diaryDeletes).toEqual([]);
  });

  it('rejects diary operations for unknown dates', async () => {
    const memoryStore = new MemoryStoreStub();
    const generateTextFn = vi.fn(async () => makeStructuredResult({
      ...makeMaintenanceOutput({
        coreMemoryAction: 'none',
        coreMemoryContent: '',
        diaryOps: [{ date: '2025-04-01', action: 'delete', content: '' }],
      }),
    })) as unknown as typeof import('ai').generateText;

    await expect(runMemoryMaintenance({
      model: {} as LanguageModel,
      memoryStore,
      recentDiaryDays: 7,
      timezone: 'UTC',
      generateTextFn,
    })).rejects.toThrow('unknown dates');

    expect(memoryStore.diaryDeletes).toEqual([]);
  });

  it('does not write anything for a no-op result', async () => {
    const memoryStore = new MemoryStoreStub();
    const generateTextFn = vi.fn(async () => makeStructuredResult({
      ...makeMaintenanceOutput({
        coreMemoryAction: 'none',
        coreMemoryContent: '',
        diaryOps: [],
      }),
    })) as unknown as typeof import('ai').generateText;

    await runMemoryMaintenance({
      model: {} as LanguageModel,
      memoryStore,
      recentDiaryDays: 7,
      timezone: 'UTC',
      generateTextFn,
    });

    expect(memoryStore.coreWrites).toEqual([]);
    expect(memoryStore.diaryReplacements).toEqual([]);
    expect(memoryStore.diaryDeletes).toEqual([]);
  });

  it('rejects duplicate diary operations for the same date', async () => {
    const memoryStore = new MemoryStoreStub();
    const generateTextFn = vi.fn(async () => makeStructuredResult({
      coreMemoryAction: 'none',
      coreMemoryContent: '',
      diaryOps: [
        { date: '2025-03-20', action: 'rewrite', content: 'merged entry' },
        { date: '2025-03-20', action: 'delete', content: '' },
      ],
      summary: 'merged duplicates',
    })) as unknown as typeof import('ai').generateText;

    await expect(runMemoryMaintenance({
      model: {} as LanguageModel,
      memoryStore,
      recentDiaryDays: 7,
      timezone: 'UTC',
      generateTextFn,
    })).rejects.toThrow('Diary operations must use unique dates');

    expect(memoryStore.diaryReplacements).toEqual([]);
    expect(memoryStore.diaryDeletes).toEqual([]);
  });

  it('includes all diary dates while limiting loaded diary bodies to the recent window', async () => {
    const memoryStore = new MemoryStoreStub('current core memory', [
      { date: '2025-03-20', content: 'older note' },
      { date: '2025-03-21', content: 'recent note' },
    ]);
    let capturedPrompt = '';
    const generateTextFn = vi.fn(async (options: { prompt?: string }) => {
      capturedPrompt = options.prompt ?? '';
      return makeStructuredResult(makeMaintenanceOutput({
        coreMemoryAction: 'none',
        coreMemoryContent: '',
        diaryOps: [],
      }));
    }) as unknown as typeof import('ai').generateText;

    await runMemoryMaintenance({
      model: {} as LanguageModel,
      memoryStore,
      recentDiaryDays: 1,
      timezone: 'UTC',
      generateTextFn,
    });

    expect(capturedPrompt).toContain('<all-diary-dates>');
    expect(capturedPrompt).toContain('2025-03-20');
    expect(capturedPrompt).toContain('## 2025-03-21');
    expect(capturedPrompt).not.toContain('## 2025-03-20');
  });

  it('allows deleting an older diary entry that is only listed by date', async () => {
    const memoryStore = new MemoryStoreStub('current core memory', [
      { date: '2025-03-20', content: 'older note' },
      { date: '2025-03-21', content: 'recent note' },
    ]);
    const generateTextFn = vi.fn(async () => makeStructuredResult({
      ...makeMaintenanceOutput({
        coreMemoryAction: 'none',
        coreMemoryContent: '',
        diaryOps: [{ date: '2025-03-20', action: 'delete', content: '' }],
      }),
    })) as unknown as typeof import('ai').generateText;

    await runMemoryMaintenance({
      model: {} as LanguageModel,
      memoryStore,
      recentDiaryDays: 1,
      timezone: 'UTC',
      generateTextFn,
    });

    expect(memoryStore.diaryDeletes).toEqual(['2025-03-20']);
  });

  it('rejects rewriting an older diary entry whose body was not loaded', async () => {
    const memoryStore = new MemoryStoreStub('current core memory', [
      { date: '2025-03-20', content: 'older note' },
      { date: '2025-03-21', content: 'recent note' },
    ]);
    const generateTextFn = vi.fn(async () => makeStructuredResult({
      ...makeMaintenanceOutput({
        coreMemoryAction: 'none',
        coreMemoryContent: '',
        diaryOps: [{ date: '2025-03-20', action: 'rewrite', content: 'replacement' }],
      }),
    })) as unknown as typeof import('ai').generateText;

    await expect(runMemoryMaintenance({
      model: {} as LanguageModel,
      memoryStore,
      recentDiaryDays: 1,
      timezone: 'UTC',
      generateTextFn,
    })).rejects.toThrow('rewrites for unloaded dates');

    expect(memoryStore.diaryReplacements).toEqual([]);
  });

  it('passes providerOptions through to generateText when provided', async () => {
    const memoryStore = new MemoryStoreStub();
    let capturedProviderOptions: unknown;
    const providerOptions = { openai: { reasoningEffort: 'low' as const } };
    const generateTextFn = vi.fn(async (options: { providerOptions?: unknown }) => {
      capturedProviderOptions = options.providerOptions;
      return makeStructuredResult(makeMaintenanceOutput({
        coreMemoryAction: 'none',
        coreMemoryContent: '',
        diaryOps: [],
      }));
    }) as unknown as typeof import('ai').generateText;

    await runMemoryMaintenance({
      model: {} as LanguageModel,
      memoryStore,
      recentDiaryDays: 7,
      timezone: 'UTC',
      generateTextFn,
      providerOptions,
    });

    expect(capturedProviderOptions).toEqual(providerOptions);
  });

  it('returns null when structured output is missing', async () => {
    const memoryStore = new MemoryStoreStub();
    const generateTextFn = vi.fn(async () => makeStructuredResult(undefined)) as unknown as typeof import('ai').generateText;

    await expect(runMemoryMaintenance({
      model: {} as LanguageModel,
      memoryStore,
      recentDiaryDays: 7,
      timezone: 'UTC',
      generateTextFn,
    })).resolves.toBeNull();

    expect(memoryStore.coreWrites).toEqual([]);
    expect(memoryStore.diaryReplacements).toEqual([]);
    expect(memoryStore.diaryDeletes).toEqual([]);
  });

  it('requires a non-blank summary', async () => {
    const memoryStore = new MemoryStoreStub();
    const generateTextFn = vi.fn(async () => makeStructuredResult({
      coreMemoryAction: 'none',
      coreMemoryContent: '',
      diaryOps: [],
      summary: '   ',
    })) as unknown as typeof import('ai').generateText;

    await expect(runMemoryMaintenance({
      model: {} as LanguageModel,
      memoryStore,
      recentDiaryDays: 7,
      timezone: 'UTC',
      generateTextFn,
    })).rejects.toThrow('Summary must be non-blank');
  });

  it('normalizes summary whitespace before returning it', async () => {
    const memoryStore = new MemoryStoreStub();
    const generateTextFn = vi.fn(async () => makeStructuredResult({
      coreMemoryAction: 'none',
      coreMemoryContent: '',
      diaryOps: [],
      summary: '  removed duplicate entries\n\nand consolidated metadata  ',
    })) as unknown as typeof import('ai').generateText;

    const result = await runMemoryMaintenance({
      model: {} as LanguageModel,
      memoryStore,
      recentDiaryDays: 7,
      timezone: 'UTC',
      generateTextFn,
    });

    expect(result?.summary).toBe('removed duplicate entries and consolidated metadata');
  });

  it('bounds the all-diary-dates section while preserving old-date discovery metadata', async () => {
    const startDate = new Date('2023-01-01T00:00:00.000Z');
    const diaries = Array.from({ length: 900 }, (_, index) => {
      const date = new Date(startDate);
      date.setUTCDate(startDate.getUTCDate() + index);
      return {
        date: date.toISOString().slice(0, 10),
        content: `entry ${index + 1}`,
      };
    });
    const memoryStore = new MemoryStoreStub('current core memory', diaries);
    let capturedPrompt = '';
    const generateTextFn = vi.fn(async (options: { prompt?: string }) => {
      capturedPrompt = options.prompt ?? '';
      return makeStructuredResult(makeMaintenanceOutput({
        coreMemoryAction: 'none',
        coreMemoryContent: '',
        diaryOps: [],
      }));
    }) as unknown as typeof import('ai').generateText;

    await runMemoryMaintenance({
      model: {} as LanguageModel,
      memoryStore,
      recentDiaryDays: 1,
      timezone: 'UTC',
      generateTextFn,
    });

    const allDiaryDatesSection = capturedPrompt.match(/<all-diary-dates>\n\n([\s\S]*?)\n\n<\/all-diary-dates>/)?.[1] ?? '';
    expect(allDiaryDatesSection.length).toBeLessThan(6_001);
    expect(allDiaryDatesSection).toContain('Showing ');
    expect(allDiaryDatesSection).toContain('Oldest exact dates:');
    expect(allDiaryDatesSection).toContain('Most recent exact dates:');
    expect(allDiaryDatesSection).toContain('Only operate on YYYY-MM-DD dates shown explicitly anywhere in this section.');
  });

  it('rejects deletes for interior dates omitted from a bounded all-diary-dates section', async () => {
    const startDate = new Date('2023-01-01T00:00:00.000Z');
    const diaries = Array.from({ length: 900 }, (_, index) => {
      const date = new Date(startDate);
      date.setUTCDate(startDate.getUTCDate() + index);
      return {
        date: date.toISOString().slice(0, 10),
        content: `entry ${index + 1}`,
      };
    });
    const memoryStore = new MemoryStoreStub('current core memory', diaries);
    const generateTextFn = vi.fn(async () => makeStructuredResult(makeMaintenanceOutput({
      coreMemoryAction: 'none',
      coreMemoryContent: '',
      diaryOps: [{ date: '2024-01-15', action: 'delete', content: '' }],
    }))) as unknown as typeof import('ai').generateText;

    await expect(runMemoryMaintenance({
      model: {} as LanguageModel,
      memoryStore,
      recentDiaryDays: 1,
      timezone: 'UTC',
      generateTextFn,
    })).rejects.toThrow('unknown dates');

    expect(memoryStore.diaryDeletes).toEqual([]);
  });

  it('allows deleting dates shown as omitted-range boundaries in a bounded all-diary-dates section', async () => {
    const startDate = new Date('2023-01-01T00:00:00.000Z');
    const diaries = Array.from({ length: 900 }, (_, index) => {
      const date = new Date(startDate);
      date.setUTCDate(startDate.getUTCDate() + index);
      return {
        date: date.toISOString().slice(0, 10),
        content: `entry ${index + 1}`,
      };
    });
    const memoryStore = new MemoryStoreStub('current core memory', diaries);
    let capturedPrompt = '';
    const generateTextFn = vi.fn(async (options: { prompt?: string }) => {
      capturedPrompt = options.prompt ?? '';
      return makeStructuredResult(makeMaintenanceOutput({
        coreMemoryAction: 'none',
        coreMemoryContent: '',
        diaryOps: [
          { date: '2023-02-01', action: 'delete', content: '' },
          { date: '2023-02-28', action: 'delete', content: '' },
        ],
      }));
    }) as unknown as typeof import('ai').generateText;

    await runMemoryMaintenance({
      model: {} as LanguageModel,
      memoryStore,
      recentDiaryDays: 1,
      timezone: 'UTC',
      generateTextFn,
    });

    expect(capturedPrompt).toContain('from 2023-02-01 to 2023-02-28');
    expect(memoryStore.diaryDeletes).toEqual(['2023-02-01', '2023-02-28']);
  });
});
