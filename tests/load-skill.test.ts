import type { ZodType } from 'zod';
import { describe, expect, it } from 'vitest';

import { createLoadSkillTool } from '../src/agent/tools/load-skill.js';
import type { ISkillStore, SkillDefinition } from '../src/skill/types.js';

function createSkillStoreStub(skills: SkillDefinition[]): ISkillStore {
  return {
    async listSkills() {
      return skills;
    },
    async getSkill(name: string) {
      return skills.find((skill) => skill.name === name) ?? null;
    },
    async close() {},
  };
}

describe('loadSkill tool', () => {
  it('returns the full skill instructions for a known skill', async () => {
    const tool = createLoadSkillTool({
      skillStore: createSkillStoreStub([
        {
          name: 'code-review',
          description: 'Review code',
          instructions: 'Check security first.',
          enabled: true,
        },
      ]),
    });

    await expect(tool.execute!(
      { name: 'code-review' },
      { toolCallId: 'c1', messages: [], abortSignal: undefined as never },
    )).resolves.toEqual({
      loaded: true,
      name: 'code-review',
      description: 'Review code',
      instructions: 'Check security first.',
    });
  });

  it('returns loaded false for missing skills', async () => {
    const tool = createLoadSkillTool({ skillStore: createSkillStoreStub([]) });

    await expect(tool.execute!(
      { name: 'missing' },
      { toolCallId: 'c1', messages: [], abortSignal: undefined as never },
    )).resolves.toEqual({
      loaded: false,
      name: 'missing',
    });
  });

  it('validates non-empty names', () => {
    const tool = createLoadSkillTool({ skillStore: createSkillStoreStub([]) });
    const schema = tool.inputSchema as ZodType;
    expect(schema.safeParse({ name: '' }).success).toBe(false);
  });
});
