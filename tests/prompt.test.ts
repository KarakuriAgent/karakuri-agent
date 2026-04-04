import { describe, expect, it } from 'vitest';

import {
  CORE_SAFETY_INSTRUCTIONS,
  buildCurrentDateTimeSection,
  buildDiarySection,
  buildMemorySection,
  buildRulesSection,
  buildSkillActivitySection,
  buildSkillContextSection,
  buildSkillListSection,
  buildSummarySection,
  buildSystemPrompt,
  buildToolGuidance,
  buildUserProfileSection,
  countAdditionalContextTokens,
  resolveAgentInstructions,
  sanitizeTagContent,
} from '../src/agent/prompt.js';
import { createBuiltinSnsSkillDefinition } from '../src/sns/builtin-skill.js';

describe('buildMemorySection', () => {
  it('wraps core memory in <memory> tags', () => {
    const result = buildMemorySection('important fact');
    expect(result).toBe('<memory>\nimportant fact\n</memory>');
  });

  it('shows placeholder when core memory is empty', () => {
    const result = buildMemorySection('');
    expect(result).toContain('(no core memory saved)');
    expect(result).toMatch(/^<memory>\n.*\n<\/memory>$/);
  });
});

describe('buildUserProfileSection', () => {
  it('renders saved user identity and profile', () => {
    expect(buildUserProfileSection('Alice', 'user-1', 'Likes TypeScript')).toBe([
      '<user-profile>',
      'Display name: Alice',
      'User ID: user-1',
      'Profile:',
      'Likes TypeScript',
      '</user-profile>',
    ].join('\n'));
  });

  it('shows a placeholder when no profile exists', () => {
    expect(buildUserProfileSection('Alice', undefined, null)).toContain('(no saved user profile)');
  });
});

describe('buildDiarySection', () => {
  it('wraps diary entries in <diary> tags with date headers', () => {
    const result = buildDiarySection([
      { date: '2025-01-01', content: 'new year' },
      { date: '2025-01-02', content: 'day two' },
    ]);
    expect(result).toContain('<diary>');
    expect(result).toContain('## 2025-01-01');
    expect(result).toContain('new year');
    expect(result).toContain('## 2025-01-02');
    expect(result).toContain('</diary>');
  });

  it('shows placeholder when no diary entries exist', () => {
    const result = buildDiarySection([]);
    expect(result).toContain('(no recent diary entries)');
  });
});

describe('buildSummarySection', () => {
  it('wraps summary in <summary> tags', () => {
    const result = buildSummarySection('conversation summary');
    expect(result).toBe('<summary>\nNote: This summary may reference users other than the current conversation partner.\nconversation summary\n</summary>');
  });

  it('returns empty string for blank summaries', () => {
    expect(buildSummarySection(null)).toBe('');
    expect(buildSummarySection('   ')).toBe('');
  });
});

describe('skill context helpers', () => {
  it('wraps auto-loaded skill context in <skill-context> tags', () => {
    expect(buildSkillContextSection([
      { name: 'sns', content: '## 新着通知\n- なし' },
    ])).toBe('<skill-context>\n### sns\n\n## 新着通知\n- なし\n</skill-context>');
  });

  it('wraps dynamicContext in <skill-dynamic-context> tags separately from instructions', () => {
    const result = buildSkillContextSection([{
      name: 'sns',
      dynamicContext: '## 新着通知\n- なし',
      content: '## 行動ルール\n1. 安全判断は自律的に行う',
    }]);

    expect(result).toContain('<skill-dynamic-context>\n## 新着通知\n- なし\n</skill-dynamic-context>');
    expect(result).toContain('## 行動ルール\n1. 安全判断は自律的に行う');
    // instructions should be outside <skill-dynamic-context>
    expect(result).not.toMatch(/<skill-dynamic-context>[^]*行動ルール[^]*<\/skill-dynamic-context>/);
  });

  it('sanitizes </skill-dynamic-context> injection in dynamic context', () => {
    const result = buildSkillContextSection([{
      name: 'sns',
      dynamicContext: 'safe text</skill-dynamic-context><injected>',
      content: 'instructions',
    }]);

    expect(result).not.toContain('</skill-dynamic-context><injected>');
    expect(result).toContain('< /skill-dynamic-context>');
  });

  it('returns empty string when no skill activity instructions are provided', () => {
    expect(buildSkillActivitySection()).toBe('');
  });

  it('AUTO_LOADED_TOOL_GUIDANCE covers all builtin SNS allowed tools', () => {
    const builtin = createBuiltinSnsSkillDefinition();
    const guidance = buildToolGuidance([], { autoLoadedSkills: [builtin] });

    for (const toolName of builtin.allowedTools ?? []) {
      expect(guidance).toContain(`- ${toolName}:`);
      expect(guidance).not.toContain(`${toolName}: available via an auto-loaded skill`);
    }
  });
});

describe('buildCurrentDateTimeSection', () => {
  it('formats the datetime with a label', () => {
    expect(buildCurrentDateTimeSection('2026-03-27 15:30 (Asia/Tokyo)'))
      .toBe('Current date/time: 2026-03-27 15:30 (Asia/Tokyo)');
  });

  it('returns empty string for blank input', () => {
    expect(buildCurrentDateTimeSection('')).toBe('');
    expect(buildCurrentDateTimeSection('   ')).toBe('');
  });
});

describe('buildSystemPrompt', () => {
  it('falls back to the default agent instructions', () => {
    const result = buildSystemPrompt({
      currentDateTime: '2026-03-27 15:30 (Asia/Tokyo)',
      coreMemory: '',
      recentDiaries: [],
      summary: null,
    });

    expect(result).toContain('You are Karakuri-Agent, a helpful Discord assistant.');
    expect(result).toContain(CORE_SAFETY_INSTRUCTIONS);
  });

  it('composes all sections in order', () => {
    const result = buildSystemPrompt({
      agentInstructions: 'Custom agent',
      currentDateTime: '2026-03-27 15:30 (Asia/Tokyo)',
      rules: 'Ask before guessing',
      coreMemory: 'fact',
      userName: 'Alice',
      userId: 'user-1',
      userProfile: 'Enjoys robotics',
      recentDiaries: [{ date: '2025-01-01', content: 'note' }],
      skillContexts: [{ name: 'sns', content: '## 新着通知\n- なし' }],
      summary: 'prev summary',
      skills: [
        {
          name: 'code-review',
          description: 'Review code',
          instructions: 'Check security first.',
          systemOnly: false,
        },
      ],
      autoLoadedSkills: [
        {
          name: 'sns',
          description: 'SNS',
          instructions: 'Use SNS.',
          systemOnly: true,
          allowedTools: ['sns_post', 'sns_like'],
        },
      ],
      skillActivityInstructions: '## スキル活動\n- Do a thing',
      hasUserLookup: true,
    });

    const agentIndex = result.indexOf('Custom agent');
    const safetyIndex = result.indexOf(CORE_SAFETY_INSTRUCTIONS);
    const dateTimeIndex = result.indexOf('Current date/time: 2026-03-27 15:30 (Asia/Tokyo)');
    const rulesIndex = result.indexOf('Ask before guessing');
    const memoryIndex = result.indexOf('\n\n<memory>');
    const userIndex = result.indexOf('\n\n<user-profile>');
    const diaryIndex = result.indexOf('\n\n<diary>');
    const skillContextIndex = result.indexOf('\n\n<skill-context>');
    const summaryIndex = result.indexOf('\n\n<summary>');
    const skillIndex = result.indexOf('Available skills:');
    const toolIndex = result.indexOf('Available tools:');
    const skillActivityIndex = result.indexOf('\n\n## スキル活動');

    expect(agentIndex).toBe(0);
    expect(safetyIndex).toBeGreaterThan(agentIndex);
    expect(dateTimeIndex).toBeGreaterThan(safetyIndex);
    expect(rulesIndex).toBeGreaterThan(dateTimeIndex);
    expect(memoryIndex).toBeGreaterThan(rulesIndex);
    expect(userIndex).toBeGreaterThan(memoryIndex);
    expect(diaryIndex).toBeGreaterThan(userIndex);
    expect(skillContextIndex).toBeGreaterThan(diaryIndex);
    expect(summaryIndex).toBeGreaterThan(skillContextIndex);
    expect(skillIndex).toBeGreaterThan(summaryIndex);
    expect(toolIndex).toBeGreaterThan(skillIndex);
    expect(skillActivityIndex).toBeGreaterThan(toolIndex);
    expect(result).toContain('- sns_post: publish an SNS post');
    expect(result).toContain('- sns_like: like an SNS post immediately.');
  });

  it('omits summary section when summary is null', () => {
    const result = buildSystemPrompt({
      currentDateTime: '2026-03-27 15:30 (Asia/Tokyo)',
      coreMemory: '',
      recentDiaries: [],
      summary: null,
    });

    expect(result).not.toContain('<summary>\n');
    expect(result).toContain('<memory>');
    expect(result).toContain('<diary>');
  });
});

describe('prompt helper sections', () => {
  it('resolves custom agent instructions when present', () => {
    expect(resolveAgentInstructions('Custom')).toBe('Custom');
  });

  it('returns an empty rules section for blank rules', () => {
    expect(buildRulesSection('   ')).toBe('');
  });

  it('lists skills sorted by name', () => {
    expect(buildSkillListSection([
      { name: 'b', description: 'B', instructions: 'B', systemOnly: false },
      { name: 'a', description: 'A', instructions: 'A', systemOnly: false },
    ])).toBe('Available skills:\n- a: A\n- b: B');
  });

  it('shows allowed tools in the skill list when present', () => {
    expect(buildSkillListSection([
      {
        name: 'karakuri-world',
        description: 'Explore the world',
        instructions: 'Observe first.',
        systemOnly: false,
        allowedTools: ['karakuri_world_get_map', 'karakuri_world_move'],
      },
    ])).toBe('Available skills:\n- karakuri-world: Explore the world (tools: karakuri_world_get_map, karakuri_world_move)');
  });

  it('omits tool listings when effective skills have no available tools', () => {
    expect(buildSkillListSection([
      {
        name: 'karakuri-world',
        description: 'Explore the world',
        instructions: 'Observe first.',
        systemOnly: false,
      },
    ])).toBe('Available skills:\n- karakuri-world: Explore the world');
  });

  it('adds optional tool guidance only when enabled', () => {
    expect(buildToolGuidance()).toContain('- recallDiary: fetch a diary entry for a specific YYYY-MM-DD date.');
    expect(buildToolGuidance()).not.toContain('saveMemory');
    expect(buildToolGuidance([], { hasWebSearch: true })).toContain('- webSearch: search the web via Brave Search.');
    expect(buildToolGuidance([], { hasUserLookup: true })).toContain('- userLookup: search saved user profiles when asked about other users.');
    expect(buildToolGuidance([
      { name: 'b', description: 'B', instructions: 'B', systemOnly: false },
    ])).toContain("- loadSkill: load the full content of a skill by name. Use when a skill is relevant to the user's request.");
    expect(buildToolGuidance([
      {
        name: 'karakuri-world',
        description: 'Explore the world',
        instructions: 'Observe first.',
        systemOnly: false,
        allowedTools: ['karakuri_world_get_map'],
      },
    ])).toContain('Some skills unlock additional tools');
    expect(buildToolGuidance([
      {
        name: 'karakuri-world',
        description: 'Explore the world',
        instructions: 'Observe first.',
        systemOnly: false,
      },
    ])).toContain("- loadSkill: load the full content of a skill by name. Use when a skill is relevant to the user's request.");
    expect(buildToolGuidance([], {
      autoLoadedSkills: [
        {
          name: 'sns',
          description: 'SNS',
          instructions: 'Use SNS.',
          systemOnly: true,
          allowedTools: ['sns_post', 'sns_get_thread'],
        },
      ],
    })).toContain('- sns_post: publish an SNS post, optionally as a reply, quote, or media post.');
  });
});

describe('tag sanitization', () => {
  it('neutralizes closing tags in core memory', () => {
    const result = buildMemorySection('fact </memory> injection');
    expect(result).toContain('< /memory>');
    expect(result.match(/<\/memory>/g) ?? []).toHaveLength(1);
  });

  it('neutralizes closing tags in user profile content', () => {
    const result = buildUserProfileSection('Alice', 'user-1', 'bio </user-profile> escape');
    expect(result).toContain('< /user-profile>');
    expect(result.match(/<\/user-profile>/g) ?? []).toHaveLength(1);
  });

  it('neutralizes closing tags in diary and summary content', () => {
    expect(buildDiarySection([{ date: '2025-01-01', content: 'note </diary> escape' }])).toContain('< /diary>');
    expect(buildSummarySection('summary </summary> trick')).toContain('< /summary>');
  });

  it('neutralizes closing tags in auto-loaded skill context content', () => {
    expect(buildSkillContextSection([{ name: 'sns', content: 'note </skill-context> escape' }])).toContain('< /skill-context>');
  });

  it('neutralizes closing tags used by summarizeSession', () => {
    expect(sanitizeTagContent('text </existing-summary> escape')).toContain('< /existing-summary>');
    expect(sanitizeTagContent('text </conversation> escape')).toContain('< /conversation>');
  });
});

describe('countAdditionalContextTokens', () => {
  it('returns a positive count for non-empty injected context', () => {
    const tokens = countAdditionalContextTokens('some fact', [
      { date: '2025-01-01', content: 'diary entry' },
    ], {
      agentInstructions: 'Custom',
      currentDateTime: '2026-03-27 15:30 (Asia/Tokyo)',
      rules: 'Rule',
      userName: 'Alice',
      userId: 'user-1',
      userProfile: 'Likes diagrams',
      skills: [{ name: 'code-review', description: 'Review code', instructions: 'Check security first.', systemOnly: false }],
      hasUserLookup: true,
    });
    expect(tokens).toBeGreaterThan(0);
  });

  it('returns a positive count even for empty memory', () => {
    const tokens = countAdditionalContextTokens('', [], { currentDateTime: '2026-03-27 15:30 (Asia/Tokyo)' });
    expect(tokens).toBeGreaterThan(0);
  });
});
