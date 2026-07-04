import type Database from 'better-sqlite3';

import { createLogger } from '../utils/logger.js';
import { openLifeDatabase } from './db.js';
import { buildFtsMatchQuery } from './episodes.js';

const logger = createLogger('NarrativeStore');

export type NarrativeKind = 'diary' | 'theme' | 'chapter';

export interface Narrative {
  id: number;
  kind: NarrativeKind;
  periodStart: string;
  periodEnd: string;
  body: string;
  revision: number;
  active: boolean;
  supersedes: number | null;
  provenance: number[];
  procVersion: string;
  createdAt: string;
}

export interface NewNarrative {
  kind: NarrativeKind;
  periodStart: string;
  periodEnd: string;
  body: string;
  provenance: number[];
  procVersion: string;
  /** 改訂元の narrative id（章・テーマの改訂） */
  supersedes?: number | undefined;
}

export interface INarrativeStore {
  insert(narrative: NewNarrative): Promise<number>;
  getById(id: number): Promise<Narrative | null>;
  listActive(kind: NarrativeKind, limit: number): Promise<Narrative[]>;
  listByPeriod(kind: NarrativeKind, periodStart: string, periodEnd: string): Promise<Narrative[]>;
  searchText(query: string, limit: number): Promise<Narrative[]>;
  close(): Promise<void>;
}

interface NarrativeRow {
  id: number;
  kind: string;
  period_start: string;
  period_end: string;
  body: string;
  revision: number;
  active: number;
  supersedes: number | null;
  provenance: string;
  proc_version: string;
  created_at: string;
}

export interface SqliteNarrativeStoreOptions {
  dataDir?: string | undefined;
  db?: Database.Database | undefined;
}

export class SqliteNarrativeStore implements INarrativeStore {
  private readonly db: Database.Database;
  private readonly ownsDb: boolean;

  constructor({ dataDir, db }: SqliteNarrativeStoreOptions) {
    if (db != null) {
      this.db = db;
      this.ownsDb = false;
    } else if (dataDir != null) {
      this.db = openLifeDatabase({ dataDir });
      this.ownsDb = true;
    } else {
      throw new Error('SqliteNarrativeStore requires either dataDir or db');
    }
  }

  /** 挿入。supersedes 指定時は旧 narrative を非 active 化し revision を継承する（改訂） */
  async insert(narrative: NewNarrative): Promise<number> {
    const write = this.db.transaction((): number => {
      let revision = 1;
      if (narrative.supersedes != null) {
        const previous = this.db.prepare<[number], { revision: number }>(
          'SELECT revision FROM narratives WHERE id = ?',
        ).get(narrative.supersedes);
        if (previous != null) {
          revision = previous.revision + 1;
          this.db.prepare('UPDATE narratives SET active = 0 WHERE id = ?').run(narrative.supersedes);
        }
      }
      const result = this.db.prepare(`
        INSERT INTO narratives (kind, period_start, period_end, body, revision, active, supersedes, provenance, proc_version, created_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      `).run(
        narrative.kind,
        narrative.periodStart,
        narrative.periodEnd,
        narrative.body,
        revision,
        narrative.supersedes ?? null,
        JSON.stringify(narrative.provenance),
        narrative.procVersion,
        new Date().toISOString(),
      );
      return Number(result.lastInsertRowid);
    });
    const id = write();
    logger.debug('Narrative inserted', { id, kind: narrative.kind });
    return Promise.resolve(id);
  }

  async getById(id: number): Promise<Narrative | null> {
    const row = this.db.prepare<[number], NarrativeRow>('SELECT * FROM narratives WHERE id = ?').get(id);
    return Promise.resolve(row != null ? mapRow(row) : null);
  }

  async listActive(kind: NarrativeKind, limit: number): Promise<Narrative[]> {
    const rows = this.db.prepare<[string, number], NarrativeRow>(`
      SELECT * FROM narratives
      WHERE kind = ? AND active = 1
      ORDER BY period_start DESC, id DESC
      LIMIT ?
    `).all(kind, Math.max(0, limit));
    return Promise.resolve(rows.map(mapRow));
  }

  async listByPeriod(kind: NarrativeKind, periodStart: string, periodEnd: string): Promise<Narrative[]> {
    const rows = this.db.prepare<[string, string, string], NarrativeRow>(`
      SELECT * FROM narratives
      WHERE kind = ? AND active = 1 AND period_start >= ? AND period_end <= ?
      ORDER BY period_start ASC, id ASC
    `).all(kind, periodStart, periodEnd);
    return Promise.resolve(rows.map(mapRow));
  }

  async searchText(query: string, limit: number): Promise<Narrative[]> {
    const normalized = query.trim();
    if (normalized.length === 0 || limit <= 0) {
      return [];
    }

    if ([...normalized].length < 3) {
      const rows = this.db.prepare<[string, number], NarrativeRow>(`
        SELECT * FROM narratives
        WHERE active = 1 AND body LIKE ? ESCAPE '\\'
        ORDER BY period_start DESC
        LIMIT ?
      `).all(`%${normalized.replace(/[\\%_]/g, (match) => `\\${match}`)}%`, limit);
      return rows.map(mapRow);
    }

    try {
      const rows = this.db.prepare<[string, number], NarrativeRow>(`
        SELECT narratives.*
        FROM narratives_fts
        JOIN narratives ON narratives.id = narratives_fts.rowid
        WHERE narratives_fts MATCH ? AND narratives.active = 1
        ORDER BY bm25(narratives_fts) ASC
        LIMIT ?
      `).all(buildFtsMatchQuery(normalized), limit);
      return rows.map(mapRow);
    } catch (error) {
      logger.warn('Narrative FTS search failed', error, { query: normalized });
      return [];
    }
  }

  async close(): Promise<void> {
    if (this.ownsDb && this.db.open) {
      this.db.close();
    }

    return Promise.resolve();
  }
}

function mapRow(row: NarrativeRow): Narrative {
  return {
    id: row.id,
    kind: row.kind as NarrativeKind,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    body: row.body,
    revision: row.revision,
    active: row.active !== 0,
    supersedes: row.supersedes,
    provenance: parseNumberArray(row.provenance),
    procVersion: row.proc_version,
    createdAt: row.created_at,
  };
}

function parseNumberArray(text: string): number[] {
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter((value): value is number => typeof value === 'number') : [];
  } catch {
    return [];
  }
}
