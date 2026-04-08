import { type Dirent, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { formatDateInTimezone } from '../utils/date.js';
import { createLogger } from '../utils/logger.js';
import type { DiaryEntry, IDiaryStore } from './types.js';

const logger = createLogger('SqliteDiaryStore');
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const LEGACY_DIARY_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.md$/;

interface SqliteDiaryStoreOptions {
  dataDir: string;
  timezone?: string;
}

interface DiaryContentRow {
  content: string;
}

interface DiaryEntryRow {
  date: string;
  content: string;
}

interface DiaryDateRow {
  date: string;
}

export class SqliteDiaryStore implements IDiaryStore {
  private readonly db: Database.Database;
  private readonly timezone: string;
  private readonly readDiaryStatement: Database.Statement<[string], DiaryContentRow>;
  private readonly writeDiaryStatement: Database.Statement<[string, string, string]>;
  private readonly deleteDiaryStatement: Database.Statement<[string]>;
  private readonly getRecentDiariesStatement: Database.Statement<[string, string], DiaryEntryRow>;
  private readonly listDiaryDatesStatement: Database.Statement<[], DiaryDateRow>;
  private readonly hasLegacyImportStatement: Database.Statement<[string], { imported: 1 }>;
  private readonly markLegacyImportStatement: Database.Statement<[string, string]>;
  private readonly replaceDiaryTransaction: (date: string, content: string, createdAt: string) => void;

  constructor({ dataDir, timezone = 'Asia/Tokyo' }: SqliteDiaryStoreOptions) {
    const dbPath = join(dataDir, 'diary.db');
    try {
      mkdirSync(dataDir, { recursive: true });
      this.db = new Database(dbPath);
    } catch (error) {
      throw new Error(`Failed to open diary database at ${dbPath}: ${error instanceof Error ? error.message : error}`);
    }

    try {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS diary_entries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          date TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS legacy_diary_imports (
          date TEXT PRIMARY KEY,
          imported_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_diary_entries_date ON diary_entries(date);
      `);

      this.timezone = timezone;
      this.readDiaryStatement = this.db.prepare<[string], DiaryContentRow>(`
        SELECT content
        FROM diary_entries
        WHERE date = ?
        ORDER BY id ASC
      `);
      this.writeDiaryStatement = this.db.prepare(`
        INSERT INTO diary_entries (date, content, created_at)
        VALUES (?, ?, ?)
      `);
      this.deleteDiaryStatement = this.db.prepare('DELETE FROM diary_entries WHERE date = ?');
      this.getRecentDiariesStatement = this.db.prepare<[string, string], DiaryEntryRow>(`
        SELECT date, content
        FROM diary_entries
        WHERE date >= ? AND date <= ?
        ORDER BY date ASC, id ASC
      `);
      this.listDiaryDatesStatement = this.db.prepare<[], DiaryDateRow>(`
        SELECT DISTINCT date
        FROM diary_entries
        ORDER BY date ASC
      `);
      this.hasLegacyImportStatement = this.db.prepare<[string], { imported: 1 }>(`
        SELECT 1 AS imported
        FROM legacy_diary_imports
        WHERE date = ?
      `);
      this.markLegacyImportStatement = this.db.prepare(`
        INSERT OR IGNORE INTO legacy_diary_imports (date, imported_at)
        VALUES (?, ?)
      `);
      this.replaceDiaryTransaction = this.db.transaction((date: string, content: string, createdAt: string) => {
        this.deleteDiaryStatement.run(date);
        this.writeDiaryStatement.run(date, content, createdAt);
      });
      this.importLegacyDiaryFiles(join(dataDir, 'memory', 'diary'));
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  async readDiary(date: string): Promise<string | null> {
    assertIsoDate(date);
    const rows = this.readDiaryStatement.all(date);
    if (rows.length === 0) {
      return null;
    }

    return rows.map((row) => row.content).join('\n\n');
  }

  async writeDiary(date: string, content: string): Promise<void> {
    assertIsoDate(date);
    const normalizedContent = content.trim();
    if (normalizedContent.length === 0) {
      return;
    }

    this.writeDiaryStatement.run(date, normalizedContent, new Date().toISOString());
    logger.debug('Diary written', { date, contentLength: normalizedContent.length });
    return Promise.resolve();
  }

  async replaceDiary(date: string, content: string): Promise<void> {
    assertIsoDate(date);
    const normalizedContent = content.trim();
    if (normalizedContent.length === 0) {
      await this.deleteDiary(date);
      return;
    }

    this.replaceDiaryTransaction(date, normalizedContent, new Date().toISOString());
    logger.debug('Diary replaced', { date, contentLength: normalizedContent.length });
    return Promise.resolve();
  }

  async deleteDiary(date: string): Promise<boolean> {
    assertIsoDate(date);
    const result = this.deleteDiaryStatement.run(date);
    logger.debug('Diary deleted', { date, deleted: result.changes > 0 });
    return Promise.resolve(result.changes > 0);
  }

  async getRecentDiaries(days: number): Promise<DiaryEntry[]> {
    if (days <= 0) {
      return [];
    }

    const { cutoffDate, todayDate } = getRecentDateRange(days, this.timezone);
    const rows = this.getRecentDiariesStatement.all(cutoffDate, todayDate);
    const groupedEntries = new Map<string, string[]>();

    for (const row of rows) {
      const normalizedContent = row.content.trim();
      if (normalizedContent.length === 0) {
        continue;
      }

      const entries = groupedEntries.get(row.date);
      if (entries == null) {
        groupedEntries.set(row.date, [normalizedContent]);
      } else {
        entries.push(normalizedContent);
      }
    }

    const diaries = Array.from(groupedEntries.entries(), ([date, contents]) => ({
      date,
      content: contents.join('\n\n'),
    }));
    logger.debug('getRecentDiaries', { days, matchedCount: diaries.length });
    return diaries;
  }

  async listDiaryDates(): Promise<string[]> {
    const rows = this.listDiaryDatesStatement.all();
    return rows.map((row) => row.date);
  }

  async close(): Promise<void> {
    if (this.db.open) {
      this.db.close();
    }

    return Promise.resolve();
  }

  private importLegacyDiaryFiles(legacyDiaryDir: string): void {
    if (!existsSync(legacyDiaryDir)) {
      return;
    }

    let legacyFiles: Dirent[];
    try {
      legacyFiles = readdirSync(legacyDiaryDir, { withFileTypes: true });
    } catch (error) {
      logger.warn('Failed to read legacy diary directory, skipping import', {
        path: legacyDiaryDir,
        error: error instanceof Error ? error.message : error,
      });
      return;
    }

    const importLegacyDiaryFile = this.db.transaction((entries: Array<{ date: string; content: string }>) => {
      let importedCount = 0;
      for (const entry of entries) {
        const markResult = this.markLegacyImportStatement.run(entry.date, new Date().toISOString());
        if (markResult.changes === 0) {
          continue;
        }

        this.writeDiaryStatement.run(entry.date, entry.content, `${entry.date}T00:00:00.000Z`);
        importedCount += 1;
      }

      return importedCount;
    });

    const entriesToImport: Array<{ date: string; content: string }> = [];
    for (const legacyFile of legacyFiles) {
      if (!legacyFile.isFile()) {
        continue;
      }

      const match = LEGACY_DIARY_FILE_PATTERN.exec(legacyFile.name);
      if (match == null) {
        continue;
      }

      const date = match[1];
      if (date == null) {
        continue;
      }

      if (this.hasLegacyImportStatement.get(date) != null) {
        continue;
      }

      let content: string;
      try {
        content = readFileSync(join(legacyDiaryDir, legacyFile.name), 'utf8').trim();
      } catch (error) {
        logger.warn('Failed to read legacy diary file, skipping', {
          file: legacyFile.name,
          error: error instanceof Error ? error.message : error,
        });
        continue;
      }

      if (content.length === 0) {
        continue;
      }

      entriesToImport.push({ date, content });
    }

    if (entriesToImport.length === 0) {
      return;
    }

    let importedCount: number;
    try {
      importedCount = importLegacyDiaryFile(entriesToImport);
    } catch (error) {
      logger.warn('Failed to execute legacy diary import transaction, skipping', {
        entryCount: entriesToImport.length,
        error: error instanceof Error ? error.message : error,
      });
      return;
    }

    if (importedCount > 0) {
      logger.info('Imported legacy diary files into SQLite', { importedCount });
    }
  }
}

function getRecentDateRange(days: number, timezone: string): { cutoffDate: string; todayDate: string } {
  const now = new Date();
  const todayDate = formatDateInTimezone(now, timezone);

  const year = Number(todayDate.slice(0, 4));
  const month = Number(todayDate.slice(5, 7));
  const day = Number(todayDate.slice(8, 10));
  const cutoffLocal = new Date(Date.UTC(year, month - 1, day - (days - 1)));

  const cutoffYear = String(cutoffLocal.getUTCFullYear());
  const cutoffMonth = String(cutoffLocal.getUTCMonth() + 1).padStart(2, '0');
  const cutoffDay = String(cutoffLocal.getUTCDate()).padStart(2, '0');

  return { cutoffDate: `${cutoffYear}-${cutoffMonth}-${cutoffDay}`, todayDate };
}

function assertIsoDate(date: string): void {
  if (!ISO_DATE_PATTERN.test(date)) {
    throw new Error(`Invalid diary date "${date}": expected format YYYY-MM-DD`);
  }
}
