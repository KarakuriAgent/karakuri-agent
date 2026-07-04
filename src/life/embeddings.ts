/**
 * 埋め込み（sqlite-vec）— M3。
 *
 * 埋め込みは OpenAI 互換 API で差し替え可能。API の失敗・未設定でエピソード確定を
 * ブロックしない（FTS のみでも検索可能）。失敗分は episode_embedding_pending に積み、
 * 非同期 backfill で後から埋める。
 */

import { createOpenAI } from '@ai-sdk/openai';
import { embed, type EmbeddingModel } from 'ai';

type StringEmbeddingModel = EmbeddingModel;
import type Database from 'better-sqlite3';

import { createLogger } from '../utils/logger.js';

const logger = createLogger('EpisodeEmbeddingIndex');

export interface IEmbeddingProvider {
  readonly modelName: string;
  embedText(text: string): Promise<number[]>;
}

export interface OpenAiEmbeddingProviderOptions {
  model: string;
  apiKey: string;
  baseURL?: string | undefined;
}

export class OpenAiEmbeddingProvider implements IEmbeddingProvider {
  readonly modelName: string;
  private readonly model: StringEmbeddingModel;

  constructor({ model, apiKey, baseURL }: OpenAiEmbeddingProviderOptions) {
    this.modelName = model;
    const provider = createOpenAI({
      apiKey,
      ...(baseURL != null ? { baseURL } : {}),
    });
    this.model = provider.embedding(model);
  }

  async embedText(text: string): Promise<number[]> {
    const result = await embed({ model: this.model, value: text });
    return result.embedding;
  }
}

export interface EpisodeEmbeddingIndexOptions {
  db: Database.Database;
  provider: IEmbeddingProvider;
  dimensions: number;
}

export class EpisodeEmbeddingIndex {
  private readonly db: Database.Database;
  private readonly provider: IEmbeddingProvider;
  private readonly dimensions: number;
  private available = false;

  constructor({ db, provider, dimensions }: EpisodeEmbeddingIndexOptions) {
    this.db = db;
    this.provider = provider;
    this.dimensions = dimensions;
    this.available = this.ensureVecTable();
  }

  isAvailable(): boolean {
    return this.available;
  }

  /**
   * vec0 仮想テーブルを次元数つきで用意する。既存メタと次元数・モデルが一致しない
   * 場合はベクトル検索を無効化する（再埋め込みは M7 reprocessing の仕事）。
   */
  private ensureVecTable(): boolean {
    try {
      const meta = this.db.prepare<[string], { value: string }>(
        'SELECT value FROM life_meta WHERE key = ?',
      );
      const storedDimensions = meta.get('embedding_dimensions')?.value;
      const storedModel = meta.get('embedding_model')?.value;
      if (storedDimensions != null && Number(storedDimensions) !== this.dimensions) {
        logger.warn('Embedding dimensions changed; vector search disabled until re-embedding (M7)', {
          stored: storedDimensions,
          configured: this.dimensions,
        });
        return false;
      }
      if (storedModel != null && storedModel !== this.provider.modelName) {
        logger.warn('Embedding model changed; vector search disabled until re-embedding (M7)', {
          stored: storedModel,
          configured: this.provider.modelName,
        });
        return false;
      }

      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS episodes_vec USING vec0(
          episode_id INTEGER PRIMARY KEY,
          embedding FLOAT[${this.dimensions}]
        );
      `);
      const setMeta = this.db.prepare(
        'INSERT INTO life_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      );
      setMeta.run('embedding_dimensions', String(this.dimensions));
      setMeta.run('embedding_model', this.provider.modelName);
      return true;
    } catch (error) {
      logger.warn('Failed to prepare episodes_vec table; vector search disabled', {
        error: error instanceof Error ? error.message : error,
      });
      return false;
    }
  }

  /**
   * エピソードの埋め込みを付与する。失敗しても throw せず pending に積む
   * （エピソード確定をブロックしない）。
   */
  async indexEpisode(episodeId: number, body: string): Promise<boolean> {
    if (!this.available) {
      this.markPending(episodeId);
      return false;
    }

    try {
      const embedding = await this.provider.embedText(body);
      this.insertEmbedding(episodeId, embedding);
      this.db.prepare('DELETE FROM episode_embedding_pending WHERE episode_id = ?').run(episodeId);
      return true;
    } catch (error) {
      logger.warn('Failed to embed episode; queued for backfill', error, { episodeId });
      this.markPending(episodeId);
      return false;
    }
  }

  /** pending の埋め込みを後から埋める。埋めた件数を返す */
  async backfillPending(limit = 50): Promise<number> {
    if (!this.available) {
      return 0;
    }

    const pending = this.db.prepare<[number], { episode_id: number }>(
      'SELECT episode_id FROM episode_embedding_pending LIMIT ?',
    ).all(limit);
    let indexed = 0;
    for (const row of pending) {
      const episode = this.db.prepare<[number], { body: string }>(
        'SELECT body FROM episodes WHERE id = ?',
      ).get(row.episode_id);
      if (episode == null) {
        this.db.prepare('DELETE FROM episode_embedding_pending WHERE episode_id = ?').run(row.episode_id);
        continue;
      }
      const succeeded = await this.indexEpisode(row.episode_id, episode.body);
      if (!succeeded) {
        break; // API が落ちている間はリトライを続けない
      }
      indexed += 1;
    }

    if (indexed > 0) {
      logger.info('Backfilled episode embeddings', { indexed });
    }
    return indexed;
  }

  async pendingCount(): Promise<number> {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM episode_embedding_pending').get() as { count: number };
    return row.count;
  }

  /** クエリ文字列の KNN 検索。失敗時は空配列（FTS のみで検索継続） */
  async searchSimilar(text: string, limit: number): Promise<Array<{ episodeId: number; distance: number }>> {
    if (!this.available || limit <= 0) {
      return [];
    }

    try {
      const embedding = await this.provider.embedText(text);
      return this.searchByEmbedding(embedding, limit);
    } catch (error) {
      logger.warn('Vector search failed; continuing with FTS only', error);
      return [];
    }
  }

  getEmbedding(episodeId: number): number[] | null {
    if (!this.available) {
      return null;
    }
    try {
      const row = this.db.prepare<[number], { embedding: Buffer }>(
        'SELECT embedding FROM episodes_vec WHERE episode_id = ?',
      ).get(episodeId);
      if (row == null) {
        return null;
      }
      return [...new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4)];
    } catch {
      return null;
    }
  }

  private searchByEmbedding(embedding: number[], limit: number): Array<{ episodeId: number; distance: number }> {
    const rows = this.db.prepare<[Buffer, number], { episode_id: number; distance: number }>(`
      SELECT episode_id, distance
      FROM episodes_vec
      WHERE embedding MATCH ? AND k = ?
      ORDER BY distance ASC
    `).all(toEmbeddingBuffer(embedding), limit);
    return rows.map((row) => ({ episodeId: row.episode_id, distance: row.distance }));
  }

  private insertEmbedding(episodeId: number, embedding: number[]): void {
    if (embedding.length !== this.dimensions) {
      throw new Error(`Embedding dimensions mismatch: expected ${this.dimensions}, got ${embedding.length}`);
    }
    // vec0 仮想テーブルは upsert 非対応のため delete → insert で置き換える
    const replace = this.db.transaction(() => {
      this.db.prepare('DELETE FROM episodes_vec WHERE episode_id = ?').run(BigInt(episodeId));
      this.db.prepare('INSERT INTO episodes_vec (episode_id, embedding) VALUES (?, ?)')
        .run(BigInt(episodeId), toEmbeddingBuffer(embedding));
    });
    replace();
  }

  private markPending(episodeId: number): void {
    try {
      this.db.prepare('INSERT OR IGNORE INTO episode_embedding_pending (episode_id) VALUES (?)').run(episodeId);
    } catch (error) {
      logger.warn('Failed to mark episode embedding as pending', error, { episodeId });
    }
  }
}

function toEmbeddingBuffer(embedding: number[]): Buffer {
  return Buffer.from(new Float32Array(embedding).buffer);
}
