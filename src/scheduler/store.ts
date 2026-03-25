import { readdir, rm, rmdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { isMissingFileError, readFileIfExists, writeFileAtomically } from '../utils/file.js';
import { FileWatcher, type WatchDisposable } from '../utils/file-watcher.js';
import { createLogger } from '../utils/logger.js';
import { CRON_JOB_NAME_PATTERN, parseCronMarkdown, renderCronMarkdown } from './frontmatter.js';
import type { CronJobDefinition, ISchedulerStore, RegisterCronJobInput, SchedulerReloadListener } from './types.js';

const logger = createLogger('SchedulerStore');

const HEARTBEAT_FILE_NAME = 'HEARTBEAT.md';
const CRON_FILE_NAME = 'CRON.md';

interface CronLoadEntry {
  directory: string;
  job: CronJobDefinition | null;
  failed: boolean;
}

export interface FileSchedulerStoreOptions {
  dataDir: string;
  watcher?: FileWatcher;
}

export class FileSchedulerStore implements ISchedulerStore {
  private readonly dataDir: string;
  private readonly heartbeatPath: string;
  private readonly cronDir: string;
  private readonly watcher: FileWatcher;
  private readonly ownsWatcher: boolean;
  private readonly dataWatcher: WatchDisposable;
  private readonly cronRootWatcher: WatchDisposable;
  private readonly childWatchers = new Map<string, WatchDisposable>();
  private readonly cronJobs = new Map<string, CronJobDefinition>();
  private readonly directoryToName = new Map<string, string>();
  private heartbeatInstructions: string | null = null;
  private reloadGeneration = 0;
  private reloadListener: SchedulerReloadListener | undefined;

  private constructor({ dataDir, watcher }: FileSchedulerStoreOptions) {
    this.dataDir = dataDir;
    this.heartbeatPath = join(dataDir, HEARTBEAT_FILE_NAME);
    this.cronDir = join(dataDir, 'cron');
    this.watcher = watcher ?? new FileWatcher();
    this.ownsWatcher = watcher == null;
    this.dataWatcher = this.watcher.watch(this.dataDir, () => this.reloadRuntime(), {
      filenameFilter: /^HEARTBEAT\.md$/,
      debounceMs: 50,
    });
    this.cronRootWatcher = this.watcher.watch(this.cronDir, () => this.reloadRuntime(), {
      debounceMs: 50,
    });
  }

  static async create(options: FileSchedulerStoreOptions): Promise<FileSchedulerStore> {
    const store = new FileSchedulerStore(options);

    try {
      await store.reload();
      logger.info('SchedulerStore initialized', {
        hasHeartbeat: store.heartbeatInstructions != null,
        cronJobCount: store.cronJobs.size,
      });
      return store;
    } catch (error) {
      await store.close();
      throw error;
    }
  }

  async readHeartbeatInstructions(): Promise<string | null> {
    return this.heartbeatInstructions;
  }

  async listCronJobs(): Promise<CronJobDefinition[]> {
    return [...this.cronJobs.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((job) => ({ ...job }));
  }

  setReloadListener(listener: SchedulerReloadListener | undefined): void {
    this.reloadListener = listener;
  }

  async registerJob(input: RegisterCronJobInput): Promise<CronJobDefinition> {
    const name = input.name.trim();
    if (!CRON_JOB_NAME_PATTERN.test(name)) {
      throw new Error('Cron job name must match /^[a-z0-9][a-z0-9-]*$/');
    }

    const markdown = renderCronMarkdown({
      name,
      schedule: input.schedule.trim(),
      instructions: input.instructions.trim(),
      enabled: input.enabled ?? true,
      sessionMode: input.sessionMode ?? 'isolated',
      staggerMs: input.staggerMs ?? 0,
      oneshot: input.oneshot ?? false,
    });
    const definition = parseCronMarkdown(name, markdown);
    const directory = join(this.cronDir, name);
    await writeFileAtomically(join(directory, CRON_FILE_NAME), markdown);

    this.cronJobs.set(name, definition);
    this.directoryToName.set(directory, name);
    this.syncChildWatchers([...new Set([...this.childWatchers.keys(), directory])].sort());
    await this.notifyReloadSafely();
    return { ...definition };
  }

  async unregisterJob(name: string): Promise<boolean> {
    const normalizedName = name.trim();
    if (!CRON_JOB_NAME_PATTERN.test(normalizedName)) {
      throw new Error('Cron job name must match /^[a-z0-9][a-z0-9-]*$/');
    }

    const directory = join(this.cronDir, normalizedName);
    const filePath = join(directory, CRON_FILE_NAME);
    let removed = false;

    try {
      await rm(filePath);
      removed = true;
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error;
      }
    }

    let directoryRemoved = false;
    try {
      await rmdir(directory);
      directoryRemoved = true;
    } catch (error) {
      const maybeError = error as NodeJS.ErrnoException | null;
      if (maybeError?.code === 'ENOENT') {
        directoryRemoved = true;
      } else if (maybeError?.code !== 'ENOTEMPTY') {
        throw error;
      }
    }

    this.cronJobs.delete(normalizedName);
    this.directoryToName.delete(directory);
    if (directoryRemoved) {
      const watcher = this.childWatchers.get(directory);
      if (watcher != null) {
        watcher.unsubscribe();
        this.childWatchers.delete(directory);
      }
    }

    if (removed) {
      await this.notifyReloadSafely();
    }

    return removed;
  }

  async close(): Promise<void> {
    this.dataWatcher.unsubscribe();
    this.cronRootWatcher.unsubscribe();
    for (const watcher of this.childWatchers.values()) {
      watcher.unsubscribe();
    }
    this.childWatchers.clear();

    if (this.ownsWatcher) {
      await this.watcher.close();
    }
    logger.debug('SchedulerStore closed');
  }

  private async reloadRuntime(): Promise<void> {
    try {
      await this.reload();
    } catch (error) {
      logger.warn('Failed to reload scheduler definitions', error);
    }
  }

  private async reload(): Promise<void> {
    const generation = ++this.reloadGeneration;
    const [heartbeatInstructions, directories] = await Promise.all([
      readInstructionsFile(this.heartbeatPath),
      listCronDirectories(this.cronDir),
    ]);

    if (generation !== this.reloadGeneration) {
      return;
    }

    this.syncChildWatchers(directories);

    const entries = await loadCronEntries(directories);
    if (generation !== this.reloadGeneration) {
      return;
    }

    this.heartbeatInstructions = heartbeatInstructions;
    this.applyEntries(entries, new Set(directories));
    logger.debug('Scheduler definitions reloaded', {
      hasHeartbeat: this.heartbeatInstructions != null,
      cronJobCount: this.cronJobs.size,
    });
    await this.notifyReload();
  }

  private applyEntries(entries: CronLoadEntry[], currentDirectories: Set<string>): void {
    for (const [directory, name] of this.directoryToName) {
      if (!currentDirectories.has(directory)) {
        this.cronJobs.delete(name);
        this.directoryToName.delete(directory);
      }
    }

    for (const entry of entries) {
      if (entry.job != null) {
        this.cronJobs.set(entry.job.name, entry.job);
        this.directoryToName.set(entry.directory, entry.job.name);
      } else {
        const oldName = this.directoryToName.get(entry.directory);
        if (oldName != null) {
          this.cronJobs.delete(oldName);
          this.directoryToName.delete(entry.directory);
        }
      }
    }
  }

  private syncChildWatchers(directories: string[]): void {
    const nextDirectories = new Set(directories);

    for (const [directory, watcher] of this.childWatchers) {
      if (nextDirectories.has(directory)) {
        continue;
      }

      watcher.unsubscribe();
      this.childWatchers.delete(directory);
    }

    for (const directory of directories) {
      if (this.childWatchers.has(directory)) {
        continue;
      }

      this.childWatchers.set(
        directory,
        this.watcher.watch(directory, () => this.reloadRuntime(), {
          filenameFilter: /^CRON\.md$/,
          debounceMs: 50,
        }),
      );
    }
  }

  private async notifyReloadSafely(): Promise<void> {
    try {
      await this.notifyReload();
    } catch (error) {
      logger.warn('Reload listener failed after store mutation', error);
    }
  }

  private async notifyReload(): Promise<void> {
    if (this.reloadListener == null) {
      return;
    }

    await this.reloadListener({
      heartbeatInstructions: this.heartbeatInstructions,
      cronJobs: await this.listCronJobs(),
    });
  }
}

async function readInstructionsFile(path: string): Promise<string | null> {
  const content = await readFileIfExists(path);
  const normalized = content?.trim();
  return normalized != null && normalized.length > 0 ? normalized : null;
}

async function loadCronEntries(directories: string[]): Promise<CronLoadEntry[]> {
  return Promise.all(
    directories.map(async (directory): Promise<CronLoadEntry> => {
      const markdown = await readFileIfExists(join(directory, CRON_FILE_NAME));
      if (markdown == null) {
        return { directory, job: null, failed: false };
      }

      try {
        return {
          directory,
          job: parseCronMarkdown(basename(directory), markdown),
          failed: false,
        };
      } catch (error) {
        logger.warn(`Skipping invalid CRON.md in ${directory}`, error);
        return { directory, job: null, failed: true };
      }
    }),
  );
}

async function listCronDirectories(cronDir: string): Promise<string[]> {
  try {
    const entries = await readdir(cronDir, { withFileTypes: true });
    return entries
      .filter((entry) => {
        if (!entry.isDirectory()) {
          return false;
        }

        if (!CRON_JOB_NAME_PATTERN.test(entry.name)) {
          logger.warn(`Ignoring invalid cron job directory: ${entry.name}`);
          return false;
        }

        return true;
      })
      .map((entry) => join(cronDir, entry.name))
      .sort();
  } catch (error) {
    const maybeError = error as NodeJS.ErrnoException | null;
    if (maybeError?.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}
