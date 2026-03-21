import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { formatDateInTimezone } from '../utils/date.js';
import { isMissingFileError, readFileIfExists, writeFileAtomically } from '../utils/file.js';
import { FileWatcher } from '../utils/file-watcher.js';
import { createLogger } from '../utils/logger.js';
import { KeyedMutex } from '../utils/mutex.js';
import type { DiaryEntry, IMemoryStore } from './types.js';

const logger = createLogger('MemoryStore');

const DIARY_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.md$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface FileMemoryStoreOptions {
  dataDir: string;
  timezone?: string;
  mutex?: KeyedMutex;
  watcher?: FileWatcher;
}

export class FileMemoryStore implements IMemoryStore {
  private readonly coreDir: string;
  private readonly coreMemoryPath: string;
  private readonly diaryDir: string;
  private readonly timezone: string;
  private readonly mutex: KeyedMutex;
  private readonly watcher: FileWatcher;
  private readonly ownsWatcher: boolean;
  private coreMemoryCache: string | undefined;
  private readonly diaryContentCache = new Map<string, string | null>();
  private diaryDatesCache: string[] | undefined;
  private readonly coreWatchDisposable;
  private readonly diaryWatchDisposable;
  private coreReloadGeneration = 0;

  constructor({
    dataDir,
    timezone = 'Asia/Tokyo',
    mutex = new KeyedMutex(),
    watcher,
  }: FileMemoryStoreOptions) {
    this.coreDir = join(dataDir, 'memory', 'core');
    this.coreMemoryPath = join(this.coreDir, 'memory.md');
    this.diaryDir = join(dataDir, 'memory', 'diary');
    this.timezone = timezone;
    this.mutex = mutex;
    this.watcher = watcher ?? new FileWatcher();
    this.ownsWatcher = watcher == null;
    this.coreWatchDisposable = this.watcher.watch(this.coreDir, () => this.reloadCoreMemory(), {
      filenameFilter: /^memory\.md$/,
      debounceMs: 50,
    });
    this.diaryWatchDisposable = this.watcher.watch(this.diaryDir, async () => {
      this.diaryContentCache.clear();
      this.diaryDatesCache = undefined;
    }, {
      filenameFilter: DIARY_FILE_PATTERN,
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

  async readDiary(date: string): Promise<string | null> {
    const cached = this.diaryContentCache.get(date);
    if (cached !== undefined) {
      return cached;
    }

    const diaryPath = this.getDiaryPath(date);
    const content = await readFileIfExists(diaryPath);
    this.diaryContentCache.set(date, content);
    return content;
  }

  async writeDiary(date: string, content: string): Promise<void> {
    const diaryPath = this.getDiaryPath(date);
    const normalizedContent = content.trim();

    if (normalizedContent.length === 0) {
      return;
    }

    await this.mutex.runExclusive(diaryPath, async () => {
      const current = (await this.readDiary(date)) ?? '';
      const next = appendContent(current, normalizedContent);
      await writeFileAtomically(diaryPath, next);
      this.diaryContentCache.set(date, next);
      logger.debug('Diary written', { date, contentLength: normalizedContent.length });

      if (this.diaryDatesCache != null && !this.diaryDatesCache.includes(date)) {
        this.diaryDatesCache = [...this.diaryDatesCache, date].sort();
      }
    });
  }

  async getRecentDiaries(days: number): Promise<DiaryEntry[]> {
    if (days <= 0) {
      return [];
    }

    const { cutoffDate, todayDate } = getRecentDateRange(days, this.timezone);
    const allDates = (await this.listDiaryDates()).sort();
    const recentDates = allDates.filter((date) => date >= cutoffDate && date <= todayDate);

    const diaries = await Promise.all(
      recentDates.map(async (date) => ({
        date,
        content: (await this.readDiary(date)) ?? '',
      })),
    );

    const result = diaries.filter((entry) => entry.content.length > 0);
    logger.debug('getRecentDiaries', { days, matchedCount: result.length });
    return result;
  }

  async listDiaryDates(): Promise<string[]> {
    if (this.diaryDatesCache != null) {
      return [...this.diaryDatesCache];
    }

    try {
      const entries = await readdir(this.diaryDir, { withFileTypes: true });
      const dates = entries
        .filter((entry) => entry.isFile())
        .map((entry) => DIARY_FILE_PATTERN.exec(entry.name)?.[1])
        .filter((date): date is string => date != null)
        .sort();
      this.diaryDatesCache = dates;
      return [...dates];
    } catch (error) {
      if (isMissingFileError(error)) {
        this.diaryDatesCache = [];
        return [];
      }

      throw error;
    }
  }

  async close(): Promise<void> {
    this.coreWatchDisposable.unsubscribe();
    this.diaryWatchDisposable.unsubscribe();

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

  private getDiaryPath(date: string): string {
    if (!ISO_DATE_PATTERN.test(date)) {
      throw new Error(`Invalid diary date: ${date}`);
    }

    return join(this.diaryDir, `${date}.md`);
  }
}

function getRecentDateRange(days: number, timezone: string): { cutoffDate: string; todayDate: string } {
  const now = new Date();
  const todayDate = formatDateInTimezone(now, timezone);

  const year = Number(todayDate.slice(0, 4));
  const month = Number(todayDate.slice(5, 7));
  const day = Number(todayDate.slice(8, 10));
  const cutoffLocal = new Date(year, month - 1, day - (days - 1));

  const cy = String(cutoffLocal.getFullYear());
  const cm = String(cutoffLocal.getMonth() + 1).padStart(2, '0');
  const cd = String(cutoffLocal.getDate()).padStart(2, '0');

  return { cutoffDate: `${cy}-${cm}-${cd}`, todayDate };
}

function appendContent(existing: string, entry: string): string {
  if (existing.trim().length === 0) {
    return `${entry}\n`;
  }

  const separator = existing.endsWith('\n') ? '\n' : '\n\n';
  return `${existing}${separator}${entry}\n`;
}
