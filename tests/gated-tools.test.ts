import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { buildGatedToolSets, filterSkillsToAvailableTools } from '../src/agent/tools/gated-tools.js';
import type { SkillDefinition } from '../src/skill/types.js';

const SNS_CREDS = {
  sns: {
    provider: 'mastodon' as const,
    instanceUrl: 'https://social.example',
    accessToken: 'secret',
  },
};

const NO_CREDS = {};

function makeSkill(overrides: Partial<SkillDefinition> & Pick<SkillDefinition, 'name'>): SkillDefinition {
  return {
    description: 'test skill',
    instructions: 'do something',
    systemOnly: false,
    ...overrides,
  };
}

describe('buildGatedToolSets', () => {
  it('does not expose karakuri-world tools through skill gating', () => {
    const skills = [
      makeSkill({
        name: 'karakuri-world',
        allowedTools: ['karakuri_world_get_map', 'karakuri_world_move'],
      }),
    ];

    const result = buildGatedToolSets(skills, NO_CREDS);

    expect(result.size).toBe(0);
  });

  it('skips skills with no matching allowed tools', () => {
    const skills = [
      makeSkill({
        name: 'karakuri-world',
        allowedTools: ['nonexistent_tool_a', 'nonexistent_tool_b'],
      }),
    ];

    const result = buildGatedToolSets(skills, NO_CREDS);

    expect(result.size).toBe(0);
  });

  it('skips skills without allowedTools', () => {
    const skills = [
      makeSkill({ name: 'plain-skill' }),
    ];

    const result = buildGatedToolSets(skills, NO_CREDS);

    expect(result.size).toBe(0);
  });

  it('returns empty map when no tool sources are configured', () => {
    const skills = [
      makeSkill({
        name: 'karakuri-world',
        allowedTools: ['karakuri_world_get_map'],
      }),
    ];

    const result = buildGatedToolSets(skills, NO_CREDS);

    expect(result.size).toBe(0);
  });

  it('handles multiple skills with mixed availability', () => {
    const skills = [
      makeSkill({
        name: 'karakuri-world',
        allowedTools: ['karakuri_world_get_map'],
      }),
      makeSkill({ name: 'plain-skill' }),
      makeSkill({
        name: 'missing-tools',
        allowedTools: ['nonexistent_tool'],
      }),
    ];

    const result = buildGatedToolSets(skills, NO_CREDS);

    expect(result.size).toBe(0);
    expect(result.has('plain-skill')).toBe(false);
    expect(result.has('missing-tools')).toBe(false);
  });

  it('builds a tool set for SNS skills when SNS credentials are configured', () => {
    const skills = [
      makeSkill({
        name: 'sns',
        allowedTools: ['sns_get_post', 'sns_post'],
      }),
    ];

    const result = buildGatedToolSets(skills, SNS_CREDS);

    expect(result.size).toBe(1);
    expect(Object.keys(result.get('sns')!)).toEqual(['sns_get_post', 'sns_post']);
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
      systemOnly: false,
    }]);
  });

  it('filters out karakuri-world skills even when karakuri-world credentials exist', () => {
    const skills = [
      makeSkill({
        name: 'karakuri-world',
        allowedTools: ['karakuri_world_get_map', 'karakuri_world_move'],
      }),
    ];

    const result = filterSkillsToAvailableTools(skills, NO_CREDS);

    expect(result).toHaveLength(0);
  });

  it('filters out legacy karakuri-world skills even without allowedTools', () => {
    const skills = [
      makeSkill({
        name: 'karakuri-world',
      }),
    ];

    const result = filterSkillsToAvailableTools(skills, NO_CREDS);

    expect(result).toHaveLength(0);
  });

  it('filters out skills whose required tools are all unavailable', () => {
    const skills = [
      makeSkill({
        name: 'karakuri-world',
        allowedTools: ['karakuri_world_get_map'],
      }),
    ];

    const result = filterSkillsToAvailableTools(skills, NO_CREDS);

    expect(result).toHaveLength(0);
  });

  it('filters out karakuri-world skills even with partial tool availability', () => {
    const skills = [
      makeSkill({
        name: 'karakuri-world',
        allowedTools: ['karakuri_world_get_map', 'nonexistent_tool'],
      }),
    ];

    const result = filterSkillsToAvailableTools(skills, NO_CREDS);

    expect(result).toHaveLength(0);
  });

  it('handles mixed skills with and without allowedTools', () => {
    const skills = [
      makeSkill({ name: 'plain-skill' }),
      makeSkill({
        name: 'karakuri-world',
        allowedTools: ['karakuri_world_get_map'],
      }),
      makeSkill({
        name: 'unavailable-skill',
        allowedTools: ['nonexistent_tool'],
      }),
    ];

    const result = filterSkillsToAvailableTools(skills, NO_CREDS);

    expect(result).toHaveLength(1);
    expect(result.map((s) => s.name)).toEqual(['plain-skill']);
  });

  it('strips allowedTools from filtered skills that had no matching tools', () => {
    const skills = [
      makeSkill({
        name: 'karakuri-world',
        allowedTools: ['nonexistent_tool_a', 'nonexistent_tool_b'],
      }),
    ];

    const result = filterSkillsToAvailableTools(skills, NO_CREDS);

    expect(result).toHaveLength(0);
  });

  it('filters out SNS skills when SNS credentials are unavailable', () => {
    const skills = [
      makeSkill({
        name: 'sns',
        allowedTools: ['sns_get_post'],
      }),
    ];

    expect(filterSkillsToAvailableTools(skills, NO_CREDS)).toHaveLength(0);
    expect(filterSkillsToAvailableTools(skills, SNS_CREDS)[0]!.allowedTools).toEqual(['sns_get_post']);
  });
});
