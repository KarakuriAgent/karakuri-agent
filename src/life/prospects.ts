import type Database from 'better-sqlite3';

import { createLogger } from '../utils/logger.js';
import { openLifeDatabase } from './db.js';

const logger = createLogger('ProspectStore');

export type ProspectKind = 'promise' | 'intention' | 'goal';
export type ProspectStatus = 'open' | 'fulfilled' | 'abandoned' | 'expired';

/**
 * open のまま一度も touch されずにこの日数が過ぎた prospect は「もう生きていない意図」
 * として決定論で expired へ落とす（#111）。省察の LLM 棚卸しだけに任せると
 * 実機で同趣旨の古い意図が数日間 open のまま注入枠を占有し続けたため
 */
export const PROSPECT_STALE_TTL_DAYS = 7;

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
  /**
   * プロンプト注入用の open 一覧（#111）: 期日つきを先頭に、残りは「最近生まれた・
   * 最近想起された」順。listOpen（id 昇順 = 最古優先）だと古い意図が注入枠を
   * 占有し続け、会話由来の新しい約束が行動選択に届かないため分離する
   */
  listOpenForInjection(limit?: number): Promise<Prospect[]>;
  /**
   * 直近に手仕舞いした（open 以外へ遷移した）prospect（#112）。会話セッションへ
   * 「この件はもう追わなくてよい」を伝え、解決済みの話題を古い物語のまま
   * 蒸し返す事故を防ぐ
   */
  recentlyClosed(since: Date, limit?: number): Promise<Prospect[]>;
  /** updated_at が cutoff より古い open を expired へ落とす（決定論 TTL — #111）。返り値は件数 */
  expireStaleOpen(cutoff: Date): Promise<number>;
  /** 同一本文の open prospect が既にあるか（重複登録防止） */
  hasOpenWithBody(body: string): Promise<boolean>;
  /**
   * 同趣旨の open prospect を探す（#105）。正規化後の完全一致は全 open を対象、
   * 字面類似は直近 recentHours 以内に登録されたものだけを対象にする
   */
  findSimilarOpen(body: string, options?: { recentHours?: number; now?: Date }): Promise<Prospect | null>;
  /** 「まだその意図が生きている」ことの記録として updated_at を更新する */
  touch(id: number): Promise<void>;
  /** open の総数（上限判定用 — #105） */
  countOpen(): Promise<number>;
  /** 指定 kind の最も古い open（上限あふれ時の自動 abandoned 対象 — #105） */
  findOldestOpenByKind(kind: ProspectKind): Promise<Prospect | null>;
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

  async listOpenForInjection(limit = 5): Promise<Prospect[]> {
    const rows = this.db.prepare<[number], ProspectRow>(`
      SELECT * FROM prospects
      WHERE status = 'open'
      ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at ASC, updated_at DESC, id DESC
      LIMIT ?
    `).all(Math.max(0, limit));
    return Promise.resolve(rows.map(mapRow));
  }

  async recentlyClosed(since: Date, limit = 5): Promise<Prospect[]> {
    const rows = this.db.prepare<[string, number], ProspectRow>(`
      SELECT * FROM prospects
      WHERE status != 'open' AND updated_at >= ?
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `).all(since.toISOString(), Math.max(0, limit));
    return Promise.resolve(rows.map(mapRow));
  }

  async expireStaleOpen(cutoff: Date): Promise<number> {
    const result = this.db.prepare(`
      UPDATE prospects SET status = 'expired', updated_at = ?
      WHERE status = 'open' AND updated_at < ?
    `).run(new Date().toISOString(), cutoff.toISOString());
    if (result.changes > 0) {
      logger.info('Stale open prospects expired', { count: result.changes, cutoff: cutoff.toISOString() });
    }
    return Promise.resolve(result.changes);
  }

  async hasOpenWithBody(body: string): Promise<boolean> {
    const row = this.db.prepare<[string], { id: number }>(
      "SELECT id FROM prospects WHERE status = 'open' AND body = ? LIMIT 1",
    ).get(body.trim());
    return Promise.resolve(row != null);
  }

  async findSimilarOpen(body: string, options: { recentHours?: number; now?: Date } = {}): Promise<Prospect | null> {
    const recentHours = options.recentHours ?? 24;
    const now = options.now ?? new Date();
    const normalized = normalizeProspectBody(body);
    if (normalized.length === 0) {
      return null;
    }
    const open = await this.listOpen(200);
    const recentSince = now.getTime() - recentHours * 3_600_000;
    for (const prospect of open) {
      const existingNormalized = normalizeProspectBody(prospect.body);
      if (existingNormalized === normalized) {
        return prospect;
      }
      // 字面類似は直近登録分だけを対象にする（古い意図との偶然の類似で
      // 新しい意図を握りつぶさない）
      if (new Date(prospect.createdAt).getTime() < recentSince) {
        continue;
      }
      if (prospectBodiesLookSimilar(normalized, existingNormalized)) {
        return prospect;
      }
    }
    return null;
  }

  async touch(id: number): Promise<void> {
    this.db.prepare("UPDATE prospects SET updated_at = ? WHERE id = ? AND status = 'open'")
      .run(new Date().toISOString(), id);
    return Promise.resolve();
  }

  async countOpen(): Promise<number> {
    const row = this.db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM prospects WHERE status = 'open'").get();
    return Promise.resolve(row?.n ?? 0);
  }

  async findOldestOpenByKind(kind: ProspectKind): Promise<Prospect | null> {
    const row = this.db.prepare<[string], ProspectRow>(`
      SELECT * FROM prospects WHERE status = 'open' AND kind = ?
      ORDER BY created_at ASC, id ASC LIMIT 1
    `).get(kind);
    return Promise.resolve(row != null ? mapRow(row) : null);
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

/**
 * 重複判定用の本文正規化（#105）: 空白・句読点と、意図表現の語尾ゆらぎ
 * （「〜する必要がある」「〜するつもりだ」等）を落とす。決定論のみ（LLM 不使用）
 */
export function normalizeProspectBody(body: string): string {
  return body
    .trim()
    .replace(/[\s　]+/g, '')
    .replace(/[。．、，・！!？?]/g, '')
    .replace(/(する必要があ(?:る|ります)|する予定(?:である|だ|です)|するつもり(?:である|だ|です)|しようとしてい(?:る|ます)|するべき(?:だ|です)|したい(?:です)?|し続け(?:る|ます)|を検討中(?:である|です)|を検討してい(?:る|ます))$/u, 'する')
    .replace(/(である|です|ます|だ)$/u, '');
}

/**
 * 3-gram の Dice 係数と包含関係による決定論の字面類似判定（#105）。
 * 閾値は「同じ相手名を含むだけの別意図」（例: 「kbx-100からの手紙を読む」と
 * 「kbx-100からの依頼を断る」 ≈ 0.62）を弾き、実機で観測された言い換え重複
 * （「…譲渡提案を処理する」と「…譲渡提案について判断する」 ≈ 0.68）を拾う位置に置く
 */
const PROSPECT_SIMILARITY_DICE_THRESHOLD = 0.65;

export function prospectBodiesLookSimilar(normalizedA: string, normalizedB: string): boolean {
  if (normalizedA.length === 0 || normalizedB.length === 0) {
    return false;
  }
  if (normalizedA.includes(normalizedB) || normalizedB.includes(normalizedA)) {
    return true;
  }
  const a = trigrams(normalizedA);
  const b = trigrams(normalizedB);
  if (a.size === 0 || b.size === 0) {
    return false;
  }
  let shared = 0;
  for (const gram of a) {
    if (b.has(gram)) {
      shared += 1;
    }
  }
  const dice = (2 * shared) / (a.size + b.size);
  return dice >= PROSPECT_SIMILARITY_DICE_THRESHOLD;
}

function trigrams(text: string): Set<string> {
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= text.length; i += 1) {
    grams.add(text.slice(i, i + 3));
  }
  return grams;
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
