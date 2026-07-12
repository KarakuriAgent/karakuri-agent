/**
 * 生きたエージェントのチューニングパラメータ一元管理。
 *
 * 閾値・係数の変更は同じ体験ログから別のビューを生むため、主要セットは
 * 処理系バージョン（proc_version）の一部として扱う（#95）。値を変えたら
 * LIFE_TUNING_VERSION を上げること。
 */

// v2: importance ラベル/salience のドラフト蓄積を確定時の importance に反映（#100）、
//     valence の同符号ソフトサチュレーション（#102）
export const LIFE_TUNING_VERSION = 'tuning-v2';

export interface LifeTuning {
  valenceHalfLifeHours: number;
  energyDecayPerHour: number;
  hungerIncreasePerHour: number;
  sleepingHungerFactor: number;
  socialIncreasePerHour: number;
  sleepEnergyRecoveryPerHour: number;
  maxDeltaPerEvent: number;
  maxLazyElapsedHours: number;
  circadianLateNightFactor: number;
  circadianMorningFactor: number;
}

export const LIFE_TUNING: LifeTuning = {
  /** 気分（valence）がベースライン 0 へ戻る半減期（時間） */
  valenceHalfLifeHours: 8,
  /** 覚醒中の元気度の自然減衰（1 時間あたり） */
  energyDecayPerHour: 0.03,
  /** 空腹の自然進行（1 時間あたり） */
  hungerIncreasePerHour: 0.06,
  /** 睡眠中の空腹進行の倍率 */
  sleepingHungerFactor: 0.4,
  /** 社交欲求の自然増加（1 時間あたり） */
  socialIncreasePerHour: 0.04,
  /**
   * 睡眠中の元気度回復の下限保証（1 時間あたり）。
   * appraisal が回復量ゼロを出し続けても状態が張り付かないためのルール側の保証
   * （復帰不能ループ = 5 時間ループと同型の故障を決定論で防ぐ）
   */
  sleepEnergyRecoveryPerHour: 0.1,
  /** 1 イベントの appraisal が動かせる状態変化量の上限（クランプ） */
  maxDeltaPerEvent: 0.3,
  /** 遅延評価で一度に進める経過時間の上限（時間）。長期停止後の暴走防止 */
  maxLazyElapsedHours: 48,
  /** 概日リズム: 深夜（0-5 時）の元気度減衰倍率 */
  circadianLateNightFactor: 1.6,
  /** 概日リズム: 朝（6-9 時）の元気度減衰倍率（調子が出ない） */
  circadianMorningFactor: 1.2,
};

/** appraisal 処理系バージョン。プロンプト版 + モデル + チューニングセット */
// v2: social 方向の定義（満たされた交流で減る）・valence 正バイアス校正・sleep 遷移の定義を明確化（#102）
export const APPRAISAL_PROMPT_VERSION = 'appraisal-v2';

export function buildAppraisalProcVersion(model: string): string {
  return `${APPRAISAL_PROMPT_VERSION}/${model}/${LIFE_TUNING_VERSION}`;
}
