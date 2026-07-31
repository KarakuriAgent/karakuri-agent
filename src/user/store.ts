import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import type { IUserStore, LinkUserAliasOptions, UserAlias, UserRecord, UserSearchOptions } from './types.js';
import { createLogger } from '../utils/logger.js';

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 25;
const ALIAS_RESOLUTION_MAX_HOPS = 8;

const logger = createLogger('UserStore');

interface SqliteUserStoreOptions {
  dataDir: string;
}

interface UserRow {
  user_id: string;
  display_name: string;
  created_at: string;
  updated_at: string;
}

interface UserAliasRow {
  alias_user_id: string;
  primary_user_id: string;
  linked_at: string;
  linked_by: string | null;
  note: string | null;
}

interface ExistsRow { matched: 1 }

export class SqliteUserStore implements IUserStore {
  private readonly db: Database.Database;
  private readonly getUserStatement: Database.Statement<[string], UserRow>;
  private readonly ensureUserStatement: Database.Statement<[string, string, string, string]>;
  private readonly searchUsersStatement: Database.Statement<
    [string, string, string, string, string, number, number],
    UserRow
  >;
  private readonly getAliasStatement: Database.Statement<[string], UserAliasRow>;
  private readonly listAliasesStatement: Database.Statement<[string], UserAliasRow>;
  private readonly insertAliasStatement: Database.Statement<[string, string, string, string | null, string | null]>;
  private readonly deleteAliasStatement: Database.Statement<[string]>;
  private readonly existsUserStatement: Database.Statement<[string], ExistsRow>;
  private readonly hasAliasesAsPrimaryStatement: Database.Statement<[string], ExistsRow>;
  private readonly linkUserAliasTransaction: (
    alias: string,
    primary: string,
    linkedBy: string | undefined,
    note: string | undefined,
  ) => void;

  constructor({ dataDir }: SqliteUserStoreOptions) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new Database(join(dataDir, 'users.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_aliases (
        alias_user_id TEXT PRIMARY KEY,
        primary_user_id TEXT NOT NULL,
        linked_at TEXT NOT NULL,
        linked_by TEXT,
        note TEXT,
        CHECK (alias_user_id != primary_user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_users_display_name_nocase
        ON users(display_name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_users_updated_at
        ON users(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_user_aliases_primary
        ON user_aliases(primary_user_id);
    `);

    this.getUserStatement = this.db.prepare<[string], UserRow>(`
      SELECT user_id, display_name, created_at, updated_at
      FROM users
      WHERE user_id = ?
    `);
    // 旧 post-response evaluator の updateDisplayName 削除に伴い、表示名は観測のたびに
    // ここで追随させる（空文字での上書きだけは防ぐ）
    this.ensureUserStatement = this.db.prepare(`
      INSERT INTO users (user_id, display_name, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        display_name = COALESCE(NULLIF(excluded.display_name, ''), display_name),
        updated_at = excluded.updated_at
    `);
    this.searchUsersStatement = this.db.prepare<
      [string, string, string, string, string, number, number],
      UserRow
    >(`
      SELECT user_id, display_name, created_at, updated_at
      FROM (
        SELECT
          user_id,
          display_name,
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
          OR display_name LIKE ? ESCAPE '\\')
      )
      ORDER BY match_rank ASC, updated_at DESC, display_name COLLATE NOCASE ASC, user_id ASC
      LIMIT ? OFFSET ?
    `);
    this.getAliasStatement = this.db.prepare<[string], UserAliasRow>(`
      SELECT alias_user_id, primary_user_id, linked_at, linked_by, note
      FROM user_aliases
      WHERE alias_user_id = ?
    `);
    this.listAliasesStatement = this.db.prepare<[string], UserAliasRow>(`
      SELECT alias_user_id, primary_user_id, linked_at, linked_by, note
      FROM user_aliases
      WHERE primary_user_id = ?
      ORDER BY linked_at ASC, alias_user_id ASC
    `);
    this.insertAliasStatement = this.db.prepare(`
      INSERT INTO user_aliases (alias_user_id, primary_user_id, linked_at, linked_by, note)
      VALUES (?, ?, ?, ?, ?)
    `);
    this.deleteAliasStatement = this.db.prepare(`DELETE FROM user_aliases WHERE alias_user_id = ?`);
    this.existsUserStatement = this.db.prepare<[string], ExistsRow>(`
      SELECT 1 AS matched FROM users WHERE user_id = ? LIMIT 1
    `);
    this.hasAliasesAsPrimaryStatement = this.db.prepare<[string], ExistsRow>(`
      SELECT 1 AS matched FROM user_aliases WHERE primary_user_id = ? LIMIT 1
    `);
    this.linkUserAliasTransaction = this.db.transaction((
      alias: string,
      primary: string,
      linkedBy: string | undefined,
      note: string | undefined,
    ) => {
      if (this.existsUserStatement.get(alias) == null || this.existsUserStatement.get(primary) == null) {
        throw new Error('not_found: both alias_user_id and primary_user_id must already exist in users');
      }
      if (this.getAliasStatement.get(alias) != null) {
        throw new Error('already_linked: alias_user_id is already linked');
      }
      if (this.getAliasStatement.get(primary) != null) {
        throw new Error('chain_detected: primary_user_id is already an alias of another user');
      }
      if (this.hasAliasesAsPrimaryStatement.get(alias) != null) {
        throw new Error('cannot_demote_primary: alias_user_id is already a primary user');
      }
      this.insertAliasStatement.run(
        alias,
        primary,
        new Date().toISOString(),
        linkedBy != null && linkedBy.length > 0 ? linkedBy : null,
        note != null && note.length > 0 ? note : null,
      );
    }).immediate;

    this.assertNoAliasChains();
  }

  private assertNoAliasChains(): void {
    const chained = this.db.prepare<[], { alias_user_id: string; primary_user_id: string }>(`
      SELECT a.alias_user_id, a.primary_user_id
      FROM user_aliases a
      WHERE EXISTS (SELECT 1 FROM user_aliases b WHERE b.alias_user_id = a.primary_user_id)
      LIMIT 5
    `).all();
    if (chained.length > 0) {
      logger.warn('Detected user_aliases chain rows; resolveAlias will follow them with bounded hops', {
        examples: chained,
      });
    }
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
      limit,
      offset,
    );
    return Promise.resolve(rows.map(mapUserRow));
  }

  async linkUserAlias(aliasUserId: string, primaryUserId: string, opts: LinkUserAliasOptions = {}): Promise<void> {
    const alias = aliasUserId.trim();
    const primary = primaryUserId.trim();
    if (alias.length === 0 || primary.length === 0) {
      throw new Error('invalid_user_id: user IDs must be non-empty');
    }
    if (alias === primary) {
      throw new Error('self_link: alias_user_id and primary_user_id must be different');
    }

    const note = opts.note?.trim();
    const linkedBy = opts.linkedBy?.trim();
    this.linkUserAliasTransaction(alias, primary, linkedBy, note);
    return Promise.resolve();
  }

  async unlinkUserAlias(aliasUserId: string): Promise<void> {
    const alias = aliasUserId.trim();
    if (alias.length === 0) {
      throw new Error('invalid_user_id: alias_user_id must be non-empty');
    }
    const info = this.deleteAliasStatement.run(alias);
    if (info.changes === 0) {
      throw new Error(`not_linked: alias_user_id is not currently linked: ${alias}`);
    }
    return Promise.resolve();
  }

  async listAliases(primaryUserId: string): Promise<UserAlias[]> {
    return Promise.resolve(this.listAliasesStatement.all(primaryUserId).map(mapAliasRow));
  }

  async listAliasesByPrimaryIds(ids: string[]): Promise<Map<string, UserAlias[]>> {
    const result = new Map<string, UserAlias[]>();
    const uniqueIds = [...new Set(ids)];
    for (const id of uniqueIds) {
      const aliases = this.listAliasesStatement.all(id).map(mapAliasRow);
      if (aliases.length > 0) {
        result.set(id, aliases);
      }
    }
    return Promise.resolve(result);
  }

  async resolveAlias(userId: string): Promise<{ primaryUserId: string; aliasOf: UserAlias | null }> {
    const firstAlias = this.getAliasStatement.get(userId);
    if (firstAlias == null) {
      return Promise.resolve({ primaryUserId: userId, aliasOf: null });
    }
    const visited = new Set<string>([userId]);
    let current = firstAlias;
    for (let hops = 0; hops < ALIAS_RESOLUTION_MAX_HOPS; hops += 1) {
      if (visited.has(current.primary_user_id)) {
        logger.error('Alias chain contains a cycle; stopping resolution at last unique node', {
          userId,
          stoppedAt: current.alias_user_id,
        });
        break;
      }
      visited.add(current.primary_user_id);
      const next = this.getAliasStatement.get(current.primary_user_id);
      if (next == null) {
        return Promise.resolve({ primaryUserId: current.primary_user_id, aliasOf: mapAliasRow(firstAlias) });
      }
      current = next;
    }
    logger.error('Alias chain exceeded max hops; returning last resolved primary as best effort', {
      userId,
      maxHops: ALIAS_RESOLUTION_MAX_HOPS,
    });
    return Promise.resolve({ primaryUserId: current.primary_user_id, aliasOf: mapAliasRow(firstAlias) });
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAliasRow(row: UserAliasRow): UserAlias {
  return {
    aliasUserId: row.alias_user_id,
    primaryUserId: row.primary_user_id,
    linkedAt: row.linked_at,
    linkedBy: row.linked_by,
    note: row.note,
  };
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
