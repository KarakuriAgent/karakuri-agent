import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import type { ISnsActivityStore, SnsActivity, SnsActivityType } from './types.js';

// getRecentActivities returns at most DEFAULT_RECENT_ACTIVITY_LIMIT entries
// within a 3-day sliding window, keeping result sets bounded on both axes.
const RECENT_ACTIVITY_WINDOW_MS = 3 * 24 * 60 * 60 * 1_000;
const DEFAULT_RECENT_ACTIVITY_LIMIT = 10;
const LAST_NOTIFICATION_ID_KEY = 'last_notification_id';

interface ActivityRow {
  id: number;
  type: SnsActivityType;
  post_id: string;
  text: string | null;
  reply_to_id: string | null;
  quote_post_id: string | null;
  created_at: string;
}

interface ExistsRow {
  matched: 1;
}

interface MetadataRow {
  value: string;
}

export interface SqliteSnsActivityStoreOptions {
  dataDir: string;
}

export class SqliteSnsActivityStore implements ISnsActivityStore {
  private readonly db: Database.Database;
  private readonly insertActivityStatement: Database.Statement<[
    SnsActivityType,
    string,
    string | null,
    string | null,
    string | null,
    string,
  ]>;
  private readonly hasLikedStatement: Database.Statement<[string], ExistsRow>;
  private readonly hasRepostedStatement: Database.Statement<[string], ExistsRow>;
  private readonly hasRepliedStatement: Database.Statement<[string], ExistsRow>;
  private readonly hasQuotedStatement: Database.Statement<[string], ExistsRow>;
  private readonly getRecentActivitiesStatement: Database.Statement<[string, number], ActivityRow>;
  private readonly getMetadataStatement: Database.Statement<[string], MetadataRow>;
  private readonly upsertMetadataStatement: Database.Statement<[string, string]>;

  constructor({ dataDir }: SqliteSnsActivityStoreOptions) {
    const dbPath = join(dataDir, 'sns-activity.db');
    try {
      mkdirSync(dataDir, { recursive: true });
      this.db = new Database(dbPath);
    } catch (error) {
      throw new Error(`Failed to open SNS activity database at ${dbPath}: ${error instanceof Error ? error.message : error}`);
    }

    try {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sns_activities (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL CHECK(type IN ('post','like','repost')), -- must match SnsActivityType in src/sns/types.ts
          post_id TEXT NOT NULL,
          text TEXT,
          reply_to_id TEXT,
          quote_post_id TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sns_activities_created_at ON sns_activities(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_sns_activities_type_post_id ON sns_activities(type, post_id);
        CREATE INDEX IF NOT EXISTS idx_sns_activities_type_reply_to_id ON sns_activities(type, reply_to_id) WHERE reply_to_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_sns_activities_type_quote_post_id ON sns_activities(type, quote_post_id) WHERE quote_post_id IS NOT NULL;
        CREATE TABLE IF NOT EXISTS sns_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);

      this.insertActivityStatement = this.db.prepare(`
        INSERT INTO sns_activities (type, post_id, text, reply_to_id, quote_post_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      this.hasLikedStatement = this.db.prepare<[string], ExistsRow>(`
        SELECT 1 AS matched FROM sns_activities WHERE type = 'like' AND post_id = ? LIMIT 1
      `);
      this.hasRepostedStatement = this.db.prepare<[string], ExistsRow>(`
        SELECT 1 AS matched FROM sns_activities WHERE type = 'repost' AND post_id = ? LIMIT 1
      `);
      this.hasRepliedStatement = this.db.prepare<[string], ExistsRow>(`
        SELECT 1 AS matched FROM sns_activities WHERE type = 'post' AND reply_to_id = ? LIMIT 1
      `);
      this.hasQuotedStatement = this.db.prepare<[string], ExistsRow>(`
        SELECT 1 AS matched FROM sns_activities WHERE type = 'post' AND quote_post_id = ? LIMIT 1
      `);
      this.getRecentActivitiesStatement = this.db.prepare<[string, number], ActivityRow>(`
        SELECT id, type, post_id, text, reply_to_id, quote_post_id, created_at
        FROM sns_activities
        WHERE created_at >= ?
        ORDER BY created_at DESC
        LIMIT ?
      `);
      this.getMetadataStatement = this.db.prepare<[string], MetadataRow>(`
        SELECT value FROM sns_metadata WHERE key = ?
      `);
      this.upsertMetadataStatement = this.db.prepare(`
        INSERT INTO sns_metadata (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  async recordPost(postId: string, text: string, replyToId?: string, quotePostId?: string): Promise<void> {
    this.insertActivityStatement.run('post', postId, text.trim(), replyToId ?? null, quotePostId ?? null, new Date().toISOString());
    return Promise.resolve();
  }

  async recordLike(postId: string): Promise<void> {
    this.insertActivityStatement.run('like', postId, null, null, null, new Date().toISOString());
    return Promise.resolve();
  }

  async recordRepost(postId: string): Promise<void> {
    this.insertActivityStatement.run('repost', postId, null, null, null, new Date().toISOString());
    return Promise.resolve();
  }

  async hasLiked(postId: string): Promise<boolean> {
    return Promise.resolve(this.hasLikedStatement.get(postId) != null);
  }

  async hasReposted(postId: string): Promise<boolean> {
    return Promise.resolve(this.hasRepostedStatement.get(postId) != null);
  }

  async hasReplied(replyToId: string): Promise<boolean> {
    return Promise.resolve(this.hasRepliedStatement.get(replyToId) != null);
  }

  async hasQuoted(postId: string): Promise<boolean> {
    return Promise.resolve(this.hasQuotedStatement.get(postId) != null);
  }

  async getRecentActivities(limit = DEFAULT_RECENT_ACTIVITY_LIMIT): Promise<SnsActivity[]> {
    const rows = this.getRecentActivitiesStatement.all(
      new Date(Date.now() - RECENT_ACTIVITY_WINDOW_MS).toISOString(),
      Math.max(1, limit),
    );
    return Promise.resolve(rows.map((row): SnsActivity => {
      if (row.type === 'post') {
        return {
          id: row.id,
          type: 'post',
          postId: row.post_id,
          text: row.text ?? '',
          ...(row.reply_to_id != null ? { replyToId: row.reply_to_id } : {}),
          ...(row.quote_post_id != null ? { quotePostId: row.quote_post_id } : {}),
          createdAt: row.created_at,
        };
      }
      return {
        id: row.id,
        type: row.type as 'like' | 'repost',
        postId: row.post_id,
        createdAt: row.created_at,
      };
    }));
  }

  async getLastNotificationId(): Promise<string | null> {
    return Promise.resolve(this.getMetadataStatement.get(LAST_NOTIFICATION_ID_KEY)?.value ?? null);
  }

  async setLastNotificationId(notificationId: string): Promise<void> {
    this.upsertMetadataStatement.run(LAST_NOTIFICATION_ID_KEY, notificationId);
    return Promise.resolve();
  }

  async close(): Promise<void> {
    if (this.db.open) {
      this.db.close();
    }
    return Promise.resolve();
  }
}
