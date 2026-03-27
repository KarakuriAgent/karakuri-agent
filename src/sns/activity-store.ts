import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { createLogger } from '../utils/logger.js';
import type {
  ActivityRecord,
  ISnsActivityStore,
  ISnsScheduleStore,
  ScheduledAction,
  ScheduledActionInput,
  ScheduledLikeParams,
  ScheduledPostParams,
  ScheduledRepostParams,
  SnsActivity,
  SnsActivityType,
} from './types.js';

const logger = createLogger('SnsActivityStore');
const RECENT_ACTIVITY_WINDOW_MS = 3 * 24 * 60 * 60 * 1_000;
const DEFAULT_RECENT_ACTIVITY_LIMIT = 10;
const LAST_NOTIFICATION_ID_KEY = 'last_notification_id';

type ScheduledActionStatus = 'pending' | 'executing' | 'completed' | 'failed';

interface ActivityRow {
  id: number;
  type: SnsActivityType;
  post_id: string;
  text: string | null;
  reply_to_id: string | null;
  quote_post_id: string | null;
  created_at: string;
}

interface ScheduledActionRow {
  id: number;
  action_type: 'post' | 'like' | 'repost';
  scheduled_at: string;
  params: string;
  status: ScheduledActionStatus;
  created_at: string;
  executing_started_at: string | null;
}

interface ExistsRow {
  matched: 1;
}

interface MetadataRow {
  value: string;
}

interface NotificationReservationRow {
  token: string;
  notification_id: string;
  created_at: string;
}

interface TableInfoRow {
  name: string;
}

export interface SqliteSnsActivityStoreOptions {
  dataDir: string;
  now?: (() => Date) | undefined;
}

export class SqliteSnsActivityStore implements ISnsActivityStore, ISnsScheduleStore {
  private readonly db: Database.Database;
  private readonly now: () => Date;
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
  private readonly insertNotificationReservationStatement: Database.Statement<[string, string, string]>;
  private readonly selectNotificationReservationStatement: Database.Statement<[string], NotificationReservationRow>;
  private readonly deleteNotificationReservationStatement: Database.Statement<[string]>;
  private readonly deleteAllNotificationReservationsStatement: Database.Statement<[]>;
  private readonly insertScheduledActionStatement: Database.Statement<[
    'post' | 'like' | 'repost',
    string,
    string,
    string,
    string,
  ]>;
  private readonly selectDueScheduledActionsStatement: Database.Statement<[string, number], ScheduledActionRow>;
  private readonly claimScheduledActionStatement: Database.Statement<[string, number]>;
  private readonly updateScheduledFailureStatement: Database.Statement<[string, number]>;
  private readonly getPendingAndExecutingStatement: Database.Statement<[], ScheduledActionRow>;
  private readonly recoverAllStaleExecutingStatement: Database.Statement<[]>;
  private readonly recoverStaleExecutingBeforeStatement: Database.Statement<[string]>;
  private readonly markScheduledCompletedStatement: Database.Statement<[number]>;

  constructor({ dataDir, now }: SqliteSnsActivityStoreOptions) {
    const dbPath = join(dataDir, 'sns-activity.db');
    try {
      mkdirSync(dataDir, { recursive: true });
      this.db = new Database(dbPath);
    } catch (error) {
      throw new Error(`Failed to open SNS activity database at ${dbPath}: ${error instanceof Error ? error.message : error}`);
    }

    this.now = now ?? (() => new Date());

    try {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sns_activities (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL CHECK(type IN ('post','like','repost')),
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
        CREATE TABLE IF NOT EXISTS sns_notification_reservations (
          token TEXT PRIMARY KEY,
          notification_id TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sns_scheduled_actions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          action_type TEXT NOT NULL CHECK(action_type IN ('post', 'like', 'repost')),
          scheduled_at TEXT NOT NULL,
          params TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'executing', 'completed', 'failed')),
          error TEXT,
          created_at TEXT NOT NULL,
          executing_started_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_sns_scheduled_pending
          ON sns_scheduled_actions (status, scheduled_at) WHERE status = 'pending';
      `);
      ensureScheduledActionColumns(this.db);

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
      this.insertNotificationReservationStatement = this.db.prepare(`
        INSERT INTO sns_notification_reservations (token, notification_id, created_at)
        VALUES (?, ?, ?)
      `);
      this.selectNotificationReservationStatement = this.db.prepare<[string], NotificationReservationRow>(`
        SELECT token, notification_id, created_at
        FROM sns_notification_reservations
        WHERE token = ?
      `);
      this.deleteNotificationReservationStatement = this.db.prepare(`
        DELETE FROM sns_notification_reservations
        WHERE token = ?
      `);
      this.deleteAllNotificationReservationsStatement = this.db.prepare(`
        DELETE FROM sns_notification_reservations
      `);
      this.insertScheduledActionStatement = this.db.prepare(`
        INSERT INTO sns_scheduled_actions (action_type, scheduled_at, params, status, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      this.selectDueScheduledActionsStatement = this.db.prepare<[string, number], ScheduledActionRow>(`
        SELECT id, action_type, scheduled_at, params, status, created_at, executing_started_at
        FROM sns_scheduled_actions
        WHERE status = 'pending' AND scheduled_at <= ?
        ORDER BY scheduled_at ASC, id ASC
        LIMIT ?
      `);
      this.claimScheduledActionStatement = this.db.prepare(`
        UPDATE sns_scheduled_actions
        SET status = 'executing', error = NULL, executing_started_at = ?
        WHERE id = ?
      `);
      this.updateScheduledFailureStatement = this.db.prepare(`
        UPDATE sns_scheduled_actions
        SET status = 'failed', error = ?, executing_started_at = NULL
        WHERE id = ? AND status = 'executing'
      `);
      this.getPendingAndExecutingStatement = this.db.prepare(`
        SELECT id, action_type, scheduled_at, params, status, created_at, executing_started_at
        FROM sns_scheduled_actions
        WHERE status IN ('pending', 'executing')
        ORDER BY scheduled_at ASC, id ASC
      `);
      this.recoverAllStaleExecutingStatement = this.db.prepare(`
        UPDATE sns_scheduled_actions
        SET status = 'pending', error = NULL
        WHERE status = 'executing'
      `);
      this.recoverStaleExecutingBeforeStatement = this.db.prepare(`
        UPDATE sns_scheduled_actions
        SET status = 'pending', error = NULL
        WHERE status = 'executing'
          AND (executing_started_at IS NULL OR executing_started_at <= ?)
      `);
      this.markScheduledCompletedStatement = this.db.prepare(`
        UPDATE sns_scheduled_actions
        SET status = 'completed', error = NULL, executing_started_at = NULL
        WHERE id = ?
      `);
      // Clear stale reservations from a previous process that may have crashed
      // before committing or releasing its reservations.
      this.deleteAllNotificationReservationsStatement.run();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  async recordPost(postId: string, text: string, replyToId?: string, quotePostId?: string): Promise<void> {
    this.insertActivity('post', postId, text.trim(), replyToId ?? null, quotePostId ?? null, this.now().toISOString());
    return Promise.resolve();
  }

  async recordLike(postId: string): Promise<void> {
    this.insertActivity('like', postId, null, null, null, this.now().toISOString());
    return Promise.resolve();
  }

  async recordRepost(postId: string): Promise<void> {
    this.insertActivity('repost', postId, null, null, null, this.now().toISOString());
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
      new Date(this.now().getTime() - RECENT_ACTIVITY_WINDOW_MS).toISOString(),
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

  async reserveLastNotificationId(notificationId: string): Promise<string> {
    const reservationToken = randomUUID();
    this.insertNotificationReservationStatement.run(reservationToken, notificationId, this.now().toISOString());
    return Promise.resolve(reservationToken);
  }

  async commitLastNotificationReservation(reservationToken: string): Promise<void> {
    this.runImmediateTransaction(() => {
      const reservation = this.selectNotificationReservationStatement.get(reservationToken);
      if (reservation == null) {
        throw new Error(`Notification reservation not found during commit (token: ${reservationToken})`);
      }
      const committed = this.getMetadataStatement.get(LAST_NOTIFICATION_ID_KEY)?.value ?? null;
      const nextNotificationId = maxNotificationId(committed, reservation.notification_id);
      if (nextNotificationId != null) {
        this.upsertMetadataStatement.run(LAST_NOTIFICATION_ID_KEY, nextNotificationId);
      }
      this.deleteNotificationReservationStatement.run(reservationToken);
    });
    return Promise.resolve();
  }

  async releaseLastNotificationReservation(reservationToken: string): Promise<void> {
    this.deleteNotificationReservationStatement.run(reservationToken);
    return Promise.resolve();
  }

  async schedule(action: ScheduledActionInput): Promise<number> {
    const result = this.insertScheduledActionStatement.run(
      action.actionType,
      action.scheduledAt.toISOString(),
      JSON.stringify(action.params),
      'pending',
      this.now().toISOString(),
    );
    return Promise.resolve(Number(result.lastInsertRowid));
  }

  async claimPendingActions(now: Date, limit = Number.MAX_SAFE_INTEGER): Promise<ScheduledAction[]> {
    const normalizedLimit = Number.isFinite(limit)
      ? Math.max(1, Math.floor(limit))
      : Number.MAX_SAFE_INTEGER;
    return Promise.resolve(this.runImmediateTransaction(() => {
      const rows = this.selectDueScheduledActionsStatement.all(now.toISOString(), normalizedLimit);
      for (const row of rows) {
        this.claimScheduledActionStatement.run(now.toISOString(), row.id);
      }
      return rows.map((row) => ({
        ...mapScheduledActionRow(row),
        status: 'executing' as const,
        recoveredFromExecuting: row.executing_started_at != null,
      }));
    }));
  }

  async completeWithRecord(id: number, record: ActivityRecord): Promise<void> {
    this.runImmediateTransaction(() => {
      this.markScheduledCompletedStatement.run(id);
      const createdAt = record.createdAt?.toISOString() ?? this.now().toISOString();
      switch (record.type) {
        case 'post':
          this.insertActivity('post', record.postId, record.text.trim(), record.replyToId ?? null, record.quotePostId ?? null, createdAt);
          break;
        case 'like':
          this.insertActivity('like', record.postId, null, null, null, createdAt);
          break;
        case 'repost':
          this.insertActivity('repost', record.postId, null, null, null, createdAt);
          break;
      }
    });
    return Promise.resolve();
  }

  async markFailed(id: number, error: string): Promise<void> {
    const result = this.updateScheduledFailureStatement.run(error, id);
    if (result.changes === 0) {
      logger.warn('markFailed was a no-op; action may have been recovered concurrently', { id, error });
    }
    return Promise.resolve();
  }

  async recoverStaleExecuting(before?: Date): Promise<number> {
    const result = before != null
      ? this.recoverStaleExecutingBeforeStatement.run(before.toISOString())
      : this.recoverAllStaleExecutingStatement.run();
    return Promise.resolve(result.changes);
  }

  async getPendingAndExecuting(): Promise<ScheduledAction[]> {
    return Promise.resolve(this.getPendingAndExecutingStatement.all().map((row) => mapScheduledActionRow(row)));
  }

  async close(): Promise<void> {
    if (this.db.open) {
      this.db.close();
    }
    return Promise.resolve();
  }

  private insertActivity(
    type: SnsActivityType,
    postId: string,
    text: string | null,
    replyToId: string | null,
    quotePostId: string | null,
    createdAt: string,
  ): void {
    this.insertActivityStatement.run(type, postId, text, replyToId, quotePostId, createdAt);
  }

  private runImmediateTransaction<T>(callback: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

function mapScheduledActionRow(row: ScheduledActionRow): ScheduledAction {
  const scheduledAt = new Date(row.scheduled_at);
  if (Number.isNaN(scheduledAt.getTime())) {
    throw new Error(`Invalid scheduled_at in sns_scheduled_actions row ${row.id}`);
  }

  switch (row.action_type) {
    case 'post': {
      const params = parseScheduledPostParams(row.params, row.id);
      return {
        id: row.id,
        actionType: 'post',
        scheduledAt,
        params,
        status: row.status as 'pending' | 'executing',
        createdAt: row.created_at,
        recoveredFromExecuting: row.executing_started_at != null,
      };
    }
    case 'like': {
      const params = parseScheduledLikeParams(row.params, row.id);
      return {
        id: row.id,
        actionType: 'like',
        scheduledAt,
        params,
        status: row.status as 'pending' | 'executing',
        createdAt: row.created_at,
        recoveredFromExecuting: row.executing_started_at != null,
      };
    }
    case 'repost': {
      const params = parseScheduledRepostParams(row.params, row.id);
      return {
        id: row.id,
        actionType: 'repost',
        scheduledAt,
        params,
        status: row.status as 'pending' | 'executing',
        createdAt: row.created_at,
        recoveredFromExecuting: row.executing_started_at != null,
      };
    }
  }
}

function parseScheduledPostParams(raw: string, id: number): ScheduledPostParams {
  const params = parseJsonObject(raw, id);
  if (typeof params.text !== 'string' || params.text.trim().length === 0) {
    throw new Error(`Invalid scheduled post params in row ${id}: text is required`);
  }
  const validVisibilities = new Set(['public', 'unlisted', 'private', 'direct']);
  if (typeof params.visibility !== 'string' || !validVisibilities.has(params.visibility)) {
    throw new Error(`Invalid scheduled post params in row ${id}: visibility must be one of ${[...validVisibilities].join(', ')}`);
  }
  if (params.mediaIds != null && (!Array.isArray(params.mediaIds) || params.mediaIds.some((value) => typeof value !== 'string'))) {
    throw new Error(`Invalid scheduled post params in row ${id}: mediaIds must be an array of strings`);
  }

  return {
    text: params.text,
    visibility: params.visibility as ScheduledPostParams['visibility'],
    ...(typeof params.replyToId === 'string' ? { replyToId: params.replyToId } : {}),
    ...(typeof params.quotePostId === 'string' ? { quotePostId: params.quotePostId } : {}),
    ...(Array.isArray(params.mediaIds) ? { mediaIds: params.mediaIds as string[] } : {}),
  };
}

function parseScheduledLikeParams(raw: string, id: number): ScheduledLikeParams {
  const params = parseJsonObject(raw, id);
  if (typeof params.postId !== 'string' || params.postId.trim().length === 0) {
    throw new Error(`Invalid scheduled like params in row ${id}: postId is required`);
  }
  return { postId: params.postId };
}

function parseScheduledRepostParams(raw: string, id: number): ScheduledRepostParams {
  const params = parseJsonObject(raw, id);
  if (typeof params.postId !== 'string' || params.postId.trim().length === 0) {
    throw new Error(`Invalid scheduled repost params in row ${id}: postId is required`);
  }
  return { postId: params.postId };
}

function parseJsonObject(raw: string, id: number): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Expected object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Invalid scheduled action params in row ${id}: ${error instanceof Error ? error.message : error}`);
  }
}

function ensureScheduledActionColumns(db: Database.Database): void {
  const columns = db.prepare<[], TableInfoRow>('PRAGMA table_info(sns_scheduled_actions)').all();
  const columnNames = new Set(columns.map((column) => column.name));
  if (!columnNames.has('executing_started_at')) {
    db.exec('ALTER TABLE sns_scheduled_actions ADD COLUMN executing_started_at TEXT');
  }
}

function maxNotificationId(left: string | null, right: string | null): string | null {
  if (left == null) {
    return right;
  }
  if (right == null) {
    return left;
  }
  return compareNotificationIds(left, right) >= 0 ? left : right;
}

// Mastodon uses monotonically increasing numeric IDs, so for all-numeric IDs
// of differing lengths, comparing by length is sufficient (longer = newer).
// Falls back to lexicographic comparison for non-numeric or equal-length IDs.
function compareNotificationIds(left: string, right: string): number {
  const numericPattern = /^\d+$/;
  if (numericPattern.test(left) && numericPattern.test(right)) {
    if (left.length !== right.length) {
      return left.length - right.length;
    }
  }
  return left.localeCompare(right);
}
