import type { ToolSet } from 'ai';

import type { SnsCredentials } from '../../config.js';
import type { IActionLedgerStore } from '../../life/action-ledger.js';
import type { ExperienceRecorder } from '../../life/recorder.js';
import { isReservedSkillName } from '../../skill/reserved.js';
import type { SnsRateLimiter } from '../../sns/rate-limiter.js';
import type { ISnsActivityStore } from '../../sns/types.js';
import type { SkillDefinition } from '../../skill/types.js';
import type { IUserStore } from '../../user/types.js';
import { createLogger } from '../../utils/logger.js';
import { createSnsTools } from './sns.js';

const logger = createLogger('GatedTools');

export interface AvailableGatedToolSources {
  snsList?: SnsCredentials[] | undefined;
  /** @deprecated Use snsList. */
  sns?: SnsCredentials | undefined;
  dataDir?: string | undefined;
  snsActivityStores?: Map<SnsCredentials['provider'], ISnsActivityStore> | undefined;
  userStore?: IUserStore | undefined;
  reportError?: ((message: string) => void) | undefined;
  experienceRecorder?: ExperienceRecorder | undefined;
  actionLedger?: IActionLedgerStore | undefined;
  /** M8: provider 別の書き込みレート制限 */
  snsRateLimiters?: Map<SnsCredentials['provider'], SnsRateLimiter> | undefined;
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

  const snsSources = availableToolSources.snsList ?? (availableToolSources.sns != null ? [availableToolSources.sns] : []);
  for (const sns of snsSources) {
    const providerTools = createSnsTools({
      sns,
      ...(availableToolSources.dataDir != null ? { dataDir: availableToolSources.dataDir } : {}),
      ...(availableToolSources.snsActivityStores?.get(sns.provider) != null
        ? { activityStore: availableToolSources.snsActivityStores.get(sns.provider)! }
        : {}),
      ...(availableToolSources.userStore != null ? { userStore: availableToolSources.userStore } : {}),
      ...(availableToolSources.reportError != null ? { reportError: availableToolSources.reportError } : {}),
      ...(availableToolSources.experienceRecorder != null ? { experienceRecorder: availableToolSources.experienceRecorder } : {}),
      ...(availableToolSources.actionLedger != null ? { actionLedger: availableToolSources.actionLedger } : {}),
      ...(availableToolSources.snsRateLimiters?.get(sns.provider) != null
        ? { rateLimiter: availableToolSources.snsRateLimiters.get(sns.provider)! }
        : {}),
    });
    Object.assign(allGatedTools, providerTools);
    if (availableToolSources.snsList == null && availableToolSources.sns != null) {
      for (const action of ['post', 'get_post', 'like', 'repost', 'upload_media', 'get_thread'] as const) {
        allGatedTools[`sns_${action}`] = providerTools[`sns_${action}`]!;
      }
    }
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
