import { tool, type ToolSet } from 'ai';
import { z } from 'zod';

import type { ISkillStore } from '../../skill/types.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('LoadSkill');

export interface LoadSkillToolOptions {
  skillStore: ISkillStore;
  tools: ToolSet;
  gatedToolSets: ReadonlyMap<string, ToolSet>;
}

export function createLoadSkillTool({ skillStore, tools, gatedToolSets }: LoadSkillToolOptions) {
  return tool({
    description: 'Load the full instructions for an available skill by name when it is relevant to the request.',
    inputSchema: z.object({
      name: z.string().trim().min(1).describe('Skill name to load.'),
    }),
    execute: async ({ name }) => {
      const skill = await skillStore.getSkill(name);
      if (skill == null) {
        logger.debug('Skill not found', { name });
        return {
          loaded: false,
          name,
        };
      }

      const skillTools = gatedToolSets.get(name);
      if (skill.allowedTools != null && skillTools == null) {
        logger.warn('Skill tools unavailable', {
          skillName: skill.name,
          requiredTools: skill.allowedTools,
        });
        return {
          loaded: false,
          name: skill.name,
          unavailable: true,
        };
      }

      if (skillTools != null) {
        for (const toolName of Object.keys(skillTools)) {
          const existing = tools[toolName];
          if (existing != null && existing !== skillTools[toolName]) {
            logger.error('Gated tool name conflict', { skillName: name, toolName });
            return {
              loaded: false,
              name: skill.name,
              error: `Internal tool name conflict for "${toolName}". This is a configuration error.`,
            };
          }
        }
        // Mutates the shared tools object so newly registered tools are visible to subsequent LLM steps.
        Object.assign(tools, skillTools);
      }

      const allowedTools = skillTools != null ? Object.keys(skillTools) : undefined;

      return {
        loaded: true,
        name: skill.name,
        description: skill.description,
        ...(allowedTools != null && allowedTools.length > 0 ? { allowedTools } : {}),
        instructions: skill.instructions,
      };
    },
  });
}
