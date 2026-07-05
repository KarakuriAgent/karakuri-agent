import type Database from 'better-sqlite3';

import { createLogger } from '../utils/logger.js';
import { openLifeDatabase } from './db.js';

const logger = createLogger('ProspectStore');

export type ProspectKind = 'promise' | 'intention' | 'goal';
export type ProspectStatus = 'open' | 'fulfilled' | 'abandoned';

export interface Prospect {
  id: number;
  kind: ProspectKind;
  body: string;
  counterpart: string | null;
  dueAt: string | null;
  status: ProspectStatus;
  provenance: number[];
  procVersion: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewProspect {
  kind: ProspectKind;
  body: string;
  counterpart?: string | undefined;
  dueAt?: string | undefined;
  provenance: number[];
  procVersion: string;
}

export interface IProspectStore {
  insert(prospect: NewProspect): Promise<number>;
  getById(id: number): Promise<Prospect | null>;
  listOpen(limit?: number): Promise<Prospect[]>;
  /** 同一本文の open prospect が既にあるか（重複登録防止） */
  hasOpenWithBody(body: string): Promise<boolean>;
  /** status は状態遷移（open からのみ遷移可能）。純粋なログ導出ではない（M7 参照） */
  updateStatus(id: number, status: ProspectStatus): Promise<boolean>;
  close(): Promise<void>;
}

interface ProspectRow {
  id: number;
  kind: string;
  body: string;
  counterpart: string | null;
  due_at: string | null;
  status: string;
  provenance: string;
  proc_version: string;
  created_at: string;
  updated_at: string;
}

export interface SqliteProspectStoreOptions {
  dataDir?: string | undefined;
  db?: Database.Database | undefined;
}

export class SqliteProspectStore implements IProspectStore {
  private readonly db: Database.Database;
  private readonly ownsDb: boolean;

  constructor({ dataDir, db }: SqliteProspectStoreOptions) {
    if (db != null) {
      this.db = db;
      this.ownsDb = false;
    } else if (dataDir != null) {
      this.db = openLifeDatabase({ dataDir });
      this.ownsDb = true;
    } else {
      throw new Error('SqliteProspectStore requires either dataDir or db');
    }
  }

  async insert(prospect: NewProspect): Promise<number> {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO prospects (kind, body, counterpart, due_at, status, provenance, proc_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)
    `).run(
      prospect.kind,
      prospect.body,
      prospect.counterpart ?? null,
      prospect.dueAt ?? null,
      JSON.stringify(prospect.provenance),
      prospect.procVersion,
      now,
      now,
    );
    const id = Number(result.lastInsertRowid);
    logger.debug('Prospect inserted', { id, kind: prospect.kind });
    return Promise.resolve(id);
  }

  async getById(id: number): Promise<Prospect | null> {
    const row = this.db.prepare<[number], ProspectRow>('SELECT * FROM prospects WHERE id = ?').get(id);
    return Promise.resolve(row != null ? mapRow(row) : null);
  }

  async listOpen(limit = 20): Promise<Prospect[]> {
    const rows = this.db.prepare<[number], ProspectRow>(`
      SELECT * FROM prospects
      WHERE status = 'open'
      ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at ASC, id ASC
      LIMIT ?
    `).all(Math.max(0, limit));
    return Promise.resolve(rows.map(mapRow));
  }

  async hasOpenWithBody(body: string): Promise<boolean> {
    const row = this.db.prepare<[string], { id: number }>(
      "SELECT id FROM prospects WHERE status = 'open' AND body = ? LIMIT 1",
    ).get(body.trim());
    return Promise.resolve(row != null);
  }

  async updateStatus(id: number, status: ProspectStatus): Promise<boolean> {
    // 状態遷移は open からのみ（再処理で fulfilled が open に戻ることを防ぐ経路依存の値）
    const result = this.db.prepare(`
      UPDATE prospects SET status = ?, updated_at = ?
      WHERE id = ? AND status = 'open'
    `).run(status, new Date().toISOString(), id);
    return Promise.resolve(result.changes > 0);
  }

  async close(): Promise<void> {
    if (this.ownsDb && this.db.open) {
      this.db.close();
    }

    return Promise.resolve();
  }
}

function mapRow(row: ProspectRow): Prospect {
  return {
    id: row.id,
    kind: row.kind as ProspectKind,
    body: row.body,
    counterpart: row.counterpart,
    dueAt: row.due_at,
    status: row.status as ProspectStatus,
    provenance: parseNumberArray(row.provenance),
    procVersion: row.proc_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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

/** KW 応答生成時の「近い予定・果たしていない約束」注入テキスト（untrusted タグは呼び出し側） */
export function formatProspectsForPrompt(prospects: Prospect[]): string {
  return prospects
    .map((prospect) => {
      const due = prospect.dueAt != null ? `（期日: ${prospect.dueAt.slice(0, 16).replace('T', ' ')}）` : '';
      const counterpart = prospect.counterpart != null ? `（相手: ${prospect.counterpart}）` : '';
      const label = prospect.kind === 'promise' ? '約束' : prospect.kind === 'goal' ? '目標' : '予定';
      return `- [${label}] ${prospect.body}${counterpart}${due}`;
    })
    .join('\n');
}
