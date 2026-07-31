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

/** backfill をこの回数連続で失敗したら API 全体の障害とみなして打ち切る */
const MAX_CONSECUTIVE_BACKFILL_FAILURES = 3;

/**
 * 1 行あたりの backfill 失敗回数の上限。超えた行はコンテンツ起因の恒久失敗と
 * みなして選択から除外し（dead-letter）、後続の pending を飢えさせない。
 * 回収は M7 の --reembed（pending 作り直し = attempts リセット）で行う。
 *
 * API 全体の障害中も先頭行の attempts は進むため（障害とコンテンツ起因は
 * この層では区別できない）、選択を attempts 昇順にして増分を全体へ分散させ、
 * 上限は一時障害で使い切らない程度に大きく取る
 */
const MAX_BACKFILL_ATTEMPTS_PER_EPISODE = 10;

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

    // attempts 昇順で選ぶ: 失敗した行は自然に後回しになり、恒久失敗行が
    // 先頭に居座って毎回同じ場所で打ち切られる飢餓を防ぐ。上限に達した行
    // （内容起因の恒久失敗とみなす）は dead-letter として選択から除外する
    const pending = this.db.prepare<[number, number], { episode_id: number }>(
      'SELECT episode_id FROM episode_embedding_pending WHERE attempts < ? ORDER BY attempts ASC, episode_id ASC LIMIT ?',
    ).all(MAX_BACKFILL_ATTEMPTS_PER_EPISODE, limit);
    let indexed = 0;
    let consecutiveFailures = 0;
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
        const attempts = this.recordBackfillFailure(row.episode_id);
        if (attempts >= MAX_BACKFILL_ATTEMPTS_PER_EPISODE) {
          logger.warn('Episode embedding dead-lettered after repeated failures', {
            episodeId: row.episode_id,
            attempts,
          });
        }
        // 連続失敗は API 全体の障害とみなして打ち切る（行単位の恒久失敗は
        // attempts 上限側で除外されるため、ここは一時障害の早期打ち切り専用）
        consecutiveFailures += 1;
        if (consecutiveFailures >= MAX_CONSECUTIVE_BACKFILL_FAILURES) {
          break;
        }
        continue;
      }
      consecutiveFailures = 0;
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

  /** backfill 失敗を行単位で記録し、更新後の attempts を返す */
  private recordBackfillFailure(episodeId: number): number {
    try {
      const row = this.db.prepare<[number], { attempts: number }>(
        'UPDATE episode_embedding_pending SET attempts = attempts + 1 WHERE episode_id = ? RETURNING attempts',
      ).get(episodeId);
      return row?.attempts ?? 0;
    } catch (error) {
      logger.warn('Failed to record embedding backfill failure', error, { episodeId });
      return 0;
    }
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
