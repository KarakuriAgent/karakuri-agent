/**
 * Loop Detector — 反復収束への決定論的対策（M1）。
 *
 * 同一行動 + 同一対象が N 回連続で発火し、trusted 側（システム生成の決定論テキスト）で
 * 警告をプロンプトに注入する。LLM の自己判断には任せない（実ログで「LLM 任せでは
 * 5 時間破れなかった」ことが証明済み）。
 *
 * key はエージェント自身が発行したコマンド（own_action）から作るため、KW の
 * 通知形式・kind 変更の影響を受けない。
 */

import { createLogger } from '../utils/logger.js';
import { EVENT_KINDS, type IExperienceLogStore } from './types.js';

const logger = createLogger('LoopDetector');

export const DEFAULT_LOOP_DETECTOR_THRESHOLD = 3;
/** 再起動復元時に streak 再構築のため遡る own_action の件数 */
const RESTORE_SCAN_LIMIT = 50;

interface Streak {
  key: string;
  count: number;
}

export interface LoopDetectorOptions {
  threshold?: number | undefined;
}

export class LoopDetector {
  private readonly threshold: number;
  private readonly streaks = new Map<string, Streak>();

  constructor({ threshold = DEFAULT_LOOP_DETECTOR_THRESHOLD }: LoopDetectorOptions = {}) {
    this.threshold = Math.max(2, threshold);
  }

  /** own_action の発行を記録し、現在の連続回数を返す。 */
  recordOwnAction(channel: string, key: string): number {
    const current = this.streaks.get(channel);
    if (current != null && current.key === key) {
      current.count += 1;
      return current.count;
    }

    this.streaks.set(channel, { key, count: 1 });
    return 1;
  }

  getConsecutiveCount(channel: string): number {
    return this.streaks.get(channel)?.count ?? 0;
  }

  /**
   * 閾値超過時の警告文（trusted）。untrusted コンテンツ（コマンド文字列・相手名など、
   * 世界の選択肢由来のテキスト）は引用しない形式にする（prompt injection 経路にしない）。
   */
  buildWarning(channel: string): string | null {
    const streak = this.streaks.get(channel);
    if (streak == null || streak.count < this.threshold) {
      return null;
    }

    return [
      `【行動ループ警告】直前まで同じ行動を同じ対象へ ${streak.count} 回連続で繰り返しているが、状況は変わっていない。`,
      '同じ働きかけを続けても結果は変わらない。今回は別の行動・別の対象・別の場所を選ぶこと。',
    ].join('\n');
  }

  /**
   * 再起動復元: experience_log の直近 own_action 列から連続回数を再構築する。
   * 既に streak を持つチャネルには何もしない。
   */
  async restore(store: IExperienceLogStore, channel: string): Promise<void> {
    if (this.streaks.has(channel)) {
      return;
    }

    try {
      const records = await store.getRecent(RESTORE_SCAN_LIMIT, {
        channel,
        kind: EVENT_KINDS.ownAction,
      });
      const latest = records[0];
      if (latest == null) {
        return;
      }

      const latestKey = ownActionKeyFromPayload(latest.payload);
      if (latestKey == null) {
        return;
      }

      // records は新しい順。先頭から同一 key が続く長さ = 現在の連続回数
      let count = 0;
      for (const record of records) {
        if (ownActionKeyFromPayload(record.payload) !== latestKey) {
          break;
        }
        count += 1;
      }

      this.streaks.set(channel, { key: latestKey, count });
      logger.info('Loop detector streak restored from experience log', { channel, count });
    } catch (error) {
      logger.warn('Failed to restore loop detector streak', error, { channel });
    }
  }
}

/**
 * own_action の「同一行動 + 同一対象」判定キー。
 * 対象が抽出できる場合は command + 対象で判定し、メッセージ本文など対象以外の
 * パラメータ差分で反復が偽装されないようにする。対象がなければ params 全体で判定する。
 */
export function buildOwnActionKey(command: string, params: unknown): string {
  const target = extractOwnActionTarget(params);
  return target != null
    ? `${command}|target:${target}`
    : `${command}|params:${stableStringify(params)}`;
}

const TARGET_FIELD_CANDIDATES = [
  'target',
  'target_id',
  'target_node_id',
  'target_agent_id',
  'agent_id',
  'npc_id',
  'node_id',
  'to',
] as const;

export function extractOwnActionTarget(params: unknown): string | undefined {
  if (typeof params !== 'object' || params == null) {
    return undefined;
  }

  const record = params as Record<string, unknown>;
  for (const field of TARGET_FIELD_CANDIDATES) {
    const value = record[field];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }

  return undefined;
}

function ownActionKeyFromPayload(payloadJson: string): string | null {
  try {
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    if (typeof payload?.command !== 'string' || payload.command.length === 0) {
      return null;
    }
    return buildOwnActionKey(payload.command, payload.params);
  } catch {
    return null;
  }
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value)) ?? 'null';
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (typeof value === 'object' && value != null) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record).sort().map((key) => [key, sortKeysDeep(record[key])]),
    );
  }
  return value;
}
