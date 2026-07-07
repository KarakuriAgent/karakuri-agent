import { APICallError } from 'ai';
import { describe, expect, it } from 'vitest';

import { isRepetitiveToolCallError } from '../src/llm/repetitive-tool-call-error.js';

function makeApiCallError(overrides: { message?: string; statusCode?: number; responseBody?: string } = {}): APICallError {
  return new APICallError({
    message: overrides.message ?? 'Repetitive tool calls detected in the conversation history.',
    url: 'https://example.com',
    requestBodyValues: {},
    statusCode: overrides.statusCode ?? 400,
    ...(overrides.responseBody != null ? { responseBody: overrides.responseBody } : {}),
  });
}

describe('isRepetitiveToolCallError', () => {
  it('returns true for a 400 APICallError mentioning repetitive tool calls', () => {
    expect(isRepetitiveToolCallError(makeApiCallError())).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isRepetitiveToolCallError(makeApiCallError({ message: 'REPETITIVE TOOL CALL detected' }))).toBe(true);
  });

  it('returns true when the phrase is only in responseBody', () => {
    const error = makeApiCallError({
      message: 'Bad request',
      responseBody: JSON.stringify({ error: 'Repetitive tool call detected' }),
    });
    expect(isRepetitiveToolCallError(error)).toBe(true);
  });

  it('returns false when statusCode is not 400', () => {
    expect(isRepetitiveToolCallError(makeApiCallError({ statusCode: 500 }))).toBe(false);
  });

  it('returns false when the message does not mention repetitive tool calls', () => {
    expect(isRepetitiveToolCallError(makeApiCallError({ message: 'Some other invalid parameter' }))).toBe(false);
  });

  it('returns false for a plain Error', () => {
    expect(isRepetitiveToolCallError(new Error('Repetitive tool calls detected'))).toBe(false);
  });
});
