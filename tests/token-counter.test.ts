import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';

import {
  estimateMessageTokens,
  estimateTokenCount,
  serializeForTokenCounting,
} from '../src/utils/token-counter.js';

describe('serializeForTokenCounting', () => {
  it('returns empty string for null and undefined', () => {
    expect(serializeForTokenCounting(null)).toBe('');
    expect(serializeForTokenCounting(undefined)).toBe('');
  });

  it('returns the string as-is for string input', () => {
    expect(serializeForTokenCounting('hello world')).toBe('hello world');
  });

  it('converts primitives to string', () => {
    expect(serializeForTokenCounting(42)).toBe('42');
    expect(serializeForTokenCounting(true)).toBe('true');
    expect(serializeForTokenCounting(BigInt(99))).toBe('99');
  });

  it('converts Date to ISO string', () => {
    const date = new Date('2025-06-15T12:00:00.000Z');
    expect(serializeForTokenCounting(date)).toBe('2025-06-15T12:00:00.000Z');
  });

  it('joins array elements with newlines', () => {
    expect(serializeForTokenCounting(['a', 'b'])).toBe('a\nb');
  });

  it('serializes a message-like object as role: content', () => {
    expect(serializeForTokenCounting({ role: 'user', content: 'hi' })).toBe('user: hi');
  });

  it('extracts text from a text part', () => {
    expect(serializeForTokenCounting({ type: 'text', text: 'hello' })).toBe('hello');
  });

  it('serializes tool-call parts', () => {
    const part = {
      type: 'tool-call',
      toolCallId: 'c1',
      toolName: 'save',
      input: { x: 1 },
    };
    const result = serializeForTokenCounting(part);
    expect(result).toContain('tool-call');
    expect(result).toContain('"toolName":"save"');
  });

  it('serializes tool-result parts', () => {
    const part = {
      type: 'tool-result',
      toolCallId: 'c1',
      toolName: 'save',
      output: { ok: true },
    };
    const result = serializeForTokenCounting(part);
    expect(result).toContain('tool-result');
    expect(result).toContain('"toolName":"save"');
  });

  it('falls back to JSON.stringify for generic objects', () => {
    expect(serializeForTokenCounting({ foo: 'bar' })).toBe('{"foo":"bar"}');
  });
});

describe('estimateTokenCount', () => {
  it('returns 0 for empty or null input', () => {
    expect(estimateTokenCount('')).toBe(0);
    expect(estimateTokenCount(null)).toBe(0);
  });

  it('estimates roughly 1 token per 4 characters', () => {
    const text = 'a'.repeat(100);
    expect(estimateTokenCount(text)).toBe(25);
  });

  it('rounds up for non-divisible lengths', () => {
    expect(estimateTokenCount('hi')).toBe(1);
  });
});

describe('estimateMessageTokens', () => {
  it('sums token estimates across messages', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'a'.repeat(40) },
      { role: 'assistant', content: 'b'.repeat(40) },
    ];
    const total = estimateMessageTokens(messages);
    expect(total).toBeGreaterThan(0);
    expect(total).toBe(
      estimateTokenCount(messages[0]!) + estimateTokenCount(messages[1]!),
    );
  });

  it('returns 0 for empty array', () => {
    expect(estimateMessageTokens([])).toBe(0);
  });
});
