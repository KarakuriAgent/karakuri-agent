import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { Lock, StateAdapter } from 'chat';

import { readFileIfExists, writeFileAtomically } from '../utils/file.js';
import { createLogger } from '../utils/logger.js';
import { KeyedMutex } from '../utils/mutex.js';

const logger = createLogger('FileState');

const STATE_FILE_SCHEMA_VERSION = 1 as const;
const DEFAULT_KEY_PREFIX = 'chat-sdk';
const STATE_FILE_NAME = 'chat-state.json';

interface StoredLock {
  expiresAt: number;
  token: string;
}

interface StoredCacheEntry {
  expiresAt: number | null;
  value: unknown;
}

interface StoredListEntry {
  expiresAt: number | null;
  value: unknown;
}

interface FileStateNamespace {
  cache: Record<string, StoredCacheEntry>;
  lists: Record<string, StoredListEntry[]>;
  locks: Record<string, StoredLock>;
  subscriptions: string[];
}

interface FileStateFile {
  namespaces: Record<string, FileStateNamespace>;
  schemaVersion: number;
}

interface StateResult<T> {
  changed?: boolean;
  result: T;
}

export interface CreateFileStateAdapterOptions {
  dataDir: string;
  keyPrefix?: string;
  mutex?: KeyedMutex;
}

export class FileStateAdapter implements StateAdapter {
  private readonly keyPrefix: string;
  private readonly mutex: KeyedMutex;
  private readonly stateFilePath: string;
  private connected = false;
  private connectPromise: Promise<void> | null = null;

  constructor({
    dataDir,
    keyPrefix = DEFAULT_KEY_PREFIX,
    mutex = new KeyedMutex(),
  }: CreateFileStateAdapterOptions) {
    this.keyPrefix = keyPrefix;
    this.mutex = mutex;
    this.stateFilePath = join(dataDir, 'state', STATE_FILE_NAME);
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    this.connectPromise ??= this.mutex.runExclusive(this.stateFilePath, async () => {
      const state = await this.readStateFile();
      const { namespace, created } = getOrCreateNamespace(state, this.keyPrefix);
      const expiredEntriesRemoved = pruneExpiredEntries(namespace);
      const staleLocksCleared = Object.keys(namespace.locks).length > 0;

      if (staleLocksCleared) {
        namespace.locks = {};
      }

      if (created || expiredEntriesRemoved || staleLocksCleared) {
        await this.writeStateFile(state);
      }

      this.connected = true;
      logger.debug('FileStateAdapter connected');
    }).catch((error) => {
      this.connectPromise = null;
      throw error;
    });

    try {
      await this.connectPromise;
    } finally {
      if (this.connected) {
        this.connectPromise = null;
      }
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.connectPromise = null;
    logger.debug('FileStateAdapter disconnected');
  }

  async subscribe(threadId: string): Promise<void> {
    await this.withState(async (namespace) => {
      if (namespace.subscriptions.includes(threadId)) {
        return { result: undefined };
      }

      namespace.subscriptions.push(threadId);
      namespace.subscriptions.sort();
      return {
        result: undefined,
        changed: true,
      };
    });
  }

  async unsubscribe(threadId: string): Promise<void> {
    await this.withState(async (namespace) => {
      const nextSubscriptions = namespace.subscriptions.filter((item) => item !== threadId);
      if (nextSubscriptions.length === namespace.subscriptions.length) {
        return { result: undefined };
      }

      namespace.subscriptions = nextSubscriptions;
      return {
        result: undefined,
        changed: true,
      };
    });
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    return this.withState(async (namespace) => ({
      result: namespace.subscriptions.includes(threadId),
    }));
  }

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    return this.withState(async (namespace) => {
      const current = namespace.locks[threadId];
      if (current != null) {
        return { result: null };
      }

      const lock: StoredLock = {
        token: `file_${randomUUID()}`,
        expiresAt: Date.now() + ttlMs,
      };
      namespace.locks[threadId] = lock;
      return {
        result: {
          threadId,
          token: lock.token,
          expiresAt: lock.expiresAt,
        },
        changed: true,
      };
    });
  }

  async forceReleaseLock(threadId: string): Promise<void> {
    await this.withState(async (namespace) => {
      if (namespace.locks[threadId] == null) {
        return { result: undefined };
      }

      delete namespace.locks[threadId];
      return {
        result: undefined,
        changed: true,
      };
    });
  }

  async releaseLock(lock: Lock): Promise<void> {
    await this.withState(async (namespace) => {
      const stored = namespace.locks[lock.threadId];
      if (stored?.token !== lock.token) {
        return { result: undefined };
      }

      delete namespace.locks[lock.threadId];
      return {
        result: undefined,
        changed: true,
      };
    });
  }

  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    return this.withState(async (namespace) => {
      const stored = namespace.locks[lock.threadId];
      if (stored == null || stored.token !== lock.token) {
        return { result: false };
      }

      stored.expiresAt = Date.now() + ttlMs;
      return {
        result: true,
        changed: true,
      };
    });
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    return this.withState(async (namespace) => ({
      result: (namespace.cache[key]?.value as T | undefined) ?? null,
    }));
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    await this.withState(async (namespace) => {
      namespace.cache[key] = {
        value,
        expiresAt: ttlMs == null ? null : Date.now() + ttlMs,
      };
      return {
        result: undefined,
        changed: true,
      };
    });
  }

  async setIfNotExists(key: string, value: unknown, ttlMs?: number): Promise<boolean> {
    return this.withState(async (namespace) => {
      if (namespace.cache[key] != null) {
        return { result: false };
      }

      namespace.cache[key] = {
        value,
        expiresAt: ttlMs == null ? null : Date.now() + ttlMs,
      };
      return {
        result: true,
        changed: true,
      };
    });
  }

  async delete(key: string): Promise<void> {
    await this.withState(async (namespace) => {
      if (namespace.cache[key] == null) {
        return { result: undefined };
      }

      delete namespace.cache[key];
      return {
        result: undefined,
        changed: true,
      };
    });
  }

  async appendToList(
    key: string,
    value: unknown,
    options?: {
      maxLength?: number;
      ttlMs?: number;
    },
  ): Promise<void> {
    await this.withState(async (namespace) => {
      const expiresAt = options?.ttlMs == null ? null : Date.now() + options.ttlMs;
      const existing = namespace.lists[key] ?? [];
      let nextEntries = [...existing, { value, expiresAt }];

      if (options?.maxLength != null) {
        nextEntries = nextEntries.slice(Math.max(nextEntries.length - options.maxLength, 0));
      }

      if (expiresAt != null) {
        nextEntries = nextEntries.map((entry) => ({
          ...entry,
          expiresAt,
        }));
      }

      if (nextEntries.length === 0) {
        delete namespace.lists[key];
      } else {
        namespace.lists[key] = nextEntries;
      }

      return {
        result: undefined,
        changed: true,
      };
    });
  }

  async getList<T = unknown>(key: string): Promise<T[]> {
    return this.withState(async (namespace) => ({
      result: (namespace.lists[key] ?? []).map((entry) => entry.value as T),
    }));
  }

  private async withState<T>(
    task: (namespace: FileStateNamespace) => Promise<StateResult<T>> | StateResult<T>,
  ): Promise<T> {
    this.ensureConnected();

    return this.mutex.runExclusive(this.stateFilePath, async () => {
      const state = await this.readStateFile();
      const { namespace, created } = getOrCreateNamespace(state, this.keyPrefix);
      const expiredEntriesRemoved = pruneExpiredEntries(namespace);
      const { result, changed = false } = await task(namespace);

      if (created || expiredEntriesRemoved || changed) {
        await this.writeStateFile(state);
      }

      return result;
    });
  }

  private async readStateFile(): Promise<FileStateFile> {
    const stored = await readFileIfExists(this.stateFilePath);

    if (stored == null) {
      return createEmptyStateFile();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stored);
    } catch (error) {
      throw new Error(`Invalid bot state JSON at ${this.stateFilePath}`, { cause: error });
    }

    return normalizeStateFile(parsed);
  }

  private async writeStateFile(state: FileStateFile): Promise<void> {
    await writeFileAtomically(this.stateFilePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  private ensureConnected(): void {
    if (!this.connected) {
      throw new Error('FileStateAdapter is not connected. Call connect() first.');
    }
  }
}

export function createFileStateAdapter(options: CreateFileStateAdapterOptions): FileStateAdapter {
  return new FileStateAdapter(options);
}

function createEmptyStateFile(): FileStateFile {
  return {
    schemaVersion: STATE_FILE_SCHEMA_VERSION,
    namespaces: {},
  };
}

function createEmptyNamespace(): FileStateNamespace {
  return {
    subscriptions: [],
    locks: {},
    cache: {},
    lists: {},
  };
}

function normalizeStateFile(raw: unknown): FileStateFile {
  if (!isRecord(raw)) {
    logger.warn('Bot state file has invalid structure, resetting to empty state');
    return createEmptyStateFile();
  }

  const schemaVersion = raw.schemaVersion;
  if (schemaVersion != null && schemaVersion !== STATE_FILE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported bot state schema version: ${schemaVersion}. Expected ${STATE_FILE_SCHEMA_VERSION}.`,
    );
  }

  const namespacesSource = isRecord(raw.namespaces) ? raw.namespaces : {};
  const namespaces: Record<string, FileStateNamespace> = {};

  for (const [name, namespace] of Object.entries(namespacesSource)) {
    namespaces[name] = normalizeNamespace(namespace);
  }

  return {
    schemaVersion: STATE_FILE_SCHEMA_VERSION,
    namespaces,
  };
}

function normalizeNamespace(raw: unknown): FileStateNamespace {
  if (!isRecord(raw)) {
    logger.warn('Bot state namespace has invalid structure, resetting to empty namespace');
    return createEmptyNamespace();
  }

  const subscriptions = Array.isArray(raw.subscriptions)
    ? Array.from(
        new Set(raw.subscriptions.filter((entry): entry is string => typeof entry === 'string')),
      ).sort()
    : [];

  const locksSource = isRecord(raw.locks) ? raw.locks : {};
  const locks: Record<string, StoredLock> = {};
  for (const [threadId, entry] of Object.entries(locksSource)) {
    const normalizedLock = normalizeLock(entry);
    if (normalizedLock != null) {
      locks[threadId] = normalizedLock;
    }
  }

  const cacheSource = isRecord(raw.cache) ? raw.cache : {};
  const cache: Record<string, StoredCacheEntry> = {};
  for (const [key, entry] of Object.entries(cacheSource)) {
    const normalizedEntry = normalizeCacheEntry(entry);
    if (normalizedEntry != null) {
      cache[key] = normalizedEntry;
    }
  }

  const listsSource = isRecord(raw.lists) ? raw.lists : {};
  const lists: Record<string, StoredListEntry[]> = {};
  for (const [key, entry] of Object.entries(listsSource)) {
    if (!Array.isArray(entry)) {
      continue;
    }

    const normalizedEntries = entry
      .map((listEntry) => normalizeListEntry(listEntry))
      .filter((listEntry): listEntry is StoredListEntry => listEntry != null);

    if (normalizedEntries.length > 0) {
      lists[key] = normalizedEntries;
    }
  }

  return {
    subscriptions,
    locks,
    cache,
    lists,
  };
}

function normalizeLock(raw: unknown): StoredLock | null {
  if (!isRecord(raw) || typeof raw.token !== 'string') {
    return null;
  }

  const expiresAt = asNullableNumber(raw.expiresAt);
  if (expiresAt == null) {
    return null;
  }

  return {
    token: raw.token,
    expiresAt,
  };
}

function normalizeCacheEntry(raw: unknown): StoredCacheEntry | null {
  if (!isRecord(raw) || !('value' in raw)) {
    return null;
  }

  return {
    value: raw.value,
    expiresAt: asNullableNumber(raw.expiresAt),
  };
}

function normalizeListEntry(raw: unknown): StoredListEntry | null {
  if (!isRecord(raw) || !('value' in raw)) {
    return null;
  }

  return {
    value: raw.value,
    expiresAt: asNullableNumber(raw.expiresAt),
  };
}

function getOrCreateNamespace(
  state: FileStateFile,
  keyPrefix: string,
): { created: boolean; namespace: FileStateNamespace } {
  const existing = state.namespaces[keyPrefix];
  if (existing != null) {
    return {
      namespace: existing,
      created: false,
    };
  }

  const namespace = createEmptyNamespace();
  state.namespaces[keyPrefix] = namespace;
  return {
    namespace,
    created: true,
  };
}

function pruneExpiredEntries(namespace: FileStateNamespace): boolean {
  const now = Date.now();
  let changed = false;

  for (const [threadId, lock] of Object.entries(namespace.locks)) {
    if (lock.expiresAt <= now) {
      delete namespace.locks[threadId];
      changed = true;
    }
  }

  for (const [key, entry] of Object.entries(namespace.cache)) {
    if (entry.expiresAt != null && entry.expiresAt <= now) {
      delete namespace.cache[key];
      changed = true;
    }
  }

  for (const [key, entries] of Object.entries(namespace.lists)) {
    const activeEntries = entries.filter(
      (entry) => entry.expiresAt == null || entry.expiresAt > now,
    );

    if (activeEntries.length === entries.length) {
      continue;
    }

    changed = true;
    if (activeEntries.length === 0) {
      delete namespace.lists[key];
    } else {
      namespace.lists[key] = activeEntries;
    }
  }

  return changed;
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

