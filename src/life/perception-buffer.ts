/**
 * Perception Buffer — 知覚と記憶の分離（M1）。
 *
 * 行動選択用の通知（世界状態・選択肢を含む）はチャネル別の最新 1 件を丸ごと
 * バッファし、会話履歴・セッションに積まない。perception / choices 等の
 * フィールド名で切り出さず通知単位で扱う（KW 側の封筒構造の変化に依存しない）。
 *
 * 前提: 行動選択用通知は毎回全量を含む（差分配信ではない）。現行 KW 実装で
 * 確認済みだが変わりうるため、差分配信化された場合はバッファ戦略の見直しが必要。
 */

import { createLogger } from '../utils/logger.js';
import { EVENT_KINDS, type IExperienceLogStore } from './types.js';

const logger = createLogger('PerceptionBuffer');

/**
 * 通知をセッション履歴に残すかバッファのみにするかのエージェント所有の分類ルール。
 * - 会話系（相手の発言・割り込みの会話内容）は履歴に残す — 多ターン会話の成立に必須
 * - 状態系（行動選択用の通知）はバッファのみ
 * - 未知の新種別のデフォルトは「履歴に残す」（体験ログには全 raw が入るため情報は
 *   失われないが、セッション上の文脈喪失は会話を壊す。肥大が観測されたら分類を追加する）
 */
export type KwNotificationRouting = 'history' | 'buffer_only';

export function routeKwNotification(normalizedKind: string): KwNotificationRouting {
  return normalizedKind === EVENT_KINDS.worldEvent ? 'buffer_only' : 'history';
}

export interface PerceptionEntry {
  payload: unknown;
  receivedAt: Date;
}

export class PerceptionBuffer {
  private readonly latest = new Map<string, PerceptionEntry>();

  update(channel: string, payload: unknown, receivedAt: Date): void {
    this.latest.set(channel, { payload, receivedAt });
  }

  getLatest(channel: string): PerceptionEntry | null {
    return this.latest.get(channel) ?? null;
  }

  /**
   * 再起動復元: experience_log から最新の行動選択用通知（状態系）を復元する。
   * 次の通知が来るまで世界状態が不明、という未定義状態を作らない。
   * 既にバッファ済みのチャネルには何もしない。
   */
  async restoreChannel(store: IExperienceLogStore, channel: string): Promise<boolean> {
    if (this.latest.has(channel)) {
      return true;
    }

    try {
      const records = await store.getRecent(1, { channel, kind: EVENT_KINDS.worldEvent });
      const record = records[0];
      if (record == null) {
        return false;
      }

      this.latest.set(channel, {
        payload: parsePayload(record.payload),
        receivedAt: new Date(record.receivedAt),
      });
      logger.info('Perception buffer restored from experience log', {
        channel,
        receivedAt: record.receivedAt,
      });
      return true;
    } catch (error) {
      logger.warn('Failed to restore perception buffer from experience log', error, { channel });
      return false;
    }
  }
}

function parsePayload(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}
