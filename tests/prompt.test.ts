import { describe, expect, it } from 'vitest';

import {
  CORE_SAFETY_INSTRUCTIONS,
  buildCurrentDateTimeSection,
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
import { buildCheckPhoneSnsActivityInstructions, createBuiltinSnsSkillDefinition } from '../src/sns/builtin-skill.js';

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

  it('excludes unsupported ELYTH repost from builtin skill and world action guidance', () => {
    const builtin = createBuiltinSnsSkillDefinition('elyth');
    const checkPhoneGuidance = buildCheckPhoneSnsActivityInstructions('elyth');

    expect(builtin.allowedTools).toEqual([
      'sns_elyth_post',
      'sns_elyth_get_post',
      'sns_elyth_like',
      'sns_elyth_get_thread',
    ]);
    expect(builtin.instructions).toContain('リポスト非対応');
    expect(builtin.instructions).not.toContain('sns_elyth_repost');
    expect(checkPhoneGuidance).not.toContain('`sns_elyth_repost`');
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
      userName: 'Alice',
      userId: 'user-1',
      userProfile: 'Enjoys robotics',
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
    const userIndex = result.indexOf('\n\n<user-profile>');
    const skillContextIndex = result.indexOf('\n\n<skill-context>');
    const summaryIndex = result.indexOf('\n\n<summary>');
    const skillIndex = result.indexOf('Available skills:');
    const toolIndex = result.indexOf('Available tools:');
    const skillActivityIndex = result.indexOf('\n\n## スキル活動');

    expect(agentIndex).toBe(0);
    expect(safetyIndex).toBeGreaterThan(agentIndex);
    expect(dateTimeIndex).toBeGreaterThan(safetyIndex);
    expect(rulesIndex).toBeGreaterThan(dateTimeIndex);
    expect(userIndex).toBeGreaterThan(rulesIndex);
    expect(skillContextIndex).toBeGreaterThan(userIndex);
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
      summary: null,
    });

    expect(result).not.toContain('<summary>\n');
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
    expect(buildToolGuidance()).toContain('- webFetch: fetch a URL and extract its readable content as Markdown.');
    expect(buildToolGuidance()).not.toContain('recallDiary');
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
  it('neutralizes closing tags in user profile content', () => {
    const result = buildUserProfileSection('Alice', 'user-1', 'bio </user-profile> escape');
    expect(result).toContain('< /user-profile>');
    expect(result.match(/<\/user-profile>/g) ?? []).toHaveLength(1);
  });

  it('neutralizes closing tags in summary content', () => {
    expect(buildSummarySection('summary </summary> trick')).toContain('< /summary>');
  });

  it('neutralizes closing tags in auto-loaded skill context content', () => {
    expect(buildSkillContextSection([{ name: 'sns', content: 'note </skill-context> escape' }])).toContain('< /skill-context>');
  });

  it('neutralizes closing tags used by summarizeSession', () => {
    expect(sanitizeTagContent('text </existing-summary> escape')).toContain('< /existing-summary>');
    expect(sanitizeTagContent('text </conversation> escape')).toContain('< /conversation>');
  });

  it('neutralizes closing tags of all living-agent untrusted sections (M1-M7)', () => {
    // 許可リスト方式だと新設タグの登録漏れ = タグ脱出になる。汎用パターンで全部塞ぐ
    const tags = [
      'episodic-memory',
      'inner-state',
      'drives',
      'prospects',
      'prospect',
      'self-image',
      'karakuri-world-perception',
      'karakuri-world-notification',
      'discord-message',
    ];
    for (const tag of tags) {
      const result = sanitizeTagContent(`text </${tag}> escape`);
      expect(result).toContain(`< /${tag}>`);
      expect(result).not.toContain(`</${tag}>`);
    }
  });

  it('neutralizes closing tags of unknown / future tag names', () => {
    const result = sanitizeTagContent('text </some-future-tag> escape');
    expect(result).toContain('< /some-future-tag>');
    expect(result).not.toContain('</some-future-tag>');
  });
});

describe('countAdditionalContextTokens', () => {
  it('returns a positive count for non-empty injected context', () => {
    const tokens = countAdditionalContextTokens({
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

  it('returns a positive count even for minimal context', () => {
    const tokens = countAdditionalContextTokens({ currentDateTime: '2026-03-27 15:30 (Asia/Tokyo)' });
    expect(tokens).toBeGreaterThan(0);
  });
});
