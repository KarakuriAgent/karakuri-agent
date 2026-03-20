import { tool } from 'ai';
import { z } from 'zod';

import type { IMemoryStore } from '../../memory/types.js';

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be in YYYY-MM-DD format');

export interface RecallDiaryToolOptions {
  memoryStore: IMemoryStore;
}

export function createRecallDiaryTool({ memoryStore }: RecallDiaryToolOptions) {
  return tool({
    description:
      'Fetch a diary entry for a specific date. Use this for older entries not already injected into context.',
    inputSchema: z.object({
      date: isoDateSchema.describe('Diary date in YYYY-MM-DD format.'),
    }),
    execute: async ({ date }) => {
      const content = await memoryStore.readDiary(date);
      return {
        date,
        found: content != null,
        content,
      };
    },
  });
}
