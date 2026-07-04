/**
 * seed 記憶と既存データのインポート（M4）。
 *
 * - seed 記憶: 立ち上げ時の初期記憶（この世界に来た経緯・住んでいる場所・暮らしの下地）。
 *   LLM は「自分が何者か」を指示より文脈上の証拠から推論するため、記憶の蓄積が最強の
 *   定着装置になる。内容は人格定義（AGENT.md）と整合させて data/seed-memories.json に書く
 * - 既存データ: diary.db / users.db / memory.md を新ストアへ一括インポート
 *
 * provenance の整合: どちらも experience_log に区別可能な kind（seed / legacy_import）で
 * 投入してから beliefs / narratives が参照する（一次資料 NOT NULL と整合）。
 * 冪等: life_meta のフラグで一度だけ実行される。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { z } from 'zod';

import type { IDiaryStore, IMemoryStore } from '../memory/types.js';
import type { IUserStore } from '../user/types.js';
import { createLogger } from '../utils/logger.js';
import type { IBeliefStore } from './beliefs.js';
import { getLifeMeta, setLifeMeta } from './db.js';
import type { INarrativeStore } from './narratives.js';
import { EVENT_KINDS, type IExperienceLogStore } from './types.js';

const logger = createLogger('LifeSeed');

export const SEED_MEMORIES_FILE = 'seed-memories.json';
const META_SEED_IMPORTED = 'seed_imported';
const META_LEGACY_IMPORTED = 'legacy_imported';
const SEED_PROC_VERSION = 'seed-v1';
const LEGACY_PROC_VERSION = 'legacy-import-v1';

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

export interface ImportLegacyStoresOptions {
  db: Database.Database;
  experienceLogStore: IExperienceLogStore;
  beliefStore: IBeliefStore;
  narrativeStore: INarrativeStore;
  memoryStore: IMemoryStore;
  diaryStore: IDiaryStore;
  userStore?: IUserStore | undefined;
  now?: () => Date;
}

/**
 * 既存の diary.db / users.db / memory.md を「移行前の記録」として一度だけ
 * 新ストアへインポートする。旧ストアは M6 まで並走するため変更しない。
 */
export async function importLegacyStores({
  db,
  experienceLogStore,
  beliefStore,
  narrativeStore,
  memoryStore,
  diaryStore,
  userStore,
  now = () => new Date(),
}: ImportLegacyStoresOptions): Promise<{ diaries: number; coreMemory: boolean; profiles: number } | null> {
  if (getLifeMeta(db, META_LEGACY_IMPORTED) != null) {
    return null;
  }

  // 日記 → narratives(kind=diary)
  let diaries = 0;
  try {
    const dates = await diaryStore.listDiaryDates();
    for (const date of dates) {
      const content = await diaryStore.readDiary(date);
      if (content == null || content.trim().length === 0) {
        continue;
      }
      const eventId = await experienceLogStore.append({
        receivedAt: now(),
        channel: 'legacy:diary',
        kind: 'legacy_import',
        payload: { type: 'diary', date, content },
      });
      await narrativeStore.insert({
        kind: 'diary',
        periodStart: date,
        periodEnd: date,
        body: content.trim(),
        provenance: [eventId],
        procVersion: LEGACY_PROC_VERSION,
      });
      diaries += 1;
    }
  } catch (error) {
    logger.warn('Failed to import legacy diaries', error);
  }

  // core memory → belief(world_fact)
  let coreMemory = false;
  try {
    const content = await memoryStore.readCoreMemory();
    if (content.trim().length > 0) {
      const eventId = await experienceLogStore.append({
        receivedAt: now(),
        channel: 'legacy:core-memory',
        kind: 'legacy_import',
        payload: { type: 'core_memory', content },
      });
      await beliefStore.insert({
        kind: 'world_fact',
        body: content.trim(),
        confidence: 0.8,
        provenance: [eventId, eventId],
        procVersion: LEGACY_PROC_VERSION,
      });
      coreMemory = true;
    }
  } catch (error) {
    logger.warn('Failed to import legacy core memory', error);
  }

  // user profiles → beliefs(person_fact, subject = userId)
  let profiles = 0;
  if (userStore != null) {
    try {
      const users = await userStore.searchUsers('', { limit: 10_000 });
      for (const user of users) {
        if (user.profile == null || user.profile.trim().length === 0) {
          continue;
        }
        const eventId = await experienceLogStore.append({
          receivedAt: now(),
          channel: 'legacy:users',
          kind: 'legacy_import',
          payload: { type: 'user_profile', userId: user.userId, displayName: user.displayName, profile: user.profile },
        });
        await beliefStore.insert({
          kind: 'person_fact',
          subject: user.userId,
          body: `${user.displayName}: ${user.profile.trim()}`,
          confidence: 0.8,
          provenance: [eventId, eventId],
          procVersion: LEGACY_PROC_VERSION,
        });
        profiles += 1;
      }
    } catch (error) {
      logger.warn('Failed to import legacy user profiles', error);
    }
  }

  setLifeMeta(db, META_LEGACY_IMPORTED, now().toISOString());
  logger.info('Legacy stores imported', { diaries, coreMemory, profiles });
  return { diaries, coreMemory, profiles };
}
