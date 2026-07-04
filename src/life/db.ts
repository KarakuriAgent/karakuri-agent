import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { createLogger } from '../utils/logger.js';

const logger = createLogger('LifeDb');

export const LIFE_DB_FILE_NAME = 'life.db';

export interface LifeDbMigration {
  version: number;
  up: string;
}

/**
 * 記憶 DB（life.db）のマイグレーション。後続マイルストーンはここへ追記する。
 * 適用済みバージョンは schema_migrations に記録され、起動時に未適用分だけ実行される。
 */
export const LIFE_DB_MIGRATIONS: readonly LifeDbMigration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE experience_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        received_at TEXT NOT NULL,
        channel     TEXT NOT NULL,
        kind        TEXT NOT NULL,
        actor       TEXT,
        payload     TEXT NOT NULL
      );
      CREATE INDEX idx_experience_log_time ON experience_log(received_at);
      CREATE INDEX idx_experience_log_actor ON experience_log(actor, received_at);
      -- 一次資料は不変。アプリ層に加えて DB 層でも append-only を強制する
      CREATE TRIGGER experience_log_no_update BEFORE UPDATE ON experience_log
      BEGIN
        SELECT RAISE(ABORT, 'experience_log is append-only');
      END;
      CREATE TRIGGER experience_log_no_delete BEFORE DELETE ON experience_log
      BEGIN
        SELECT RAISE(ABORT, 'experience_log is append-only');
      END;
    `,
  },
  {
    version: 2,
    up: `
      -- 頻度台帳（飽き・ループ検出の入力）。key は own_action 由来
      CREATE TABLE action_ledger (
        bucket       TEXT NOT NULL,
        key          TEXT NOT NULL,
        window_start TEXT NOT NULL,
        count        INTEGER NOT NULL,
        PRIMARY KEY (bucket, key, window_start)
      );
      CREATE INDEX idx_action_ledger_window ON action_ledger(bucket, window_start);
    `,
  },
  {
    version: 3,
    up: `
      -- 内部状態の現在値（1 行のみ）
      CREATE TABLE inner_state (
        id         INTEGER PRIMARY KEY CHECK (id = 1),
        updated_at TEXT NOT NULL,
        valence    REAL NOT NULL,
        energy     REAL NOT NULL,
        hunger     REAL NOT NULL,
        social     REAL NOT NULL,
        sleeping   INTEGER NOT NULL
      );
      -- 内部状態の履歴（現在値と分けて持つ）
      CREATE TABLE inner_state_history (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        recorded_at TEXT NOT NULL,
        valence     REAL NOT NULL,
        energy      REAL NOT NULL,
        hunger      REAL NOT NULL,
        social      REAL NOT NULL,
        sleeping    INTEGER NOT NULL,
        trigger     TEXT
      );
      CREATE INDEX idx_inner_state_history_time ON inner_state_history(recorded_at);
      -- appraisal 判定ログ（可観測性 + M3 で記銘に接続する判定の記録）
      CREATE TABLE appraisal_log (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id     INTEGER,
        received_at  TEXT NOT NULL,
        channel      TEXT NOT NULL,
        output       TEXT NOT NULL,
        rejections   TEXT,
        proc_version TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX idx_appraisal_log_time ON appraisal_log(received_at);
    `,
  },
];

export interface OpenLifeDatabaseOptions {
  dataDir: string;
  fileName?: string;
  migrations?: readonly LifeDbMigration[];
}

/**
 * life.db を開き、未適用のマイグレーションを適用して返す。
 * 既存の diary.db 等と同じ運用パターン（WAL / synchronous=NORMAL、`data/` コピーでバックアップ完結）。
 */
export function openLifeDatabase({
  dataDir,
  fileName = LIFE_DB_FILE_NAME,
  migrations = LIFE_DB_MIGRATIONS,
}: OpenLifeDatabaseOptions): Database.Database {
  const dbPath = join(dataDir, fileName);
  let db: Database.Database;
  try {
    mkdirSync(dataDir, { recursive: true });
    db = new Database(dbPath);
  } catch (error) {
    throw new Error(`Failed to open life database at ${dbPath}: ${error instanceof Error ? error.message : error}`);
  }

  try {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    const appliedVersions = applyLifeDbMigrations(db, migrations);
    if (appliedVersions.length > 0) {
      logger.info('Applied life DB migrations', { versions: appliedVersions });
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** 未適用のマイグレーションをバージョン昇順に適用し、適用したバージョン一覧を返す。 */
export function applyLifeDbMigrations(
  db: Database.Database,
  migrations: readonly LifeDbMigration[] = LIFE_DB_MIGRATIONS,
): number[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const sorted = [...migrations].sort((left, right) => left.version - right.version);
  const versions = sorted.map((migration) => migration.version);
  if (new Set(versions).size !== versions.length) {
    throw new Error(`Duplicate life DB migration versions: ${versions.join(', ')}`);
  }

  const hasApplied = db.prepare<[number], { version: number }>(
    'SELECT version FROM schema_migrations WHERE version = ?',
  );
  const markApplied = db.prepare<[number, string]>(
    'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
  );

  const applied: number[] = [];
  for (const migration of sorted) {
    if (hasApplied.get(migration.version) != null) {
      continue;
    }

    const runMigration = db.transaction(() => {
      db.exec(migration.up);
      markApplied.run(migration.version, new Date().toISOString());
    });
    runMigration();
    applied.push(migration.version);
  }

  return applied;
}
