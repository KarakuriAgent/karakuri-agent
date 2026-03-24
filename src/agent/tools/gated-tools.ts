import type { ToolSet } from 'ai';

import type { ApiCredentials } from '../../config.js';
import type { SkillDefinition } from '../../skill/types.js';
import { createLogger } from '../../utils/logger.js';
import { createKarakuriWorldTools } from './karakuri-world.js';

const logger = createLogger('GatedTools');

export interface AvailableGatedToolSources {
  karakuriWorld?: ApiCredentials | undefined;
}

export function buildGatedToolSets(
  skills: SkillDefinition[],
  availableToolSources: AvailableGatedToolSources,
): ReadonlyMap<string, ToolSet> {
  const result = new Map<string, ToolSet>();
  const allGatedTools = buildAllGatedTools(availableToolSources);

  for (const skill of skills) {
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

  if (availableToolSources.karakuriWorld != null) {
    Object.assign(allGatedTools, createKarakuriWorldTools(availableToolSources.karakuriWorld));
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
