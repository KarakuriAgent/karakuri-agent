import type { IMemoryStore } from '../../memory/types.js';
import { createRecallDiaryTool } from './recall-diary.js';
import { createSaveMemoryTool } from './save-memory.js';

export interface CreateAgentToolsOptions {
  memoryStore: IMemoryStore;
  timezone: string;
}

export function createAgentTools({ memoryStore, timezone }: CreateAgentToolsOptions) {
  return {
    saveMemory: createSaveMemoryTool({ memoryStore, timezone }),
    recallDiary: createRecallDiaryTool({ memoryStore }),
  };
}

export type AgentToolSet = ReturnType<typeof createAgentTools>;
