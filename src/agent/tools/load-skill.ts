import { tool } from 'ai';
import { z } from 'zod';

import type { ISkillStore } from '../../skill/types.js';

export interface LoadSkillToolOptions {
  skillStore: ISkillStore;
}

export function createLoadSkillTool({ skillStore }: LoadSkillToolOptions) {
  return tool({
    description: 'Load the full instructions for an available skill by name when it is relevant to the request.',
    inputSchema: z.object({
      name: z.string().trim().min(1).describe('Skill name to load.'),
    }),
    execute: async ({ name }) => {
      const skill = await skillStore.getSkill(name);
      if (skill == null) {
        return {
          loaded: false,
          name,
        };
      }

      return {
        loaded: true,
        name: skill.name,
        description: skill.description,
        instructions: skill.instructions,
      };
    },
  });
}
