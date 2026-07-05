import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

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
  {
    version: 4,
    up: `
      -- エピソード（導出ビュー）。本文は生活の語彙で書く
      CREATE TABLE episodes (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at  TEXT NOT NULL,
        channel      TEXT NOT NULL,
        body         TEXT NOT NULL,
        importance   REAL NOT NULL,
        buoyancy     REAL NOT NULL DEFAULT 1.0,
        emotion      TEXT,
        participants TEXT,
        provenance   TEXT NOT NULL,
        proc_version TEXT NOT NULL
      );
      CREATE INDEX idx_episodes_time ON episodes(occurred_at);
      -- 全文検索（external content。episodes への書き込みとトリガーで同期）
      CREATE VIRTUAL TABLE episodes_fts USING fts5(body, content='episodes', content_rowid='id', tokenize='trigram');
      CREATE TRIGGER episodes_fts_ai AFTER INSERT ON episodes BEGIN
        INSERT INTO episodes_fts(rowid, body) VALUES (new.id, new.body);
      END;
      CREATE TRIGGER episodes_fts_ad AFTER DELETE ON episodes BEGIN
        INSERT INTO episodes_fts(episodes_fts, rowid, body) VALUES ('delete', old.id, old.body);
      END;
      CREATE TRIGGER episodes_fts_au AFTER UPDATE OF body ON episodes BEGIN
        INSERT INTO episodes_fts(episodes_fts, rowid, body) VALUES ('delete', old.id, old.body);
        INSERT INTO episodes_fts(rowid, body) VALUES (new.id, new.body);
      END;
      -- 開いたエピソード（ドラフト）。クラッシュ後は「中断された体験」として close する
      CREATE TABLE episode_drafts (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        channel       TEXT NOT NULL,
        thread_key    TEXT NOT NULL,
        started_at    TEXT NOT NULL,
        last_event_at TEXT NOT NULL,
        beats         TEXT NOT NULL,
        participants  TEXT NOT NULL,
        emotions      TEXT NOT NULL,
        provenance    TEXT NOT NULL,
        UNIQUE (channel, thread_key)
      );
      -- 埋め込み backfill 待ち（API 失敗・未設定でエピソード確定をブロックしない）
      CREATE TABLE episode_embedding_pending (
        episode_id INTEGER PRIMARY KEY
      );
      -- 埋め込みモデル・次元数などの運用メタ
      CREATE TABLE life_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    version: 5,
    up: `
      -- 自伝的階層（diary / theme / chapter を kind で共有。改訂で更新）
      CREATE TABLE narratives (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        kind         TEXT NOT NULL,
        period_start TEXT NOT NULL,
        period_end   TEXT NOT NULL,
        body         TEXT NOT NULL,
        revision     INTEGER NOT NULL DEFAULT 1,
        active       INTEGER NOT NULL DEFAULT 1,
        supersedes   INTEGER,
        provenance   TEXT NOT NULL,
        proc_version TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX idx_narratives_kind_period ON narratives(kind, period_start);
      CREATE VIRTUAL TABLE narratives_fts USING fts5(body, content='narratives', content_rowid='id', tokenize='trigram');
      CREATE TRIGGER narratives_fts_ai AFTER INSERT ON narratives BEGIN
        INSERT INTO narratives_fts(rowid, body) VALUES (new.id, new.body);
      END;
      CREATE TRIGGER narratives_fts_ad AFTER DELETE ON narratives BEGIN
        INSERT INTO narratives_fts(narratives_fts, rowid, body) VALUES ('delete', old.id, old.body);
      END;
      CREATE TRIGGER narratives_fts_au AFTER UPDATE OF body ON narratives BEGIN
        INSERT INTO narratives_fts(narratives_fts, rowid, body) VALUES ('delete', old.id, old.body);
        INSERT INTO narratives_fts(rowid, body) VALUES (new.id, new.body);
      END;
      -- 信念（事実 + 自己像）。上書きではなく改訂（supersedes チェーン）
      CREATE TABLE beliefs (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        kind         TEXT NOT NULL,
        subject      TEXT,
        body         TEXT NOT NULL,
        confidence   REAL NOT NULL,
        active       INTEGER NOT NULL DEFAULT 1,
        supersedes   INTEGER,
        provenance   TEXT NOT NULL,
        proc_version TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX idx_beliefs_kind_active ON beliefs(kind, active);
      CREATE INDEX idx_beliefs_subject ON beliefs(subject, active);
    `,
  },
  {
    version: 6,
    up: `
      -- 展望記憶（約束・意図・目標）。status は省察の棚卸しによる状態遷移（経路依存）
      CREATE TABLE prospects (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        kind         TEXT NOT NULL,
        body         TEXT NOT NULL,
        counterpart  TEXT,
        due_at       TEXT,
        status       TEXT NOT NULL DEFAULT 'open',
        provenance   TEXT NOT NULL,
        proc_version TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );
      CREATE INDEX idx_prospects_status ON prospects(status, due_at);
    `,
  },
  {
    version: 7,
    up: `
      -- 社会知識グラフ（エッジテーブル + 再帰 CTE で 1〜2 ホップ展開）
      -- strength / affect は観測の累積で更新される経路依存の値（M7 参照）
      CREATE TABLE relations (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        subject_id   TEXT NOT NULL,
        relation     TEXT NOT NULL,
        object_id    TEXT NOT NULL,
        strength     REAL,
        affect       REAL,
        observed_at  TEXT NOT NULL,
        provenance   TEXT NOT NULL,
        proc_version TEXT NOT NULL,
        UNIQUE (subject_id, relation, object_id)
      );
      CREATE INDEX idx_relations_subject ON relations(subject_id);
      CREATE INDEX idx_relations_object ON relations(object_id);
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
    // sqlite-vec はベクトル検索（episodes_vec）用。ロード失敗しても記録機能は
    // 継続する（vec テーブルは EpisodeEmbeddingIndex 側で遅延作成される）
    try {
      sqliteVec.load(db);
    } catch (error) {
      logger.warn('Failed to load sqlite-vec extension; vector search will be unavailable', {
        error: error instanceof Error ? error.message : error,
      });
    }
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

/** life_meta の読み書き（運用メタ・省察の最終実行日など） */
export function getLifeMeta(db: Database.Database, key: string): string | null {
  const row = db.prepare<[string], { value: string }>(
    'SELECT value FROM life_meta WHERE key = ?',
  ).get(key);
  return row?.value ?? null;
}

export function setLifeMeta(db: Database.Database, key: string, value: string): void {
  db.prepare(
    'INSERT INTO life_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
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
