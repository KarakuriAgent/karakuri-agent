import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { readFileIfExists } from '../utils/file.js';
import { FileWatcher, type WatchDisposable } from '../utils/file-watcher.js';
import { createLogger } from '../utils/logger.js';
import { parseSkillMarkdown } from './frontmatter.js';
import type { ISkillStore, SkillDefinition } from './types.js';

const logger = createLogger('SkillStore');

const SKILL_FILE_NAME = 'SKILL.md';

export interface FileSkillStoreOptions {
  dataDir: string;
  watcher?: FileWatcher;
}

interface SkillLoadEntry {
  directory: string;
  skill: SkillDefinition | null;
  failed: boolean;
}

export class FileSkillStore implements ISkillStore {
  private readonly skillsDir: string;
  private readonly watcher: FileWatcher;
  private readonly ownsWatcher: boolean;
  private readonly childWatchers = new Map<string, WatchDisposable>();
  private readonly skills = new Map<string, SkillDefinition>();
  private readonly directoryToName = new Map<string, string>();
  private readonly rootWatcher: WatchDisposable;
  private reloadGeneration = 0;

  private constructor({ skillsDir, watcher }: { skillsDir: string; watcher?: FileWatcher }) {
    this.skillsDir = skillsDir;
    this.watcher = watcher ?? new FileWatcher();
    this.ownsWatcher = watcher == null;
    this.rootWatcher = this.watcher.watch(this.skillsDir, () => this.reloadRuntime(), { debounceMs: 50 });
  }

  static async create(options: FileSkillStoreOptions): Promise<FileSkillStore> {
    const store = new FileSkillStore({
      skillsDir: join(options.dataDir, 'skills'),
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

  async listSkills(): Promise<SkillDefinition[]> {
    return [...this.skills.values()]
      .filter((skill) => skill.enabled)
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((skill) => ({ ...skill }));
  }

  async getSkill(name: string): Promise<SkillDefinition | null> {
    const skill = this.skills.get(name);
    if (skill == null || !skill.enabled) {
      return null;
    }

    return { ...skill };
  }

  async close(): Promise<void> {
    this.rootWatcher.unsubscribe();
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
    const directories = await listSkillDirectories(this.skillsDir);

    if (generation !== this.reloadGeneration) {
      return;
    }

    this.syncChildWatchers(directories);

    const entries = await loadSkillEntries(directories, { failOnError });

    if (generation !== this.reloadGeneration) {
      return;
    }

    const parsedSkills = entries
      .map((entry) => entry.skill)
      .filter((skill): skill is SkillDefinition => skill != null);
    ensureUniqueSkillNames(parsedSkills);

    this.applyEntries(entries, new Set(directories));
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
  directories: string[],
  { failOnError }: { failOnError: boolean },
): Promise<SkillLoadEntry[]> {
  return Promise.all(
    directories.map(async (directory): Promise<SkillLoadEntry> => {
      const filePath = join(directory, SKILL_FILE_NAME);
      const markdown = await readFileIfExists(filePath);
      if (markdown == null) {
        return { directory, skill: null, failed: false };
      }

      try {
        return { directory, skill: parseSkillMarkdown(markdown), failed: false };
      } catch (error) {
        if (failOnError) {
          throw error;
        }
        logger.warn(`Skipping invalid SKILL.md in ${directory}`, error);
        return { directory, skill: null, failed: true };
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

function ensureUniqueSkillNames(skills: SkillDefinition[]): SkillDefinition[] {
  const names = new Set<string>();

  for (const skill of skills) {
    if (names.has(skill.name)) {
      throw new Error(`Duplicate skill name: ${skill.name}`);
    }

    names.add(skill.name);
  }

  return skills;
}
