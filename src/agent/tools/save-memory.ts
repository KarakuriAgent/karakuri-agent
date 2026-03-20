import { tool } from 'ai';
import { z } from 'zod';

import type { IMemoryStore } from '../../memory/types.js';
import { formatDateInTimezone } from '../../utils/date.js';

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be in YYYY-MM-DD format');

export interface SaveMemoryToolOptions {
  memoryStore: IMemoryStore;
  timezone: string;
  now?: () => Date;
}

export function createSaveMemoryTool({
  memoryStore,
  timezone,
  now = () => new Date(),
}: SaveMemoryToolOptions) {
  return tool({
    description:
      'Append durable memory to the core memory file or add a diary note for a specific day.',
    inputSchema: z.object({
      target: z.enum(['core', 'diary']).describe('Where to save the memory.'),
      content: z.string().min(1).max(4_000).describe('The content to append.'),
      date: isoDateSchema
        .optional()
        .describe('Diary date in YYYY-MM-DD. Defaults to today in the configured timezone.'),
    }),
    execute: async ({ target, content, date }) => {
      const normalizedContent = content.trim();

      if (target === 'core') {
        await memoryStore.writeCoreMemory(normalizedContent, 'append');
        return { saved: true, target };
      }

      const diaryDate = date ?? formatDateInTimezone(now(), timezone);
      await memoryStore.writeDiary(diaryDate, normalizedContent);
      return { saved: true, target, date: diaryDate };
    },
  });
}
