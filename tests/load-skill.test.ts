import { tool, type ToolSet, type ToolExecutionOptions } from 'ai';
import type { ZodType } from 'zod';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { createLoadSkillTool } from '../src/agent/tools/load-skill.js';
import { SkillContextRegistry } from '../src/skill/context-provider.js';
import type { ISkillStore, SkillDefinition, SkillFilterOptions } from '../src/skill/types.js';

const DEFAULT_OPTIONS: ToolExecutionOptions = {
  toolCallId: 'tool-1',
  messages: [],
};

function createSkillStoreStub(skills: SkillDefinition[]): ISkillStore {
  return {
    async listSkills(options?: SkillFilterOptions) {
      return skills.filter((skill) => options?.includeSystemOnly === true || !skill.systemOnly);
    },
    async getSkill(name: string, options?: SkillFilterOptions) {
      return skills.find((skill) => skill.name === name && (options?.includeSystemOnly === true || !skill.systemOnly)) ?? null;
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

describe('SkillContextRegistry', () => {
  it('throws on duplicate registration', () => {
    const registry = new SkillContextRegistry();
    registry.register('foo', { getContext: async () => 'ctx' });
    expect(() => registry.register('foo', { getContext: async () => 'other' }))
      .toThrow('Context provider already registered for skill "foo"');
  });

  it('returns null for unregistered skills', async () => {
    const registry = new SkillContextRegistry();
    await expect(registry.getContext('missing')).resolves.toBeNull();
  });

  it('returns a warning string when the provider throws', async () => {
    const registry = new SkillContextRegistry();
    registry.register('broken', { getContext: async () => { throw new Error('boom'); } });
    const result = await registry.getContext('broken');
    expect(result).toContain('[WARNING:');
    expect(result).toContain('broken');
  });
});

describe('loadSkill tool', () => {
  it('returns the full skill instructions for a known skill', async () => {
    const tools = createNoopToolSet();
    const toolInstance = createLoadSkillTool({
      skillStore: createSkillStoreStub([
        {
          name: 'code-review',
          description: 'Review code',
          instructions: 'Check security first.',
          systemOnly: false,
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
          systemOnly: false,
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
          systemOnly: false,
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

  it('does not load system-only skills by default', async () => {
    const toolInstance = createLoadSkillTool({
      skillStore: createSkillStoreStub([
        {
          name: 'system-skill',
          description: 'System only',
          instructions: 'Only for system.',
          systemOnly: true,
        },
      ]),
      tools: createNoopToolSet(),
      gatedToolSets: new Map(),
    });

    await expect(toolInstance.execute!(
      { name: 'system-skill' },
      DEFAULT_OPTIONS,
    )).resolves.toEqual({
      loaded: false,
      name: 'system-skill',
    });
  });

  it('loads system-only skills when explicitly allowed', async () => {
    const toolInstance = createLoadSkillTool({
      skillStore: createSkillStoreStub([
        {
          name: 'system-skill',
          description: 'System only',
          instructions: 'Only for system.',
          systemOnly: true,
        },
      ]),
      tools: createNoopToolSet(),
      gatedToolSets: new Map(),
      includeSystemOnly: true,
    });

    await expect(toolInstance.execute!(
      { name: 'system-skill' },
      DEFAULT_OPTIONS,
    )).resolves.toEqual({
      loaded: true,
      name: 'system-skill',
      description: 'System only',
      instructions: 'Only for system.',
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
          systemOnly: false,
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

  it('returns a structured error on tool name conflict with a different tool source', async () => {
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
          systemOnly: false,
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
      loaded: false,
      name: 'karakuri-world',
      error: expect.stringContaining('tool name conflict'),
    });
  });


  it('prepends dynamic context when a context provider is registered', async () => {
    const registry = new SkillContextRegistry();
    registry.register('code-review', {
      getContext: async () => '## Dynamic context\n- latest signals',
    });
    const toolInstance = createLoadSkillTool({
      skillStore: createSkillStoreStub([
        {
          name: 'code-review',
          description: 'Review code',
          instructions: 'Check security first.',
          systemOnly: false,
        },
      ]),
      tools: createNoopToolSet(),
      gatedToolSets: new Map(),
      contextRegistry: registry,
    });

    await expect(toolInstance.execute!(
      { name: 'code-review' },
      DEFAULT_OPTIONS,
    )).resolves.toEqual({
      loaded: true,
      name: 'code-review',
      description: 'Review code',
      instructions: '## Dynamic context\n- latest signals\n\n---\n\nCheck security first.',
    });
  });

  it('returns a context-failure warning when the context provider throws', async () => {
    const registry = new SkillContextRegistry();
    registry.register('code-review', {
      getContext: async () => { throw new Error('provider crashed'); },
    });
    const toolInstance = createLoadSkillTool({
      skillStore: createSkillStoreStub([
        {
          name: 'code-review',
          description: 'Review code',
          instructions: 'Check security first.',
          systemOnly: false,
        },
      ]),
      tools: createNoopToolSet(),
      gatedToolSets: new Map(),
      contextRegistry: registry,
    });

    const result = await toolInstance.execute!(
      { name: 'code-review' },
      DEFAULT_OPTIONS,
    ) as { loaded: boolean; instructions: string };

    expect(result.loaded).toBe(true);
    expect(result.instructions).toContain('[WARNING:');
    expect(result.instructions).toContain('Check security first.');
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
