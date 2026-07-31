import type Database from 'better-sqlite3';

import { createLogger } from '../utils/logger.js';
import { openLifeDatabase } from './db.js';

const logger = createLogger('BeliefStore');

export type BeliefKind = 'world_fact' | 'person_fact' | 'self';

/**
 * 出所が単一（独立した観測が 1 件以下）の信念に許す confidence の上限。
 * 単発の他者発言だけで高確度にしない（記憶への持続的インジェクション対策）。
 */
export const SINGLE_SOURCE_CONFIDENCE_CAP = 0.6;

export interface Belief {
  id: number;
  kind: BeliefKind;
  subject: string | null;
  body: string;
  confidence: number;
  active: boolean;
  supersedes: number | null;
  provenance: number[];
  procVersion: string;
  createdAt: string;
}

export interface NewBelief {
  kind: BeliefKind;
  subject?: string | undefined;
  body: string;
  confidence: number;
  provenance: number[];
  procVersion: string;
  /** 改訂元の belief id。上書きではなく改訂（履歴チェーン） */
  supersedes?: number | undefined;
}

export interface IBeliefStore {
  insert(belief: NewBelief): Promise<number>;
  getById(id: number): Promise<Belief | null>;
  listActive(options?: { kind?: BeliefKind; subject?: string; limit?: number }): Promise<Belief[]>;
  /** 改訂: 旧 belief を非 active 化して新レコードを挿入する */
  revise(beliefId: number, updates: { body?: string; confidence?: number; provenance?: number[]; procVersion: string }): Promise<number | null>;
  deactivate(beliefId: number): Promise<boolean>;
  /** 改訂チェーンを新しい順に辿る */
  getRevisionChain(beliefId: number): Promise<Belief[]>;
  close(): Promise<void>;
}

interface BeliefRow {
  id: number;
  kind: string;
  subject: string | null;
  body: string;
  confidence: number;
  active: number;
  supersedes: number | null;
  provenance: string;
  proc_version: string;
  created_at: string;
}

export interface SqliteBeliefStoreOptions {
  dataDir?: string | undefined;
  db?: Database.Database | undefined;
}

/** confidence を出所数に応じて決定論でクランプする */
export function clampBeliefConfidence(confidence: number, provenanceCount: number): number {
  const clamped = Math.min(1, Math.max(0, confidence));
  return provenanceCount <= 1 ? Math.min(clamped, SINGLE_SOURCE_CONFIDENCE_CAP) : clamped;
}

export class SqliteBeliefStore implements IBeliefStore {
  private readonly db: Database.Database;
  private readonly ownsDb: boolean;

  constructor({ dataDir, db }: SqliteBeliefStoreOptions) {
    if (db != null) {
      this.db = db;
      this.ownsDb = false;
    } else if (dataDir != null) {
      this.db = openLifeDatabase({ dataDir });
      this.ownsDb = true;
    } else {
      throw new Error('SqliteBeliefStore requires either dataDir or db');
    }
  }

  async insert(belief: NewBelief): Promise<number> {
    const confidence = clampBeliefConfidence(belief.confidence, belief.provenance.length);
    const write = this.db.transaction((): number => {
      if (belief.supersedes != null) {
        this.db.prepare('UPDATE beliefs SET active = 0 WHERE id = ?').run(belief.supersedes);
      }
      const result = this.db.prepare(`
        INSERT INTO beliefs (kind, subject, body, confidence, active, supersedes, provenance, proc_version, created_at)
        VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)
      `).run(
        belief.kind,
        belief.subject ?? null,
        belief.body,
        confidence,
        belief.supersedes ?? null,
        JSON.stringify(belief.provenance),
        belief.procVersion,
        new Date().toISOString(),
      );
      return Number(result.lastInsertRowid);
    });
    const id = write();
    logger.debug('Belief inserted', { id, kind: belief.kind, confidence });
    return Promise.resolve(id);
  }

  async getById(id: number): Promise<Belief | null> {
    const row = this.db.prepare<[number], BeliefRow>('SELECT * FROM beliefs WHERE id = ?').get(id);
    return Promise.resolve(row != null ? mapRow(row) : null);
  }

  async listActive({ kind, subject, limit = 100 }: { kind?: BeliefKind; subject?: string; limit?: number } = {}): Promise<Belief[]> {
    const conditions = ['active = 1'];
    const parameters: Array<string | number> = [];
    if (kind != null) {
      conditions.push('kind = ?');
      parameters.push(kind);
    }
    if (subject != null) {
      conditions.push('subject = ?');
      parameters.push(subject);
    }
    const rows = this.db.prepare<Array<string | number>, BeliefRow>(`
      SELECT * FROM beliefs
      WHERE ${conditions.join(' AND ')}
      ORDER BY confidence DESC, id DESC
      LIMIT ?
    `).all(...parameters, Math.max(0, limit));
    return Promise.resolve(rows.map(mapRow));
  }

  async revise(
    beliefId: number,
    updates: { body?: string; confidence?: number; provenance?: number[]; procVersion: string },
  ): Promise<number | null> {
    const current = await this.getById(beliefId);
    if (current == null) {
      return null;
    }

    const provenance = updates.provenance ?? current.provenance;
    return this.insert({
      kind: current.kind,
      ...(current.subject != null ? { subject: current.subject } : {}),
      body: updates.body ?? current.body,
      confidence: updates.confidence ?? current.confidence,
      provenance,
      procVersion: updates.procVersion,
      supersedes: beliefId,
    });
  }

  async deactivate(beliefId: number): Promise<boolean> {
    const result = this.db.prepare('UPDATE beliefs SET active = 0 WHERE id = ?').run(beliefId);
    return Promise.resolve(result.changes > 0);
  }

  async getRevisionChain(beliefId: number): Promise<Belief[]> {
    // 再帰 CTE で改訂チェーンを遡る
    const rows = this.db.prepare<[number], BeliefRow>(`
      WITH RECURSIVE chain(id) AS (
        SELECT ?
        UNION ALL
        SELECT beliefs.supersedes FROM beliefs JOIN chain ON beliefs.id = chain.id
        WHERE beliefs.supersedes IS NOT NULL
      )
      SELECT beliefs.* FROM beliefs JOIN chain ON beliefs.id = chain.id
      ORDER BY beliefs.id DESC
    `).all(beliefId);
    return Promise.resolve(rows.map(mapRow));
  }

  async close(): Promise<void> {
    if (this.ownsDb && this.db.open) {
      this.db.close();
    }

    return Promise.resolve();
  }
}

function mapRow(row: BeliefRow): Belief {
  return {
    id: row.id,
    kind: row.kind as BeliefKind,
    subject: row.subject,
    body: row.body,
    confidence: row.confidence,
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
