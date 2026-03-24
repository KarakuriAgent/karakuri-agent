import { tool, type ToolSet, type ToolExecutionOptions } from 'ai';
import type { ZodType } from 'zod';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { createLoadSkillTool } from '../src/agent/tools/load-skill.js';
import type { ISkillStore, SkillDefinition } from '../src/skill/types.js';

const DEFAULT_OPTIONS: ToolExecutionOptions = {
  toolCallId: 'tool-1',
  messages: [],
};

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

function createNoopToolSet(): ToolSet {
  return {
    noop: tool({
      description: 'noop',
      inputSchema: z.object({}),
      execute: async () => ({ ok: true }),
    }),
  };
}

describe('loadSkill tool', () => {
  it('returns the full skill instructions for a known skill', async () => {
    const tools = createNoopToolSet();
    const toolInstance = createLoadSkillTool({
      skillStore: createSkillStoreStub([
        {
          name: 'code-review',
          description: 'Review code',
          instructions: 'Check security first.',
          enabled: true,
        },
      ]),
      tools,
      gatedToolSets: new Map(),
    });

    await expect(toolInstance.execute!(
      { name: 'code-review' },
      DEFAULT_OPTIONS,
    )).resolves.toEqual({
      loaded: true,
      name: 'code-review',
      description: 'Review code',
      instructions: 'Check security first.',
    });
  });

  it('returns allowedTools and dynamically adds gated tools', async () => {
    const tools = createNoopToolSet();
    const unlockedTools: ToolSet = {
      karakuri_world_get_map: tool({
        description: 'map',
        inputSchema: z.object({}),
        execute: async () => ({ rows: 1, cols: 1 }),
      }),
    };
    const toolInstance = createLoadSkillTool({
      skillStore: createSkillStoreStub([
        {
          name: 'karakuri-world',
          description: 'Explore the world',
          instructions: 'Observe first.',
          enabled: true,
          allowedTools: ['karakuri_world_get_map'],
        },
      ]),
      tools,
      gatedToolSets: new Map([['karakuri-world', unlockedTools]]),
    });

    await expect(toolInstance.execute!(
      { name: 'karakuri-world' },
      DEFAULT_OPTIONS,
    )).resolves.toEqual({
      loaded: true,
      name: 'karakuri-world',
      description: 'Explore the world',
      allowedTools: ['karakuri_world_get_map'],
      instructions: 'Observe first.',
    });
    expect(tools).toHaveProperty('karakuri_world_get_map');
  });

  it('omits unavailable allowedTools from the loadSkill result', async () => {
    const tools = createNoopToolSet();
    const toolInstance = createLoadSkillTool({
      skillStore: createSkillStoreStub([
        {
          name: 'karakuri-world',
          description: 'Explore the world',
          instructions: 'Observe first.',
          enabled: true,
          allowedTools: ['karakuri_world_get_map', 'karakuri_world_move'],
        },
      ]),
      tools,
      gatedToolSets: new Map(),
    });

    await expect(toolInstance.execute!(
      { name: 'karakuri-world' },
      DEFAULT_OPTIONS,
    )).resolves.toEqual({
      loaded: false,
      name: 'karakuri-world',
      unavailable: true,
    });
    expect(tools).not.toHaveProperty('karakuri_world_get_map');
    expect(tools).not.toHaveProperty('karakuri_world_move');
  });

  it('returns loaded false for missing skills', async () => {
    const toolInstance = createLoadSkillTool({
      skillStore: createSkillStoreStub([]),
      tools: createNoopToolSet(),
      gatedToolSets: new Map(),
    });

    await expect(toolInstance.execute!(
      { name: 'missing' },
      DEFAULT_OPTIONS,
    )).resolves.toEqual({
      loaded: false,
      name: 'missing',
    });
  });

  it('allows re-loading the same skill in the same turn without collision error', async () => {
    const tools = createNoopToolSet();
    const unlockedTools: ToolSet = {
      karakuri_world_get_map: tool({
        description: 'map',
        inputSchema: z.object({}),
        execute: async () => ({ rows: 1, cols: 1 }),
      }),
    };
    const toolInstance = createLoadSkillTool({
      skillStore: createSkillStoreStub([
        {
          name: 'karakuri-world',
          description: 'Explore the world',
          instructions: 'Observe first.',
          enabled: true,
          allowedTools: ['karakuri_world_get_map'],
        },
      ]),
      tools,
      gatedToolSets: new Map([['karakuri-world', unlockedTools]]),
    });

    await toolInstance.execute!({ name: 'karakuri-world' }, DEFAULT_OPTIONS);
    await expect(toolInstance.execute!(
      { name: 'karakuri-world' },
      DEFAULT_OPTIONS,
    )).resolves.toMatchObject({ loaded: true, name: 'karakuri-world' });
    expect(tools).toHaveProperty('karakuri_world_get_map');
  });

  it('throws on tool name conflict with a different tool source', async () => {
    const conflictingTool = tool({
      description: 'conflicting',
      inputSchema: z.object({}),
      execute: async () => ({ ok: true }),
    });
    const tools: ToolSet = {
      ...createNoopToolSet(),
      karakuri_world_get_map: conflictingTool,
    };
    const unlockedTools: ToolSet = {
      karakuri_world_get_map: tool({
        description: 'map',
        inputSchema: z.object({}),
        execute: async () => ({ rows: 1, cols: 1 }),
      }),
    };
    const toolInstance = createLoadSkillTool({
      skillStore: createSkillStoreStub([
        {
          name: 'karakuri-world',
          description: 'Explore the world',
          instructions: 'Observe first.',
          enabled: true,
          allowedTools: ['karakuri_world_get_map'],
        },
      ]),
      tools,
      gatedToolSets: new Map([['karakuri-world', unlockedTools]]),
    });

    await expect(toolInstance.execute!(
      { name: 'karakuri-world' },
      DEFAULT_OPTIONS,
    )).rejects.toThrow('Gated tool name conflict');
  });

  it('validates non-empty names', () => {
    const toolInstance = createLoadSkillTool({
      skillStore: createSkillStoreStub([]),
      tools: createNoopToolSet(),
      gatedToolSets: new Map(),
    });
    const schema = toolInstance.inputSchema as ZodType;
    expect(schema.safeParse({ name: '' }).success).toBe(false);
  });
});
