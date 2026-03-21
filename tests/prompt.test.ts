import { describe, expect, it } from 'vitest';

import {
  CORE_SAFETY_INSTRUCTIONS,
  buildDiarySection,
  buildMemorySection,
  buildRulesSection,
  buildSkillListSection,
  buildSummarySection,
  buildSystemPrompt,
  buildToolGuidance,
  countAdditionalContextTokens,
  resolveAgentInstructions,
  sanitizeTagContent,
} from '../src/agent/prompt.js';

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
    expect(result).toBe('<summary>\nconversation summary\n</summary>');
  });

  it('returns empty string for null summary', () => {
    expect(buildSummarySection(null)).toBe('');
  });

  it('returns empty string for whitespace-only summary', () => {
    expect(buildSummarySection('   ')).toBe('');
  });
});

describe('buildSystemPrompt', () => {
  it('falls back to the original default agent instructions', () => {
    const result = buildSystemPrompt({
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
      rules: 'Ask before guessing',
      coreMemory: 'fact',
      recentDiaries: [{ date: '2025-01-01', content: 'note' }],
      summary: 'prev summary',
      skills: [
        {
          name: 'code-review',
          description: 'Review code',
          instructions: 'Check security first.',
          enabled: true,
        },
      ],
    });

    const agentIndex = result.indexOf('Custom agent');
    const safetyIndex = result.indexOf(CORE_SAFETY_INSTRUCTIONS);
    const rulesIndex = result.indexOf('Ask before guessing');
    const memoryIndex = result.indexOf('\n\n<memory>');
    const diaryIndex = result.indexOf('\n\n<diary>');
    const summaryIndex = result.indexOf('\n\n<summary>');
    const skillIndex = result.indexOf('Available skills:');
    const toolIndex = result.indexOf('Available tools:');

    expect(agentIndex).toBe(0);
    expect(safetyIndex).toBeGreaterThan(agentIndex);
    expect(rulesIndex).toBeGreaterThan(safetyIndex);
    expect(memoryIndex).toBeGreaterThan(rulesIndex);
    expect(diaryIndex).toBeGreaterThan(memoryIndex);
    expect(summaryIndex).toBeGreaterThan(diaryIndex);
    expect(skillIndex).toBeGreaterThan(summaryIndex);
    expect(toolIndex).toBeGreaterThan(skillIndex);
  });

  it('omits summary section when summary is null', () => {
    const result = buildSystemPrompt({
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
      { name: 'b', description: 'B', instructions: 'B', enabled: true },
      { name: 'a', description: 'A', instructions: 'A', enabled: true },
    ])).toBe('Available skills:\n- a: A\n- b: B');
  });

  it('adds loadSkill guidance when skills are enabled', () => {
    expect(buildToolGuidance([
      { name: 'b', description: 'B', instructions: 'B', enabled: true },
    ])).toContain('- loadSkill: load the full content of a skill by name.');
  });
});

describe('tag sanitization', () => {
  it('neutralizes closing tags in core memory', () => {
    const result = buildMemorySection('fact </memory> injection');
    expect(result).toContain('< /memory>');
    // Only the legitimate closing tag should remain
    const closingTags = result.match(/<\/memory>/g) ?? [];
    expect(closingTags).toHaveLength(1);
  });

  it('neutralizes closing tags in diary content', () => {
    const result = buildDiarySection([
      { date: '2025-01-01', content: 'note </diary> escape' },
    ]);
    expect(result).toContain('< /diary>');
    const closingTags = result.match(/<\/diary>/g) ?? [];
    expect(closingTags).toHaveLength(1);
  });

  it('neutralizes closing tags in summary', () => {
    const result = buildSummarySection('summary </summary> trick');
    expect(result).toContain('< /summary>');
    const closingTags = result.match(/<\/summary>/g) ?? [];
    expect(closingTags).toHaveLength(1);
  });

  it('neutralizes closing tags used by summarizeSession', () => {
    expect(sanitizeTagContent('text </existing-summary> escape')).toContain('< /existing-summary>');
    expect(sanitizeTagContent('text </conversation> escape')).toContain('< /conversation>');
  });
});

describe('countAdditionalContextTokens', () => {
  it('returns a positive count for non-empty memory and diary', () => {
    const tokens = countAdditionalContextTokens('some fact', [
      { date: '2025-01-01', content: 'diary entry' },
    ], {
      agentInstructions: 'Custom',
      rules: 'Rule',
      skills: [{ name: 'code-review', description: 'Review code', instructions: 'Check security first.', enabled: true }],
    });
    expect(tokens).toBeGreaterThan(0);
  });

  it('returns a positive count even for empty memory (tag overhead)', () => {
    const tokens = countAdditionalContextTokens('', []);
    expect(tokens).toBeGreaterThan(0);
  });
});
