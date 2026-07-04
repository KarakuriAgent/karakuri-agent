import type Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

import { createLogger } from '../utils/logger.js';

const logger = createLogger('LifeDbVerification');

/**
 * M3 で使う sqlite-vec / FTS5 trigram の先行ロード検証。
 *
 * FTS5 trigram は 3 文字未満のクエリに構造的にマッチしない。日本語 2 文字語
 * （人名・「映画」等）は MATCH では引けないが LIKE では引けることを実測で確認済み。
 * 判断基準: M3 の想起では 3 文字未満のクエリを LIKE フォールバックで補う
 * （それでも不足する場合に形態素トークナイズ前処理 / PostgreSQL + PGroonga を再検討）。
 */
export interface LifeDbCapabilities {
  sqliteVec: { ok: boolean; version?: string; error?: string };
  fts5Trigram: {
    ok: boolean;
    /** 日本語 2 文字語が MATCH で引けるか（trigram の構造上 false が既知の実測値） */
    twoCharMatch: boolean;
    /** 2 文字語の LIKE フォールバックが機能するか */
    twoCharLikeFallback: boolean;
    error?: string;
  };
}

export function verifyLifeDbCapabilities(db: Database.Database): LifeDbCapabilities {
  const result: LifeDbCapabilities = {
    sqliteVec: { ok: false },
    fts5Trigram: { ok: false, twoCharMatch: false, twoCharLikeFallback: false },
  };

  try {
    sqliteVec.load(db);
    const row = db.prepare('SELECT vec_version() AS version').get() as { version: string };
    db.exec(`
      CREATE VIRTUAL TABLE temp.life_verify_vec USING vec0(id INTEGER PRIMARY KEY, embedding FLOAT[4]);
      DROP TABLE temp.life_verify_vec;
    `);
    result.sqliteVec = { ok: true, version: row.version };
  } catch (error) {
    result.sqliteVec = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  try {
    db.exec("CREATE VIRTUAL TABLE temp.life_verify_fts USING fts5(body, tokenize='trigram')");
    try {
      db.prepare('INSERT INTO temp.life_verify_fts (body) VALUES (?)').run('映画館でBさんと映画を観た');
      const matchCount = (query: string): number =>
        (db.prepare('SELECT COUNT(*) AS count FROM temp.life_verify_fts WHERE life_verify_fts MATCH ?').get(query) as { count: number }).count;
      const likeCount = (db.prepare('SELECT COUNT(*) AS count FROM temp.life_verify_fts WHERE body LIKE ?').get('%映画%') as { count: number }).count;
      result.fts5Trigram = {
        ok: matchCount('映画館') > 0,
        twoCharMatch: matchCount('映画') > 0,
        twoCharLikeFallback: likeCount > 0,
      };
    } finally {
      db.exec('DROP TABLE temp.life_verify_fts');
    }
  } catch (error) {
    result.fts5Trigram = {
      ok: false,
      twoCharMatch: false,
      twoCharLikeFallback: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return result;
}

/** 起動時検証のログ出力。失敗があれば warn（M0 では記録機能に影響しないため起動は続行する）。 */
export function logLifeDbCapabilities(capabilities: LifeDbCapabilities): boolean {
  const healthy = capabilities.sqliteVec.ok && capabilities.fts5Trigram.ok;
  if (healthy) {
    logger.info('Life DB capabilities verified', {
      vecVersion: capabilities.sqliteVec.version,
      fts5TwoCharMatch: capabilities.fts5Trigram.twoCharMatch,
      fts5TwoCharLikeFallback: capabilities.fts5Trigram.twoCharLikeFallback,
    });
  } else {
    logger.warn('Life DB capability verification failed (episodic recall in M3 will be degraded)', {
      sqliteVec: capabilities.sqliteVec,
      fts5Trigram: capabilities.fts5Trigram,
    });
  }
  return healthy;
}
