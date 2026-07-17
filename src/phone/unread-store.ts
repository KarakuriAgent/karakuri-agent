/**
 * スマホ未読キュー（M8）。
 *
 * KW カスタムコマンド統合が有効なとき、Discord のユーザーメッセージは即応答せず
 * ここへ積まれ、エージェントが世界内で `check_phone`（スマホを見る）を選んだときに
 * スレッド単位でまとめて処理される。未読の件数だけが KW の行動選択プロンプトへ
 * 注入される（本文は入れない — 行動選択の乗っ取り防止）。
 */

import type Database from 'better-sqlite3';

import { openLifeDatabase } from '../life/db.js';

export interface UnreadMessage {
  id: number;
  source: string;
  threadId: string;
  messageId: string | null;
  authorId: string | null;
  authorName: string | null;
  body: string;
  receivedAt: string;
}

export interface NewUnreadMessage {
  source: string;
  threadId: string;
  messageId?: string | undefined;
  authorId?: string | undefined;
  authorName?: string | undefined;
  body: string;
  receivedAt: Date;
}

export interface UnreadThread {
  threadId: string;
  messages: UnreadMessage[];
}

/** スレッドごとの会話状態（M9 #110）: 催促判定・能動送信の礼儀ゲートの一次データ */
export interface PhoneThreadState {
  threadId: string;
  counterpartId: string | null;
  counterpartName: string | null;
  lastIncomingAt: Date | null;
  lastOutgoingAt: Date | null;
  lastProactiveAt: Date | null;
  lastNudgeAt: Date | null;
}

export interface NoteOutgoingOptions {
  /** 能動送信（send_message）による発信。礼儀ゲート（最小間隔・日次上限）の基準になる */
  proactive?: boolean;
  /** 催促（返事待ちの追い送り）。同一スレッドのクールダウン基準になる */
  nudge?: boolean;
}

export interface IPhoneUnreadStore {
  enqueue(message: NewUnreadMessage): Promise<number>;
  /** 未処理メッセージをスレッド単位にまとめて返す（古いスレッド順、maxThreads まで） */
  listPendingThreads(maxThreads: number): Promise<UnreadThread[]>;
  markProcessed(ids: number[], processedAt: Date): Promise<void>;
  countPending(): Promise<number>;
  /** 最も古い未処理メッセージの受信時刻（無ければ null）。返信待ち圧の導出に使う */
  oldestPendingReceivedAt(): Promise<Date | null>;
  /** 既知スレッドの会話状態を返す（M9）。着信は enqueue が自動更新する */
  listThreadStates(): Promise<PhoneThreadState[]>;
  /** 発信を記録する（check_phone 返信・send_message 送信成功時） */
  noteOutgoing(threadId: string, at: Date, options?: NoteOutgoingOptions): Promise<void>;
  /** since 以降に能動送信したスレッド数（日次上限ゲート用） */
  countProactiveSince(since: Date): Promise<number>;
  close(): Promise<void>;
}

interface UnreadRow {
  id: number;
  source: string;
  thread_id: string;
  message_id: string | null;
  author_id: string | null;
  author_name: string | null;
  body: string;
  received_at: string;
}

export interface SqlitePhoneUnreadStoreOptions {
  dataDir?: string | undefined;
  /** 既に開いた life.db を共有する場合に指定。指定時は close してもこの接続は閉じない */
  db?: Database.Database | undefined;
}

export class SqlitePhoneUnreadStore implements IPhoneUnreadStore {
  private readonly db: Database.Database;
  private readonly ownsDb: boolean;

  constructor({ dataDir, db }: SqlitePhoneUnreadStoreOptions) {
    if (db != null) {
      this.db = db;
      this.ownsDb = false;
    } else if (dataDir != null) {
      this.db = openLifeDatabase({ dataDir });
      this.ownsDb = true;
    } else {
      throw new Error('SqlitePhoneUnreadStore requires either dataDir or db');
    }
  }

  async enqueue(message: NewUnreadMessage): Promise<number> {
    const result = this.db.prepare(`
      INSERT INTO phone_unread (source, thread_id, message_id, author_id, author_name, body, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      message.source,
      message.threadId,
      message.messageId ?? null,
      message.authorId ?? null,
      message.authorName ?? null,
      message.body,
      message.receivedAt.toISOString(),
    );
    // 会話状態台帳（M9）: 着信を記録する。counterpart は分かるときだけ上書きし、
    // last_incoming_at は後退させない
    this.db.prepare(`
      INSERT INTO phone_thread_state (thread_id, counterpart_id, counterpart_name, last_incoming_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        counterpart_id = COALESCE(excluded.counterpart_id, counterpart_id),
        counterpart_name = COALESCE(excluded.counterpart_name, counterpart_name),
        last_incoming_at = MAX(COALESCE(last_incoming_at, ''), excluded.last_incoming_at)
    `).run(
      message.threadId,
      message.authorId ?? null,
      message.authorName ?? null,
      message.receivedAt.toISOString(),
    );
    return Promise.resolve(Number(result.lastInsertRowid));
  }

  async listPendingThreads(maxThreads: number): Promise<UnreadThread[]> {
    const rows = this.db.prepare(`
      SELECT id, source, thread_id, message_id, author_id, author_name, body, received_at
      FROM phone_unread
      WHERE processed_at IS NULL
        AND thread_id IN (
          SELECT thread_id FROM phone_unread
          WHERE processed_at IS NULL
          GROUP BY thread_id
          ORDER BY MIN(id) ASC
          LIMIT ?
        )
      ORDER BY thread_id, id ASC
    `).all(Math.max(0, maxThreads)) as UnreadRow[];

    const threads = new Map<string, UnreadThread>();
    for (const row of rows) {
      const thread = threads.get(row.thread_id) ?? { threadId: row.thread_id, messages: [] };
      thread.messages.push({
        id: row.id,
        source: row.source,
        threadId: row.thread_id,
        messageId: row.message_id,
        authorId: row.author_id,
        authorName: row.author_name,
        body: row.body,
        receivedAt: row.received_at,
      });
      threads.set(row.thread_id, thread);
    }
    // 最古の未読が古いスレッドから処理する
    return Promise.resolve([...threads.values()].sort((a, b) => (a.messages[0]?.id ?? 0) - (b.messages[0]?.id ?? 0)));
  }

  async markProcessed(ids: number[], processedAt: Date): Promise<void> {
    if (ids.length === 0) {
      return Promise.resolve();
    }
    const statement = this.db.prepare('UPDATE phone_unread SET processed_at = ? WHERE id = ?');
    const run = this.db.transaction((targets: number[]) => {
      for (const id of targets) {
        statement.run(processedAt.toISOString(), id);
      }
    });
    run(ids);
    return Promise.resolve();
  }

  async countPending(): Promise<number> {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM phone_unread WHERE processed_at IS NULL').get() as { count: number };
    return Promise.resolve(row.count);
  }

  async oldestPendingReceivedAt(): Promise<Date | null> {
    const row = this.db.prepare('SELECT MIN(received_at) AS oldest FROM phone_unread WHERE processed_at IS NULL').get() as { oldest: string | null };
    return Promise.resolve(row.oldest != null ? new Date(row.oldest) : null);
  }

  async listThreadStates(): Promise<PhoneThreadState[]> {
    const rows = this.db.prepare(`
      SELECT thread_id, counterpart_id, counterpart_name, last_incoming_at, last_outgoing_at, last_proactive_at, last_nudge_at
      FROM phone_thread_state
    `).all() as Array<{
      thread_id: string;
      counterpart_id: string | null;
      counterpart_name: string | null;
      last_incoming_at: string | null;
      last_outgoing_at: string | null;
      last_proactive_at: string | null;
      last_nudge_at: string | null;
    }>;
    return Promise.resolve(rows.map((row) => ({
      threadId: row.thread_id,
      counterpartId: row.counterpart_id,
      counterpartName: row.counterpart_name,
      lastIncomingAt: row.last_incoming_at != null ? new Date(row.last_incoming_at) : null,
      lastOutgoingAt: row.last_outgoing_at != null ? new Date(row.last_outgoing_at) : null,
      lastProactiveAt: row.last_proactive_at != null ? new Date(row.last_proactive_at) : null,
      lastNudgeAt: row.last_nudge_at != null ? new Date(row.last_nudge_at) : null,
    })));
  }

  async noteOutgoing(threadId: string, at: Date, options: NoteOutgoingOptions = {}): Promise<void> {
    const iso = at.toISOString();
    this.db.prepare(`
      INSERT INTO phone_thread_state (thread_id, last_outgoing_at, last_proactive_at, last_nudge_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        last_outgoing_at = MAX(COALESCE(last_outgoing_at, ''), excluded.last_outgoing_at),
        last_proactive_at = COALESCE(excluded.last_proactive_at, last_proactive_at),
        last_nudge_at = COALESCE(excluded.last_nudge_at, last_nudge_at)
    `).run(
      threadId,
      iso,
      options.proactive === true ? iso : null,
      options.nudge === true ? iso : null,
    );
    return Promise.resolve();
  }

  async countProactiveSince(since: Date): Promise<number> {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS count FROM phone_thread_state WHERE last_proactive_at >= ?',
    ).get(since.toISOString()) as { count: number };
    return Promise.resolve(row.count);
  }

  async close(): Promise<void> {
    if (this.ownsDb && this.db.open) {
      this.db.close();
    }
    return Promise.resolve();
  }
}
