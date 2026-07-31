/**
 * ハイブリッド想起（Retrieval Service）— M3。
 *
 * 信号の融合: 意味類似（sqlite-vec）+ 字句一致（FTS5 trigram / LIKE フォールバック）
 * + 新しさ（減衰）+ 重要度（importance × buoyancy）+ 社会的文脈（相手ブースト）。
 * RRF で融合し、MMR で多様性を確保する（同じ記憶ばかり引く性質は反復収束の圧力源）。
 *
 * 2 モード:
 * 1. 自動想起 — 応答生成前の文脈組み立て（buildEpisodicMemorySection）
 * 2. 能動想起 — エージェントが使う検索ツール（recallEpisodes、agent/tools 側）
 */

import { formatDateInTimezone } from '../utils/date.js';
import { createLogger } from '../utils/logger.js';
import type { EpisodeEmbeddingIndex } from './embeddings.js';
import type { Episode, IEpisodeStore } from './episodes.js';

const logger = createLogger('EpisodeRetrieval');

export interface RetrievalQuery {
  /** 検索テキスト（現在の話題・通知の要約など） */
  text?: string | undefined;
  /** いま目の前にいる相手（actor 規約 ID）。紐づく記憶をブーストする */
  participants?: string[] | undefined;
  now: Date;
  limit?: number | undefined;
}

export interface ScoredEpisode {
  episode: Episode;
  score: number;
}

export interface EpisodeRetrievalServiceOptions {
  episodeStore: IEpisodeStore;
  embeddingIndex?: EpisodeEmbeddingIndex | undefined;
  /** 新しさ信号の半減期（日） */
  recencyHalfLifeDays?: number | undefined;
  /** MMR の関連度と多様性のバランス（0..1、大きいほど関連度重視） */
  mmrLambda?: number | undefined;
  /** 各信号で取る候補数 */
  candidatePoolSize?: number | undefined;
}

const RRF_K = 60;

export class EpisodeRetrievalService {
  private readonly store: IEpisodeStore;
  private readonly embeddingIndex: EpisodeEmbeddingIndex | undefined;
  private readonly recencyHalfLifeDays: number;
  private readonly mmrLambda: number;
  private readonly candidatePoolSize: number;

  constructor({
    episodeStore,
    embeddingIndex,
    recencyHalfLifeDays = 14,
    mmrLambda = 0.7,
    candidatePoolSize = 20,
  }: EpisodeRetrievalServiceOptions) {
    this.store = episodeStore;
    this.embeddingIndex = embeddingIndex;
    this.recencyHalfLifeDays = recencyHalfLifeDays;
    this.mmrLambda = mmrLambda;
    this.candidatePoolSize = candidatePoolSize;
  }

  async search({ text, participants, now, limit = 5 }: RetrievalQuery): Promise<ScoredEpisode[]> {
    const pool = this.candidatePoolSize;
    const normalizedText = text?.trim();

    // 各信号の候補リスト（rank 順）を集める
    const [textMatches, recent] = await Promise.all([
      normalizedText != null && normalizedText.length > 0
        ? this.store.searchText(normalizedText, pool)
        : Promise.resolve([]),
      this.store.listRecent(pool),
    ]);
    const vectorMatches = normalizedText != null && normalizedText.length > 0 && this.embeddingIndex != null
      ? await this.embeddingIndex.searchSimilar(normalizedText, pool)
      : [];

    // 候補集合（id → Episode）
    const candidates = new Map<number, Episode>();
    for (const match of textMatches) {
      candidates.set(match.episode.id, match.episode);
    }
    for (const episode of recent) {
      candidates.set(episode.id, episode);
    }
    for (const match of vectorMatches) {
      if (!candidates.has(match.episodeId)) {
        const episode = await this.store.getById(match.episodeId);
        if (episode != null) {
          candidates.set(episode.id, episode);
        }
      }
    }
    if (candidates.size === 0) {
      return [];
    }

    // 信号ごとの rank リストを作る
    const ranks: Array<Map<number, number>> = [];
    if (textMatches.length > 0) {
      ranks.push(new Map(textMatches.map((match, index) => [match.episode.id, index + 1])));
    }
    if (vectorMatches.length > 0) {
      ranks.push(new Map(vectorMatches.map((match, index) => [match.episodeId, index + 1])));
    }
    // 新しさ・重要度は全候補を並べ替えて rank 化する
    const allCandidates = [...candidates.values()];
    const byRecency = [...allCandidates].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
    ranks.push(new Map(byRecency.map((episode, index) => [episode.id, index + 1])));
    const byImportance = [...allCandidates].sort(
      (a, b) => b.importance * b.buoyancy - a.importance * a.buoyancy,
    );
    ranks.push(new Map(byImportance.map((episode, index) => [episode.id, index + 1])));

    // RRF 融合 + 社会的文脈・新しさの連続ブースト
    const participantSet = new Set(participants ?? []);
    const fused: ScoredEpisode[] = allCandidates.map((episode) => {
      let score = 0;
      for (const rank of ranks) {
        const position = rank.get(episode.id);
        if (position != null) {
          score += 1 / (RRF_K + position);
        }
      }
      // 社会的文脈: 目の前の相手に紐づく記憶をブースト
      if (participantSet.size > 0 && episode.participants.some((participant) => participantSet.has(participant))) {
        score *= 1.5;
      }
      // 新しさ・浮力の連続係数（rank ベースの RRF を微調整）
      const ageDays = Math.max(0, (now.getTime() - new Date(episode.occurredAt).getTime()) / 86_400_000);
      const recencyFactor = Math.pow(0.5, ageDays / this.recencyHalfLifeDays);
      score *= 0.5 + 0.5 * recencyFactor;
      score *= 0.5 + 0.5 * episode.buoyancy;
      return { episode, score };
    });
    fused.sort((a, b) => b.score - a.score);

    // MMR で多様性確保
    return this.applyMmr(fused, limit);
  }

  /** MMR: relevance - λ 補正で既選択と似た記憶を抑制する（重複上位の抑制） */
  private applyMmr(ranked: ScoredEpisode[], limit: number): ScoredEpisode[] {
    const selected: ScoredEpisode[] = [];
    const remaining = [...ranked];
    while (selected.length < limit && remaining.length > 0) {
      let bestIndex = 0;
      let bestValue = -Infinity;
      for (let i = 0; i < remaining.length; i += 1) {
        const candidate = remaining[i]!;
        const maxSimilarity = selected.reduce(
          (max, chosen) => Math.max(max, this.similarity(candidate.episode, chosen.episode)),
          0,
        );
        const value = this.mmrLambda * candidate.score - (1 - this.mmrLambda) * maxSimilarity * candidate.score;
        if (value > bestValue) {
          bestValue = value;
          bestIndex = i;
        }
      }
      selected.push(remaining.splice(bestIndex, 1)[0]!);
    }
    return selected;
  }

  /** 類似度: 埋め込みがあればコサイン、なければ本文の文字バイグラム Jaccard */
  private similarity(a: Episode, b: Episode): number {
    const embeddingA = this.embeddingIndex?.getEmbedding(a.id) ?? null;
    const embeddingB = this.embeddingIndex?.getEmbedding(b.id) ?? null;
    if (embeddingA != null && embeddingB != null) {
      return cosineSimilarity(embeddingA, embeddingB);
    }
    return bigramJaccard(a.body, b.body);
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i += 1) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / Math.sqrt(normA * normB);
}

export function bigramJaccard(a: string, b: string): number {
  const bigramsA = characterBigrams(a);
  const bigramsB = characterBigrams(b);
  if (bigramsA.size === 0 || bigramsB.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const bigram of bigramsA) {
    if (bigramsB.has(bigram)) {
      intersection += 1;
    }
  }
  return intersection / (bigramsA.size + bigramsB.size - intersection);
}

function characterBigrams(text: string): Set<string> {
  const characters = [...text.replace(/\s+/g, '')];
  const bigrams = new Set<string>();
  for (let i = 0; i < characters.length - 1; i += 1) {
    bigrams.add(`${characters[i]}${characters[i + 1]}`);
  }
  return bigrams;
}

/**
 * 自動想起の結果をプロンプト注入用テキストへ整形する（untrusted タグは呼び出し側で付ける）。
 * 日付は UTC 暦日ではなくローカル日で示す（日記・日次省察の日付帰属と一致させる）
 */
export function formatEpisodesForPrompt(episodes: ScoredEpisode[], timezone: string): string {
  if (episodes.length === 0) {
    return '';
  }
  return episodes
    .map(({ episode }) => `- [${formatDateInTimezone(new Date(episode.occurredAt), timezone)}] ${episode.body}`)
    .join('\n');
}

export { logger as retrievalLogger };
