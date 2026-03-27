import { createHash } from 'node:crypto';
import { join } from 'node:path';

import type { ModelMessage } from 'ai';

import { readFileIfExists, writeFileAtomically } from '../utils/file.js';
import { createLogger } from '../utils/logger.js';
import { KeyedMutex } from '../utils/mutex.js';
import { estimateMessageTokens, estimateTokenCount } from '../utils/token-counter.js';
import type { ISessionManager, SessionData } from './types.js';

const logger = createLogger('SessionManager');

export const SESSION_SCHEMA_VERSION = 1 as const;

export interface FileSessionManagerOptions {
  dataDir: string;
  tokenBudget: number;
  mutex?: KeyedMutex;
}

export class FileSessionManager implements ISessionManager {
  private readonly sessionsDir: string;
  private readonly tokenBudget: number;
  private readonly mutex: KeyedMutex;
  private readonly sessionCache = new Map<string, SessionData>();

  constructor({ dataDir, tokenBudget, mutex = new KeyedMutex() }: FileSessionManagerOptions) {
    this.sessionsDir = join(dataDir, 'sessions');
    this.tokenBudget = tokenBudget;
    this.mutex = mutex;
  }

  async loadSession(sessionId: string): Promise<SessionData> {
    const cached = this.sessionCache.get(sessionId);
    if (cached != null) {
      logger.debug('Session cache hit', { sessionId });
      return structuredClone(cached);
    }

    const sessionPath = this.getSessionPath(sessionId);
    const stored = await readFileIfExists(sessionPath);

    if (stored == null) {
      logger.debug('New session created', { sessionId });
      return createEmptySession(sessionId);
    }

    const parsed = JSON.parse(stored) as Partial<SessionData>;
    assertSupportedSchemaVersion(parsed.schemaVersion);
    const normalized = normalizeSession(parsed, sessionId);
    this.sessionCache.set(sessionId, normalized);
    logger.debug('Session loaded from disk', { sessionId });
    return structuredClone(normalized);
  }

  async saveSession(session: SessionData): Promise<void> {
    const sessionPath = this.getSessionPath(session.sessionId);

    await this.mutex.runExclusive(sessionPath, async () => {
      await this.writeSessionFile(session);
    });
  }

  async addMessages(sessionId: string, messages: ModelMessage[]): Promise<SessionData> {
    if (messages.length === 0) {
      return this.loadSession(sessionId);
    }

    const sessionPath = this.getSessionPath(sessionId);
    return this.mutex.runExclusive(sessionPath, async () => {
      const session = await this.loadSession(sessionId);
      const updated: SessionData = {
        ...session,
        messages: [...session.messages, ...messages],
        updatedAt: new Date().toISOString(),
      };

      await this.writeSessionFile(updated);
      logger.debug('Messages added to session', { sessionId, count: messages.length });
      return updated;
    });
  }

  needsSummarization(session: SessionData, additionalTokens: number): boolean {
    const summaryTokens = estimateTokenCount(session.summary ?? '');
    const messageTokens = estimateMessageTokens(session.messages);
    const result = summaryTokens + messageTokens + Math.max(additionalTokens, 0) > this.tokenBudget;
    logger.debug('needsSummarization', { sessionId: session.sessionId, summaryTokens, messageTokens, additionalTokens, budget: this.tokenBudget, result });
    return result;
  }

  async applySummary(
    sessionId: string,
    summary: string,
    keepRecentTurns: number,
  ): Promise<SessionData> {
    const sessionPath = this.getSessionPath(sessionId);

    return this.mutex.runExclusive(sessionPath, async () => {
      const session = await this.loadSession(sessionId);
      const turns = groupMessagesIntoTurns(session.messages);
      const retainedMessages = turns.slice(Math.max(turns.length - keepRecentTurns, 0)).flat();
      const updated: SessionData = {
        ...session,
        summary,
        messages: retainedMessages,
        updatedAt: new Date().toISOString(),
      };

      await this.writeSessionFile(updated);
      logger.debug('Summary applied', { sessionId, retainedMessages: retainedMessages.length, summaryLength: summary.length });
      return updated;
    });
  }

  private getSessionPath(sessionId: string): string {
    return join(this.sessionsDir, `${hashSessionId(sessionId)}.json`);
  }

  private async writeSessionFile(session: SessionData): Promise<void> {
    const sessionPath = this.getSessionPath(session.sessionId);
    const normalized = normalizeSession(session, session.sessionId);
    await writeFileAtomically(sessionPath, `${JSON.stringify(normalized, null, 2)}\n`);
    this.sessionCache.set(session.sessionId, structuredClone(normalized));
  }
}

function createEmptySession(sessionId: string): SessionData {
  const now = new Date().toISOString();
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    sessionId,
    messages: [],
    summary: null,
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeSession(raw: Partial<SessionData>, sessionId: string): SessionData {
  const empty = createEmptySession(sessionId);

  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    sessionId,
    messages: Array.isArray(raw.messages) ? raw.messages : [],
    summary: typeof raw.summary === 'string' ? raw.summary : null,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : empty.createdAt,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : empty.updatedAt,
  };
}

function assertSupportedSchemaVersion(schemaVersion: Partial<SessionData>['schemaVersion']): void {
  if (schemaVersion != null && schemaVersion !== SESSION_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported session schema version: ${schemaVersion}. Expected ${SESSION_SCHEMA_VERSION}.`,
    );
  }
}

function groupMessagesIntoTurns(messages: ModelMessage[]): ModelMessage[][] {
  const turns: ModelMessage[][] = [];
  let currentTurn: ModelMessage[] = [];

  for (const message of messages) {
    if (message.role === 'user' && currentTurn.length > 0) {
      turns.push(currentTurn);
      currentTurn = [message];
      continue;
    }

    currentTurn.push(message);
  }

  if (currentTurn.length > 0) {
    turns.push(currentTurn);
  }

  return turns;
}


function hashSessionId(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('base64url');
}
