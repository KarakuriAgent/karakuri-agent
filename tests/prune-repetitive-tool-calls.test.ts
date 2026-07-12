import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';

import { pruneRepetitiveToolCallsFromMessages } from '../src/session/prune-repetitive-tool-calls.js';

function userMessage(content: string): ModelMessage {
  return { role: 'user', content };
}

function assistantToolCallMessage(
  toolCallId: string,
  toolName = 'recallEpisodes',
  input: unknown = { target: 'core' },
): ModelMessage {
  return { role: 'assistant', content: [{ type: 'tool-call', toolCallId, toolName, input }] };
}

function toolResultMessage(toolCallId: string, toolName = 'recallEpisodes'): ModelMessage {
  return {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId, toolName, output: { type: 'text', value: 'saved' } }],
  };
}

describe('pruneRepetitiveToolCallsFromMessages', () => {
  it('returns the original array reference when there are no duplicates', () => {
    const messages = [
      userMessage('hi'),
      assistantToolCallMessage('call-1'),
      toolResultMessage('call-1'),
    ];

    const result = pruneRepetitiveToolCallsFromMessages(messages);

    expect(result.prunedCount).toBe(0);
    expect(result.prunedToolCallIds).toEqual([]);
    expect(result.messages).toBe(messages);
  });

  it('removes the older pair when the same tool-call is repeated once', () => {
    const messages = [
      userMessage('one'),
      assistantToolCallMessage('call-1'),
      toolResultMessage('call-1'),
      userMessage('two'),
      assistantToolCallMessage('call-2'),
      toolResultMessage('call-2'),
    ];

    const result = pruneRepetitiveToolCallsFromMessages(messages);

    expect(result.prunedCount).toBe(1);
    expect(result.prunedToolCallIds).toEqual(['call-1']);
    expect(result.messages).toEqual([
      userMessage('one'),
      userMessage('two'),
      assistantToolCallMessage('call-2'),
      toolResultMessage('call-2'),
    ]);
  });

  it('keeps only the latest occurrence when the same tool-call repeats three or more times', () => {
    const messages = [
      assistantToolCallMessage('call-1'),
      toolResultMessage('call-1'),
      assistantToolCallMessage('call-2'),
      toolResultMessage('call-2'),
      assistantToolCallMessage('call-3'),
      toolResultMessage('call-3'),
    ];

    const result = pruneRepetitiveToolCallsFromMessages(messages);

    expect(result.prunedCount).toBe(2);
    expect(result.prunedToolCallIds).toEqual(['call-1', 'call-2']);
    expect(result.messages).toEqual([assistantToolCallMessage('call-3'), toolResultMessage('call-3')]);
  });

  it('keeps text parts on an assistant message while removing only the duplicated tool-call part', () => {
    const messages: ModelMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'checking...' },
          { type: 'tool-call', toolCallId: 'call-1', toolName: 'recallEpisodes', input: { target: 'core' } },
        ],
      },
      toolResultMessage('call-1'),
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'checking again...' },
          { type: 'tool-call', toolCallId: 'call-2', toolName: 'recallEpisodes', input: { target: 'core' } },
        ],
      },
      toolResultMessage('call-2'),
    ];

    const result = pruneRepetitiveToolCallsFromMessages(messages);

    expect(result.prunedCount).toBe(1);
    expect(result.messages[0]).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'checking...' }],
    });
    expect(result.messages).toHaveLength(3);
  });

  it('tracks distinct signatures independently', () => {
    const messages = [
      assistantToolCallMessage('call-1', 'recallEpisodes', { target: 'core' }),
      toolResultMessage('call-1'),
      assistantToolCallMessage('call-2', 'webFetch', { url: 'https://example.com' }),
      toolResultMessage('call-2', 'webFetch'),
      assistantToolCallMessage('call-3', 'recallEpisodes', { target: 'core' }),
      toolResultMessage('call-3'),
      assistantToolCallMessage('call-4', 'webFetch', { url: 'https://example.com' }),
      toolResultMessage('call-4', 'webFetch'),
    ];

    const result = pruneRepetitiveToolCallsFromMessages(messages);

    expect(result.prunedToolCallIds.sort()).toEqual(['call-1', 'call-2']);
    expect(result.messages).toEqual([
      assistantToolCallMessage('call-3', 'recallEpisodes', { target: 'core' }),
      toolResultMessage('call-3'),
      assistantToolCallMessage('call-4', 'webFetch', { url: 'https://example.com' }),
      toolResultMessage('call-4', 'webFetch'),
    ]);
  });

  it('treats input key order as equivalent when building the duplicate signature', () => {
    const messages = [
      assistantToolCallMessage('call-1', 'recallEpisodes', { a: 1, b: 2 }),
      toolResultMessage('call-1'),
      assistantToolCallMessage('call-2', 'recallEpisodes', { b: 2, a: 1 }),
      toolResultMessage('call-2'),
    ];

    const result = pruneRepetitiveToolCallsFromMessages(messages);

    expect(result.prunedCount).toBe(1);
    expect(result.prunedToolCallIds).toEqual(['call-1']);
  });

  it('treats different array element order in input as a distinct signature', () => {
    const messages = [
      assistantToolCallMessage('call-1', 'recallEpisodes', { ids: [1, 2] }),
      toolResultMessage('call-1'),
      assistantToolCallMessage('call-2', 'recallEpisodes', { ids: [2, 1] }),
      toolResultMessage('call-2'),
    ];

    const result = pruneRepetitiveToolCallsFromMessages(messages);

    expect(result.prunedCount).toBe(0);
  });

  it('does not treat calls with the same toolCallId-independent name/input as duplicates when toolName differs', () => {
    const messages = [
      assistantToolCallMessage('call-1', 'recallEpisodes', { target: 'core' }),
      toolResultMessage('call-1'),
      assistantToolCallMessage('call-2', 'webFetch', { target: 'core' }),
      toolResultMessage('call-2', 'webFetch'),
    ];

    const result = pruneRepetitiveToolCallsFromMessages(messages);

    expect(result.prunedCount).toBe(0);
  });

  it('does not crash when a duplicated tool-call has no matching tool-result in history', () => {
    const messages = [
      assistantToolCallMessage('call-1'),
      assistantToolCallMessage('call-2'),
    ];

    const result = pruneRepetitiveToolCallsFromMessages(messages);

    expect(result.prunedCount).toBe(1);
    expect(result.prunedToolCallIds).toEqual(['call-1']);
    expect(result.messages).toEqual([assistantToolCallMessage('call-2')]);
  });

  it('passes through user, system, and string-content assistant messages untouched', () => {
    const messages: ModelMessage[] = [
      { role: 'system', content: 'be helpful' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello there' },
    ];

    const result = pruneRepetitiveToolCallsFromMessages(messages);

    expect(result.prunedCount).toBe(0);
    expect(result.messages).toBe(messages);
  });
});
