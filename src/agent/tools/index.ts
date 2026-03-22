import type { IMemoryStore } from '../../memory/types.js';
import type { ISkillStore, SkillDefinition } from '../../skill/types.js';
import type { IMessageSink, ISchedulerStore } from '../../scheduler/types.js';
import { hasAdminToolAccess } from './admin-auth.js';
import { createLoadSkillTool } from './load-skill.js';
import { createManageCronTool } from './manage-cron.js';
import { createPostMessageTool } from './post-message.js';
import { createRecallDiaryTool } from './recall-diary.js';
import { createSaveMemoryTool } from './save-memory.js';
import { createWebFetchTool } from './web-fetch.js';
import { createWebSearchTool } from './web-search.js';

export interface CreateAgentToolsOptions {
  memoryStore: IMemoryStore;
  timezone: string;
  braveApiKey?: string | undefined;
  skillStore?: ISkillStore | undefined;
  skills?: SkillDefinition[] | undefined;
  messageSink?: IMessageSink | undefined;
  postMessageEnabled?: boolean | undefined;
  postMessageChannelIds?: string[] | undefined;
  schedulerStore?: ISchedulerStore | undefined;
  adminUserIds?: string[] | undefined;
  userId?: string | undefined;
}

export function createAgentTools({
  memoryStore,
  timezone,
  braveApiKey,
  skillStore,
  skills = [],
  messageSink,
  postMessageEnabled,
  postMessageChannelIds,
  schedulerStore,
  adminUserIds = [],
  userId,
}: CreateAgentToolsOptions) {
  const hasAdminAccess = hasAdminToolAccess(userId, adminUserIds);
  const shouldExposePostMessage = (postMessageEnabled ?? (postMessageChannelIds?.length ?? 0) > 0)
    && hasAdminAccess;
  const manageCronEnabled = hasAdminAccess && schedulerStore != null;

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
    ...(shouldExposePostMessage && messageSink != null
      ? {
          postMessage: createPostMessageTool({
            messageSink,
            allowedChannelIds: postMessageChannelIds ?? [],
            adminUserIds,
            userId,
          }),
        }
      : {}),
    ...(manageCronEnabled
      ? {
          manageCron: createManageCronTool({
            schedulerStore: schedulerStore!,
            adminUserIds,
            userId,
          }),
        }
      : {}),
  };
}

export type AgentToolSet = ReturnType<typeof createAgentTools>;
