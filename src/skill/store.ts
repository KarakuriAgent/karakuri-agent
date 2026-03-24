import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { readFileIfExists } from '../utils/file.js';
import { FileWatcher, type WatchDisposable } from '../utils/file-watcher.js';
import { createLogger } from '../utils/logger.js';
import { parseSkillMarkdown } from './frontmatter.js';
import type { ISkillStore, SkillDefinition, SkillFilterOptions } from './types.js';

const logger = createLogger('SkillStore');

const SKILL_FILE_NAME = 'SKILL.md';

export interface FileSkillStoreOptions {
  dataDir: string;
  watcher?: FileWatcher;
}

interface SkillSource {
  dir: string;
  systemOnly: boolean;
}

interface SkillDirectoryEntry {
  directory: string;
  systemOnly: boolean;
}

interface SkillLoadEntry extends SkillDirectoryEntry {
  skill: SkillDefinition | null;
  failed: boolean;
}

export class FileSkillStore implements ISkillStore {
  private readonly skillSources: SkillSource[];
  private readonly watcher: FileWatcher;
  private readonly ownsWatcher: boolean;
  private readonly childWatchers = new Map<string, WatchDisposable>();
  private readonly skills = new Map<string, SkillDefinition>();
  private readonly directoryToName = new Map<string, string>();
  private readonly rootWatchers: WatchDisposable[];
  private reloadGeneration = 0;

  private constructor({ skillSources, watcher }: { skillSources: SkillSource[]; watcher?: FileWatcher }) {
    this.skillSources = skillSources;
    this.watcher = watcher ?? new FileWatcher();
    this.ownsWatcher = watcher == null;
    this.rootWatchers = this.skillSources.map((source) =>
      this.watcher.watch(source.dir, () => this.reloadRuntime(), { debounceMs: 50 }),
    );
  }

  static async create(options: FileSkillStoreOptions): Promise<FileSkillStore> {
    const store = new FileSkillStore({
      skillSources: [
        { dir: join(options.dataDir, 'skills'), systemOnly: false },
        { dir: join(options.dataDir, 'system-skills'), systemOnly: true },
      ],
      ...(options.watcher != null ? { watcher: options.watcher } : {}),
    });

    try {
      await store.reloadStartup();
      logger.info('SkillStore initialized', { skillCount: store.skills.size });
      return store;
    } catch (error) {
      await store.close();
      throw error;
    }
  }

  async listSkills(options?: SkillFilterOptions): Promise<SkillDefinition[]> {
    return [...this.skills.values()]
      .filter((skill) => options?.includeSystemOnly === true || !skill.systemOnly)
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((skill) => ({ ...skill }));
  }

  async getSkill(name: string, options?: SkillFilterOptions): Promise<SkillDefinition | null> {
    const skill = this.skills.get(name);
    if (skill == null) {
      return null;
    }

    if (skill.systemOnly && options?.includeSystemOnly !== true) {
      return null;
    }

    return { ...skill };
  }

  async close(): Promise<void> {
    for (const disposable of this.rootWatchers) {
      disposable.unsubscribe();
    }
    for (const disposable of this.childWatchers.values()) {
      disposable.unsubscribe();
    }
    this.childWatchers.clear();

    if (this.ownsWatcher) {
      await this.watcher.close();
    }
    logger.debug('SkillStore closed');
  }

  private async reloadStartup(): Promise<void> {
    await this.reload({ failOnError: true });
  }

  private async reloadRuntime(): Promise<void> {
    try {
      await this.reload({ failOnError: false });
    } catch (error) {
      logger.warn('Failed to reload skills', error);
    }
  }

  private async reload({ failOnError }: { failOnError: boolean }): Promise<void> {
    const generation = ++this.reloadGeneration;
    const directoryEntries = (await Promise.all(
      this.skillSources.map(async (source) =>
        (await listSkillDirectories(source.dir)).map((directory) => ({
          directory,
          systemOnly: source.systemOnly,
        })),
      ),
    )).flat();

    if (generation !== this.reloadGeneration) {
      return;
    }

    this.syncChildWatchers(directoryEntries.map((entry) => entry.directory));

    const entries = await loadSkillEntries(directoryEntries, { failOnError });

    if (generation !== this.reloadGeneration) {
      return;
    }

    const loadedEntries = entries.filter(
      (entry): entry is SkillLoadEntry & { skill: SkillDefinition } => entry.skill != null,
    );
    ensureUniqueSkillNames(loadedEntries);

    this.applyEntries(entries, new Set(directoryEntries.map((entry) => entry.directory)));
    logger.debug('Skills reloaded', { skillCount: this.skills.size });
  }

  private applyEntries(entries: SkillLoadEntry[], currentDirectories: Set<string>): void {
    for (const [directory, name] of this.directoryToName) {
      if (!currentDirectories.has(directory)) {
        this.skills.delete(name);
        this.directoryToName.delete(directory);
      }
    }

    for (const entry of entries) {
      if (entry.skill != null) {
        const oldName = this.directoryToName.get(entry.directory);
        if (oldName != null && oldName !== entry.skill.name) {
          this.skills.delete(oldName);
        }
        this.skills.set(entry.skill.name, entry.skill);
        this.directoryToName.set(entry.directory, entry.skill.name);
      } else if (!entry.failed) {
        const oldName = this.directoryToName.get(entry.directory);
        if (oldName != null) {
          this.skills.delete(oldName);
          this.directoryToName.delete(entry.directory);
        }
      }
    }
  }

  private syncChildWatchers(skillDirectories: string[]): void {
    const nextDirectories = new Set(skillDirectories);

    for (const [directory, disposable] of this.childWatchers) {
      if (nextDirectories.has(directory)) {
        continue;
      }

      disposable.unsubscribe();
      this.childWatchers.delete(directory);
    }

    for (const directory of skillDirectories) {
      if (this.childWatchers.has(directory)) {
        continue;
      }

      this.childWatchers.set(
        directory,
        this.watcher.watch(directory, () => this.reloadRuntime(), {
          filenameFilter: /^SKILL\.md$/,
          debounceMs: 50,
        }),
      );
    }
  }
}

async function loadSkillEntries(
  directories: SkillDirectoryEntry[],
  { failOnError }: { failOnError: boolean },
): Promise<SkillLoadEntry[]> {
  return Promise.all(
    directories.map(async ({ directory, systemOnly }): Promise<SkillLoadEntry> => {
      const filePath = join(directory, SKILL_FILE_NAME);
      const markdown = await readFileIfExists(filePath);
      if (markdown == null) {
        return { directory, systemOnly, skill: null, failed: false };
      }

      try {
        return {
          directory,
          systemOnly,
          skill: { ...parseSkillMarkdown(markdown), systemOnly },
          failed: false,
        };
      } catch (error) {
        if (failOnError) {
          throw error;
        }
        logger.warn(`Skipping invalid SKILL.md in ${directory}`, error);
        return { directory, systemOnly, skill: null, failed: true };
      }
    }),
  );
}

async function listSkillDirectories(skillsDir: string): Promise<string[]> {
  try {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(skillsDir, entry.name))
      .sort();
  } catch (error) {
    const maybeError = error as NodeJS.ErrnoException | null;
    if (maybeError?.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

function ensureUniqueSkillNames(entries: Array<{ directory: string; skill: SkillDefinition }>): void {
  const seen = new Map<string, string>();

  for (const { directory, skill } of entries) {
    const existing = seen.get(skill.name);
    if (existing != null) {
      throw new Error(`Duplicate skill name "${skill.name}" found in ${existing} and ${directory}`);
    }

    seen.set(skill.name, directory);
  }
}
