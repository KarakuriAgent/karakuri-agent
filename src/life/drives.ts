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
  /** 共有欲: 「語れる体験」を探す直近ウィンドウ（時間） */
  shareUrgeEpisodeWindowHours: 24,
  /** 共有欲: 投稿後にふたたび圧が湧くまでのクールダウン（時間）。実質のペースメーカー（8h ≒ 最大 3 回/日） */
  shareUrgePostCooldownHours: 8,
  /** 共有欲: 「心が動いた体験」とみなす importance の下限（medium = 0.6 以上） */
  shareUrgeMinImportance: 0.6,
  /** SNS 未確認圧（#109）: この時間以上 SNS 通知を確認していないと「覗きたい」圧が湧く */
  snsCuriosityThresholdHours: 12,
} as const;

/** 共有欲の判定に必要な読み取り依存（episodes と SNS 活動ログ） */
export interface ShareUrgeDeps {
  /** since 以降で importance が閾値以上のエピソード数 */
  countSalientEpisodesSince(since: Date, minImportance: number): Promise<number>;
  /** 全 provider 横断の直近投稿時刻（ISO）。未投稿なら null */
  getLastPostAt(): Promise<string | null>;
}

/**
 * 共有欲（M8 追補）: 「心が動いた体験があり、まだ誰にも話していない」を決定論で検出して
 * 言語化する。importance は appraisal 由来（感情が動いた体験ほど高い）なので、
 * 感情の出所は本人の体験 — ツールが内発的感情を捏造しない原則と整合する。
 * 一度投稿すればクールダウンが明けるまで圧は消える（構造的に連投しない）。
 */
export async function describeShareUrge(
  deps: ShareUrgeDeps,
  now: Date,
  options: { episodeWindowHours?: number; postCooldownHours?: number; minImportance?: number } = {},
): Promise<string | null> {
  const episodeWindowHours = options.episodeWindowHours ?? DRIVES_DEFAULTS.shareUrgeEpisodeWindowHours;
  const postCooldownHours = options.postCooldownHours ?? DRIVES_DEFAULTS.shareUrgePostCooldownHours;
  const minImportance = options.minImportance ?? DRIVES_DEFAULTS.shareUrgeMinImportance;

  const lastPostAt = await deps.getLastPostAt();
  if (lastPostAt != null && now.getTime() - new Date(lastPostAt).getTime() < postCooldownHours * 3_600_000) {
    return null;
  }

  const since = new Date(now.getTime() - episodeWindowHours * 3_600_000);
  const salientCount = await deps.countSalientEpisodesSince(since, minImportance);
  if (salientCount === 0) {
    return null;
  }

  return '最近、心が動く出来事があった。誰かに話したい気持ちがある。';
}

/**
 * SNS 未確認圧（#109）: 実機で `<phone-status>` の経過分数（2,739 分まで増加）が
 * 一度も行動を誘発しなかったため、閾値超過を欲求の言葉に変換して `<drives>` へ
 * 注入する（share urge と同型の決定論導出）。browse_sns / check_phone の実行で
 * lastCheckedAt が更新されて自然に解消される。
 * lastCheckedAt が null（起動後未確認）のときは経過が不明なため注入しない。
 */
export function describeSnsCuriosity(
  lastCheckedAt: Date | null,
  now: Date,
  options: { thresholdHours?: number } = {},
): string | null {
  if (lastCheckedAt == null) {
    return null;
  }
  const thresholdHours = options.thresholdHours ?? DRIVES_DEFAULTS.snsCuriosityThresholdHours;
  if (now.getTime() - lastCheckedAt.getTime() < thresholdHours * 3_600_000) {
    return null;
  }
  return 'しばらくSNSを見ていない。ちょっと覗きたい気持ちがある。';
}

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
  /** 共有欲の判定依存（SNS が構成されているときのみ渡す） */
  shareUrge?: ShareUrgeDeps | undefined;
  /** SNS 未確認圧の判定に使う最後の通知確認時刻（SNS 構成時のみ。null = 起動後未確認） */
  snsLastCheckedAt?: Date | null | undefined;
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
  if (options.shareUrge != null) {
    const shareUrge = await describeShareUrge(options.shareUrge, now).catch(() => null);
    if (shareUrge != null) {
      parts.push(shareUrge);
    }
  }
  if (options.snsLastCheckedAt !== undefined) {
    const snsCuriosity = describeSnsCuriosity(options.snsLastCheckedAt, now);
    if (snsCuriosity != null) {
      parts.push(snsCuriosity);
    }
  }
  return parts.length > 0 ? parts.join('') : null;
}
