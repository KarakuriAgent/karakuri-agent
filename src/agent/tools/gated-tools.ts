import type { ToolSet } from 'ai';

import type { SnsCredentials } from '../../config.js';
import { isReservedSkillName } from '../../skill/reserved.js';
import type { ISnsActivityStore, ISnsScheduleStore } from '../../sns/types.js';
import type { SkillDefinition } from '../../skill/types.js';
import type { IUserStore } from '../../user/types.js';
import { createLogger } from '../../utils/logger.js';
import { createSnsTools } from './sns.js';

const logger = createLogger('GatedTools');

export interface AvailableGatedToolSources {
  sns?: SnsCredentials | undefined;
  snsActivityStore?: ISnsActivityStore | undefined;
  snsScheduleStore?: ISnsScheduleStore | undefined;
  userStore?: IUserStore | undefined;
  evaluateUser?: ((snsUserId: string, displayName: string, postText: string) => void) | undefined;
  reportError?: ((message: string) => void) | undefined;
}

export function buildGatedToolSets(
  skills: SkillDefinition[],
  availableToolSources: AvailableGatedToolSources,
): ReadonlyMap<string, ToolSet> {
  const result = new Map<string, ToolSet>();
  const allGatedTools = buildAllGatedTools(availableToolSources);

  for (const skill of skills) {
    if (isReservedSkillName(skill.name)) {
      logger.info('Skill filtered out: reserved legacy skill name', { skillName: skill.name });
      continue;
    }

    const matchedToolNames = getMatchedAllowedToolNames(skill, allGatedTools);
    if (matchedToolNames.length === 0) {
      continue;
    }

    const matchedTools: ToolSet = {};
    for (const toolName of matchedToolNames) {
      matchedTools[toolName] = allGatedTools[toolName]!;
    }
    result.set(skill.name, matchedTools);
  }

  return result;
}

export function filterSkillsToAvailableTools(
  skills: SkillDefinition[],
  availableToolSources: AvailableGatedToolSources,
): SkillDefinition[] {
  const allGatedTools = buildAllGatedTools(availableToolSources);

  return skills.flatMap((skill) => {
    if (isReservedSkillName(skill.name)) {
      logger.info('Skill filtered out: reserved legacy skill name', { skillName: skill.name });
      return [];
    }

    const { allowedTools: _allowedTools, ...skillWithoutAllowedTools } = skill;
    const matchedToolNames = getMatchedAllowedToolNames(skill, allGatedTools, { logUnmatched: false });
    if (skill.allowedTools != null && matchedToolNames.length === 0) {
      logger.info('Skill filtered out: required tools not available', {
        skillName: skill.name,
        requiredTools: skill.allowedTools,
      });
      return [];
    }

    return {
      ...skillWithoutAllowedTools,
      ...(matchedToolNames.length > 0 ? { allowedTools: matchedToolNames } : {}),
    };
  });
}

function buildAllGatedTools(availableToolSources: AvailableGatedToolSources): ToolSet {
  const allGatedTools: ToolSet = {};

  if (availableToolSources.sns != null) {
    Object.assign(allGatedTools, createSnsTools({
      ...availableToolSources.sns,
      ...(availableToolSources.snsActivityStore != null ? { activityStore: availableToolSources.snsActivityStore } : {}),
      ...(availableToolSources.snsScheduleStore != null ? { scheduleStore: availableToolSources.snsScheduleStore } : {}),
      ...(availableToolSources.userStore != null ? { userStore: availableToolSources.userStore } : {}),
      ...(availableToolSources.evaluateUser != null ? { evaluateUser: availableToolSources.evaluateUser } : {}),
      ...(availableToolSources.reportError != null ? { reportError: availableToolSources.reportError } : {}),
    }));
  }

  return allGatedTools;
}

function getMatchedAllowedToolNames(
  skill: SkillDefinition,
  allGatedTools: ToolSet,
  options?: { logUnmatched?: boolean },
): string[] {
  if (skill.allowedTools == null) {
    return [];
  }

  return skill.allowedTools.filter((toolName) => {
    if (allGatedTools[toolName] != null) {
      return true;
    }

    if (options?.logUnmatched !== false) {
      logger.error('Skill references unknown gated tool — check spelling in allowed-tools', {
        skillName: skill.name,
        toolName,
      });
    }
    return false;
  });
}
