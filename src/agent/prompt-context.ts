import { join } from 'node:path';

import { readFileIfExists } from '../utils/file.js';
import { FileWatcher } from '../utils/file-watcher.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('PromptContext');

export interface PromptContext {
  agentInstructions: string | null;
  rules: string | null;
}

export interface IPromptContextStore {
  read(): Promise<PromptContext>;
  close(): Promise<void>;
}

export interface FilePromptContextStoreOptions {
  dataDir: string;
  watcher?: FileWatcher;
}

export class FilePromptContextStore implements IPromptContextStore {
  private readonly agentPath: string;
  private readonly rulesPath: string;
  private readonly watcher: FileWatcher;
  private readonly ownsWatcher: boolean;
  private readonly watchDisposable;
  private context: PromptContext = {
    agentInstructions: null,
    rules: null,
  };
  private reloadGeneration = 0;

  private constructor({ dataDir, watcher }: FilePromptContextStoreOptions) {
    this.agentPath = join(dataDir, 'AGENT.md');
    this.rulesPath = join(dataDir, 'RULES.md');
    this.watcher = watcher ?? new FileWatcher();
    this.ownsWatcher = watcher == null;
    this.watchDisposable = this.watcher.watch(dataDir, () => this.reloadRuntime(), {
      filenameFilter: /^(AGENT|RULES)\.md$/,
      debounceMs: 50,
    });
  }

  static async create(options: FilePromptContextStoreOptions): Promise<FilePromptContextStore> {
    const store = new FilePromptContextStore(options);
    await store.reload({ failOnError: true });
    logger.info('PromptContextStore initialized', { hasAgent: store.context.agentInstructions != null, hasRules: store.context.rules != null });
    return store;
  }

  async read(): Promise<PromptContext> {
    return { ...this.context };
  }

  async close(): Promise<void> {
    this.watchDisposable.unsubscribe();
    if (this.ownsWatcher) {
      await this.watcher.close();
    }
    logger.debug('PromptContextStore closed');
  }

  private async reloadRuntime(): Promise<void> {
    try {
      await this.reload({ failOnError: false });
    } catch (error) {
      logger.warn('Failed to reload prompt context', error);
    }
  }

  private async reload({ failOnError }: { failOnError: boolean }): Promise<void> {
    const generation = ++this.reloadGeneration;

    const [agentInstructions, rules] = await Promise.all([
      readPromptFile(this.agentPath),
      readPromptFile(this.rulesPath),
    ]);

    if (generation !== this.reloadGeneration) {
      return;
    }

    this.context = {
      agentInstructions,
      rules,
    };
    logger.debug('Prompt context reloaded');
  }
}

async function readPromptFile(path: string): Promise<string | null> {
  const content = await readFileIfExists(path);
  const normalized = content?.trim();
  return normalized != null && normalized.length > 0 ? normalized : null;
}
