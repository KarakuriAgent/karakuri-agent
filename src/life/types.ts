/**
 * 生きたエージェント（living agent）の記憶基盤の型定義。
 *
 * 設計参照: docs/design/living-agent.md「二重真実構造」
 * - experience_log は一次資料（不変・追記専用）
 * - kind / actor は payload から再導出可能な索引であり、写像の改善は
 *   reprocessing（M7）で過去に遡って適用できる
 */

/** エージェント所有の抽象語彙。チャネル固有の通知種別からの写像は差し替え可能（normalize.ts）。 */
export const EVENT_KINDS = {
  /** 自分が発行した行動・発話 */
  ownAction: 'own_action',
  /** 相手からの会話・発言（KW 割り込み会話含む） */
  conversation: 'conversation',
  /** KW の世界イベント（行動完了・移動・サーバーイベント等） */
  worldEvent: 'world_event',
  /** SNS の通知・反応 */
  snsEvent: 'sns_event',
  /** Discord チャットのユーザー発言ターン */
  chatTurn: 'chat_turn',
  /** 立ち上げ時の seed 記憶（M4 で投入） */
  seed: 'seed',
  /** 写像にない種別。落とさず必ず記録する */
  unknown: 'unknown',
} as const;

export type EventKind = (typeof EVENT_KINDS)[keyof typeof EVENT_KINDS];

/**
 * チャネル横断の共通イベント封筒。
 * 正規化は封筒を揃えるだけで中身の解釈はしない（解釈は appraisal の仕事）。
 */
export interface NormalizedEvent {
  /** 受信時の実時刻。時系列の正 */
  receivedAt: Date;
  /** kw:{bot_id} / sns:{provider} / discord（bot / provider 単位の粒度） */
  channel: string;
  /** エージェント所有の抽象語彙（unknown フォールバックあり） */
  kind: string;
  /** 相手（いれば）。payload から再導出可能な索引 */
  actor?: string | undefined;
  /** 届いた封筒の逐語データ（KW なら通知 JSON 全体） */
  payload: unknown;
}

export interface ExperienceLogRecord {
  id: number;
  /** ISO8601 */
  receivedAt: string;
  channel: string;
  kind: string;
  actor: string | null;
  /** 逐語 JSON 文字列 */
  payload: string;
}

/**
 * 一次資料ストア。追記専用 — UPDATE / DELETE は提供しない
 * （DB 側にも append-only トリガーを持つ）。
 */
export interface IExperienceLogStore {
  append(event: NormalizedEvent): Promise<number>;
  /** 新しい順。M1 の Perception Buffer 復元・テスト用の最小読み出し */
  getRecent(limit: number, filter?: ExperienceLogFilter): Promise<ExperienceLogRecord[]>;
  count(): Promise<number>;
  close(): Promise<void>;
}

export interface ExperienceLogFilter {
  channel?: string | undefined;
  kind?: string | undefined;
}
