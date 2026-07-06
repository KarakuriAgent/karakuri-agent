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

export interface IPhoneUnreadStore {
  enqueue(message: NewUnreadMessage): Promise<number>;
  /** 未処理メッセージをスレッド単位にまとめて返す（古いスレッド順、maxThreads まで） */
  listPendingThreads(maxThreads: number): Promise<UnreadThread[]>;
  markProcessed(ids: number[], processedAt: Date): Promise<void>;
  countPending(): Promise<number>;
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

  async close(): Promise<void> {
    if (this.ownsDb && this.db.open) {
      this.db.close();
    }
    return Promise.resolve();
  }
}
