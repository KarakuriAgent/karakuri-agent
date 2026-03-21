import type { IMemoryStore } from '../../memory/types.js';
import type { ISkillStore, SkillDefinition } from '../../skill/types.js';
import { createLoadSkillTool } from './load-skill.js';
import { createRecallDiaryTool } from './recall-diary.js';
import { createSaveMemoryTool } from './save-memory.js';
import { createWebFetchTool } from './web-fetch.js';
import { createWebSearchTool } from './web-search.js';

export interface CreateAgentToolsOptions {
  memoryStore: IMemoryStore;
  timezone: string;
  braveApiKey?: string | undefined;
  skillStore?: ISkillStore;
  skills?: SkillDefinition[];
}

export function createAgentTools({ memoryStore, timezone, braveApiKey, skillStore, skills = [] }: CreateAgentToolsOptions) {
  return {
    saveMemory: createSaveMemoryTool({ memoryStore, timezone }),
    recallDiary: createRecallDiaryTool({ memoryStore }),
    webFetch: createWebFetchTool(),
    ...(braveApiKey != null
      ? {
          webSearch: createWebSearchTool({ braveApiKey }),
        }
      : {}),
    ...(skillStore != null && skills.length > 0
      ? {
          loadSkill: createLoadSkillTool({ skillStore }),
        }
      : {}),
  };
}

export type AgentToolSet = ReturnType<typeof createAgentTools>;
