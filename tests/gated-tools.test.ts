import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { buildGatedToolSets, filterSkillsToAvailableTools } from '../src/agent/tools/gated-tools.js';
import type { SkillDefinition } from '../src/skill/types.js';

const KARAKURI_WORLD_CREDS = {
  karakuriWorld: {
    apiBaseUrl: 'https://example.com/api',
    apiKey: 'secret',
  },
};

const NO_CREDS = {};

function makeSkill(overrides: Partial<SkillDefinition> & Pick<SkillDefinition, 'name'>): SkillDefinition {
  return {
    description: 'test skill',
    instructions: 'do something',
    enabled: true,
    ...overrides,
  };
}

describe('buildGatedToolSets', () => {
  it('builds a tool set for a skill whose allowed tools are all available', () => {
    const skills = [
      makeSkill({
        name: 'karakuri-world',
        allowedTools: ['karakuri_world_get_perception', 'karakuri_world_move'],
      }),
    ];

    const result = buildGatedToolSets(skills, KARAKURI_WORLD_CREDS);

    expect(result.size).toBe(1);
    const toolSet = result.get('karakuri-world')!;
    expect(Object.keys(toolSet)).toEqual(['karakuri_world_get_perception', 'karakuri_world_move']);
  });

  it('builds a partial tool set when only some allowed tools are available', () => {
    const skills = [
      makeSkill({
        name: 'karakuri-world',
        allowedTools: ['karakuri_world_get_map', 'nonexistent_tool'],
      }),
    ];

    const result = buildGatedToolSets(skills, KARAKURI_WORLD_CREDS);

    expect(result.size).toBe(1);
    const toolSet = result.get('karakuri-world')!;
    expect(Object.keys(toolSet)).toEqual(['karakuri_world_get_map']);
  });

  it('skips skills with no matching allowed tools', () => {
    const skills = [
      makeSkill({
        name: 'karakuri-world',
        allowedTools: ['nonexistent_tool_a', 'nonexistent_tool_b'],
      }),
    ];

    const result = buildGatedToolSets(skills, KARAKURI_WORLD_CREDS);

    expect(result.size).toBe(0);
  });

  it('skips skills without allowedTools', () => {
    const skills = [
      makeSkill({ name: 'plain-skill' }),
    ];

    const result = buildGatedToolSets(skills, KARAKURI_WORLD_CREDS);

    expect(result.size).toBe(0);
  });

  it('returns empty map when no tool sources are configured', () => {
    const skills = [
      makeSkill({
        name: 'karakuri-world',
        allowedTools: ['karakuri_world_get_perception'],
      }),
    ];

    const result = buildGatedToolSets(skills, NO_CREDS);

    expect(result.size).toBe(0);
  });

  it('handles multiple skills with mixed availability', () => {
    const skills = [
      makeSkill({
        name: 'karakuri-world',
        allowedTools: ['karakuri_world_get_perception'],
      }),
      makeSkill({ name: 'plain-skill' }),
      makeSkill({
        name: 'missing-tools',
        allowedTools: ['nonexistent_tool'],
      }),
    ];

    const result = buildGatedToolSets(skills, KARAKURI_WORLD_CREDS);

    expect(result.size).toBe(1);
    expect(result.has('karakuri-world')).toBe(true);
    expect(result.has('plain-skill')).toBe(false);
    expect(result.has('missing-tools')).toBe(false);
  });
});

describe('filterSkillsToAvailableTools', () => {
  it('keeps skills without allowedTools unchanged', () => {
    const skills = [makeSkill({ name: 'plain-skill' })];

    const result = filterSkillsToAvailableTools(skills, NO_CREDS);

    expect(result).toEqual([{
      name: 'plain-skill',
      description: 'test skill',
      instructions: 'do something',
      enabled: true,
    }]);
  });

  it('keeps skills whose allowed tools are available', () => {
    const skills = [
      makeSkill({
        name: 'karakuri-world',
        allowedTools: ['karakuri_world_get_perception', 'karakuri_world_move'],
      }),
    ];

    const result = filterSkillsToAvailableTools(skills, KARAKURI_WORLD_CREDS);

    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('karakuri-world');
    expect(result[0]!.allowedTools).toEqual(['karakuri_world_get_perception', 'karakuri_world_move']);
  });

  it('filters out skills whose required tools are all unavailable', () => {
    const skills = [
      makeSkill({
        name: 'karakuri-world',
        allowedTools: ['karakuri_world_get_perception'],
      }),
    ];

    const result = filterSkillsToAvailableTools(skills, NO_CREDS);

    expect(result).toHaveLength(0);
  });

  it('keeps skills with partial tool availability and narrows allowedTools', () => {
    const skills = [
      makeSkill({
        name: 'karakuri-world',
        allowedTools: ['karakuri_world_get_map', 'nonexistent_tool'],
      }),
    ];

    const result = filterSkillsToAvailableTools(skills, KARAKURI_WORLD_CREDS);

    expect(result).toHaveLength(1);
    expect(result[0]!.allowedTools).toEqual(['karakuri_world_get_map']);
  });

  it('handles mixed skills with and without allowedTools', () => {
    const skills = [
      makeSkill({ name: 'plain-skill' }),
      makeSkill({
        name: 'karakuri-world',
        allowedTools: ['karakuri_world_get_perception'],
      }),
      makeSkill({
        name: 'unavailable-skill',
        allowedTools: ['nonexistent_tool'],
      }),
    ];

    const result = filterSkillsToAvailableTools(skills, KARAKURI_WORLD_CREDS);

    expect(result).toHaveLength(2);
    expect(result.map((s) => s.name)).toEqual(['plain-skill', 'karakuri-world']);
  });

  it('strips allowedTools from filtered skills that had no matching tools', () => {
    const skills = [
      makeSkill({
        name: 'karakuri-world',
        allowedTools: ['nonexistent_tool_a', 'nonexistent_tool_b'],
      }),
    ];

    const result = filterSkillsToAvailableTools(skills, KARAKURI_WORLD_CREDS);

    expect(result).toHaveLength(0);
  });
});
