import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { verifyLifeDbCapabilities } from '../src/life/db-verification.js';

const databases: Database.Database[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) {
    if (db.open) {
      db.close();
    }
  }
});

describe('verifyLifeDbCapabilities', () => {
  it('loads sqlite-vec and verifies FTS5 trigram behavior for Japanese', () => {
    const db = new Database(':memory:');
    databases.push(db);

    const capabilities = verifyLifeDbCapabilities(db);

    expect(capabilities.sqliteVec.ok).toBe(true);
    expect(capabilities.sqliteVec.version).toMatch(/^v/);
    expect(capabilities.fts5Trigram.ok).toBe(true);
    // trigram は 3 文字未満のクエリに構造的にマッチしない（既知の実測値）。
    // M3 の想起では 3 文字未満のクエリを LIKE フォールバックで補う判断基準。
    expect(capabilities.fts5Trigram.twoCharMatch).toBe(false);
    expect(capabilities.fts5Trigram.twoCharLikeFallback).toBe(true);
  });

  it('does not leave verification tables behind', () => {
    const db = new Database(':memory:');
    databases.push(db);

    verifyLifeDbCapabilities(db);

    const tempTables = db.prepare(
      "SELECT name FROM sqlite_temp_master WHERE name LIKE 'life_verify%'",
    ).all();
    expect(tempTables).toEqual([]);
  });
});
