import type Database from 'better-sqlite3';

import { createLogger } from '../utils/logger.js';
import { openLifeDatabase } from './db.js';
import type {
  ExperienceLogFilter,
  ExperienceLogRecord,
  IExperienceLogStore,
  NormalizedEvent,
} from './types.js';

const logger = createLogger('ExperienceLogStore');

export interface SqliteExperienceLogStoreOptions {
  dataDir?: string | undefined;
  /** 既に開いた life.db を共有する場合に指定。指定時は close してもこの接続は閉じない */
  db?: Database.Database | undefined;
}

interface ExperienceLogRow {
  id: number;
  received_at: string;
  channel: string;
  kind: string;
  actor: string | null;
  payload: string;
}

/**
 * experience_log の追記専用ストア。
 * 一次資料は不変 — UPDATE / DELETE は提供せず、DB トリガーでも禁止している。
 * 削除要請等の運用要件は「記銘前の除外」で対応する（過去分への遡及マスキングは行わない。
 * 詳細は docs/design/living-agent.md「セキュリティ考慮」の運用ポリシー参照）。
 */
export class SqliteExperienceLogStore implements IExperienceLogStore {
  private readonly db: Database.Database;
  private readonly ownsDb: boolean;
  private readonly appendStatement: Database.Statement<[string, string, string, string | null, string]>;
  private readonly countStatement: Database.Statement<[], { count: number }>;

  constructor({ dataDir, db }: SqliteExperienceLogStoreOptions) {
    if (db != null) {
      this.db = db;
      this.ownsDb = false;
    } else if (dataDir != null) {
      this.db = openLifeDatabase({ dataDir });
      this.ownsDb = true;
    } else {
      throw new Error('SqliteExperienceLogStore requires either dataDir or db');
    }

    this.appendStatement = this.db.prepare(`
      INSERT INTO experience_log (received_at, channel, kind, actor, payload)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.countStatement = this.db.prepare<[], { count: number }>(
      'SELECT COUNT(*) AS count FROM experience_log',
    );
  }

  async append(event: NormalizedEvent): Promise<number> {
    const result = this.appendStatement.run(
      event.receivedAt.toISOString(),
      event.channel,
      event.kind,
      event.actor ?? null,
      serializePayload(event.payload),
    );
    logger.debug('Experience appended', {
      id: result.lastInsertRowid,
      channel: event.channel,
      kind: event.kind,
    });
    return Promise.resolve(Number(result.lastInsertRowid));
  }

  async getRecent(limit: number, filter?: ExperienceLogFilter): Promise<ExperienceLogRecord[]> {
    if (limit <= 0) {
      return [];
    }

    const conditions: string[] = [];
    const parameters: Array<string | number> = [];
    if (filter?.channel != null) {
      conditions.push('channel = ?');
      parameters.push(filter.channel);
    }
    if (filter?.kind != null) {
      conditions.push('kind = ?');
      parameters.push(filter.kind);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db.prepare<Array<string | number>, ExperienceLogRow>(`
      SELECT id, received_at, channel, kind, actor, payload
      FROM experience_log
      ${whereClause}
      ORDER BY id DESC
      LIMIT ?
    `).all(...parameters, limit);

    return rows.map((row) => ({
      id: row.id,
      receivedAt: row.received_at,
      channel: row.channel,
      kind: row.kind,
      actor: row.actor,
      payload: row.payload,
    }));
  }

  async listBetween(fromIso: string, toIso: string, limit = 10_000, afterId = 0): Promise<ExperienceLogRecord[]> {
    const rows = this.db.prepare<[string, string, number, number], ExperienceLogRow>(`
      SELECT id, received_at, channel, kind, actor, payload
      FROM experience_log
      WHERE received_at >= ? AND received_at <= ? AND id > ?
      ORDER BY id ASC
      LIMIT ?
    `).all(fromIso, toIso, afterId, Math.max(0, limit));

    return rows.map((row) => ({
      id: row.id,
      receivedAt: row.received_at,
      channel: row.channel,
      kind: row.kind,
      actor: row.actor,
      payload: row.payload,
    }));
  }

  async countBetween(fromIso: string, toIso: string): Promise<number> {
    const row = this.db.prepare<[string, string], { count: number }>(
      'SELECT COUNT(*) AS count FROM experience_log WHERE received_at >= ? AND received_at <= ?',
    ).get(fromIso, toIso);
    return Promise.resolve(row?.count ?? 0);
  }

  async listChannelsBetween(fromIso: string, toIso: string): Promise<string[]> {
    const rows = this.db.prepare<[string, string], { channel: string }>(
      'SELECT DISTINCT channel FROM experience_log WHERE received_at >= ? AND received_at <= ? ORDER BY channel ASC',
    ).all(fromIso, toIso);
    return Promise.resolve(rows.map((row) => row.channel));
  }

  async maxReceivedAt(ids: number[]): Promise<string | null> {
    let max: string | null = null;
    // SQLite のバインド変数上限を超えないようチャンクで問い合わせる
    for (let offset = 0; offset < ids.length; offset += 500) {
      const chunk = ids.slice(offset, offset + 500);
      const placeholders = chunk.map(() => '?').join(', ');
      const row = this.db.prepare<number[], { max: string | null }>(
        `SELECT MAX(received_at) AS max FROM experience_log WHERE id IN (${placeholders})`,
      ).get(...chunk);
      if (row?.max != null && (max == null || row.max > max)) {
        max = row.max;
      }
    }
    return Promise.resolve(max);
  }

  async count(): Promise<number> {
    return Promise.resolve(this.countStatement.get()?.count ?? 0);
  }

  async close(): Promise<void> {
    if (this.ownsDb && this.db.open) {
      this.db.close();
    }

    return Promise.resolve();
  }
}

function serializePayload(payload: unknown): string {
  if (typeof payload === 'string') {
    return payload;
  }

  try {
    const serialized = JSON.stringify(payload);
    // JSON.stringify(undefined) は undefined を返すため明示的に補う
    return serialized ?? 'null';
  } catch {
    // 循環参照等でも一次資料の記録は継続する（設計原則「未知を落とさない」）
    return JSON.stringify({ unserializable: String(payload) });
  }
}
