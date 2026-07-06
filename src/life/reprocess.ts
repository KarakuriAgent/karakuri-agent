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
 * 実行方式はオフライン一括（CLI）。稼働中プロセスと同時に走らせると、リプレイと
 * 進行中の分節化が同じドラフトテーブルを取り合うため、必ず停止中に実行する。
 * （過去期間に限定してもこの前提は外せない: 長寿命チャネルはほぼ全ての過去範囲に
 * 含まれるため、範囲外で進行中のドラフトは開始時刻で退避・復元して保護する）
 */

import type Database from 'better-sqlite3';

import { toUtcIso } from '../utils/date.js';
import { createLogger } from '../utils/logger.js';
import type { GuardedAppraisal } from './appraisal.js';
import type { Episode, IEpisodeStore } from './episodes.js';
import type { EpisodeEmbeddingIndex, IEmbeddingProvider } from './embeddings.js';
import { EpisodeEmbeddingIndex as EmbeddingIndexClass } from './embeddings.js';
import { defaultKwKindMapper, extractKwActorFromPayload } from './normalize.js';
import { SEGMENTATION_DEFAULTS, SegmentationEngine } from './segmentation.js';
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
  /** 範囲を跨ぐため削除もリプレイもしなかった確定済みエピソード数 */
  protectedEpisodes: number;
  clearedDrafts: number;
  replayedEvents: number;
  /** 保護対象（跨ぎエピソード・退避ドラフト）に属するためリプレイしなかったイベント数 */
  skippedEvents: number;
  createdEpisodes: number;
  appraisalFailures: number;
}

/** リプレイの 1 バッチ件数。experience_log をページングで全件読む */
const REPLAY_BATCH_SIZE = 1_000;

export class Reprocessor {
  constructor(private readonly options: ReprocessorOptions) {}

  /**
   * 期間内の episodes を破棄し、experience_log から再生成する。
   * 状態（inner_state / prospects / relations）には一切書かない。
   * ドラフトの破棄・強制 close はリプレイ対象イベントに登場するチャネルに
   * 限定し、さらに範囲の外にはみ出すドラフト（範囲より後に始まった生きた体験、
   * 範囲を跨ぐ体験）はリプレイ前に退避してリプレイ後に復元する。ハザードは
   * チャネルではなく時間軸にある: 過去期間の reprocess でも、同じチャネルで
   * 「いま」進行中のドラフトを消したり、リプレイのビートを混入させたり
   * してはいけない。
   */
  async reprocessEpisodes(fromIsoInput: string, toIsoInput: string): Promise<ReprocessEpisodesResult> {
    // 保存値（Date.toISOString 形式）との文字列比較を成立させるため UTC ISO へ
    // 正規化する（オフセット形式の --to 等をそのまま比較すると誤判定になる）
    const fromIso = toUtcIso(fromIsoInput);
    const toIso = toUtcIso(toIsoInput);
    const channels = await this.options.experienceLogStore.listChannelsBetween(fromIso, toIso);

    // 範囲境界を跨ぐ確定済みエピソードの保護。削除は occurred_at（開始時刻）基準、
    // リプレイは received_at 基準のため、境界を跨ぐエピソードを素朴に扱うと
    // 「削除されたのに末尾ビートが再生されない」「削除されないのに先頭側の
    // イベントが再生されて部分エピソードが重複する」の両方が起きる。
    // ドラフトと同じ方針で保護する: 跨ぐエピソードは削除せず、そのイベントは
    // リプレイでも分節化しない
    const protectedEpisodes: Episode[] = [];
    const deletableIds: number[] = [];
    for (const episode of await this.options.episodeStore.listByPeriod(fromIso, toIso)) {
      const lastEventAt = await this.options.experienceLogStore.maxReceivedAt(episode.provenance);
      if (lastEventAt != null && lastEventAt > toIso) {
        protectedEpisodes.push(episode);
      } else {
        deletableIds.push(episode.id);
      }
    }
    // 範囲開始より前に始まり範囲内へ食い込むエピソードも同様に保護対象へ集める
    // （削除はされないが、範囲内イベントをリプレイすると重複が生まれる）。
    // エピソードの時間的な広がりは分節化ガードレール（maxDraftHours）で抑えられて
    // いるため、余裕を持たせた lookback 窓の走査で足りる
    const lookbackMs = (this.options.maxDraftHours ?? SEGMENTATION_DEFAULTS.maxDraftHours) * 2 * 3_600_000;
    const fromMs = new Date(fromIso).getTime();
    const lookbackStartIso = new Date(fromMs - lookbackMs).toISOString();
    const beforeFromIso = new Date(fromMs - 1).toISOString();
    for (const episode of await this.options.episodeStore.listByPeriod(lookbackStartIso, beforeFromIso)) {
      const lastEventAt = await this.options.experienceLogStore.maxReceivedAt(episode.provenance);
      if (lastEventAt != null && lastEventAt >= fromIso) {
        protectedEpisodes.push(episode);
      }
    }
    if (protectedEpisodes.length > 0) {
      logger.info('Protecting finalized episodes straddling the replay range', {
        protectedEpisodes: protectedEpisodes.length,
      });
    }
    const deleted = await this.options.episodeStore.deleteByIds(deletableIds);

    // リプレイが完全に再構築できるドラフト（= 全ビートが [from, to] 内）だけを
    // 破棄し、範囲外にはみ出すドラフトは退避してリプレイ後に復元する。
    // 範囲より後に始まった生きたドラフトのほか、範囲を跨ぐドラフトも
    // はみ出し部分のビートを失わないよう保護する
    const preservedDrafts = (await this.options.episodeStore.listDrafts())
      .filter((draft) => channels.includes(draft.channel)
        && (draft.startedAt < fromIso || draft.lastEventAt > toIso));
    const clearedDrafts = await this.options.episodeStore.clearDrafts(channels) - preservedDrafts.length;
    if (clearedDrafts > 0 || preservedDrafts.length > 0) {
      logger.info('Cleared episode drafts for replay', {
        clearedDrafts,
        preservedDrafts: preservedDrafts.length,
        channels,
      });
    }

    // 保護対象（跨ぎエピソード・退避ドラフト）に属するイベントはリプレイしない。
    // 保護した側にビートが残っているため、再分節化すると同じ体験が
    // 切り詰められた重複エピソードとして二重に記銘されてしまう
    const skipEventIds = new Set<number>();
    for (const episode of protectedEpisodes) {
      for (const id of episode.provenance) {
        skipEventIds.add(id);
      }
    }
    for (const draft of preservedDrafts) {
      for (const id of draft.provenance) {
        skipEventIds.add(id);
      }
    }

    const segmentation = new SegmentationEngine({
      episodeStore: this.options.episodeStore,
      procVersion: this.options.procVersion,
      ...(this.options.maxBeats != null ? { maxBeats: this.options.maxBeats } : {}),
      ...(this.options.maxDraftHours != null ? { maxDraftHours: this.options.maxDraftHours } : {}),
    });

    const countBefore = await this.options.episodeStore.count();
    // 削除した範囲はリプレイ側も limit で切らずページングで全件流す
    // （切ると削除だけされて再生成されないデータ消失になる）
    let replayedEvents = 0;
    let skippedEvents = 0;
    let appraisalFailures = 0;
    let afterId = 0;
    try {
      for (;;) {
        const records = await this.options.experienceLogStore.listBetween(fromIso, toIso, REPLAY_BATCH_SIZE, afterId);
        const last = records.at(-1);
        if (last == null) {
          break;
        }
        afterId = last.id;
        for (const record of records) {
          if (skipEventIds.has(record.id)) {
            skippedEvents += 1;
            continue;
          }
          replayedEvents += 1;
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
        if (records.length < REPLAY_BATCH_SIZE) {
          break;
        }
      }

      // リプレイが開いたまま残したドラフトを機械的に閉じる
      // （リプレイの終端 = 「中断された体験」。対象チャネルに限定する）
      const farFuture = new Date(new Date(toIso).getTime() + 365 * 86_400_000);
      await segmentation.recoverStaleDrafts(farFuture, channels);
    } finally {
      // 退避した進行中ドラフトは、リプレイが途中で失敗・中断しても必ず復元する
      // （clearDrafts 後はプロセスメモリにしか存在しないため）。正常経路では
      // リプレイ残骸を上で全て close 済みなので (channel, thread_key) は衝突せず、
      // 異常経路では upsert が残骸を退避前の内容で上書きする
      for (const draft of preservedDrafts) {
        const { id: _id, ...draftBody } = draft;
        await this.options.episodeStore.upsertDraft(draftBody);
      }
    }

    // 浮力（経路依存）は経過時間から決定論で再計算する。
    // 保護した跨ぎエピソードは再構築していないため対象外（減衰履歴を保持する）
    const protectedIds = new Set(protectedEpisodes.map((episode) => episode.id));
    const now = this.options.now?.() ?? new Date();
    const rebuilt = (await this.options.episodeStore.listByPeriod(fromIso, toIso))
      .filter((episode) => !protectedIds.has(episode.id));
    for (const episode of rebuilt) {
      const ageDays = (now.getTime() - new Date(episode.occurredAt).getTime()) / 86_400_000;
      await this.options.episodeStore.updateBuoyancy(episode.id, buoyancyForAge(ageDays));
    }

    const created = await this.options.episodeStore.count() - countBefore;
    const result: ReprocessEpisodesResult = {
      deletedEpisodes: deleted,
      protectedEpisodes: protectedEpisodes.length,
      clearedDrafts,
      replayedEvents,
      skippedEvents,
      createdEpisodes: created,
      appraisalFailures,
    };
    logger.info('Episodes reprocessed', result);
    return result;
  }
}

/** rederive の 1 バッチ件数。全行（payload 込み）を一度に材料化しない */
const REDERIVE_BATCH_SIZE = 1_000;

export interface RederiveKwIndexesOptions {
  kindMapper?: ((rawKind: string) => string) | undefined;
  actorExtractor?: ((payload: unknown) => string | undefined) | undefined;
}

// value は非 null に限定する: 抽出・写像が値を返せない行は既存値を保持する方針で、
// トリガー解除経路で索引を NULL に潰す書き込みを型の上でも許さない
interface KwIndexUpdates {
  kind: Array<{ id: number; value: string }>;
  actor: Array<{ id: number; value: string }>;
}

/**
 * kind / actor 索引の遡及再導出（M0 の写像改善を過去ログへ適用する）。
 * payload / received_at / channel（一次資料の本体）には触れない。
 * experience_log の append-only トリガーを一時的に外して索引列のみ更新する。
 *
 * 単一のページングスキャンで両列ぶんの差分を集め、単一トランザクションで適用する。
 * 抽出・写像が値を返せない行は既存値を保持する（写像の後退で索引を消さない。
 * payload は一次資料として残っているため、抽出器を改善して再実行すれば追随できる）。
 */
export function rederiveKwEventIndexes(
  db: Database.Database,
  fromIsoInput: string,
  toIsoInput: string,
  options: RederiveKwIndexesOptions = {},
): { kinds: number; actors: number } {
  // received_at（Date.toISOString 形式）との文字列比較のため UTC ISO へ正規化する
  const fromIso = toUtcIso(fromIsoInput);
  const toIso = toUtcIso(toIsoInput);
  const updates = collectKwIndexUpdates(db, fromIso, toIso, {
    kindMapper: options.kindMapper ?? defaultKwKindMapper,
    actorExtractor: options.actorExtractor ?? extractKwActorFromPayload,
  });
  applyIndexColumnUpdates(db, updates);
  if (updates.kind.length > 0) {
    logger.info('Rederived KW event kinds', { updated: updates.kind.length });
  }
  if (updates.actor.length > 0) {
    logger.info('Rederived KW event actors', { updated: updates.actor.length });
  }
  return { kinds: updates.kind.length, actors: updates.actor.length };
}

/** 単一のページングスキャンで、有効化された導出器ぶんの索引差分を集める */
function collectKwIndexUpdates(
  db: Database.Database,
  fromIso: string,
  toIso: string,
  derive: RederiveKwIndexesOptions,
): KwIndexUpdates {
  interface Row { id: number; kind: string; actor: string | null; payload: string }
  const select = db.prepare<[string, string, number, number], Row>(`
    SELECT id, kind, actor, payload FROM experience_log
    WHERE received_at >= ? AND received_at <= ? AND channel LIKE 'kw:%' AND kind != 'own_action' AND id > ?
    ORDER BY id ASC
    LIMIT ?
  `);

  const updates: KwIndexUpdates = { kind: [], actor: [] };
  let afterId = 0;
  for (;;) {
    const rows = select.all(fromIso, toIso, afterId, REDERIVE_BATCH_SIZE);
    const last = rows.at(-1);
    if (last == null) {
      break;
    }
    afterId = last.id;
    for (const row of rows) {
      const payload = parsePayload(row.payload);
      if (derive.kindMapper != null) {
        const rawKind = extractRawKind(payload);
        if (rawKind != null) {
          const nextKind = derive.kindMapper(rawKind);
          if (nextKind !== row.kind) {
            updates.kind.push({ id: row.id, value: nextKind });
          }
        }
      }
      if (derive.actorExtractor != null) {
        const nextActor = derive.actorExtractor(payload);
        // 抽出できない行は既存値を保持する（kind と同じ方針）
        if (nextActor != null && nextActor !== row.actor) {
          updates.actor.push({ id: row.id, value: nextActor });
        }
      }
    }
    if (rows.length < REDERIVE_BATCH_SIZE) {
      break;
    }
  }
  return updates;
}

/**
 * 索引列（kind / actor に限定）の更新を、append-only トリガーを一時解除した
 * 単一トランザクション内で適用する。途中失敗はロールバックされ、トリガーも
 * トランザクションごと元に戻る。
 */
function applyIndexColumnUpdates(db: Database.Database, updates: KwIndexUpdates): void {
  if (updates.kind.length === 0 && updates.actor.length === 0) {
    return;
  }

  const apply = db.transaction(() => {
    db.exec('DROP TRIGGER IF EXISTS experience_log_no_update');
    try {
      for (const column of ['kind', 'actor'] as const) {
        if (updates[column].length === 0) {
          continue;
        }
        const update = db.prepare(`UPDATE experience_log SET ${column} = ? WHERE id = ?`);
        for (const entry of updates[column]) {
          update.run(entry.value, entry.id);
        }
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
  const episodes = db.prepare<[], { id: number; body: string }>('SELECT id, body FROM episodes ORDER BY id ASC').all();

  // オフラインの明示的な全パスなので、backfill の障害打ち切りヒューリスティックに
  // 任せず 1 件ずつ試す（隣接する恒久失敗で全体が止まらない）。失敗した行は
  // pending に残り（attempts 0 から）、以後の通常 backfill が拾う
  let indexed = 0;
  for (const episode of episodes) {
    if (await index.indexEpisode(episode.id, episode.body)) {
      indexed += 1;
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

function extractRawKind(payload: unknown): string | null {
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
