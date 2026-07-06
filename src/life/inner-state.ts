/**
 * 内部状態（気分・元気度・空腹・社交欲求・睡眠）— M2。
 *
 * - 時間経過はルール（決定論）、出来事の解釈は LLM（appraisal）
 * - 遅延評価: 状態は「最終更新時刻」を持ち、イベント到着時に経過時間ぶんの
 *   減衰をまとめて計算してから appraisal を適用する。バックグラウンドタイマーなし
 * - 時計は受信実時刻（received_at）で統一（世界内時刻の意味論に依存しない）
 */

import type Database from 'better-sqlite3';

import { getHourInTimezone } from '../utils/date.js';
import { KeyedMutex } from '../utils/mutex.js';
import { createLogger } from '../utils/logger.js';
import { openLifeDatabase } from './db.js';
import { LIFE_TUNING, type LifeTuning } from './tuning.js';

const logger = createLogger('InnerState');

export interface InnerState {
  /** ISO8601。遅延評価の基準時刻 */
  updatedAt: string;
  /** 気分。-1（最悪）〜 1（最高）、ベースライン 0 */
  valence: number;
  /** 元気度。0（消耗）〜 1（万全） */
  energy: number;
  /** 空腹。0（満腹）〜 1（限界に空腹） */
  hunger: number;
  /** 社交欲求。0（満たされている）〜 1（強く人恋しい） */
  social: number;
  sleeping: boolean;
}

export function defaultInnerState(now: Date): InnerState {
  return {
    updatedAt: now.toISOString(),
    valence: 0,
    energy: 0.8,
    hunger: 0.3,
    social: 0.3,
    sleeping: false,
  };
}

export interface IInnerStateStore {
  get(): Promise<InnerState | null>;
  set(state: InnerState, trigger?: string): Promise<void>;
  getHistory(limit: number): Promise<Array<InnerState & { trigger: string | null }>>;
  close(): Promise<void>;
}

export interface SqliteInnerStateStoreOptions {
  dataDir?: string | undefined;
  db?: Database.Database | undefined;
}

interface InnerStateRow {
  updated_at: string;
  valence: number;
  energy: number;
  hunger: number;
  social: number;
  sleeping: number;
}

export class SqliteInnerStateStore implements IInnerStateStore {
  private readonly db: Database.Database;
  private readonly ownsDb: boolean;

  constructor({ dataDir, db }: SqliteInnerStateStoreOptions) {
    if (db != null) {
      this.db = db;
      this.ownsDb = false;
    } else if (dataDir != null) {
      this.db = openLifeDatabase({ dataDir });
      this.ownsDb = true;
    } else {
      throw new Error('SqliteInnerStateStore requires either dataDir or db');
    }
  }

  async get(): Promise<InnerState | null> {
    const row = this.db.prepare<[], InnerStateRow>(
      'SELECT updated_at, valence, energy, hunger, social, sleeping FROM inner_state WHERE id = 1',
    ).get();
    if (row == null) {
      return null;
    }

    return {
      updatedAt: row.updated_at,
      valence: row.valence,
      energy: row.energy,
      hunger: row.hunger,
      social: row.social,
      sleeping: row.sleeping !== 0,
    };
  }

  async set(state: InnerState, trigger?: string): Promise<void> {
    const write = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO inner_state (id, updated_at, valence, energy, hunger, social, sleeping)
        VALUES (1, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET
          updated_at = excluded.updated_at,
          valence = excluded.valence,
          energy = excluded.energy,
          hunger = excluded.hunger,
          social = excluded.social,
          sleeping = excluded.sleeping
      `).run(
        state.updatedAt,
        state.valence,
        state.energy,
        state.hunger,
        state.social,
        state.sleeping ? 1 : 0,
      );
      this.db.prepare(`
        INSERT INTO inner_state_history (recorded_at, valence, energy, hunger, social, sleeping, trigger)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        state.updatedAt,
        state.valence,
        state.energy,
        state.hunger,
        state.social,
        state.sleeping ? 1 : 0,
        trigger ?? null,
      );
    });
    write();
    return Promise.resolve();
  }

  async getHistory(limit: number): Promise<Array<InnerState & { trigger: string | null }>> {
    const rows = this.db.prepare<[number], InnerStateRow & { recorded_at: string; trigger: string | null }>(`
      SELECT recorded_at, valence, energy, hunger, social, sleeping, trigger
      FROM inner_state_history
      ORDER BY id DESC
      LIMIT ?
    `).all(Math.max(0, limit));

    return rows.map((row) => ({
      updatedAt: row.recorded_at,
      valence: row.valence,
      energy: row.energy,
      hunger: row.hunger,
      social: row.social,
      sleeping: row.sleeping !== 0,
      trigger: row.trigger,
    }));
  }

  async close(): Promise<void> {
    if (this.ownsDb && this.db.open) {
      this.db.close();
    }

    return Promise.resolve();
  }
}

/** 概日リズム: 時刻帯による元気度減衰の倍率（深夜は消耗が大きく、朝は調子が出ない） */
export function circadianEnergyDecayFactor(hourOfDay: number, tuning: LifeTuning = LIFE_TUNING): number {
  if (hourOfDay >= 0 && hourOfDay < 6) {
    return tuning.circadianLateNightFactor;
  }
  if (hourOfDay >= 6 && hourOfDay < 10) {
    return tuning.circadianMorningFactor;
  }
  return 1;
}

export function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function clampValence(value: number): number {
  return Math.min(1, Math.max(-1, value));
}

/**
 * 経過時間ぶんの決定論的な状態変化を計算する（遅延評価）。
 * 1 時間刻みで概日係数を積分する。睡眠中は元気度が回復方向（下限保証）、
 * 空腹進行は減速、社交欲求は停止する。
 */
export function decayInnerState(
  state: InnerState,
  to: Date,
  timezone: string,
  tuning: LifeTuning = LIFE_TUNING,
): InnerState {
  const from = new Date(state.updatedAt);
  const elapsedMs = to.getTime() - from.getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return { ...state, updatedAt: to.getTime() > from.getTime() ? to.toISOString() : state.updatedAt };
  }

  const totalHours = Math.min(elapsedMs / 3_600_000, tuning.maxLazyElapsedHours);
  let { valence, energy, hunger, social } = state;

  // 気分はベースライン 0 へ半減期で回帰する
  valence *= Math.pow(0.5, totalHours / tuning.valenceHalfLifeHours);

  // 1 時間刻みで概日係数を反映しながら積分する
  let remaining = totalHours;
  let cursor = from.getTime();
  while (remaining > 0) {
    const stepHours = Math.min(1, remaining);
    const hour = getHourInTimezone(new Date(cursor), timezone);
    if (state.sleeping) {
      energy += tuning.sleepEnergyRecoveryPerHour * stepHours;
      hunger += tuning.hungerIncreasePerHour * tuning.sleepingHungerFactor * stepHours;
    } else {
      energy -= tuning.energyDecayPerHour * circadianEnergyDecayFactor(hour, tuning) * stepHours;
      hunger += tuning.hungerIncreasePerHour * stepHours;
      social += tuning.socialIncreasePerHour * stepHours;
    }
    cursor += stepHours * 3_600_000;
    remaining -= stepHours;
  }

  return {
    updatedAt: to.toISOString(),
    valence: clampValence(valence),
    energy: clampUnit(energy),
    hunger: clampUnit(hunger),
    social: clampUnit(social),
    sleeping: state.sleeping,
  };
}

export interface InnerStateDeltas {
  valence: number;
  energy: number;
  hunger: number;
  social: number;
}

export type SleepTransition = 'fell_asleep' | 'woke_up' | 'no_change';

export interface ApplyAppraisalInput {
  receivedAt: Date;
  deltas: InnerStateDeltas;
  sleep: SleepTransition;
  trigger?: string | undefined;
}

export interface InnerStateServiceOptions {
  store: IInnerStateStore;
  timezone: string;
  tuning?: LifeTuning;
}

/**
 * 内部状態の読み書きサービス。
 * inner_state の遅延評価は read-modify-write のため、適用パスを mutex で直列化する。
 */
export class InnerStateService {
  private readonly store: IInnerStateStore;
  private readonly timezone: string;
  private readonly tuning: LifeTuning;
  private readonly mutex = new KeyedMutex();

  constructor({ store, timezone, tuning = LIFE_TUNING }: InnerStateServiceOptions) {
    this.store = store;
    this.timezone = timezone;
    this.tuning = tuning;
  }

  /** 現在の状態の減衰込みビュー（永続化しない） */
  async getCurrent(now: Date = new Date()): Promise<InnerState> {
    const stored = await this.store.get() ?? defaultInnerState(now);
    return decayInnerState(stored, now, this.timezone, this.tuning);
  }

  /** 減衰 → appraisal 変化量適用 → 永続化。直列化された適用パス */
  async applyAppraisal({ receivedAt, deltas, sleep, trigger }: ApplyAppraisalInput): Promise<InnerState> {
    return this.mutex.runExclusive('inner-state', async () => {
      const stored = await this.store.get() ?? defaultInnerState(receivedAt);
      const decayed = decayInnerState(stored, receivedAt, this.timezone, this.tuning);
      const next: InnerState = {
        updatedAt: decayed.updatedAt,
        valence: clampValence(decayed.valence + deltas.valence),
        energy: clampUnit(decayed.energy + deltas.energy),
        hunger: clampUnit(decayed.hunger + deltas.hunger),
        social: clampUnit(decayed.social + deltas.social),
        sleeping: sleep === 'fell_asleep' ? true : sleep === 'woke_up' ? false : decayed.sleeping,
      };
      await this.store.set(next, trigger);
      logger.debug('Inner state applied', { trigger, sleep });
      return next;
    });
  }
}

/**
 * 状態の自然言語化。数値・パラメータ名などのメタ情報をエージェントに見せない
 * （設計原則「数値は言葉に変換して注入する」）。
 */
export function describeInnerState(state: InnerState): string {
  const sentences: string[] = [];

  if (state.sleeping) {
    sentences.push('今は眠っている。よほどのことがなければ目を覚まさない。');
  }

  if (state.energy < 0.2) {
    sentences.push('くたくたに疲れていて、何をするのも億劫だ。');
  } else if (state.energy < 0.45) {
    sentences.push('疲れが残っていて、少し休みたい。');
  } else if (state.energy > 0.85) {
    sentences.push('体は軽く、元気いっぱいだ。');
  }

  if (state.hunger > 0.8) {
    sentences.push('かなりお腹が空いている。');
  } else if (state.hunger > 0.55) {
    sentences.push('少しお腹が空いてきた。');
  }

  if (state.valence > 0.4) {
    sentences.push('気分がとても良い。');
  } else if (state.valence > 0.15) {
    sentences.push('機嫌は悪くない。');
  } else if (state.valence < -0.4) {
    sentences.push('気分がかなり沈んでいる。');
  } else if (state.valence < -0.15) {
    sentences.push('少し気分が沈んでいる。');
  }

  if (state.social > 0.7) {
    sentences.push('誰かと話したい気分だ。');
  } else if (state.social < 0.15) {
    sentences.push('しばらく一人で過ごしたい気分だ。');
  }

  if (sentences.length === 0) {
    sentences.push('心身ともに落ち着いていて、普段どおりの調子だ。');
  }

  return sentences.join('');
}
