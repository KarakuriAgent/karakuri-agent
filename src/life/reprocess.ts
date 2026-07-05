/**
 * Reprocessor — 体験ログからの再解釈パイプライン（M7）。
 *
 * 二重真実構造の最大の利点: 導出ビューは provenance / proc_version を持つため、
 * 一次資料（experience_log）から任意範囲を再処理してビューを再構築できる。
 * 初期の未熟な処理系の判断ミスが焼き付かない。
 *
 * 再構築対象の区別:
 * - episodes: 純粋な導出ビュー → 期間削除 + リプレイで全再構築
 * - kind / actor: payload から再導出可能な索引 → 写像改善の遡及適用（rederive）
 * - 経路依存の状態は保持する（再導出しない）:
 *   - prospects.status（省察の棚卸しによる遷移。fulfilled が open に戻ってはいけない）
 *   - relations.strength / affect（観測の累積）
 *   - inner_state（現在値・履歴）
 *   - episodes.buoyancy は経過時間から決定論で再計算する（月次減衰と同じ係数）
 *
 * 冪等性の定義:
 * 1. 決定論部分の同一性 — モック LLM で同一入力 → 同一出力（unit test）
 * 2. 再入可能性 — 同じ範囲は delete → rebuild のため、再実行しても重複生成されない
 *
 * 実行方式はオフライン一括（CLI）。進行中の運用と干渉しないよう、稼働中プロセスとは
 * 別に停止中へ実行するか、干渉が許容できる範囲（過去期間）に限定して使う。
 */

import type Database from 'better-sqlite3';

import { createLogger } from '../utils/logger.js';
import type { GuardedAppraisal } from './appraisal.js';
import type { IEpisodeStore } from './episodes.js';
import type { EpisodeEmbeddingIndex, IEmbeddingProvider } from './embeddings.js';
import { EpisodeEmbeddingIndex as EmbeddingIndexClass } from './embeddings.js';
import { defaultKwKindMapper } from './normalize.js';
import { SegmentationEngine } from './segmentation.js';
import type { IExperienceLogStore, NormalizedEvent } from './types.js';

const logger = createLogger('Reprocessor');

/** 再構築エピソードの浮力を経過時間から決定論で再計算する（月次減衰と同じ係数） */
export function buoyancyForAge(ageDays: number, factorPerMonth = 0.85, floor = 0.05): number {
  if (ageDays <= 0) {
    return 1;
  }
  return Math.max(floor, Math.pow(factorPerMonth, ageDays / 30));
}

export type ReplayAppraiseFn = (event: NormalizedEvent) => Promise<GuardedAppraisal | null>;

export interface ReprocessorOptions {
  experienceLogStore: IExperienceLogStore;
  episodeStore: IEpisodeStore;
  /** 1 イベントの appraisal（本番は LLM、テストはモック）。null はスキップ */
  appraise: ReplayAppraiseFn;
  procVersion: string;
  maxBeats?: number | undefined;
  maxDraftHours?: number | undefined;
  now?: () => Date;
}

export interface ReprocessEpisodesResult {
  deletedEpisodes: number;
  replayedEvents: number;
  createdEpisodes: number;
  appraisalFailures: number;
}

export class Reprocessor {
  constructor(private readonly options: ReprocessorOptions) {}

  /**
   * 期間内の episodes を破棄し、experience_log から再生成する。
   * 状態（inner_state / prospects / relations）には一切書かない。
   */
  async reprocessEpisodes(fromIso: string, toIso: string): Promise<ReprocessEpisodesResult> {
    const deleted = await this.options.episodeStore.deleteByPeriod(fromIso, toIso);
    await this.options.episodeStore.clearDrafts();

    const segmentation = new SegmentationEngine({
      episodeStore: this.options.episodeStore,
      procVersion: this.options.procVersion,
      ...(this.options.maxBeats != null ? { maxBeats: this.options.maxBeats } : {}),
      ...(this.options.maxDraftHours != null ? { maxDraftHours: this.options.maxDraftHours } : {}),
    });

    const countBefore = await this.options.episodeStore.count();
    const records = await this.options.experienceLogStore.listBetween(fromIso, toIso);
    let appraisalFailures = 0;
    for (const record of records) {
      const event: NormalizedEvent = {
        receivedAt: new Date(record.receivedAt),
        channel: record.channel,
        kind: record.kind,
        ...(record.actor != null ? { actor: record.actor } : {}),
        payload: parsePayload(record.payload),
      };
      try {
        const guarded = await this.options.appraise(event);
        if (guarded == null) {
          continue;
        }
        await segmentation.handleEvent({ event, eventId: record.id, guarded });
      } catch (error) {
        appraisalFailures += 1;
        logger.warn('Replay appraisal failed; skipping event', error, { eventId: record.id });
      }
    }

    // 残ったドラフトを機械的に閉じる（リプレイの終端 = 「中断された体験」）
    const farFuture = new Date(new Date(toIso).getTime() + 365 * 86_400_000);
    await segmentation.recoverStaleDrafts(farFuture);

    // 浮力（経路依存）は経過時間から決定論で再計算する
    const now = this.options.now?.() ?? new Date();
    const rebuilt = await this.options.episodeStore.listByPeriod(fromIso, toIso);
    for (const episode of rebuilt) {
      const ageDays = (now.getTime() - new Date(episode.occurredAt).getTime()) / 86_400_000;
      await this.options.episodeStore.updateBuoyancy(episode.id, buoyancyForAge(ageDays));
    }

    const created = await this.options.episodeStore.count() - countBefore;
    const result: ReprocessEpisodesResult = {
      deletedEpisodes: deleted.length,
      replayedEvents: records.length,
      createdEpisodes: created,
      appraisalFailures,
    };
    logger.info('Episodes reprocessed', result);
    return result;
  }
}

/**
 * kind / actor 索引の遡及再導出（M0 の写像改善を過去ログへ適用する）。
 * payload / received_at / channel（一次資料の本体）には触れない。
 * experience_log の append-only トリガーを一時的に外して索引列のみ更新する。
 */
export function rederiveKwEventKinds(
  db: Database.Database,
  fromIso: string,
  toIso: string,
  kindMapper: (rawKind: string) => string = defaultKwKindMapper,
): number {
  interface Row { id: number; kind: string; payload: string }
  const rows = db.prepare<[string, string], Row>(`
    SELECT id, kind, payload FROM experience_log
    WHERE received_at >= ? AND received_at <= ? AND channel LIKE 'kw:%' AND kind != 'own_action'
  `).all(fromIso, toIso);

  const updates: Array<{ id: number; kind: string }> = [];
  for (const row of rows) {
    const rawKind = extractRawKind(row.payload);
    if (rawKind == null) {
      continue;
    }
    const nextKind = kindMapper(rawKind);
    if (nextKind !== row.kind) {
      updates.push({ id: row.id, kind: nextKind });
    }
  }
  if (updates.length === 0) {
    return 0;
  }

  const apply = db.transaction(() => {
    db.exec('DROP TRIGGER IF EXISTS experience_log_no_update');
    try {
      const update = db.prepare('UPDATE experience_log SET kind = ? WHERE id = ?');
      for (const entry of updates) {
        update.run(entry.kind, entry.id);
      }
    } finally {
      db.exec(`
        CREATE TRIGGER experience_log_no_update BEFORE UPDATE ON experience_log
        BEGIN
          SELECT RAISE(ABORT, 'experience_log is append-only');
        END;
      `);
    }
  });
  apply();
  logger.info('Rederived KW event kinds', { updated: updates.length });
  return updates.length;
}

export interface ReembedResult {
  queued: number;
  indexed: number;
}

/**
 * 埋め込みモデル差し替え時の全再埋め込み。
 * vec0 仮想テーブルは次元数変更に耐えないため作り直す。
 */
export async function reembedAllEpisodes(
  db: Database.Database,
  provider: IEmbeddingProvider,
  dimensions: number,
): Promise<{ index: EpisodeEmbeddingIndex; result: ReembedResult }> {
  db.exec('DROP TABLE IF EXISTS episodes_vec');
  db.prepare('DELETE FROM life_meta WHERE key IN (?, ?)').run('embedding_dimensions', 'embedding_model');
  db.exec('DELETE FROM episode_embedding_pending');

  const index = new EmbeddingIndexClass({ db, provider, dimensions });
  const episodes = db.prepare<[], { id: number }>('SELECT id FROM episodes').all();
  const queue = db.prepare('INSERT OR IGNORE INTO episode_embedding_pending (episode_id) VALUES (?)');
  for (const episode of episodes) {
    queue.run(episode.id);
  }

  let indexed = 0;
  // backfill は失敗で停止するため、進む限り回す
  for (;;) {
    const batch = await index.backfillPending(100);
    indexed += batch;
    if (batch === 0) {
      break;
    }
  }

  logger.info('Re-embedded episodes', { queued: episodes.length, indexed });
  return { index, result: { queued: episodes.length, indexed } };
}

function parsePayload(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

function extractRawKind(payloadJson: string): string | null {
  const payload = parsePayload(payloadJson);
  if (typeof payload !== 'object' || payload == null) {
    return null;
  }
  const notification = (payload as Record<string, unknown>).notification;
  if (typeof notification === 'object' && notification != null) {
    const kind = (notification as Record<string, unknown>).kind;
    if (typeof kind === 'string' && kind.length > 0) {
      return kind;
    }
  }
  const topKind = (payload as Record<string, unknown>).kind;
  return typeof topKind === 'string' && topKind.length > 0 ? topKind : null;
}
