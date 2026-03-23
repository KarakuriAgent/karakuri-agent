import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ModelMessage } from 'ai';
import { afterEach, describe, expect, it } from 'vitest';

import { FileSessionManager } from '../src/session/manager.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function userMessage(content: string): ModelMessage {
  return { role: 'user', content };
}

function assistantMessage(content: string): ModelMessage {
  return { role: 'assistant', content };
}

function assistantToolCallMessage(): ModelMessage {
  return {
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'recallDiary',
        input: { target: 'core' },
      },
    ],
  };
}

function toolResultMessage(): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'call-1',
        toolName: 'recallDiary',
        output: { type: 'text', value: 'saved' },
      },
    ],
  };
}

async function createManager(tokenBudget = 200) {
  const dataDir = await createDataDir();
  return new FileSessionManager({ dataDir, tokenBudget });
}

async function createDataDir() {
  const dataDir = await mkdtemp(join(tmpdir(), 'karakuri-session-'));
  temporaryDirectories.push(dataDir);
  return dataDir;
}

describe('FileSessionManager', () => {
  it('creates an empty session when no file exists', async () => {
    const manager = await createManager();

    const session = await manager.loadSession('thread-1');
    expect(session.sessionId).toBe('thread-1');
    expect(session.messages).toEqual([]);
    expect(session.summary).toBeNull();
  });

  it('adds messages and loads them back from disk', async () => {
    const manager = await createManager();

    await manager.addMessages('thread-1', [userMessage('hello'), assistantMessage('hi')]);

    const session = await manager.loadSession('thread-1');
    expect(session.messages).toEqual([userMessage('hello'), assistantMessage('hi')]);
  });

  it('throws when loading a session with an unsupported schema version', async () => {
    const dataDir = await createDataDir();
    const manager = new FileSessionManager({ dataDir, tokenBudget: 200 });

    await manager.saveSession({
      schemaVersion: 1,
      sessionId: 'thread-1',
      messages: [userMessage('hello')],
      summary: null,
      createdAt: new Date('2025-01-01T00:00:00.000Z').toISOString(),
      updatedAt: new Date('2025-01-01T00:00:00.000Z').toISOString(),
    });

    const sessionPath = join(
      dataDir,
      'sessions',
      `${createHash('sha256').update('thread-1').digest('base64url')}.json`,
    );

    await writeFile(sessionPath, JSON.stringify({
      schemaVersion: 99,
      sessionId: 'thread-1',
      messages: [userMessage('hello')],
      summary: null,
      createdAt: new Date('2025-01-01T00:00:00.000Z').toISOString(),
      updatedAt: new Date('2025-01-01T00:00:00.000Z').toISOString(),
    }));

    const restartedManager = new FileSessionManager({ dataDir, tokenBudget: 200 });

    await expect(restartedManager.loadSession('thread-1')).rejects.toThrow(
      'Unsupported session schema version',
    );
  });

  it('detects summarization needed when session messages alone exceed budget', async () => {
    const manager = await createManager(5);
    const session = await manager.addMessages('thread-1', [
      userMessage('a'.repeat(100)),
    ]);

    expect(manager.needsSummarization(session, 0)).toBe(true);
  });

  it('counts additional tokens when deciding whether summarization is needed', async () => {
    const manager = await createManager(5);
    const session = await manager.addMessages('thread-1', [userMessage('small')]);

    expect(manager.needsSummarization(session, 0)).toBe(false);
    expect(manager.needsSummarization(session, 10)).toBe(true);
  });

  it('saves and loads a session directly via saveSession', async () => {
    const manager = await createManager();
    const session = {
      schemaVersion: 1 as const,
      sessionId: 'thread-direct',
      messages: [userMessage('saved directly')],
      summary: 'test summary',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    };

    await manager.saveSession(session);
    const loaded = await manager.loadSession('thread-direct');
    expect(loaded.messages).toEqual([userMessage('saved directly')]);
    expect(loaded.summary).toBe('test summary');
  });

  it('returns defensive copies from the session cache', async () => {
    const manager = await createManager();

    await manager.saveSession({
      schemaVersion: 1,
      sessionId: 'thread-1',
      messages: [userMessage('hello')],
      summary: 'summary text',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    });

    const session = await manager.loadSession('thread-1');
    session.messages.push(assistantMessage('mutated'));
    session.summary = 'mutated summary';
    session.updatedAt = '2026-01-01T00:00:00.000Z';

    const reloaded = await manager.loadSession('thread-1');
    expect(reloaded.messages).toEqual([userMessage('hello')]);
    expect(reloaded.summary).toBe('summary text');
    expect(reloaded.updatedAt).toBe('2025-01-01T00:00:00.000Z');
  });

  it('appends messages without dropping concurrent addMessages calls', async () => {
    const manager = await createManager();

    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        manager.addMessages('thread-1', [userMessage(`msg-${i}`)]),
      ),
    );

    const session = await manager.loadSession('thread-1');
    expect(session.messages).toHaveLength(8);
  });

  it('keeps recent turns together when applying a summary', async () => {
    const manager = await createManager();

    await manager.addMessages('thread-1', [
      userMessage('first question'),
      assistantMessage('first answer'),
      userMessage('second question'),
      assistantToolCallMessage(),
      toolResultMessage(),
      assistantMessage('second answer'),
    ]);

    const updated = await manager.applySummary('thread-1', 'summary text', 1);

    expect(updated.summary).toBe('summary text');
    expect(updated.messages).toEqual([
      userMessage('second question'),
      assistantToolCallMessage(),
      toolResultMessage(),
      assistantMessage('second answer'),
    ]);
  });
});
