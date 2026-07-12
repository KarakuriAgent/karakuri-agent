/**
 * seed 記憶のインポート（M4）。
 *
 * seed 記憶: 立ち上げ時の初期記憶（この世界に来た経緯・住んでいる場所・暮らしの下地）。
 * LLM は「自分が何者か」を指示より文脈上の証拠から推論するため、記憶の蓄積が最強の
 * 定着装置になる。内容は人格定義（AGENT.md）と整合させて data/seed-memories.json に書く。
 *
 * provenance の整合: experience_log に区別可能な kind（seed）で投入してから
 * beliefs / narratives が参照する（一次資料 NOT NULL と整合）。
 * 冪等: life_meta のフラグで一度だけ実行される。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { z } from 'zod';

import { createLogger } from '../utils/logger.js';
import type { IBeliefStore } from './beliefs.js';
import { getLifeMeta, setLifeMeta } from './db.js';
import type { INarrativeStore } from './narratives.js';
import { EVENT_KINDS, type IExperienceLogStore } from './types.js';

const logger = createLogger('LifeSeed');

export const SEED_MEMORIES_FILE = 'seed-memories.json';
const META_SEED_IMPORTED = 'seed_imported';
const SEED_PROC_VERSION = 'seed-v1';

const seedFileSchema = z.object({
  beliefs: z.array(z.object({
    kind: z.enum(['world_fact', 'person_fact', 'self']),
    subject: z.string().optional(),
    body: z.string().min(1),
    confidence: z.number().min(0).max(1).default(0.9),
  })).default([]),
  narratives: z.array(z.object({
    kind: z.enum(['diary', 'theme', 'chapter']),
    period_start: z.string().min(1),
    period_end: z.string().min(1),
    body: z.string().min(1),
  })).default([]),
});

export interface ImportSeedMemoriesOptions {
  db: Database.Database;
  dataDir: string;
  experienceLogStore: IExperienceLogStore;
  beliefStore: IBeliefStore;
  narrativeStore: INarrativeStore;
  now?: () => Date;
}

/** data/seed-memories.json があれば一度だけ beliefs / narratives へ投入する */
export async function importSeedMemories({
  db,
  dataDir,
  experienceLogStore,
  beliefStore,
  narrativeStore,
  now = () => new Date(),
}: ImportSeedMemoriesOptions): Promise<{ beliefs: number; narratives: number } | null> {
  if (getLifeMeta(db, META_SEED_IMPORTED) != null) {
    return null;
  }
  const seedPath = join(dataDir, SEED_MEMORIES_FILE);
  if (!existsSync(seedPath)) {
    return null;
  }

  let parsed: z.infer<typeof seedFileSchema>;
  try {
    parsed = seedFileSchema.parse(JSON.parse(readFileSync(seedPath, 'utf8')));
  } catch (error) {
    logger.error('Failed to parse seed memories file; skipping seed import', error, { seedPath });
    return null;
  }

  let beliefs = 0;
  for (const belief of parsed.beliefs) {
    const eventId = await experienceLogStore.append({
      receivedAt: now(),
      channel: 'seed',
      kind: EVENT_KINDS.seed,
      payload: { type: 'belief', ...belief },
    });
    await beliefStore.insert({
      kind: belief.kind,
      ...(belief.subject != null ? { subject: belief.subject } : {}),
      body: belief.body,
      // seed は人格定義由来の初期記憶なので単一出所キャップの対象外にする（出所 2 扱い）
      confidence: belief.confidence,
      provenance: [eventId, eventId],
      procVersion: SEED_PROC_VERSION,
    });
    beliefs += 1;
  }

  let narratives = 0;
  for (const narrative of parsed.narratives) {
    const eventId = await experienceLogStore.append({
      receivedAt: now(),
      channel: 'seed',
      kind: EVENT_KINDS.seed,
      payload: { type: 'narrative', ...narrative },
    });
    await narrativeStore.insert({
      kind: narrative.kind,
      periodStart: narrative.period_start,
      periodEnd: narrative.period_end,
      body: narrative.body,
      provenance: [eventId],
      procVersion: SEED_PROC_VERSION,
    });
    narratives += 1;
  }

  setLifeMeta(db, META_SEED_IMPORTED, now().toISOString());
  logger.info('Seed memories imported', { beliefs, narratives });
  return { beliefs, narratives };
}
