import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { extractPostTopics } from '../src/agent/tools/sns.js';
import { SqliteRelationStore } from '../src/life/relations.js';
import { applyTraitsToTuning, DEFAULT_TRAITS, loadTraits, satiationThresholdFor } from '../src/life/traits.js';
import { LIFE_TUNING } from '../src/life/tuning.js';
import { decayInnerState, type InnerState } from '../src/life/inner-state.js';
import { snsLoopIntervalFactor } from '../src/sns/loop-runner.js';

const temporaryDirectories: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createDataDir(): Promise<string> {
  const dataDir = join(process.cwd(), '.test-artifacts', `karakuri-relations-${randomUUID()}`);
  await mkdir(dataDir, { recursive: true });
  temporaryDirectories.push(dataDir);
  return dataDir;
}

function makeState(overrides: Partial<InnerState> = {}): InnerState {
  return {
    updatedAt: '2026-07-05T03:00:00.000Z',
    valence: 0,
    energy: 0.8,
    hunger: 0.3,
    social: 0.3,
    sleeping: false,
    ...overrides,
  };
}

describe('SqliteRelationStore', () => {
  it('accumulates strength and affect over repeated observations (path-dependent)', async () => {
    const dataDir = await createDataDir();
    const store = new SqliteRelationStore({ dataDir });
    cleanups.push(() => store.close());

    await store.observe({
      subjectId: 'self',
      relation: 'friend_of',
      objectId: 'kw:agent:agent-b',
      affect: 0.3,
      observedAt: new Date('2026-07-05T10:00:00.000Z'),
      provenance: [1],
      procVersion: 'test',
    });
    await store.observe({
      subjectId: 'self',
      relation: 'friend_of',
      objectId: 'kw:agent:agent-b',
      affect: 0.3,
      observedAt: new Date('2026-07-05T11:00:00.000Z'),
      provenance: [2],
      procVersion: 'test',
    });

    const edges = await store.listForSubject('self');
    expect(edges).toHaveLength(1);
    expect(edges[0]!.strength).toBeCloseTo(0.2, 5);
    expect(edges[0]!.affect).toBeCloseTo(0.3, 5);
    expect(edges[0]!.provenance).toEqual([1, 2]);
  });

  it('unifies identities across channels via alias_of and resolves the primary', async () => {
    const dataDir = await createDataDir();
    const store = new SqliteRelationStore({ dataDir });
    cleanups.push(() => store.close());

    await store.linkAlias('sns:mastodon:acct-9', 'discord:user-1', [], 'test');
    expect(await store.resolvePrimary('sns:mastodon:acct-9')).toBe('discord:user-1');
    expect(await store.resolvePrimary('discord:user-1')).toBe('discord:user-1');
  });

  it('expands 1-2 hop neighbors with a recursive CTE (KW と SNS の同一人物が想起で横断される)', async () => {
    const dataDir = await createDataDir();
    const store = new SqliteRelationStore({ dataDir });
    cleanups.push(() => store.close());

    // KW の相手 B の SNS アカウントが alias_of で統合され、B の友人 C にも届く
    await store.linkAlias('sns:mastodon:b-acct', 'kw:agent:agent-b', [], 'test');
    await store.observe({
      subjectId: 'kw:agent:agent-b',
      relation: 'friend_of',
      objectId: 'kw:agent:agent-c',
      observedAt: new Date(),
      provenance: [],
      procVersion: 'test',
    });

    const oneHop = await store.neighbors('kw:agent:agent-b', 1);
    expect(oneHop).toEqual(expect.arrayContaining(['sns:mastodon:b-acct', 'kw:agent:agent-c']));

    const twoHops = await store.neighbors('sns:mastodon:b-acct', 2);
    expect(twoHops).toEqual(expect.arrayContaining(['kw:agent:agent-b', 'kw:agent:agent-c']));
  });
});

describe('traits', () => {
  it('modulates decay so the same event affects individuals differently', () => {
    const resilient = applyTraitsToTuning({ ...DEFAULT_TRAITS, resilience: 2 });
    const fragile = applyTraitsToTuning({ ...DEFAULT_TRAITS, resilience: 0.5 });
    const state = makeState({ valence: 0.8 });
    const later = new Date('2026-07-05T11:00:00.000Z'); // 8 時間後

    const resilientState = decayInnerState(state, later, 'Asia/Tokyo', resilient);
    const fragileState = decayInnerState(state, later, 'Asia/Tokyo', fragile);
    // 立ち直りが早い個体ほど気分がベースラインへ早く戻る
    expect(resilientState.valence).toBeLessThan(fragileState.valence);

    const social = applyTraitsToTuning({ ...DEFAULT_TRAITS, socialBaseline: 2 });
    expect(social.socialIncreasePerHour).toBeCloseTo(LIFE_TUNING.socialIncreasePerHour * 2, 5);
  });

  it('curiosity lowers the satiation threshold (飽きやすい)', () => {
    expect(satiationThresholdFor({ ...DEFAULT_TRAITS, curiosity: 2 }))
      .toBeLessThan(satiationThresholdFor(DEFAULT_TRAITS));
    expect(satiationThresholdFor({ ...DEFAULT_TRAITS, curiosity: 4 })).toBeGreaterThanOrEqual(2);
  });

  it('loads traits from data/traits.json with defaults on failure', async () => {
    const dataDir = await createDataDir();
    expect(loadTraits(dataDir)).toEqual(DEFAULT_TRAITS);

    await writeFile(join(dataDir, 'traits.json'), JSON.stringify({ resilience: 2, curiosity: 1.5 }), 'utf8');
    const traits = loadTraits(dataDir);
    expect(traits.resilience).toBe(2);
    expect(traits.curiosity).toBe(1.5);
    expect(traits.socialBaseline).toBe(1);

    await writeFile(join(dataDir, 'traits.json'), '{broken json', 'utf8');
    expect(loadTraits(dataDir)).toEqual(DEFAULT_TRAITS);
  });
});

describe('snsLoopIntervalFactor', () => {
  const noonJst = new Date('2026-07-05T03:00:00.000Z');
  const lateNightJst = new Date('2026-07-04T17:00:00.000Z'); // JST 02:00

  it('slows down when tired and speeds up when craving company', () => {
    const base = snsLoopIntervalFactor(makeState(), noonJst, 'Asia/Tokyo');
    const tired = snsLoopIntervalFactor(makeState({ energy: 0.1 }), noonJst, 'Asia/Tokyo');
    const social = snsLoopIntervalFactor(makeState({ social: 0.9 }), noonJst, 'Asia/Tokyo');

    expect(tired).toBeGreaterThan(base);
    expect(social).toBeLessThan(base);
  });

  it('reduces posting late at night and while sleeping (circadian rhythm)', () => {
    expect(snsLoopIntervalFactor(makeState(), lateNightJst, 'Asia/Tokyo'))
      .toBeGreaterThan(snsLoopIntervalFactor(makeState(), noonJst, 'Asia/Tokyo'));
    expect(snsLoopIntervalFactor(makeState({ sleeping: true }), noonJst, 'Asia/Tokyo')).toBe(3);
  });
});

describe('extractPostTopics', () => {
  it('prefers hashtags and falls back to a deterministic text key', () => {
    expect(extractPostTopics('今日はいい天気 #散歩 #からくり町')).toEqual(['散歩', 'からくり町']);
    expect(extractPostTopics('映画館で新作を観てきた。とても良かった。')).toEqual(['映画館で新作を観てきた。']);
    expect(extractPostTopics('   ')).toEqual([]);
  });
});
