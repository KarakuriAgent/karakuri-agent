import type { ModelMessage } from 'ai';

const AVERAGE_CHARACTERS_PER_TOKEN = 4;

export function serializeForTokenCounting(value: unknown): string {
  if (value == null) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => serializeForTokenCounting(item)).join('\n');
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;

    if (typeof record.role === 'string' && 'content' in record) {
      return `${record.role}: ${serializeForTokenCounting(record.content)}`;
    }

    if (record.type === 'text' && typeof record.text === 'string') {
      return record.text;
    }

    if (record.type === 'tool-call') {
      return `tool-call ${JSON.stringify({
        toolCallId: record.toolCallId,
        toolName: record.toolName,
        input: record.input,
      })}`;
    }

    if (record.type === 'tool-result') {
      return `tool-result ${JSON.stringify({
        toolCallId: record.toolCallId,
        toolName: record.toolName,
        output: record.output,
      })}`;
    }

    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  return String(value);
}

export function estimateTokenCount(value: unknown): number {
  const text = serializeForTokenCounting(value).trim();
  if (text.length === 0) {
    return 0;
  }

  return Math.ceil(text.length / AVERAGE_CHARACTERS_PER_TOKEN);
}

export function estimateMessageTokens(messages: ModelMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateTokenCount(message), 0);
}
