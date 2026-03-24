import { describe, expect, it } from 'vitest';

import { parseSkillMarkdown } from '../src/skill/frontmatter.js';

describe('parseSkillMarkdown', () => {
  it('parses valid skill markdown', () => {
    expect(parseSkillMarkdown(`---
name: code-review
description: Review code safely
---
Check security first.`)).toEqual({
      name: 'code-review',
      description: 'Review code safely',
      instructions: 'Check security first.',
    });
  });

  it('parses allowed-tools as a CSV list', () => {
    expect(parseSkillMarkdown(`---
name: karakuri-world
description: Explore the world
allowed-tools: karakuri_world_get_map, karakuri_world_move , karakuri_world_wait
---
Observe first.`)).toEqual({
      name: 'karakuri-world',
      description: 'Explore the world',
      allowedTools: [
        'karakuri_world_get_map',
        'karakuri_world_move',
        'karakuri_world_wait',
      ],
      instructions: 'Observe first.',
    });
  });

  it('omits allowedTools when allowed-tools is blank after parsing', () => {
    expect(parseSkillMarkdown(`---
name: karakuri-world
description: Explore the world
allowed-tools:  ,   ,
---
Observe first.`)).toEqual({
      name: 'karakuri-world',
      description: 'Explore the world',
      instructions: 'Observe first.',
    });
  });

  it('rejects unknown keys', () => {
    expect(() =>
      parseSkillMarkdown(`---
name: code-review
description: Review code safely
owner: kohei
---
Check security first.`),
    ).toThrow(/Unknown frontmatter key/);
  });

  it('rejects enabled because it is no longer supported', () => {
    expect(() =>
      parseSkillMarkdown(`---
name: code-review
description: Review code safely
enabled: true
---
Check security first.`),
    ).toThrow(/Unknown frontmatter key/);
  });

  it('normalizes CRLF line endings', () => {
    expect(parseSkillMarkdown('---\r\nname: code-review\r\ndescription: Review code safely\r\n---\r\nCheck security first.')).toEqual({
      name: 'code-review',
      description: 'Review code safely',
      instructions: 'Check security first.',
    });
  });

  it('rejects a missing body', () => {
    expect(() =>
      parseSkillMarkdown(`---
name: code-review
description: Review code safely
---
`),
    ).toThrow(/body must not be empty/);
  });

  it('rejects invalid tool names in allowed-tools', () => {
    expect(() =>
      parseSkillMarkdown(`---
name: karakuri-world
description: Explore the world
allowed-tools: karakuri_world_get_maps, Invalid-Tool
---
Observe first.`),
    ).toThrow(/Invalid tool name/);
  });

  it('rejects tool names starting with a digit', () => {
    expect(() =>
      parseSkillMarkdown(`---
name: karakuri-world
description: Explore the world
allowed-tools: 1bad_name
---
Observe first.`),
    ).toThrow(/Invalid tool name/);
  });
});
