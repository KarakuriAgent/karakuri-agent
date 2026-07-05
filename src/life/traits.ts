/**
 * 気質（traits）— M6。
 *
 * 変化しにくい個体差を少数の固定パラメータとして持ち、appraisal の感度・減衰計算・
 * 欲求の重みの係数として実装する。人格定義（AGENT.md）と整合させる設定ファイル
 * （data/traits.json）で管理する。同じ出来事でも受け取り方が変わることで一貫した個性がつく。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { createLogger } from '../utils/logger.js';
import { DRIVES_DEFAULTS } from './drives.js';
import { LIFE_TUNING, type LifeTuning } from './tuning.js';

const logger = createLogger('LifeTraits');

export const TRAITS_FILE = 'traits.json';

const traitsSchema = z.object({
  /** 立ち直りの早さ（感情減衰速度）。1 が標準、大きいほど早く立ち直る */
  resilience: z.number().min(0.25).max(4).default(1),
  /** 社交欲求のベースライン。1 が標準、大きいほど人恋しくなりやすい */
  socialBaseline: z.number().min(0.25).max(4).default(1),
  /** 好奇心の強さ（飽きの進みやすさ）。1 が標準、大きいほど反復に早く飽きる */
  curiosity: z.number().min(0.25).max(4).default(1),
});

export type Traits = z.infer<typeof traitsSchema>;

export const DEFAULT_TRAITS: Traits = traitsSchema.parse({});

/** data/traits.json があれば読み込む。壊れていれば既定値で続行する */
export function loadTraits(dataDir: string): Traits {
  const traitsPath = join(dataDir, TRAITS_FILE);
  if (!existsSync(traitsPath)) {
    return DEFAULT_TRAITS;
  }

  try {
    const traits = traitsSchema.parse(JSON.parse(readFileSync(traitsPath, 'utf8')));
    logger.info('Traits loaded', traits);
    return traits;
  } catch (error) {
    logger.warn('Failed to load traits.json; using defaults', error);
    return DEFAULT_TRAITS;
  }
}

/** 気質を減衰・欲求のチューニングへ係数として反映する */
export function applyTraitsToTuning(traits: Traits, base: LifeTuning = LIFE_TUNING): LifeTuning {
  return {
    ...base,
    // 立ち直りが早いほど気分の半減期が短い
    valenceHalfLifeHours: base.valenceHalfLifeHours / traits.resilience,
    // 社交欲求ベースラインが高いほど社交欲求の増加が速い
    socialIncreasePerHour: base.socialIncreasePerHour * traits.socialBaseline,
  };
}

/** 好奇心が強いほど少ない反復で飽きる（閾値が下がる） */
export function satiationThresholdFor(traits: Traits): number {
  return Math.max(2, Math.round(DRIVES_DEFAULTS.satiationThreshold / traits.curiosity));
}
