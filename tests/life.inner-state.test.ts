import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  circadianEnergyDecayFactor,
  decayInnerState,
  defaultInnerState,
  describeInnerState,
  InnerStateService,
  SqliteInnerStateStore,
  type InnerState,
} from '../src/life/inner-state.js';
import { LIFE_TUNING } from '../src/life/tuning.js';

const temporaryDirectories: string[] = [];
const stores: SqliteInnerStateStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createStore(): Promise<SqliteInnerStateStore> {
  const dataDir = join(process.cwd(), '.test-artifacts', `karakuri-inner-state-${randomUUID()}`);
  await mkdir(dataDir, { recursive: true });
  temporaryDirectories.push(dataDir);
  const store = new SqliteInnerStateStore({ dataDir });
  stores.push(store);
  return store;
}

function makeState(overrides: Partial<InnerState> = {}): InnerState {
  return {
    updatedAt: '2026-07-05T03:00:00.000Z', // JST 12:00（昼、概日係数 1.0）
    valence: 0.5,
    energy: 0.8,
    hunger: 0.3,
    social: 0.3,
    sleeping: false,
    ...overrides,
  };
}

describe('decayInnerState', () => {
  it('decays energy and raises hunger/social while awake', () => {
    const state = makeState();
    const decayed = decayInnerState(state, new Date('2026-07-05T07:00:00.000Z'), 'Asia/Tokyo');

    // 4 時間経過（JST 12:00→16:00、概日係数 1.0）
    expect(decayed.energy).toBeCloseTo(0.8 - LIFE_TUNING.energyDecayPerHour * 4, 5);
    expect(decayed.hunger).toBeCloseTo(0.3 + LIFE_TUNING.hungerIncreasePerHour * 4, 5);
    expect(decayed.social).toBeCloseTo(0.3 + LIFE_TUNING.socialIncreasePerHour * 4, 5);
    expect(decayed.updatedAt).toBe('2026-07-05T07:00:00.000Z');
  });

  it('returns valence toward the baseline with a half-life', () => {
    const state = makeState({ valence: 0.8 });
    const decayed = decayInnerState(
      state,
      new Date(new Date(state.updatedAt).getTime() + LIFE_TUNING.valenceHalfLifeHours * 3_600_000),
      'Asia/Tokyo',
    );
    expect(decayed.valence).toBeCloseTo(0.4, 5);
  });

  it('recovers energy while sleeping (rule-side minimum recovery)', () => {
    const state = makeState({ sleeping: true, energy: 0.1 });
    const decayed = decayInnerState(state, new Date('2026-07-05T09:00:00.000Z'), 'Asia/Tokyo');

    // 睡眠 6 時間 → 下限保証ぶん必ず回復する（appraisal がゼロを出しても張り付かない）
    expect(decayed.energy).toBeCloseTo(0.1 + LIFE_TUNING.sleepEnergyRecoveryPerHour * 6, 5);
    // 睡眠中の空腹進行は減速し、社交欲求は増えない
    expect(decayed.hunger).toBeCloseTo(0.3 + LIFE_TUNING.hungerIncreasePerHour * LIFE_TUNING.sleepingHungerFactor * 6, 5);
    expect(decayed.social).toBeCloseTo(0.3, 5);
  });

  it('applies circadian factors (late night drains more than midday)', () => {
    expect(circadianEnergyDecayFactor(2)).toBeGreaterThan(circadianEnergyDecayFactor(14));
    expect(circadianEnergyDecayFactor(7)).toBeGreaterThan(1);

    // JST 深夜 2:00〜4:00 の 2 時間は昼間より消耗が大きい
    const midnight = makeState({ updatedAt: '2026-07-04T17:00:00.000Z' }); // JST 02:00
    const midday = makeState({ updatedAt: '2026-07-05T03:00:00.000Z' });  // JST 12:00
    const midnightDecayed = decayInnerState(midnight, new Date('2026-07-04T19:00:00.000Z'), 'Asia/Tokyo');
    const middayDecayed = decayInnerState(midday, new Date('2026-07-05T05:00:00.000Z'), 'Asia/Tokyo');
    expect(midnightDecayed.energy).toBeLessThan(middayDecayed.energy);
  });

  it('does not decay backwards in time', () => {
    const state = makeState();
    const decayed = decayInnerState(state, new Date('2026-07-05T02:00:00.000Z'), 'Asia/Tokyo');
    expect(decayed.energy).toBe(state.energy);
    expect(decayed.updatedAt).toBe(state.updatedAt);
  });

  it('caps very long elapsed periods and clamps to valid ranges', () => {
    const state = makeState({ hunger: 0.9 });
    const decayed = decayInnerState(state, new Date('2026-08-05T03:00:00.000Z'), 'Asia/Tokyo');
    expect(decayed.hunger).toBe(1);
    expect(decayed.energy).toBeGreaterThanOrEqual(0);
  });
});

describe('InnerStateService', () => {
  it('applies decay then deltas, and persists history', async () => {
    const store = await createStore();
    const service = new InnerStateService({ store, timezone: 'Asia/Tokyo' });

    await store.set(makeState({ energy: 0.5, hunger: 0.8 }), 'seed');
    const next = await service.applyAppraisal({
      receivedAt: new Date('2026-07-05T04:00:00.000Z'), // 1 時間後
      deltas: { valence: 0.15, energy: 0, hunger: -0.3, social: 0 },
      sleep: 'no_change',
      trigger: 'test/meal',
    });

    expect(next.hunger).toBeCloseTo(0.8 + LIFE_TUNING.hungerIncreasePerHour - 0.3, 5);
    expect(next.energy).toBeCloseTo(0.5 - LIFE_TUNING.energyDecayPerHour, 5);
    const history = await store.getHistory(5);
    expect(history.length).toBe(2);
    expect(history[0]?.trigger).toBe('test/meal');
  });

  it('handles sleep transitions', async () => {
    const store = await createStore();
    const service = new InnerStateService({ store, timezone: 'Asia/Tokyo' });

    const asleep = await service.applyAppraisal({
      receivedAt: new Date('2026-07-05T04:00:00.000Z'),
      deltas: { valence: 0, energy: 0, hunger: 0, social: 0 },
      sleep: 'fell_asleep',
    });
    expect(asleep.sleeping).toBe(true);

    const awake = await service.applyAppraisal({
      receivedAt: new Date('2026-07-05T10:00:00.000Z'),
      deltas: { valence: 0, energy: 0, hunger: 0, social: 0 },
      sleep: 'woke_up',
    });
    expect(awake.sleeping).toBe(false);
    // 睡眠 6 時間ぶんの下限保証回復が乗っている
    expect(awake.energy).toBeGreaterThan(asleep.energy);
  });

  it('serializes concurrent applications (no lost updates)', async () => {
    const store = await createStore();
    const service = new InnerStateService({ store, timezone: 'Asia/Tokyo' });
    await store.set(makeState({ valence: 0 }), 'seed');

    await Promise.all(
      Array.from({ length: 5 }, (_, index) => service.applyAppraisal({
        receivedAt: new Date(`2026-07-05T03:00:0${index + 1}.000Z`),
        deltas: { valence: 0.1, energy: 0, hunger: 0, social: 0 },
        sleep: 'no_change',
      })),
    );

    const state = await store.get();
    // 5 回の +0.1 がすべて反映される（read-modify-write の競合で失われない）
    expect(state?.valence).toBeCloseTo(0.5, 3);
  });

  it('returns a decayed view without persisting via getCurrent', async () => {
    const store = await createStore();
    const service = new InnerStateService({ store, timezone: 'Asia/Tokyo' });
    await store.set(makeState({ energy: 0.5 }), 'seed');

    const view = await service.getCurrent(new Date('2026-07-05T05:00:00.000Z'));
    expect(view.energy).toBeLessThan(0.5);
    // 永続値は変わらない
    expect((await store.get())?.energy).toBe(0.5);
  });
});

describe('describeInnerState', () => {
  it('never exposes numbers or parameter names', () => {
    const description = describeInnerState(makeState({ valence: -0.6, energy: 0.1, hunger: 0.9, social: 0.8 }));
    expect(description).not.toMatch(/[0-9]/);
    expect(description).not.toMatch(/valence|energy|hunger|social/i);
  });

  it('describes exhaustion, hunger, and low mood in natural language', () => {
    const description = describeInnerState(makeState({ valence: -0.6, energy: 0.1, hunger: 0.9 }));
    expect(description).toContain('疲れ');
    expect(description).toContain('お腹');
    expect(description).toContain('沈んで');
  });

  it('describes sleeping state', () => {
    expect(describeInnerState(makeState({ sleeping: true }))).toContain('眠って');
  });

  it('falls back to a calm default description', () => {
    const description = describeInnerState(makeState({ valence: 0, energy: 0.7, hunger: 0.3, social: 0.3 }));
    expect(description.length).toBeGreaterThan(0);
    expect(description).toContain('落ち着い');
  });

  it('default state is usable', () => {
    expect(describeInnerState(defaultInnerState(new Date()))).toBeTruthy();
  });
});
