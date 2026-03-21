import type { ZodType } from 'zod';
import { describe, expect, it, vi } from 'vitest';

import type { IMemoryStore } from '../src/memory/types.js';
import { createSaveMemoryTool } from '../src/agent/tools/save-memory.js';
import { formatDateInTimezone } from '../src/utils/date.js';

function createMemoryStoreStub(): IMemoryStore & {
  coreWrites: string[];
  diaryWrites: Array<{ date: string; content: string }>;
} {
  const stub = {
    coreWrites: [] as string[],
    diaryWrites: [] as Array<{ date: string; content: string }>,
    async readCoreMemory() { return ''; },
    async writeCoreMemory(content: string) { stub.coreWrites.push(content); },
    async readDiary() { return null; },
    async writeDiary(date: string, content: string) { stub.diaryWrites.push({ date, content }); },
    async getRecentDiaries() { return []; },
    async listDiaryDates() { return []; },
    async close() {},
  };
  return stub;
}

describe('formatDateInTimezone', () => {
  it('formats a date in the given timezone', () => {
    const date = new Date('2025-06-15T20:00:00.000Z');
    expect(formatDateInTimezone(date, 'Asia/Tokyo')).toBe('2025-06-16');
    expect(formatDateInTimezone(date, 'UTC')).toBe('2025-06-15');
  });
});

describe('saveMemory tool', () => {
  it('appends to core memory', async () => {
    const store = createMemoryStoreStub();
    const tool = createSaveMemoryTool({ memoryStore: store, timezone: 'UTC' });

    const result = await tool.execute!(
      { target: 'core', content: '  important fact  ' },
      { toolCallId: 'c1', messages: [], abortSignal: undefined as never },
    );

    expect(result).toEqual({ saved: true, target: 'core' });
    expect(store.coreWrites).toEqual(['important fact']);
  });

  it('writes diary with explicit date', async () => {
    const store = createMemoryStoreStub();
    const tool = createSaveMemoryTool({ memoryStore: store, timezone: 'UTC' });

    const result = await tool.execute!(
      { target: 'diary', content: 'today note', date: '2025-03-21' },
      { toolCallId: 'c1', messages: [], abortSignal: undefined as never },
    );

    expect(result).toEqual({ saved: true, target: 'diary', date: '2025-03-21' });
    expect(store.diaryWrites).toEqual([{ date: '2025-03-21', content: 'today note' }]);
  });

  it('rejects content exceeding the max length via input schema', () => {
    const store = createMemoryStoreStub();
    const tool = createSaveMemoryTool({ memoryStore: store, timezone: 'UTC' });

    const schema = tool.inputSchema as ZodType;
    const oversized = 'x'.repeat(4_001);
    const result = schema.safeParse({ target: 'core', content: oversized });
    expect(result.success).toBe(false);

    const valid = schema.safeParse({ target: 'core', content: 'ok' });
    expect(valid.success).toBe(true);
  });

  it('defaults diary date to today in the configured timezone', async () => {
    const store = createMemoryStoreStub();
    const fixedNow = new Date('2025-06-15T20:00:00.000Z');
    const tool = createSaveMemoryTool({
      memoryStore: store,
      timezone: 'Asia/Tokyo',
      now: () => fixedNow,
    });

    const result = await tool.execute!(
      { target: 'diary', content: 'auto date' },
      { toolCallId: 'c1', messages: [], abortSignal: undefined as never },
    );

    expect(result).toEqual({ saved: true, target: 'diary', date: '2025-06-16' });
  });
});
