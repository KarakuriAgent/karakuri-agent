import type Database from 'better-sqlite3';

import { createLogger } from '../utils/logger.js';
import { openLifeDatabase } from './db.js';

const logger = createLogger('EpisodeStore');

export interface Episode {
  id: number;
  occurredAt: string;
  channel: string;
  body: string;
  importance: number;
  buoyancy: number;
  /** 感情推移スナップショット（JSON 由来） */
  emotion: unknown;
  /** actor 規約 ID の配列 */
  participants: string[];
  /** experience_log.id の配列 */
  provenance: number[];
  procVersion: string;
}

export interface NewEpisode {
  occurredAt: string;
  channel: string;
  body: string;
  importance: number;
  emotion?: unknown;
  participants: string[];
  provenance: number[];
  procVersion: string;
}

export interface EpisodeDraft {
  id: number;
  channel: string;
  threadKey: string;
  startedAt: string;
  lastEventAt: string;
  beats: Array<{ at: string; text: string }>;
  participants: string[];
  /** ビートごとの気分変化量（感情推移） */
  emotions: number[];
  provenance: number[];
}

export interface IEpisodeStore {
  insert(episode: NewEpisode): Promise<number>;
  getById(id: number): Promise<Episode | null>;
  listRecent(limit: number): Promise<Episode[]>;
  count(): Promise<number>;
  listByPeriod(fromIso: string, toIso: string): Promise<Episode[]>;
  /** FTS5 trigram 検索（3 文字未満のクエリは LIKE フォールバック）。rank 昇順 */
  searchText(query: string, limit: number): Promise<Array<{ episode: Episode; rank: number }>>;
  updateBuoyancy(id: number, buoyancy: number): Promise<void>;
  /** 忘却 = 浮力の減衰。削除はしない（一次資料は不変） */
  decayBuoyancy(beforeIso: string, factor: number, floor?: number): Promise<number>;
  /**
   * M7 reprocessing 用: 期間内の導出エピソードを破棄する（episodes は導出ビューであり
   * 一次資料ではないため削除できる）。削除した id を返す
   */
  deleteByPeriod(fromIso: string, toIso: string): Promise<number[]>;
  /** M7 reprocessing 用: 全ドラフトを破棄する（リプレイで再構築される） */
  clearDrafts(): Promise<number>;
  // ドラフト操作
  getDraft(channel: string, threadKey: string): Promise<EpisodeDraft | null>;
  listDrafts(): Promise<EpisodeDraft[]>;
  upsertDraft(draft: Omit<EpisodeDraft, 'id'>): Promise<void>;
  deleteDraft(channel: string, threadKey: string): Promise<void>;
  close(): Promise<void>;
}

export interface SqliteEpisodeStoreOptions {
  dataDir?: string | undefined;
  db?: Database.Database | undefined;
}

interface EpisodeRow {
  id: number;
  occurred_at: string;
  channel: string;
  body: string;
  importance: number;
  buoyancy: number;
  emotion: string | null;
  participants: string | null;
  provenance: string;
  proc_version: string;
}

interface DraftRow {
  id: number;
  channel: string;
  thread_key: string;
  started_at: string;
  last_event_at: string;
  beats: string;
  participants: string;
  emotions: string;
  provenance: string;
}

export class SqliteEpisodeStore implements IEpisodeStore {
  private readonly db: Database.Database;
  private readonly ownsDb: boolean;

  constructor({ dataDir, db }: SqliteEpisodeStoreOptions) {
    if (db != null) {
      this.db = db;
      this.ownsDb = false;
    } else if (dataDir != null) {
      this.db = openLifeDatabase({ dataDir });
      this.ownsDb = true;
    } else {
      throw new Error('SqliteEpisodeStore requires either dataDir or db');
    }
  }

  async insert(episode: NewEpisode): Promise<number> {
    const result = this.db.prepare(`
      INSERT INTO episodes (occurred_at, channel, body, importance, buoyancy, emotion, participants, provenance, proc_version)
      VALUES (?, ?, ?, ?, 1.0, ?, ?, ?, ?)
    `).run(
      episode.occurredAt,
      episode.channel,
      episode.body,
      episode.importance,
      episode.emotion != null ? JSON.stringify(episode.emotion) : null,
      JSON.stringify(episode.participants),
      JSON.stringify(episode.provenance),
      episode.procVersion,
    );
    const id = Number(result.lastInsertRowid);
    logger.debug('Episode inserted', { id, channel: episode.channel, importance: episode.importance });
    return Promise.resolve(id);
  }

  async getById(id: number): Promise<Episode | null> {
    const row = this.db.prepare<[number], EpisodeRow>(
      'SELECT * FROM episodes WHERE id = ?',
    ).get(id);
    return Promise.resolve(row != null ? mapEpisodeRow(row) : null);
  }

  async listRecent(limit: number): Promise<Episode[]> {
    const rows = this.db.prepare<[number], EpisodeRow>(
      'SELECT * FROM episodes ORDER BY occurred_at DESC, id DESC LIMIT ?',
    ).all(Math.max(0, limit));
    return Promise.resolve(rows.map(mapEpisodeRow));
  }

  async count(): Promise<number> {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM episodes').get() as { count: number };
    return Promise.resolve(row.count);
  }

  async listByPeriod(fromIso: string, toIso: string): Promise<Episode[]> {
    const rows = this.db.prepare<[string, string], EpisodeRow>(`
      SELECT * FROM episodes
      WHERE occurred_at >= ? AND occurred_at <= ?
      ORDER BY occurred_at ASC, id ASC
    `).all(fromIso, toIso);
    return Promise.resolve(rows.map(mapEpisodeRow));
  }

  async deleteByPeriod(fromIso: string, toIso: string): Promise<number[]> {
    const rows = this.db.prepare<[string, string], { id: number }>(
      'SELECT id FROM episodes WHERE occurred_at >= ? AND occurred_at <= ?',
    ).all(fromIso, toIso);
    const ids = rows.map((row) => row.id);
    if (ids.length === 0) {
      return [];
    }

    const remove = this.db.transaction(() => {
      const deleteEpisode = this.db.prepare('DELETE FROM episodes WHERE id = ?');
      const deletePending = this.db.prepare('DELETE FROM episode_embedding_pending WHERE episode_id = ?');
      for (const id of ids) {
        deleteEpisode.run(id);
        deletePending.run(id);
        // episodes_vec は拡張未ロード環境では存在しないことがある
        try {
          this.db.prepare('DELETE FROM episodes_vec WHERE episode_id = ?').run(BigInt(id));
        } catch {
          // vec テーブルなし: 何もしない
        }
      }
    });
    remove();
    return ids;
  }

  async clearDrafts(): Promise<number> {
    const result = this.db.prepare('DELETE FROM episode_drafts').run();
    return Promise.resolve(result.changes);
  }

  async decayBuoyancy(beforeIso: string, factor: number, floor = 0.05): Promise<number> {
    const result = this.db.prepare(`
      UPDATE episodes
      SET buoyancy = MAX(?, buoyancy * ?)
      WHERE occurred_at < ? AND buoyancy > ?
    `).run(floor, factor, beforeIso, floor);
    return Promise.resolve(result.changes);
  }

  async searchText(query: string, limit: number): Promise<Array<{ episode: Episode; rank: number }>> {
    const normalized = query.trim();
    if (normalized.length === 0 || limit <= 0) {
      return [];
    }

    // FTS5 trigram は 3 文字未満のクエリに構造的にマッチしないため、
    // 短いクエリは LIKE フォールバックで補う（M0 での実測に基づく判断基準）
    if ([...normalized].length < 3) {
      const rows = this.db.prepare<[string, number], EpisodeRow>(`
        SELECT * FROM episodes
        WHERE body LIKE ? ESCAPE '\\'
        ORDER BY occurred_at DESC
        LIMIT ?
      `).all(`%${escapeLikePattern(normalized)}%`, limit);
      return rows.map((row, index) => ({ episode: mapEpisodeRow(row), rank: index + 1 }));
    }

    const matchQuery = buildFtsMatchQuery(normalized);
    try {
      const rows = this.db.prepare<[string, number], EpisodeRow & { fts_rank: number }>(`
        SELECT episodes.*, bm25(episodes_fts) AS fts_rank
        FROM episodes_fts
        JOIN episodes ON episodes.id = episodes_fts.rowid
        WHERE episodes_fts MATCH ?
        ORDER BY fts_rank ASC
        LIMIT ?
      `).all(matchQuery, limit);
      return rows.map((row, index) => ({ episode: mapEpisodeRow(row), rank: index + 1 }));
    } catch (error) {
      logger.warn('FTS search failed; falling back to LIKE', error, { query: normalized });
      const rows = this.db.prepare<[string, number], EpisodeRow>(`
        SELECT * FROM episodes
        WHERE body LIKE ? ESCAPE '\\'
        ORDER BY occurred_at DESC
        LIMIT ?
      `).all(`%${escapeLikePattern(normalized)}%`, limit);
      return rows.map((row, index) => ({ episode: mapEpisodeRow(row), rank: index + 1 }));
    }
  }

  async updateBuoyancy(id: number, buoyancy: number): Promise<void> {
    this.db.prepare('UPDATE episodes SET buoyancy = ? WHERE id = ?').run(
      Math.min(1, Math.max(0, buoyancy)),
      id,
    );
    return Promise.resolve();
  }

  async getDraft(channel: string, threadKey: string): Promise<EpisodeDraft | null> {
    const row = this.db.prepare<[string, string], DraftRow>(
      'SELECT * FROM episode_drafts WHERE channel = ? AND thread_key = ?',
    ).get(channel, threadKey);
    return Promise.resolve(row != null ? mapDraftRow(row) : null);
  }

  async listDrafts(): Promise<EpisodeDraft[]> {
    const rows = this.db.prepare<[], DraftRow>('SELECT * FROM episode_drafts ORDER BY id ASC').all();
    return Promise.resolve(rows.map(mapDraftRow));
  }

  async upsertDraft(draft: Omit<EpisodeDraft, 'id'>): Promise<void> {
    this.db.prepare(`
      INSERT INTO episode_drafts (channel, thread_key, started_at, last_event_at, beats, participants, emotions, provenance)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (channel, thread_key) DO UPDATE SET
        last_event_at = excluded.last_event_at,
        beats = excluded.beats,
        participants = excluded.participants,
        emotions = excluded.emotions,
        provenance = excluded.provenance
    `).run(
      draft.channel,
      draft.threadKey,
      draft.startedAt,
      draft.lastEventAt,
      JSON.stringify(draft.beats),
      JSON.stringify(draft.participants),
      JSON.stringify(draft.emotions),
      JSON.stringify(draft.provenance),
    );
    return Promise.resolve();
  }

  async deleteDraft(channel: string, threadKey: string): Promise<void> {
    this.db.prepare('DELETE FROM episode_drafts WHERE channel = ? AND thread_key = ?').run(channel, threadKey);
    return Promise.resolve();
  }

  async close(): Promise<void> {
    if (this.ownsDb && this.db.open) {
      this.db.close();
    }

    return Promise.resolve();
  }
}

function mapEpisodeRow(row: EpisodeRow): Episode {
  return {
    id: row.id,
    occurredAt: row.occurred_at,
    channel: row.channel,
    body: row.body,
    importance: row.importance,
    buoyancy: row.buoyancy,
    emotion: row.emotion != null ? parseJsonSafe(row.emotion) : null,
    participants: parseJsonArray(row.participants).filter((value): value is string => typeof value === 'string'),
    provenance: parseJsonArray(row.provenance).filter((value): value is number => typeof value === 'number'),
    procVersion: row.proc_version,
  };
}

function mapDraftRow(row: DraftRow): EpisodeDraft {
  return {
    id: row.id,
    channel: row.channel,
    threadKey: row.thread_key,
    startedAt: row.started_at,
    lastEventAt: row.last_event_at,
    beats: (parseJsonArray(row.beats) as Array<{ at: string; text: string }>)
      .filter((beat) => typeof beat?.text === 'string'),
    participants: parseJsonArray(row.participants).filter((value): value is string => typeof value === 'string'),
    emotions: parseJsonArray(row.emotions).filter((value): value is number => typeof value === 'number'),
    provenance: parseJsonArray(row.provenance).filter((value): value is number => typeof value === 'number'),
  };
}

function parseJsonSafe(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseJsonArray(text: string | null): unknown[] {
  if (text == null) {
    return [];
  }
  const parsed = parseJsonSafe(text);
  return Array.isArray(parsed) ? parsed : [];
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/** ユーザー入力を FTS5 のクエリ構文から隔離する（各トークンをダブルクォートで包む） */
export function buildFtsMatchQuery(text: string): string {
  return text
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(' OR ');
}
