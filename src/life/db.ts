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
