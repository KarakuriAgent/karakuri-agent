import { describe, expect, it } from 'vitest';

import {
  buildDiarySection,
  buildMemorySection,
  buildSummarySection,
  buildSystemPrompt,
  countAdditionalContextTokens,
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
  it('composes all sections in order', () => {
    const result = buildSystemPrompt({
      coreMemory: 'fact',
      recentDiaries: [{ date: '2025-01-01', content: 'note' }],
      summary: 'prev summary',
    });

    const memoryIndex = result.indexOf('<memory>');
    const diaryIndex = result.indexOf('<diary>');
    const summaryIndex = result.indexOf('<summary>');
    const toolIndex = result.indexOf('Available tools:');

    expect(memoryIndex).toBeGreaterThan(0);
    expect(diaryIndex).toBeGreaterThan(memoryIndex);
    expect(summaryIndex).toBeGreaterThan(diaryIndex);
    expect(toolIndex).toBeGreaterThan(summaryIndex);
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
    ]);
    expect(tokens).toBeGreaterThan(0);
  });

  it('returns a positive count even for empty memory (tag overhead)', () => {
    const tokens = countAdditionalContextTokens('', []);
    expect(tokens).toBeGreaterThan(0);
  });
});
