import type { ModelMessage } from 'ai';

export interface PruneToolCallsResult {
  messages: ModelMessage[];
  prunedCount: number;
  prunedToolCallIds: string[];
}

/**
 * DashScope 等が「同一 tool-call の連続」を検知して拒否するのを避けるため、
 * 履歴中で同一署名（toolName + input）の tool-call が複数回出現する場合に
 * 最新の1件だけを残し、古い方の tool-call/tool-result ペアを toolCallId 単位で除去する。
 */
export function pruneRepetitiveToolCallsFromMessages(messages: ModelMessage[]): PruneToolCallsResult {
  const occurrences: Array<{ toolCallId: string; signature: string }> = [];
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== 'tool-call') continue;
      occurrences.push({
        toolCallId: part.toolCallId,
        signature: `${part.toolName}\u0000${stableStringify(part.input)}`,
      });
    }
  }

  const idsBySignature = new Map<string, string[]>();
  for (const occurrence of occurrences) {
    const ids = idsBySignature.get(occurrence.signature) ?? [];
    ids.push(occurrence.toolCallId);
    idsBySignature.set(occurrence.signature, ids);
  }

  const idsToRemove = new Set<string>();
  for (const ids of idsBySignature.values()) {
    if (ids.length < 2) continue;
    for (const id of ids.slice(0, -1)) idsToRemove.add(id);
  }

  if (idsToRemove.size === 0) {
    return { messages, prunedCount: 0, prunedToolCallIds: [] };
  }

  const nextMessages: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      const filtered = message.content.filter((part) =>
        !((part.type === 'tool-call' || part.type === 'tool-result') && idsToRemove.has(part.toolCallId)));
      if (filtered.length === 0) continue;
      nextMessages.push(filtered.length === message.content.length ? message : { ...message, content: filtered });
      continue;
    }
    if (message.role === 'tool' && Array.isArray(message.content)) {
      const filtered = message.content.filter((part) => !(part.type === 'tool-result' && idsToRemove.has(part.toolCallId)));
      if (filtered.length === 0) continue;
      nextMessages.push(filtered.length === message.content.length ? message : { ...message, content: filtered });
      continue;
    }
    nextMessages.push(message);
  }

  return { messages: nextMessages, prunedCount: idsToRemove.size, prunedToolCallIds: [...idsToRemove] };
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value)) ?? 'null';
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (typeof value === 'object' && value != null) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, sortKeysDeep(record[key])]),
    );
  }
  return value;
}
