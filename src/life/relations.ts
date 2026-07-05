/**
 * 関係メモリ: SQL 上の社会知識グラフ（M6）。
 *
 * 関係は「自分 ↔ 相手」で閉じない。エッジ（主体・関係・客体・強度・感情価・出所・
 * 観測日時）の集合として持ち、1〜2 ホップ展開は再帰 CTE で行う（グラフ DB 製品は使わない）。
 * 同一性の統合は alias_of エッジで行う（KW 側の ID 体系が安定している前提を置かない）。
 * strength / affect は観測の累積で更新される経路依存の値。
 */

import type Database from 'better-sqlite3';

import { createLogger } from '../utils/logger.js';
import { openLifeDatabase } from './db.js';

const logger = createLogger('RelationStore');

export const ALIAS_RELATION = 'alias_of';
/** 1 回の観測で strength に加算する量（上限 1） */
const STRENGTH_INCREMENT = 0.1;
/** affect は指数移動平均で累積する */
const AFFECT_SMOOTHING = 0.3;

export interface RelationEdge {
  id: number;
  subjectId: string;
  relation: string;
  objectId: string;
  strength: number | null;
  affect: number | null;
  observedAt: string;
  provenance: number[];
  procVersion: string;
}

export interface ObserveRelationInput {
  subjectId: string;
  relation: string;
  objectId: string;
  /** この観測の感情価（あれば affect に混ぜ込む） */
  affect?: number | undefined;
  observedAt: Date;
  provenance: number[];
  procVersion: string;
}

export interface IRelationStore {
  /** エッジの観測。既存エッジは strength / affect を累積更新する */
  observe(input: ObserveRelationInput): Promise<number>;
  listForSubject(subjectId: string, limit?: number): Promise<RelationEdge[]>;
  /** alias_of を辿って primary ID を解決する */
  resolvePrimary(id: string): Promise<string>;
  /** 1〜2 ホップの近傍ノード（alias 含む）を再帰 CTE で展開する */
  neighbors(id: string, hops?: number, limit?: number): Promise<string[]>;
  linkAlias(aliasId: string, primaryId: string, provenance: number[], procVersion: string): Promise<void>;
  close(): Promise<void>;
}

interface RelationRow {
  id: number;
  subject_id: string;
  relation: string;
  object_id: string;
  strength: number | null;
  affect: number | null;
  observed_at: string;
  provenance: string;
  proc_version: string;
}

export interface SqliteRelationStoreOptions {
  dataDir?: string | undefined;
  db?: Database.Database | undefined;
}

export class SqliteRelationStore implements IRelationStore {
  private readonly db: Database.Database;
  private readonly ownsDb: boolean;

  constructor({ dataDir, db }: SqliteRelationStoreOptions) {
    if (db != null) {
      this.db = db;
      this.ownsDb = false;
    } else if (dataDir != null) {
      this.db = openLifeDatabase({ dataDir });
      this.ownsDb = true;
    } else {
      throw new Error('SqliteRelationStore requires either dataDir or db');
    }
  }

  async observe(input: ObserveRelationInput): Promise<number> {
    const existing = this.db.prepare<[string, string, string], RelationRow>(`
      SELECT * FROM relations WHERE subject_id = ? AND relation = ? AND object_id = ?
    `).get(input.subjectId, input.relation, input.objectId);

    if (existing == null) {
      const result = this.db.prepare(`
        INSERT INTO relations (subject_id, relation, object_id, strength, affect, observed_at, provenance, proc_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.subjectId,
        input.relation,
        input.objectId,
        STRENGTH_INCREMENT,
        input.affect ?? null,
        input.observedAt.toISOString(),
        JSON.stringify(input.provenance),
        input.procVersion,
      );
      return Promise.resolve(Number(result.lastInsertRowid));
    }

    // 観測の累積: strength は加算（上限 1）、affect は指数移動平均、provenance は追記
    const nextStrength = Math.min(1, (existing.strength ?? 0) + STRENGTH_INCREMENT);
    const nextAffect = input.affect != null
      ? (existing.affect != null
          ? existing.affect * (1 - AFFECT_SMOOTHING) + input.affect * AFFECT_SMOOTHING
          : input.affect)
      : existing.affect;
    const mergedProvenance = [...parseNumberArray(existing.provenance), ...input.provenance].slice(-50);
    this.db.prepare(`
      UPDATE relations
      SET strength = ?, affect = ?, observed_at = ?, provenance = ?, proc_version = ?
      WHERE id = ?
    `).run(
      nextStrength,
      nextAffect,
      input.observedAt.toISOString(),
      JSON.stringify(mergedProvenance),
      input.procVersion,
      existing.id,
    );
    logger.debug('Relation observation accumulated', {
      id: existing.id,
      strength: nextStrength,
    });
    return Promise.resolve(existing.id);
  }

  async listForSubject(subjectId: string, limit = 50): Promise<RelationEdge[]> {
    const rows = this.db.prepare<[string, string, number], RelationRow>(`
      SELECT * FROM relations
      WHERE subject_id = ? OR object_id = ?
      ORDER BY strength DESC NULLS LAST, id DESC
      LIMIT ?
    `).all(subjectId, subjectId, Math.max(0, limit));
    return Promise.resolve(rows.map(mapRow));
  }

  async resolvePrimary(id: string): Promise<string> {
    // alias_of チェーンを辿る（循環防止に深さ上限）
    let current = id;
    for (let depth = 0; depth < 5; depth += 1) {
      const row = this.db.prepare<[string, string], { object_id: string }>(
        'SELECT object_id FROM relations WHERE subject_id = ? AND relation = ? LIMIT 1',
      ).get(current, ALIAS_RELATION);
      if (row == null || row.object_id === current) {
        return current;
      }
      current = row.object_id;
    }
    return current;
  }

  async neighbors(id: string, hops = 2, limit = 30): Promise<string[]> {
    const maxHops = Math.min(2, Math.max(1, hops));
    const rows = this.db.prepare<[string, number, number], { node: string }>(`
      WITH RECURSIVE walk(node, depth) AS (
        SELECT ?, 0
        UNION
        SELECT CASE WHEN relations.subject_id = walk.node THEN relations.object_id ELSE relations.subject_id END,
               walk.depth + 1
        FROM relations
        JOIN walk ON relations.subject_id = walk.node OR relations.object_id = walk.node
        WHERE walk.depth < ?
      )
      SELECT DISTINCT node FROM walk WHERE depth > 0 LIMIT ?
    `).all(id, maxHops, Math.max(1, limit));
    return Promise.resolve(rows.map((row) => row.node).filter((node) => node !== id));
  }

  async linkAlias(aliasId: string, primaryId: string, provenance: number[], procVersion: string): Promise<void> {
    await this.observe({
      subjectId: aliasId,
      relation: ALIAS_RELATION,
      objectId: primaryId,
      observedAt: new Date(),
      provenance,
      procVersion,
    });
  }

  async close(): Promise<void> {
    if (this.ownsDb && this.db.open) {
      this.db.close();
    }

    return Promise.resolve();
  }
}

function mapRow(row: RelationRow): RelationEdge {
  return {
    id: row.id,
    subjectId: row.subject_id,
    relation: row.relation,
    objectId: row.object_id,
    strength: row.strength,
    affect: row.affect,
    observedAt: row.observed_at,
    provenance: parseNumberArray(row.provenance),
    procVersion: row.proc_version,
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
