import type { ToolSet } from 'ai';

import type { SnsCredentials } from '../../config.js';
import type { ExperienceRecorder } from '../../life/recorder.js';
import type { IProspectStore } from '../../life/prospects.js';
import type { EpisodeRetrievalService } from '../../life/retrieval.js';
import type { IMemoryStore } from '../../memory/types.js';
import type { IMessageSink, ISchedulerStore } from '../../scheduler/types.js';
import type { ISnsActivityStore } from '../../sns/types.js';
import type { SkillContextScope } from '../../skill/context-provider.js';
import type { ISkillStore, SkillDefinition } from '../../skill/types.js';
import type { IUserStore } from '../../user/types.js';
import { createLogger } from '../../utils/logger.js';
import { reportSafely } from '../../utils/report.js';
import { hasAdminToolAccess, isAdminUser } from './admin-auth.js';
import { buildGatedToolSets } from './gated-tools.js';
import { createLoadSkillTool } from './load-skill.js';
import { createManageCronTool } from './manage-cron.js';
import { createPostMessageTool } from './post-message.js';
import { createProspectReminderTool } from './prospect-reminder.js';
import { createRecallDiaryTool } from './recall-diary.js';
import { createRecallEpisodesTool } from './recall-episodes.js';
import { createLinkUserTool, createUnlinkUserTool } from './user-alias.js';
import { createUserLookupTool } from './user-lookup.js';
import { createWebFetchTool } from './web-fetch.js';
import { createWebSearchTool } from './web-search.js';

const logger = createLogger('AgentTools');

export interface CreateAgentToolsOptions {
  memoryStore: IMemoryStore;
  dataDir?: string | undefined;
  braveApiKey?: string | undefined;
  snsList?: SnsCredentials[] | undefined;
  /** @deprecated Use snsList. */
  sns?: SnsCredentials | undefined;
  snsActivityStores?: Map<SnsCredentials['provider'], ISnsActivityStore> | undefined;
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
  kwMode?: boolean | undefined;
  evaluateUser?: ((snsUserId: string, displayName: string, postText: string) => void) | undefined;
  experienceRecorder?: ExperienceRecorder | undefined;
  retrievalService?: EpisodeRetrievalService | undefined;
  prospectStore?: IProspectStore | undefined;
  timezone?: string | undefined;
}

export function createAgentTools({
  memoryStore,
  dataDir,
  braveApiKey,
  snsList,
  sns,
  snsActivityStores,
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
  kwMode = false,
  evaluateUser,
  experienceRecorder,
  retrievalService,
  prospectStore,
  timezone,
}: CreateAgentToolsOptions): ToolSet {
  const hasAdminAccess = hasAdminToolAccess(userId, adminUserIds);
  const shouldExposePostMessage = (postMessageEnabled ?? (postMessageChannelIds?.length ?? 0) > 0)
    && hasAdminAccess;
  const manageCronEnabled = hasAdminAccess && schedulerStore != null;
  // alias 系は人間 admin の手動運用専用。system turn (heartbeat / cron / SNS loop / memory maintenance) からは露出しない。
  const shouldExposeUserAlias = isAdminUser(userId, adminUserIds) && !kwMode && userStore != null;
  const evaluatedUsers = new Set<string>();

  const tools: ToolSet = {
    recallDiary: createRecallDiaryTool({ memoryStore }),
    ...(retrievalService != null
      ? {
          recallEpisodes: createRecallEpisodesTool({ retrievalService }),
        }
      : {}),
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
    ...(shouldExposeUserAlias
      ? {
          linkUser: createLinkUserTool({ userStore: userStore!, adminUserIds, userId }),
          unlinkUser: createUnlinkUserTool({ userStore: userStore!, adminUserIds, userId }),
        }
      : {}),
    // 展望記憶のリマインダー型自己登録（M5）。manageCron と違い admin-gated ではないが、
    // 「prospect を時刻 T に想起する」形に限定される（prospect-reminder.ts 参照）
    ...(!kwMode && schedulerStore != null && prospectStore != null
      ? {
          scheduleProspectReminder: createProspectReminderTool({
            schedulerStore,
            prospectStore,
            timezone: timezone ?? 'Asia/Tokyo',
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
    ...(sns != null ? { sns } : {}),
    snsList,
    dataDir,
    snsActivityStores,
    userStore,
    evaluateUser,
    reportError,
    evaluatedUsers,
    experienceRecorder,
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
