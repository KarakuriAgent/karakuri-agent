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
});
