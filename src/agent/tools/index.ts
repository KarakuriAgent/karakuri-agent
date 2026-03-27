import type { ToolSet } from 'ai';

import type { ApiCredentials, SnsCredentials } from '../../config.js';
import type { IMemoryStore } from '../../memory/types.js';
import type { IMessageSink, ISchedulerStore } from '../../scheduler/types.js';
import type { ISnsActivityStore, ISnsScheduleStore } from '../../sns/types.js';
import type { SkillContextScope } from '../../skill/context-provider.js';
import type { ISkillStore, SkillDefinition } from '../../skill/types.js';
import type { IUserStore } from '../../user/types.js';
import { createLogger } from '../../utils/logger.js';
import { reportSafely } from '../../utils/report.js';
import { hasAdminToolAccess } from './admin-auth.js';
import { buildGatedToolSets } from './gated-tools.js';
import { createLoadSkillTool } from './load-skill.js';
import { createManageCronTool } from './manage-cron.js';
import { createPostMessageTool } from './post-message.js';
import { createRecallDiaryTool } from './recall-diary.js';
import { createUserLookupTool } from './user-lookup.js';
import { createWebFetchTool } from './web-fetch.js';
import { createWebSearchTool } from './web-search.js';

const logger = createLogger('AgentTools');

export interface CreateAgentToolsOptions {
  memoryStore: IMemoryStore;
  braveApiKey?: string | undefined;
  karakuriWorld?: ApiCredentials | undefined;
  sns?: SnsCredentials | undefined;
  snsActivityStore?: ISnsActivityStore | undefined;
  snsScheduleStore?: ISnsScheduleStore | undefined;
  skillStore?: ISkillStore | undefined;
  skills?: SkillDefinition[] | undefined;
  autoLoadedSkills?: SkillDefinition[] | undefined;
  messageSink?: IMessageSink | undefined;
  reportChannelId?: string | undefined;
  postMessageEnabled?: boolean | undefined;
  postMessageChannelIds?: string[] | undefined;
  schedulerStore?: ISchedulerStore | undefined;
  adminUserIds?: string[] | undefined;
  userId?: string | undefined;
  userStore?: IUserStore | undefined;
  includeSystemOnly?: boolean | undefined;
  contextScope?: SkillContextScope | undefined;
  evaluateUser?: ((snsUserId: string, displayName: string, postText: string) => void) | undefined;
}

export function createAgentTools({
  memoryStore,
  braveApiKey,
  karakuriWorld,
  sns,
  snsActivityStore,
  snsScheduleStore,
  skillStore,
  skills = [],
  autoLoadedSkills = [],
  messageSink,
  reportChannelId,
  postMessageEnabled,
  postMessageChannelIds,
  schedulerStore,
  adminUserIds = [],
  userId,
  userStore,
  includeSystemOnly,
  contextScope,
  evaluateUser,
}: CreateAgentToolsOptions): ToolSet {
  const hasAdminAccess = hasAdminToolAccess(userId, adminUserIds);
  const shouldExposePostMessage = (postMessageEnabled ?? (postMessageChannelIds?.length ?? 0) > 0)
    && hasAdminAccess;
  const manageCronEnabled = hasAdminAccess && schedulerStore != null;

  const tools: ToolSet = {
    recallDiary: createRecallDiaryTool({ memoryStore }),
    webFetch: createWebFetchTool(),
    ...(braveApiKey != null
      ? {
          webSearch: createWebSearchTool({ braveApiKey }),
        }
      : {}),
    ...(userStore != null
      ? {
          userLookup: createUserLookupTool({ userStore }),
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
            messageSink,
            reportChannelId,
          }),
        }
      : {}),
  };

  const reportError = messageSink != null && reportChannelId != null
    ? (message: string) => { void reportSafely(messageSink, reportChannelId, message, logger); }
    : undefined;
  const gatedToolSets = buildGatedToolSets([
    ...skills,
    ...autoLoadedSkills,
  ], {
    karakuriWorld,
    sns,
    snsActivityStore,
    snsScheduleStore,
    userStore,
    evaluateUser,
    reportError,
  });
  // Auto-loaded skills have their gated tools registered immediately.
  // loadSkill.execute() also mutates this tools object to dynamically register
  // gated tools. This is intentional and scoped to a single handleMessage()
  // turn — tools is recreated per turn.
  for (const skill of autoLoadedSkills) {
    const skillTools = gatedToolSets.get(skill.name);
    if (skillTools == null) {
      logger.warn('Auto-loaded skill has no gated tools available', { skillName: skill.name, allowedTools: skill.allowedTools });
      continue;
    }
    for (const toolName of Object.keys(skillTools)) {
      const existing = tools[toolName];
      if (existing != null && existing !== skillTools[toolName]) {
        throw new Error(`Internal tool name conflict for "${toolName}" while auto-loading "${skill.name}"`);
      }
    }
    Object.assign(tools, skillTools);
  }

  if (skillStore != null && skills.length > 0) {
    tools.loadSkill = createLoadSkillTool({
      skillStore,
      tools,
      gatedToolSets,
      ...(includeSystemOnly != null ? { includeSystemOnly } : {}),
      ...(contextScope != null ? { contextScope } : {}),
    });
  }

  return tools;
}

export type AgentToolSet = ReturnType<typeof createAgentTools>;
