/**
 * 動機システム（drives）— M5。
 *
 * - 生理パラメータがそのまま欲求になる（空腹→食事したい、疲労→休みたい）
 * - 心理系: 社交欲求 + 好奇心（新しい場所・行動への圧）
 * - 飽き（satiation）: action_ledger の反復を「最近○○に偏っている」（逸脱を促す向き）で
 *   注入する。「あなたの習慣: 毎朝○○」（スクリプト化を促す向き）にはしない
 */

import type { IActionLedgerStore } from './action-ledger.js';
import type { InnerState } from './inner-state.js';

export const DRIVES_DEFAULTS = {
  /** 飽き圧を注入する直近ウィンドウ（時間） */
  satiationWindowHours: 24,
  /** この回数以上繰り返した行動を「偏り」とみなす */
  satiationThreshold: 5,
} as const;

interface DriveCandidate {
  strength: number;
  text: string;
}

/**
 * 「いま一番強い欲求」の自然言語化。数値・パラメータ名は出さない。
 * 欲求が弱いときは null（注入しない）。
 */
export function describeStrongestDrive(state: InnerState): string | null {
  if (state.sleeping) {
    return null;
  }

  const candidates: DriveCandidate[] = [];
  if (state.hunger > 0.55) {
    candidates.push({
      strength: state.hunger,
      text: state.hunger > 0.8 ? 'かなりお腹が空いていて、まず何か食べたい。' : 'そろそろ何か食べたい。',
    });
  }
  if (state.energy < 0.45) {
    candidates.push({
      strength: 1 - state.energy,
      text: state.energy < 0.2 ? '疲れきっていて、何よりも休みたい。' : '少し疲れてきたので、どこかで休みたい。',
    });
  }
  if (state.social > 0.6) {
    candidates.push({
      strength: state.social,
      text: '誰かと話したい気分だ。',
    });
  }

  if (candidates.length === 0) {
    return null;
  }
  candidates.sort((a, b) => b.strength - a.strength);
  return candidates[0]!.text;
}

/**
 * 飽き圧: 直近ウィンドウの行動の偏りを「逸脱を促す向き」で言語化する。
 * 反復はその行動の魅力を下げ、好奇心圧を上げる（感情の正帰還のブレーキ）。
 */
export async function describeSatiationPressure(
  actionLedger: IActionLedgerStore,
  now: Date,
  options: { windowHours?: number; threshold?: number } = {},
): Promise<string | null> {
  const windowHours = options.windowHours ?? DRIVES_DEFAULTS.satiationWindowHours;
  const threshold = options.threshold ?? DRIVES_DEFAULTS.satiationThreshold;
  const since = new Date(now.getTime() - windowHours * 3_600_000);

  const counts = await actionLedger.getCounts('action', since);
  const dominant = counts[0];
  if (dominant == null || dominant.count < threshold) {
    return null;
  }

  return `このところ同じ行動（${dominant.key}）に偏っている。新しい場所や、まだやっていないことを試したい気持ちがある。`;
}

/**
 * 話題偏り（M6・SNS/チャット向け）: 同じ話題・言い回しの反復投稿を抑制するため、
 * 直近の投稿話題の偏りを逸脱を促す向きで言語化する。
 */
export async function describeTopicBias(
  actionLedger: IActionLedgerStore,
  now: Date,
  options: { windowHours?: number; threshold?: number } = {},
): Promise<string | null> {
  const windowHours = options.windowHours ?? DRIVES_DEFAULTS.satiationWindowHours;
  const threshold = options.threshold ?? DRIVES_DEFAULTS.satiationThreshold;
  const since = new Date(now.getTime() - windowHours * 3_600_000);

  const counts = await actionLedger.getCounts('topic', since);
  const dominant = counts[0];
  if (dominant == null || dominant.count < threshold) {
    return null;
  }

  return `最近の投稿は同じ話題（${dominant.key}）に偏っている。今回は別の話題や、まだ話していないことに触れたい。`;
}

export interface BuildDrivesOptions {
  /** 気質（好奇心）由来の飽き閾値 */
  satiationThreshold?: number | undefined;
  /** SNS / チャット向けの話題偏りも含める */
  includeTopicBias?: boolean | undefined;
}

/** drives セクションの本文（untrusted タグは呼び出し側で付ける） */
export async function buildDrivesDescription(
  state: InnerState,
  actionLedger: IActionLedgerStore | undefined,
  now: Date,
  options: BuildDrivesOptions = {},
): Promise<string | null> {
  const parts: string[] = [];
  const strongest = describeStrongestDrive(state);
  if (strongest != null) {
    parts.push(strongest);
  }
  if (actionLedger != null) {
    const satiation = await describeSatiationPressure(actionLedger, now, {
      ...(options.satiationThreshold != null ? { threshold: options.satiationThreshold } : {}),
    }).catch(() => null);
    if (satiation != null) {
      parts.push(satiation);
    }
    if (options.includeTopicBias === true) {
      const topicBias = await describeTopicBias(actionLedger, now, {
        ...(options.satiationThreshold != null ? { threshold: options.satiationThreshold } : {}),
      }).catch(() => null);
      if (topicBias != null) {
        parts.push(topicBias);
      }
    }
  }
  return parts.length > 0 ? parts.join('') : null;
}
