/**
 * 生きたエージェントのチューニングパラメータ一元管理。
 *
 * 閾値・係数の変更は同じ体験ログから別のビューを生むため、主要セットは
 * 処理系バージョン（proc_version）の一部として扱う（#95）。値を変えたら
 * LIFE_TUNING_VERSION を上げること。
 */

// v2: importance ラベル/salience のドラフト蓄積を確定時の importance に反映（#100）、
//     valence の同符号ソフトサチュレーション（#102）
// v3: 空腹収支の再調整 — 自然増を半減（0.06 → 0.03）し、食事の回復のみ
//     クランプを緩和（maxHungerRecoveryPerEvent = 0.6）。旧収支は「1 日 5〜9 食
//     しないと常に空腹」で、実機の tibi-kanon が慢性的空腹に張り付いた
// v4: 元気度収支の再調整 — 消耗（負の energy delta）のみクランプを半減
//     （maxEnergyExertionPerEvent = 0.15）。実機 kbx-001 の 1 週間実測で覚醒中の
//     消耗はルール減衰 0.029/h + appraisal 消耗 0.066/h（グロス）で、満充電から
//     4〜10 時間で枯渇し 1 日 2〜4 回の分割睡眠になっていた。ルール減衰 0.03/h +
//     消耗半減で「普通の日は満タンから 14〜16 時間で眠くなる」収支に合わせる
// v5: 空腹収支の再々調整 — 実機 tibi-kanon で appraisal が idle_reminder /
//     wait_completed に hunger_up を上乗せ（自然増の 1〜3 倍/日）して 1.0 に
//     張り付いていたため、無行動イベントの空腹進行を棄却するガードレールを追加
//     （appraisal-v5）。増加が自然増のみになる前提で 0.03 → 0.05 へ引き上げ、
//     「1 日 3 食 + 間食」（-0.3×3 + -0.15 ≒ 覚醒 16h + 睡眠 8h×0.4 の自然増）で
//     収支が合う経済にする
export const LIFE_TUNING_VERSION = 'tuning-v5';

export interface LifeTuning {
  valenceHalfLifeHours: number;
  energyDecayPerHour: number;
  hungerIncreasePerHour: number;
  sleepingHungerFactor: number;
  socialIncreasePerHour: number;
  sleepEnergyRecoveryPerHour: number;
  maxDeltaPerEvent: number;
  maxHungerRecoveryPerEvent: number;
  maxEnergyExertionPerEvent: number;
  maxLazyElapsedHours: number;
  circadianLateNightFactor: number;
  circadianMorningFactor: number;
}

export const LIFE_TUNING: LifeTuning = {
  /** 気分（valence）がベースライン 0 へ戻る半減期（時間） */
  valenceHalfLifeHours: 8,
  /** 覚醒中の元気度の自然減衰（1 時間あたり） */
  energyDecayPerHour: 0.03,
  /**
   * 空腹の自然進行（1 時間あたり）。覚醒 16h + 睡眠 8h（×sleepingHungerFactor）で
   * 1 日約 0.96 進み、食事 down(-0.3)×3 + 間食 small_down(-0.15) の
   * 「1 日 3 食 + 間食」で収支が合う。食後 3〜4 時間で「少しお腹が空いてきた」
   * （0.55 閾値）へ戻るリズム。無行動イベントへの appraisal 上乗せは
   * ガードレールで棄却される前提の値（棄却なしだと二重計上で慢性的空腹になる）
   */
  hungerIncreasePerHour: 0.05,
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
  /**
   * 空腹の回復（負の hunger delta）のみのクランプ上限。食事は 1 回で
   * しっかり満腹に近づく行為なので、他パラメータの上限（0.3）とは分離する
   * （large_down = -0.6、down = -0.3）。空腹が進む方向は maxDeltaPerEvent のまま
   */
  maxHungerRecoveryPerEvent: 0.6,
  /**
   * 元気度の消耗（負の energy delta）のみのクランプ上限。時間経過の疲労は
   * decayInnerState が既にモデル化しているため、appraisal 側の消耗は
   * 「出来事による上乗せ」に留める（large_down = -0.15、down = -0.075、
   * small_down = -0.0375）。回復方向（充電・休憩など）は maxDeltaPerEvent のまま
   */
  maxEnergyExertionPerEvent: 0.15,
  /** 遅延評価で一度に進める経過時間の上限（時間）。長期停止後の暴走防止 */
  maxLazyElapsedHours: 48,
  /** 概日リズム: 深夜（0-5 時）の元気度減衰倍率 */
  circadianLateNightFactor: 1.6,
  /** 概日リズム: 朝（6-9 時）の元気度減衰倍率（調子が出ない） */
  circadianMorningFactor: 1.2,
};

/** appraisal 処理系バージョン。プロンプト版 + モデル + チューニングセット */
// v2: social 方向の定義・valence 正バイアス校正・sleep 遷移の定義（#102）、
//     open prospects の提示と kind の使い分け（#105）、relation の制御語彙化（#106）
// v3: hunger_down は実際の飲食/エネルギー補給のみと明記 + 飲食文脈の無い
//     負の hunger delta を棄却するガードレール（実機でチケット購入・
//     idle_reminder 等に hunger_down が出て食事の意味が薄まった）
// v4: belief_conflict（訂正・矛盾の検出）を追加し、true なら salience を
//     medium へ床上げ（#112 — 訂正が low で埋もれ、訂正前の省察で確定した
//     誤った belief が丸一日生き残った）
// v5: 空腹判定の 3 点修正 — ①無行動イベント（idle_reminder / wait_completed /
//     failed_attempt）の hunger_up を棄却（時間経過の空腹はルール側が担う）
//     ②飲食文脈の正規表現を payload 全体 → KW 通知の summary に限定
//     （choices の「パンを買う」等のメニュー文言で棄却が素通りしていた）
//     ③プロンプトに時間経過で hunger_up を出さない指示を明記
export const APPRAISAL_PROMPT_VERSION = 'appraisal-v5';

/** ペルソナ依存の解釈パターン上書き（env 由来）。設定値は判定の意味論を変えるため proc_version に痕跡を残す */
export interface InterpretationOverrides {
  /** KW_SLEEP_ACTION_PATTERN（正規表現ソース文字列） */
  sleepActionPattern?: string | undefined;
  /** APPRAISAL_FOOD_CONTEXT_PATTERN（正規表現ソース文字列） */
  foodContextPattern?: string | undefined;
}

/** proc_version 用の短い安定ハッシュ（djb2、8 hex）。パターン本文をそのまま埋めると版文字列が肥大するため */
function shortHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * 出力取得モードも判定プロセスの一部（プロンプト構成・コール分割が変わる）なので
 * proc_version に含める。json_schema（現行）は表記を変えず後方互換を保つ。
 * 解釈パターンの上書き（睡眠・飲食）も判定の意味論を変えるため、設定時のみ
 * `+interp(...)` を付与する（未設定時は従来の表記のまま）
 */
export function buildAppraisalProcVersion(
  model: string,
  outputMode: 'json_schema' | 'tool' = 'json_schema',
  interpretation?: InterpretationOverrides,
): string {
  let promptVersion = outputMode === 'tool'
    ? `${APPRAISAL_PROMPT_VERSION}+tool-v1`
    : APPRAISAL_PROMPT_VERSION;
  const interpParts: string[] = [];
  if (interpretation?.sleepActionPattern != null) {
    interpParts.push(`s:${shortHash(interpretation.sleepActionPattern)}`);
  }
  if (interpretation?.foodContextPattern != null) {
    interpParts.push(`f:${shortHash(interpretation.foodContextPattern)}`);
  }
  if (interpParts.length > 0) {
    promptVersion += `+interp(${interpParts.join(',')})`;
  }
  return `${promptVersion}/${model}/${LIFE_TUNING_VERSION}`;
}
