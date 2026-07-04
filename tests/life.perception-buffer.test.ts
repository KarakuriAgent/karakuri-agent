import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SqliteExperienceLogStore } from '../src/life/experience-log.js';
import { PerceptionBuffer, routeKwNotification } from '../src/life/perception-buffer.js';
import { EVENT_KINDS } from '../src/life/types.js';

const temporaryDirectories: string[] = [];
const stores: SqliteExperienceLogStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createStore(): Promise<SqliteExperienceLogStore> {
  const dataDir = join(process.cwd(), '.test-artifacts', `karakuri-perception-${randomUUID()}`);
  await mkdir(dataDir, { recursive: true });
  temporaryDirectories.push(dataDir);
  const store = new SqliteExperienceLogStore({ dataDir });
  stores.push(store);
  return store;
}

describe('routeKwNotification', () => {
  it('routes state notifications to buffer only', () => {
    expect(routeKwNotification(EVENT_KINDS.worldEvent)).toBe('buffer_only');
  });

  it('keeps conversation notifications in history (multi-turn conversations)', () => {
    expect(routeKwNotification(EVENT_KINDS.conversation)).toBe('history');
  });

  it('defaults unknown kinds to history', () => {
    expect(routeKwNotification(EVENT_KINDS.unknown)).toBe('history');
  });
});

describe('PerceptionBuffer', () => {
  it('keeps only the latest entry per channel', () => {
    const buffer = new PerceptionBuffer();
    buffer.update('kw:bot-1', { snapshot: 1 }, new Date('2026-07-05T10:00:00.000Z'));
    buffer.update('kw:bot-1', { snapshot: 2 }, new Date('2026-07-05T11:00:00.000Z'));
    buffer.update('kw:bot-2', { snapshot: 'other' }, new Date('2026-07-05T11:00:00.000Z'));

    expect(buffer.getLatest('kw:bot-1')?.payload).toEqual({ snapshot: 2 });
    expect(buffer.getLatest('kw:bot-2')?.payload).toEqual({ snapshot: 'other' });
    expect(buffer.getLatest('kw:bot-3')).toBeNull();
  });

  it('restores the latest world_event notification from the experience log', async () => {
    const store = await createStore();
    await store.append({
      receivedAt: new Date('2026-07-05T10:00:00.000Z'),
      channel: 'kw:bot-1',
      kind: EVENT_KINDS.worldEvent,
      payload: { notification: { kind: 'idle_reminder', snapshot: 'old' } },
    });
    await store.append({
      receivedAt: new Date('2026-07-05T11:00:00.000Z'),
      channel: 'kw:bot-1',
      kind: EVENT_KINDS.worldEvent,
      payload: { notification: { kind: 'idle_reminder', snapshot: 'latest' } },
    });
    // own_action や会話イベントは復元対象にならない
    await store.append({
      receivedAt: new Date('2026-07-05T12:00:00.000Z'),
      channel: 'kw:bot-1',
      kind: EVENT_KINDS.ownAction,
      payload: { command: 'move', params: {} },
    });

    const buffer = new PerceptionBuffer();
    const restored = await buffer.restoreChannel(store, 'kw:bot-1');

    expect(restored).toBe(true);
    expect(buffer.getLatest('kw:bot-1')?.payload).toEqual({
      notification: { kind: 'idle_reminder', snapshot: 'latest' },
    });
    expect(buffer.getLatest('kw:bot-1')?.receivedAt.toISOString()).toBe('2026-07-05T11:00:00.000Z');
  });

  it('returns false when no state notification exists', async () => {
    const store = await createStore();
    const buffer = new PerceptionBuffer();
    expect(await buffer.restoreChannel(store, 'kw:bot-1')).toBe(false);
    expect(buffer.getLatest('kw:bot-1')).toBeNull();
  });

  it('does not overwrite an already-populated channel on restore', async () => {
    const store = await createStore();
    await store.append({
      receivedAt: new Date('2026-07-05T10:00:00.000Z'),
      channel: 'kw:bot-1',
      kind: EVENT_KINDS.worldEvent,
      payload: { snapshot: 'from-log' },
    });

    const buffer = new PerceptionBuffer();
    buffer.update('kw:bot-1', { snapshot: 'live' }, new Date('2026-07-05T12:00:00.000Z'));
    expect(await buffer.restoreChannel(store, 'kw:bot-1')).toBe(true);
    expect(buffer.getLatest('kw:bot-1')?.payload).toEqual({ snapshot: 'live' });
  });
});
