import { join } from 'node:path';

import { readFileIfExists, writeFileAtomically } from '../utils/file.js';
import { FileWatcher } from '../utils/file-watcher.js';
import { createLogger } from '../utils/logger.js';
import { KeyedMutex } from '../utils/mutex.js';
import type { ICoreMemoryStore } from './types.js';

const logger = createLogger('MemoryStore');

export interface FileMemoryStoreOptions {
  dataDir: string;
  mutex?: KeyedMutex;
  watcher?: FileWatcher;
}

export class FileMemoryStore implements ICoreMemoryStore {
  private readonly coreDir: string;
  private readonly coreMemoryPath: string;
  private readonly mutex: KeyedMutex;
  private readonly watcher: FileWatcher;
  private readonly ownsWatcher: boolean;
  private coreMemoryCache: string | undefined;
  private readonly coreWatchDisposable;
  private coreReloadGeneration = 0;

  constructor({
    dataDir,
    mutex = new KeyedMutex(),
    watcher,
  }: FileMemoryStoreOptions) {
    this.coreDir = join(dataDir, 'memory', 'core');
    this.coreMemoryPath = join(this.coreDir, 'memory.md');
    this.mutex = mutex;
    this.watcher = watcher ?? new FileWatcher();
    this.ownsWatcher = watcher == null;
    this.coreWatchDisposable = this.watcher.watch(this.coreDir, () => this.reloadCoreMemory(), {
      filenameFilter: /^memory\.md$/,
      debounceMs: 50,
    });
  }

  async readCoreMemory(): Promise<string> {
    if (this.coreMemoryCache !== undefined) {
      return this.coreMemoryCache;
    }

    const content = (await readFileIfExists(this.coreMemoryPath)) ?? '';
    this.coreMemoryCache = content;
    return content;
  }

  async writeCoreMemory(content: string, mode: 'append'): Promise<void> {
    if (mode !== 'append') {
      throw new Error(`Unsupported core memory write mode: ${mode}`);
    }

    const normalizedContent = content.trim();
    if (normalizedContent.length === 0) {
      return;
    }

    await this.mutex.runExclusive(this.coreMemoryPath, async () => {
      const current = await this.readCoreMemory();
      const next = appendContent(current, normalizedContent);
      await writeFileAtomically(this.coreMemoryPath, next);
      this.coreMemoryCache = next;
      logger.debug('Core memory appended', { contentLength: normalizedContent.length });
    });
  }

  async close(): Promise<void> {
    this.coreWatchDisposable.unsubscribe();

    if (this.ownsWatcher) {
      await this.watcher.close();
    }
    logger.debug('MemoryStore closed');
  }

  private async reloadCoreMemory(): Promise<void> {
    const generation = ++this.coreReloadGeneration;
    await this.mutex.runExclusive(this.coreMemoryPath, async () => {
      if (generation !== this.coreReloadGeneration) {
        return;
      }

      const content = (await readFileIfExists(this.coreMemoryPath)) ?? '';
      this.coreMemoryCache = content;
      logger.debug('Core memory reloaded from disk');
    });
  }
}

function appendContent(existing: string, entry: string): string {
  if (existing.trim().length === 0) {
    return `${entry}\n`;
  }

  const separator = existing.endsWith('\n') ? '\n' : '\n\n';
  return `${existing}${separator}${entry}\n`;
}
