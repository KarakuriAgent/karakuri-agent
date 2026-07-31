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
  /** 返信待ち圧: 最古の未読チャットがこの時間を超えると「返事をしたい」圧が湧く */
  chatReplyThresholdHours: 2,
  /** 返信待ち圧: この時間を超えると強い文言に切り替える */
  chatReplyStrongThresholdHours: 8,
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
  options: {
    episodeWindowHours?: number;
    postCooldownHours?: number;
    minImportance?: number;
    /** M9 #110: 個別に伝えられる相手がいるとき、SNS と直接伝達の両方を選択肢として言語化する */
    personalCounterpart?: string | undefined;
  } = {},
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

  if (options.personalCounterpart != null) {
    return `最近、心が動く出来事があった。誰かに話したい気持ちがある。SNSに書くのもいいし、${options.personalCounterpart}に直接伝えるのもいい。`;
  }
  return '最近、心が動く出来事があった。誰かに話したい気持ちがある。';
}

/**
 * 返事待ちの気掛かり（M9 #110）: 自分が最後にメッセージを送ってから長時間返信が
 * 無い相手への「どうしているかな」を言語化する。判定（待ち時間・催促クールダウン・
 * 夜間ゲート）は phone service 側の決定論導出が済ませており、ここは言葉にするだけ。
 * 相手の返信（last_incoming_at 更新）で自然に解消される。
 */
export function describeAwaitingReply(counterpartName: string | null): string {
  const name = counterpartName ?? '相手';
  return `${name}にメッセージを送ってから、まだ返事が来ていない。どうしているか少し気になる。`;
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

/**
 * 返信待ち圧: 未読チャットの放置を欲求の言葉に変換して `<drives>` へ注入する
 * （SNS 未確認圧 #109 と同型の決定論導出）。実機で `<phone-status>` の未読件数
 * 提示だけでは check_phone がほぼ選ばれず（631 回提示で 2 回）、ユーザーの
 * メッセージが 16〜30 時間放置された。check_phone の実行で未読が消化されて
 * 自然に解消される。
 */
export function describeChatReplyPressure(
  oldestUnreadReceivedAt: Date | null,
  now: Date,
  options: { thresholdHours?: number; strongThresholdHours?: number } = {},
): string | null {
  if (oldestUnreadReceivedAt == null) {
    return null;
  }
  const thresholdHours = options.thresholdHours ?? DRIVES_DEFAULTS.chatReplyThresholdHours;
  const strongThresholdHours = options.strongThresholdHours ?? DRIVES_DEFAULTS.chatReplyStrongThresholdHours;
  const elapsedMs = now.getTime() - oldestUnreadReceivedAt.getTime();
  if (elapsedMs < thresholdHours * 3_600_000) {
    return null;
  }
  if (elapsedMs < strongThresholdHours * 3_600_000) {
    return 'スマホにまだ読んでいないメッセージが届いている。そろそろ確認して返事をしたい。';
  }
  return 'ずいぶん長いこと返事を待たせてしまっているメッセージがある。何をおいてもまずスマホを確認して返事をしたい。';
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

  // 疲れきり（energy < 0.2）は他の欲求に優先する。social は起きている限り
  // 増え続けて 1.0 で飽和し strength 比較で常勝するため、実機で「energy が
  // ほぼ 0 になるまで休息欲求がマスクされ続ける」が起きた（2026-07-19 kbx）
  if (state.energy < 0.2) {
    return '疲れきっていて、何よりも休みたい。';
  }

  const candidates: DriveCandidate[] = [];
  if (state.hunger > 0.55) {
    candidates.push({
      strength: state.hunger,
      // 実機で「食べ物を持っているのに探し回る」が起きたため、持ち物の確認を促す
      // 条件つきの一文を添える（持っているかどうかは本人が持ち物を見て判断する）
      text: state.hunger > 0.8
        ? 'かなりお腹が空いていて、まず何か食べたい。持ち物に食べ物があるなら、まずそれを食べてしまいたい。'
        : 'そろそろ何か食べたい。持ち物に食べ物があればそれを食べたい。',
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
  /** 返信待ち圧の判定に使う最古の未読チャット受信時刻（check_phone 構成時のみ。null = 未読なし） */
  chatOldestUnreadAt?: Date | null | undefined;
  /** 返事待ちの気掛かり（M9）: 催促可能な相手の表示名（send_message 構成時のみ。null = 該当なし） */
  awaitingReplyCounterpart?: string | null | undefined;
  /** 個別共有（M9）: 共有欲が湧いたとき直接伝えられる相手の表示名（send_message 構成時のみ） */
  shareUrgePersonalCounterpart?: string | null | undefined;
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
    const shareUrge = await describeShareUrge(options.shareUrge, now, {
      ...(options.shareUrgePersonalCounterpart != null ? { personalCounterpart: options.shareUrgePersonalCounterpart } : {}),
    }).catch(() => null);
    if (shareUrge != null) {
      parts.push(shareUrge);
    }
  }
  if (options.awaitingReplyCounterpart !== undefined && options.awaitingReplyCounterpart !== null) {
    parts.push(describeAwaitingReply(options.awaitingReplyCounterpart));
  }
  if (options.snsLastCheckedAt !== undefined) {
    const snsCuriosity = describeSnsCuriosity(options.snsLastCheckedAt, now);
    if (snsCuriosity != null) {
      parts.push(snsCuriosity);
    }
  }
  if (options.chatOldestUnreadAt !== undefined) {
    const replyPressure = describeChatReplyPressure(options.chatOldestUnreadAt, now);
    if (replyPressure != null) {
      parts.push(replyPressure);
    }
  }
  return parts.length > 0 ? parts.join('') : null;
}
