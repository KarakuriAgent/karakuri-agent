import { describe, expect, it } from 'vitest';

import type { IMemoryStore } from '../src/memory/types.js';
import { createRecallDiaryTool } from '../src/agent/tools/recall-diary.js';

function createMemoryStoreStub(
  diaries: Record<string, string> = {},
): IMemoryStore {
  return {
    async readCoreMemory() { return ''; },
    async writeCoreMemory() {},
    async readDiary(date: string) { return diaries[date] ?? null; },
    async writeDiary() {},
    async replaceDiary() {},
    async deleteDiary() { return false; },
    async getRecentDiaries() { return []; },
    async listDiaryDates() { return Object.keys(diaries); },
    async close() {},
  };
}

describe('recallDiary tool', () => {
  it('returns diary content when found', async () => {
    const store = createMemoryStoreStub({ '2025-01-15': 'diary content' });
    const tool = createRecallDiaryTool({ memoryStore: store });

    const result = await tool.execute!(
      { date: '2025-01-15' },
      { toolCallId: 'c1', messages: [], abortSignal: undefined as never },
    );

    expect(result).toEqual({
      date: '2025-01-15',
      found: true,
      content: 'diary content',
    });
  });

  it('returns found=false when diary does not exist', async () => {
    const store = createMemoryStoreStub();
    const tool = createRecallDiaryTool({ memoryStore: store });

    const result = await tool.execute!(
      { date: '2025-01-15' },
      { toolCallId: 'c1', messages: [], abortSignal: undefined as never },
    );

    expect(result).toEqual({
      date: '2025-01-15',
      found: false,
      content: null,
    });
  });
});
