import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import type { IUserStore, UserRecord, UserSearchOptions } from './types.js';

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 25;

interface SqliteUserStoreOptions {
  dataDir: string;
}

interface UserRow {
  user_id: string;
  display_name: string;
  profile: string | null;
  created_at: string;
  updated_at: string;
}

export class SqliteUserStore implements IUserStore {
  private readonly db: Database.Database;
  private readonly getUserStatement: Database.Statement<[string], UserRow>;
  private readonly ensureUserStatement: Database.Statement<[
    string,
    string,
    string,
    string,
  ]>;
  private readonly updateProfileStatement: Database.Statement<[string | null, string, string]>;
  private readonly updateDisplayNameStatement: Database.Statement<[string, string, string]>;
  private readonly searchUsersStatement: Database.Statement<
    [string, string, string, string, string, string, number, number],
    UserRow
  >;

  constructor({ dataDir }: SqliteUserStoreOptions) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new Database(join(dataDir, 'users.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        profile TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_users_display_name_nocase
      ON users(display_name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_users_updated_at
      ON users(updated_at DESC);
    `);

    this.getUserStatement = this.db.prepare<[string], UserRow>(`
      SELECT user_id, display_name, profile, created_at, updated_at
      FROM users
      WHERE user_id = ?
    `);
    this.ensureUserStatement = this.db.prepare(`
      INSERT INTO users (user_id, display_name, profile, created_at, updated_at)
      VALUES (?, ?, NULL, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        updated_at = excluded.updated_at
    `);
    this.updateProfileStatement = this.db.prepare(`
      UPDATE users
      SET profile = ?, updated_at = ?
      WHERE user_id = ?
    `);
    this.updateDisplayNameStatement = this.db.prepare(`
      UPDATE users
      SET display_name = ?, updated_at = ?
      WHERE user_id = ?
    `);
    this.searchUsersStatement = this.db.prepare<
      [string, string, string, string, string, string, number, number],
      UserRow
    >(`
      SELECT user_id, display_name, profile, created_at, updated_at
      FROM (
        SELECT
          user_id,
          display_name,
          profile,
          created_at,
          updated_at,
          CASE
            WHEN ? = '' THEN 0
            WHEN display_name = ? COLLATE NOCASE THEN 0
            WHEN display_name LIKE ? ESCAPE '\\' THEN 1
            ELSE 2
          END AS match_rank
        FROM users
        WHERE (? = ''
          OR display_name LIKE ? ESCAPE '\\'
          OR COALESCE(profile, '') LIKE ? ESCAPE '\\')
      )
      ORDER BY match_rank ASC, updated_at DESC, display_name COLLATE NOCASE ASC, user_id ASC
      LIMIT ? OFFSET ?
    `);
  }

  async getUser(userId: string): Promise<UserRecord | null> {
    const row = this.getUserStatement.get(userId);
    return Promise.resolve(row != null ? mapUserRow(row) : null);
  }

  async ensureUser(userId: string, displayName: string): Promise<UserRecord> {
    const normalizedDisplayName = displayName.trim();
    const now = new Date().toISOString();
    this.ensureUserStatement.run(userId, normalizedDisplayName, now, now);
    const user = this.getUserStatement.get(userId);
    if (user == null) {
      throw new Error(`User not found after ensureUser: ${userId}`);
    }

    return Promise.resolve(mapUserRow(user));
  }

  async updateProfile(userId: string, profile: string | null): Promise<void> {
    this.updateProfileStatement.run(profile, new Date().toISOString(), userId);
    return Promise.resolve();
  }

  async updateDisplayName(userId: string, displayName: string): Promise<void> {
    this.updateDisplayNameStatement.run(displayName.trim(), new Date().toISOString(), userId);
    return Promise.resolve();
  }

  async searchUsers(query: string, options?: UserSearchOptions): Promise<UserRecord[]> {
    const normalizedQuery = query.trim();
    const escapedQuery = escapeLikePattern(normalizedQuery);
    const prefixNeedle = `${escapedQuery}%`;
    const containsNeedle = `%${escapedQuery}%`;
    const limit = Math.min(Math.max(options?.limit ?? DEFAULT_SEARCH_LIMIT, 1), MAX_SEARCH_LIMIT);
    const offset = Math.max(options?.offset ?? 0, 0);
    const rows = this.searchUsersStatement.all(
      normalizedQuery,
      normalizedQuery,
      prefixNeedle,
      normalizedQuery,
      containsNeedle,
      containsNeedle,
      limit,
      offset,
    );
    return Promise.resolve(rows.map(mapUserRow));
  }

  async close(): Promise<void> {
    if (this.db.open) {
      this.db.close();
    }

    return Promise.resolve();
  }
}

function mapUserRow(row: UserRow): UserRecord {
  return {
    userId: row.user_id,
    displayName: row.display_name,
    profile: row.profile,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
