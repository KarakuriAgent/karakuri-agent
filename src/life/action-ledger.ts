import type Database from 'better-sqlite3';

import { createLogger } from '../utils/logger.js';
import { openLifeDatabase } from './db.js';

const logger = createLogger('ActionLedgerStore');

/** 頻度台帳のバケット。行動・話題・場所・相手の出現をルールベースでカウントする（LLM 不要）。 */
export type ActionLedgerBucket = 'action' | 'topic' | 'place' | 'target';

export interface ActionLedgerEntry {
  bucket: string;
  key: string;
  windowStart: string;
  count: number;
}

export interface IActionLedgerStore {
  increment(bucket: ActionLedgerBucket, key: string, occurredAt: Date): Promise<void>;
  /** since 以降のウィンドウを key ごとに集計して返す（count 降順） */
  getCounts(bucket: ActionLedgerBucket, since: Date): Promise<Array<{ key: string; count: number }>>;
  close(): Promise<void>;
}

export interface SqliteActionLedgerStoreOptions {
  dataDir?: string | undefined;
  /** 既に開いた life.db を共有する場合に指定。指定時は close してもこの接続は閉じない */
  db?: Database.Database | undefined;
  /** 集計ウィンドウ幅（分）。既定 60 分 */
  windowMinutes?: number | undefined;
}

export class SqliteActionLedgerStore implements IActionLedgerStore {
  private readonly db: Database.Database;
  private readonly ownsDb: boolean;
  private readonly windowMs: number;
  private readonly incrementStatement: Database.Statement<[string, string, string]>;

  constructor({ dataDir, db, windowMinutes = 60 }: SqliteActionLedgerStoreOptions) {
    if (db != null) {
      this.db = db;
      this.ownsDb = false;
    } else if (dataDir != null) {
      this.db = openLifeDatabase({ dataDir });
      this.ownsDb = true;
    } else {
      throw new Error('SqliteActionLedgerStore requires either dataDir or db');
    }

    this.windowMs = Math.max(1, windowMinutes) * 60_000;
    this.incrementStatement = this.db.prepare(`
      INSERT INTO action_ledger (bucket, key, window_start, count)
      VALUES (?, ?, ?, 1)
      ON CONFLICT (bucket, key, window_start) DO UPDATE SET count = count + 1
    `);
  }

  async increment(bucket: ActionLedgerBucket, key: string, occurredAt: Date): Promise<void> {
    const windowStart = this.windowStartFor(occurredAt);
    this.incrementStatement.run(bucket, key, windowStart);
    logger.debug('Action ledger incremented', { bucket, key, windowStart });
    return Promise.resolve();
  }

  async getCounts(bucket: ActionLedgerBucket, since: Date): Promise<Array<{ key: string; count: number }>> {
    const rows = this.db.prepare<[string, string], { key: string; total: number }>(`
      SELECT key, SUM(count) AS total
      FROM action_ledger
      WHERE bucket = ? AND window_start >= ?
      GROUP BY key
      ORDER BY total DESC, key ASC
    `).all(bucket, this.windowStartFor(since));

    return rows.map((row) => ({ key: row.key, count: row.total }));
  }

  async close(): Promise<void> {
    if (this.ownsDb && this.db.open) {
      this.db.close();
    }

    return Promise.resolve();
  }

  private windowStartFor(occurredAt: Date): string {
    return new Date(Math.floor(occurredAt.getTime() / this.windowMs) * this.windowMs).toISOString();
  }
}
