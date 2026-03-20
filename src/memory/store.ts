import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { formatDateInTimezone } from '../utils/date.js';
import { isMissingFileError, readFileIfExists, writeFileAtomically } from '../utils/file.js';
import { KeyedMutex } from '../utils/mutex.js';
import type { DiaryEntry, IMemoryStore } from './types.js';

const DIARY_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.md$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface FileMemoryStoreOptions {
  dataDir: string;
  timezone?: string;
  mutex?: KeyedMutex;
}

export class FileMemoryStore implements IMemoryStore {
  private readonly coreMemoryPath: string;
  private readonly diaryDir: string;
  private readonly timezone: string;
  private readonly mutex: KeyedMutex;

  constructor({ dataDir, timezone = 'Asia/Tokyo', mutex = new KeyedMutex() }: FileMemoryStoreOptions) {
    this.coreMemoryPath = join(dataDir, 'memory', 'core', 'memory.md');
    this.diaryDir = join(dataDir, 'memory', 'diary');
    this.timezone = timezone;
    this.mutex = mutex;
  }

  async readCoreMemory(): Promise<string> {
    return (await readFileIfExists(this.coreMemoryPath)) ?? '';
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
    });
  }

  async readDiary(date: string): Promise<string | null> {
    const diaryPath = this.getDiaryPath(date);
    return readFileIfExists(diaryPath);
  }

  async writeDiary(date: string, content: string): Promise<void> {
    const diaryPath = this.getDiaryPath(date);
    const normalizedContent = content.trim();

    if (normalizedContent.length === 0) {
      return;
    }

    await this.mutex.runExclusive(diaryPath, async () => {
      const current = (await readFileIfExists(diaryPath)) ?? '';
      const next = appendContent(current, normalizedContent);
      await writeFileAtomically(diaryPath, next);
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

    return diaries.filter((entry) => entry.content.length > 0);
  }

  async listDiaryDates(): Promise<string[]> {
    try {
      const entries = await readdir(this.diaryDir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile())
        .map((entry) => DIARY_FILE_PATTERN.exec(entry.name)?.[1])
        .filter((date): date is string => date != null)
        .sort();
    } catch (error) {
      if (isMissingFileError(error)) {
        return [];
      }

      throw error;
    }
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

