import type { ModelMessage } from 'ai';

export interface SessionData {
  schemaVersion: 1;
  sessionId: string;
  messages: ModelMessage[];
  summary: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PruneRepetitiveToolCallsResult {
  session: SessionData;
  prunedCount: number;
  prunedToolCallIds: string[];
}

export interface ISessionManager {
  loadSession(sessionId: string): Promise<SessionData>;
  saveSession(session: SessionData): Promise<void>;
  addMessages(sessionId: string, messages: ModelMessage[]): Promise<SessionData>;
  needsSummarization(session: SessionData, additionalTokens: number): boolean;
  applySummary(sessionId: string, summary: string, keepRecentTurns: number): Promise<SessionData>;
  pruneRepetitiveToolCalls(sessionId: string): Promise<PruneRepetitiveToolCallsResult>;
}
