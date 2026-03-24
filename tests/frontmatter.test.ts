import { describe, expect, it } from 'vitest';

import { parseSkillMarkdown } from '../src/skill/frontmatter.js';

describe('parseSkillMarkdown', () => {
  it('parses valid skill markdown', () => {
    expect(parseSkillMarkdown(`---\nname: code-review\ndescription: Review code safely\nenabled: true\n---\nCheck security first.`)).toEqual({
      name: 'code-review',
      description: 'Review code safely',
      enabled: true,
      instructions: 'Check security first.',
    });
  });

  it('parses allowed-tools as a CSV list', () => {
    expect(parseSkillMarkdown(`---\nname: karakuri-world\ndescription: Explore the world\nallowed-tools: karakuri_world_get_map, karakuri_world_move , karakuri_world_wait\n---\nObserve first.`)).toEqual({
      name: 'karakuri-world',
      description: 'Explore the world',
      enabled: true,
      allowedTools: [
        'karakuri_world_get_map',
        'karakuri_world_move',
        'karakuri_world_wait',
      ],
      instructions: 'Observe first.',
    });
  });

  it('omits allowedTools when allowed-tools is blank after parsing', () => {
    expect(parseSkillMarkdown(`---\nname: karakuri-world\ndescription: Explore the world\nallowed-tools:  ,   ,\n---\nObserve first.`)).toEqual({
      name: 'karakuri-world',
      description: 'Explore the world',
      enabled: true,
      instructions: 'Observe first.',
    });
  });

  it('defaults enabled to true when omitted', () => {
    expect(parseSkillMarkdown(`---\nname: schedule-helper\ndescription: Help with schedules\n---\nUse timezones.`).enabled).toBe(true);
  });

  it('rejects unknown keys', () => {
    expect(() =>
      parseSkillMarkdown(`---\nname: code-review\ndescription: Review code safely\nowner: kohei\n---\nCheck security first.`),
    ).toThrow(/Unknown frontmatter key/);
  });

  it('rejects invalid enabled values', () => {
    expect(() =>
      parseSkillMarkdown(`---\nname: code-review\ndescription: Review code safely\nenabled: maybe\n---\nCheck security first.`),
    ).toThrow(/must be true or false/);
  });

  it('normalizes CRLF line endings', () => {
    expect(parseSkillMarkdown("---\r\nname: code-review\r\ndescription: Review code safely\r\n---\r\nCheck security first.")).toEqual({
      name: 'code-review',
      description: 'Review code safely',
      enabled: true,
      instructions: 'Check security first.',
    });
  });

  it('rejects a missing body', () => {
    expect(() =>
      parseSkillMarkdown(`---\nname: code-review\ndescription: Review code safely\n---\n`),
    ).toThrow(/body must not be empty/);
  });

  it('rejects invalid tool names in allowed-tools', () => {
    expect(() =>
      parseSkillMarkdown(`---\nname: karakuri-world\ndescription: Explore the world\nallowed-tools: karakuri_world_get_maps, Invalid-Tool\n---\nObserve first.`),
    ).toThrow(/Invalid tool name/);
  });

  it('rejects tool names starting with a digit', () => {
    expect(() =>
      parseSkillMarkdown(`---\nname: karakuri-world\ndescription: Explore the world\nallowed-tools: 1bad_name\n---\nObserve first.`),
    ).toThrow(/Invalid tool name/);
  });
});
