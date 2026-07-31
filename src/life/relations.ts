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

/**
 * 関係の制御語彙（#106）。「継続的な関係の種類」だけを持ち、1 回の行為の説明
 * （"is chatting with" 等）は関係にしない。実機で 75 エッジに 60 種以上の
 * 自由記述が発生し UNIQUE(subject, relation, object) の観測累積が機能しなかった
 * 問題への対応。写像にない表現は acquaintance に落とす（情報の残滓は
 * experience_log にあり、写像改善は reprocessing / 再移行で遡及できる）。
 */
export const RELATION_VOCABULARY = [
  'acquaintance',
  'friend',
  'close_friend',
  'family',
  'housemate',
  'coworker',
  'rival',
  'dislikes',
] as const;

const RELATION_VOCABULARY_SET = new Set<string>(RELATION_VOCABULARY);

const RELATION_LABEL_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/housemate|cohabit|shared?[_ ]home|roommate|同居|ルームメイト/i, 'housemate'],
  [/close[_ ]?friend|best[_ ]?friend|親友/i, 'close_friend'],
  [/family|家族|親子|兄弟|姉妹|きょうだい/i, 'family'],
  [/coworker|colleague|同僚|仕事仲間/i, 'coworker'],
  [/rival|competitor|ライバル|競争相手/i, 'rival'],
  [/dislike|dismissive|hostile|hate|unfriendly|unkind|敵対|嫌い|険悪|不仲/i, 'dislikes'],
  [/friend|friendly|goodwill|仲良|友人|友達|好意/i, 'friend'],
];

/**
 * 否定表現の検出: 「友好的ではない」等が positive パターンの部分一致で
 * friend へ反転しないよう、positive 写像の前に中立へ落とす
 */
const NEGATED_LABEL_PATTERN = /ではない|でない|くない|\bnot\b|\bno longer\b/i;

/** 自由記述の関係ラベルを制御語彙へ写像する（決定論。写像にないものは acquaintance） */
export function normalizeRelationLabel(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === ALIAS_RELATION) {
    return ALIAS_RELATION;
  }
  if (RELATION_VOCABULARY_SET.has(trimmed)) {
    return trimmed;
  }
  // 明確な敵対・嫌悪（friend 以外）は否定検査より先に判定する
  for (const [pattern, vocabulary] of RELATION_LABEL_PATTERNS) {
    if (vocabulary !== 'friend' && pattern.test(trimmed)) {
      return vocabulary;
    }
  }
  if (NEGATED_LABEL_PATTERN.test(trimmed)) {
    return 'acquaintance';
  }
  const friendEntry = RELATION_LABEL_PATTERNS.find(([, vocabulary]) => vocabulary === 'friend');
  if (friendEntry != null && friendEntry[0].test(trimmed)) {
    return 'friend';
  }
  return 'acquaintance';
}

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

const RELATION_VOCAB_MIGRATED_KEY = 'relation_vocab_migrated';

/**
 * 既存 relations 行の一括移行（#106・一度だけ）: 自由記述の relation を制御語彙へ、
 * 自己を指す表記ゆらぎ（エージェント名・agent 等）を 'self' へ正規化し、
 * 統合で衝突する行は strength 合算（上限 1）・affect 加重平均・observed_at 最新・
 * provenance 和集合で 1 行にまとめる。alias_of エッジは対象外。
 */
export function migrateRelationVocabularyOnce(
  db: Database.Database,
  options: { selfLabels: ReadonlySet<string>; procVersion: string },
): { merged: number; rewritten: number } | null {
  const migratedAt = db.prepare<[string], { value: string }>('SELECT value FROM life_meta WHERE key = ?')
    .get(RELATION_VOCAB_MIGRATED_KEY);
  if (migratedAt != null) {
    return null;
  }

  const normalizeParty = (label: string): string =>
    options.selfLabels.has(label.trim().toLowerCase()) ? 'self' : label.trim();

  const rows = db.prepare<[], RelationRow>('SELECT * FROM relations').all();
  const groups = new Map<string, { subject: string; relation: string; object: string; rows: RelationRow[] }>();
  let rewritten = 0;
  for (const row of rows) {
    if (row.relation === ALIAS_RELATION) {
      continue;
    }
    const subject = normalizeParty(row.subject_id);
    const object = normalizeParty(row.object_id);
    const relation = normalizeRelationLabel(row.relation);
    if (subject !== row.subject_id || object !== row.object_id || relation !== row.relation) {
      rewritten += 1;
    }
    const key = JSON.stringify([subject, relation, object]);
    const group = groups.get(key);
    if (group != null) {
      group.rows.push(row);
    } else {
      groups.set(key, { subject, relation, object, rows: [row] });
    }
  }

  let merged = 0;
  const run = db.transaction(() => {
    for (const { subject, relation, object, rows: group } of groups.values()) {
      const unchanged = group.length === 1
        && group[0]!.subject_id === subject
        && group[0]!.relation === relation
        && group[0]!.object_id === object;
      if (unchanged) {
        continue;
      }
      // strength 合算（上限 1）・affect は strength による加重平均・observed_at 最新
      let strengthSum = 0;
      let affectWeighted = 0;
      let affectWeight = 0;
      let latestObservedAt = '';
      const provenance: number[] = [];
      for (const row of group) {
        const strength = row.strength ?? 0;
        strengthSum += strength;
        if (row.affect != null) {
          const weight = Math.max(strength, 0.01);
          affectWeighted += row.affect * weight;
          affectWeight += weight;
        }
        if (row.observed_at > latestObservedAt) {
          latestObservedAt = row.observed_at;
        }
        provenance.push(...parseNumberArray(row.provenance));
      }
      db.prepare(`DELETE FROM relations WHERE id IN (${group.map(() => '?').join(',')})`)
        .run(...group.map((row) => row.id));
      db.prepare(`
        INSERT INTO relations (subject_id, relation, object_id, strength, affect, observed_at, provenance, proc_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        subject,
        relation,
        object,
        Math.min(1, strengthSum),
        affectWeight > 0 ? affectWeighted / affectWeight : null,
        latestObservedAt,
        JSON.stringify([...new Set(provenance)].slice(-50)),
        options.procVersion,
      );
      merged += group.length > 1 ? group.length : 0;
    }
    db.prepare('INSERT OR REPLACE INTO life_meta (key, value) VALUES (?, ?)')
      .run(RELATION_VOCAB_MIGRATED_KEY, new Date().toISOString());
  });
  run();
  logger.info('Relation vocabulary migrated', { rewritten, merged });
  return { merged, rewritten };
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
