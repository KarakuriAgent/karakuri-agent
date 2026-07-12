import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildOneshotCronExpression, createProspectReminderTool, MAX_PROSPECT_REMINDERS } from '../src/agent/tools/prospect-reminder.js';
import { SqliteActionLedgerStore } from '../src/life/action-ledger.js';
import { buildDrivesDescription, describeSatiationPressure, describeShareUrge, describeStrongestDrive, type ShareUrgeDeps } from '../src/life/drives.js';
import type { InnerState } from '../src/life/inner-state.js';
import { formatProspectsForPrompt, normalizeProspectBody, prospectBodiesLookSimilar, SqliteProspectStore } from '../src/life/prospects.js';
import type { CronJobDefinition, ISchedulerStore, RegisterCronJobInput } from '../src/scheduler/types.js';

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

async function createProspectStore(): Promise<SqliteProspectStore> {
  const dataDir = join(process.cwd(), '.test-artifacts', `karakuri-prospects-${randomUUID()}`);
  await mkdir(dataDir, { recursive: true });
  temporaryDirectories.push(dataDir);
  const store = new SqliteProspectStore({ dataDir });
  cleanups.push(() => store.close());
  return store;
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

describe('SqliteProspectStore', () => {
  it('inserts prospects and lists open ones ordered by due date', async () => {
    const store = await createProspectStore();
    await store.insert({ kind: 'goal', body: 'チケット代1800円を稼ぐ', provenance: [1], procVersion: 'test' });
    await store.insert({ kind: 'promise', body: '明日Bさんと映画を観る', counterpart: 'kw:agent:agent-b', dueAt: '2026-07-06T10:00:00.000Z', provenance: [2], procVersion: 'test' });

    const open = await store.listOpen();
    expect(open).toHaveLength(2);
    expect(open[0]!.kind).toBe('promise'); // 期日ありが先
    expect(await store.hasOpenWithBody('明日Bさんと映画を観る')).toBe(true);
  });

  it('transitions status only from open (path-dependent state)', async () => {
    const store = await createProspectStore();
    const id = await store.insert({ kind: 'promise', body: '約束', provenance: [1], procVersion: 'test' });

    expect(await store.updateStatus(id, 'fulfilled')).toBe(true);
    // fulfilled → abandoned は不可（open からのみ遷移）
    expect(await store.updateStatus(id, 'abandoned')).toBe(false);
    expect((await store.getById(id))?.status).toBe('fulfilled');
    expect(await store.listOpen()).toHaveLength(0);
  });

  it('finds same-intent open prospects via normalization and trigram similarity (#105)', async () => {
    const store = await createProspectStore();
    const id = await store.insert({
      kind: 'intention',
      body: 'kbx-100からの1円の譲渡提案を処理する必要がある',
      provenance: [1],
      procVersion: 'test',
    });

    // 語尾ゆらぎの正規化一致
    expect((await store.findSimilarOpen('kbx-100からの1円の譲渡提案を処理する'))?.id).toBe(id);
    // 字面類似（直近登録なので対象）
    expect((await store.findSimilarOpen('kbx-100からの1円の譲渡提案について判断する必要がある'))?.id).toBe(id);
    // 無関係な意図はマッチしない
    expect(await store.findSimilarOpen('からくり町の水族館に行ってみたい')).toBeNull();
  });

  it('limits similarity matching to recently created prospects (#105)', async () => {
    const store = await createProspectStore();
    await store.insert({
      kind: 'intention',
      body: '新しい出会いを探すために周囲を探索し続ける',
      provenance: [1],
      procVersion: 'test',
    });

    // 25 時間後: 類似はもう対象外（正規化完全一致だけが全期間対象）
    const future = new Date(Date.now() + 25 * 3_600_000);
    expect(await store.findSimilarOpen('新しい出会いを探すために近くの通りを歩き回る', { now: future })).toBeNull();
    expect(await store.findSimilarOpen('新しい出会いを探すために周囲を探索する', { now: future })).not.toBeNull();
  });

  it('normalizes prospect bodies for dedupe (#105)', () => {
    expect(normalizeProspectBody('周囲を探索する必要がある。')).toBe(normalizeProspectBody('周囲を探索する'));
    expect(normalizeProspectBody('  周囲を 探索する！ ')).toBe(normalizeProspectBody('周囲を探索する'));
    // 丁寧形も平叙形と同じに正規化される
    expect(normalizeProspectBody('周囲を探索する必要があります')).toBe(normalizeProspectBody('周囲を探索する必要がある'));
    expect(normalizeProspectBody('水族館に行くつもりです')).toBe(normalizeProspectBody('水族館に行くつもりだ'));
    expect(prospectBodiesLookSimilar(
      normalizeProspectBody('kbx-100からの譲渡を受け入れるか判断する'),
      normalizeProspectBody('kbx-100からの譲渡を受け入れるか断るかを判断する'),
    )).toBe(true);
    // 相手名の接頭辞を共有するだけの別意図は類似と判定しない（誤 skip 防止）
    expect(prospectBodiesLookSimilar(
      normalizeProspectBody('kbx-100からの手紙を読む'),
      normalizeProspectBody('kbx-100からの依頼を断る'),
    )).toBe(false);
  });

  it('caps open prospects by counting directly and abandoning the oldest intention (#105)', async () => {
    const store = await createProspectStore();
    await store.insert({ kind: 'promise', body: '約束A', dueAt: '2026-07-06T10:00:00.000Z', provenance: [], procVersion: 'test' });
    await store.insert({ kind: 'intention', body: '一番古い意図', provenance: [], procVersion: 'test' });
    await store.insert({ kind: 'intention', body: '新しい意図', provenance: [], procVersion: 'test' });

    expect(await store.countOpen()).toBe(3);
    const oldest = await store.findOldestOpenByKind('intention');
    expect(oldest?.body).toBe('一番古い意図');
    // promise しか無い kind を尋ねたら intention は返らない
    expect((await store.findOldestOpenByKind('goal'))).toBeNull();
  });

  it('touch updates updated_at for open prospects (#105)', async () => {
    const store = await createProspectStore();
    const id = await store.insert({ kind: 'intention', body: '散歩する', provenance: [], procVersion: 'test' });
    const before = (await store.getById(id))!.updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.touch(id);
    const after = (await store.getById(id))!.updatedAt;
    expect(after >= before).toBe(true);
  });

  it('formats prospects for prompt injection', () => {
    const formatted = formatProspectsForPrompt([{
      id: 1,
      kind: 'promise',
      body: 'Bさんと映画を観る',
      counterpart: 'kw:agent:agent-b',
      dueAt: '2026-07-06T10:00:00.000Z',
      status: 'open',
      provenance: [],
      procVersion: 'test',
      createdAt: '',
      updatedAt: '',
    }]);
    expect(formatted).toContain('[約束]');
    expect(formatted).toContain('Bさんと映画を観る');
    expect(formatted).toContain('期日');
  });
});

describe('drives', () => {
  it('converts physiology into desires (strongest first)', () => {
    expect(describeStrongestDrive(makeState({ hunger: 0.9 }))).toContain('食べたい');
    expect(describeStrongestDrive(makeState({ energy: 0.1 }))).toContain('休みたい');
    expect(describeStrongestDrive(makeState({ social: 0.8 }))).toContain('話したい');
    expect(describeStrongestDrive(makeState())).toBeNull();
    expect(describeStrongestDrive(makeState({ sleeping: true, hunger: 1 }))).toBeNull();
  });

  it('emits satiation pressure phrased to encourage deviation, not habit', async () => {
    const dataDir = join(process.cwd(), '.test-artifacts', `karakuri-drives-${randomUUID()}`);
    await mkdir(dataDir, { recursive: true });
    temporaryDirectories.push(dataDir);
    const ledger = new SqliteActionLedgerStore({ dataDir });
    cleanups.push(() => ledger.close());

    const now = new Date('2026-07-05T12:00:00.000Z');
    for (let i = 0; i < 6; i += 1) {
      await ledger.increment('action', 'conversation_start', new Date(now.getTime() - i * 3_600_000));
    }

    const pressure = await describeSatiationPressure(ledger, now);
    expect(pressure).toContain('偏っている');
    expect(pressure).toContain('conversation_start');
    // 「習慣」としての固定化を促す言い回しは使わない
    expect(pressure).not.toContain('習慣');

    const combined = await buildDrivesDescription(makeState({ hunger: 0.9 }), ledger, now);
    expect(combined).toContain('食べたい');
    expect(combined).toContain('偏っている');
  });

  it('returns null below the satiation threshold', async () => {
    const dataDir = join(process.cwd(), '.test-artifacts', `karakuri-drives-${randomUUID()}`);
    await mkdir(dataDir, { recursive: true });
    temporaryDirectories.push(dataDir);
    const ledger = new SqliteActionLedgerStore({ dataDir });
    cleanups.push(() => ledger.close());
    await ledger.increment('action', 'move', new Date('2026-07-05T11:00:00.000Z'));

    expect(await describeSatiationPressure(ledger, new Date('2026-07-05T12:00:00.000Z'))).toBeNull();
  });
});

describe('describeShareUrge (M8 追補)', () => {
  const NOW = new Date('2026-07-06T12:00:00.000Z');
  const makeDeps = (overrides: Partial<ShareUrgeDeps> = {}): ShareUrgeDeps => ({
    countSalientEpisodesSince: async () => 1,
    getLastPostAt: async () => null,
    ...overrides,
  });

  it('urges sharing when a salient episode exists and nothing was posted recently', async () => {
    expect(await describeShareUrge(makeDeps(), NOW)).toContain('誰かに話したい');
  });

  it('stays silent during the post cooldown (pacemaker: max ~3/day at 8h)', async () => {
    const deps = makeDeps({ getLastPostAt: async () => '2026-07-06T05:00:00.000Z' }); // 7h 前
    expect(await describeShareUrge(deps, NOW)).toBeNull();
    // クールダウン明け（8h 超）は再び湧く
    const past = makeDeps({ getLastPostAt: async () => '2026-07-06T03:00:00.000Z' }); // 9h 前
    expect(await describeShareUrge(past, NOW)).not.toBeNull();
  });

  it('stays silent without a salient episode', async () => {
    const deps = makeDeps({ countSalientEpisodesSince: async () => 0 });
    expect(await describeShareUrge(deps, NOW)).toBeNull();
  });

  it('joins the drives description via buildDrivesDescription', async () => {
    const combined = await buildDrivesDescription(makeState(), undefined, NOW, { shareUrge: makeDeps() });
    expect(combined).toContain('誰かに話したい');
  });
});

describe('prospect reminder tool', () => {
  function createSchedulerStore(): ISchedulerStore & { jobs: Map<string, CronJobDefinition> } {
    const jobs = new Map<string, CronJobDefinition>();
    return {
      jobs,
      readHeartbeatInstructions: async () => null,
      listCronJobs: async () => [...jobs.values()],
      registerJob: async (input: RegisterCronJobInput) => {
        const job: CronJobDefinition = {
          name: input.name,
          schedule: input.schedule,
          instructions: input.instructions,
          enabled: input.enabled ?? true,
          sessionMode: input.sessionMode ?? 'isolated',
          staggerMs: input.staggerMs ?? 0,
          oneshot: input.oneshot ?? false,
        };
        jobs.set(job.name, job);
        return job;
      },
      unregisterJob: async (name: string) => jobs.delete(name),
      setReloadListener: () => {},
      close: async () => {},
    };
  }

  async function setup() {
    const prospectStore = await createProspectStore();
    const schedulerStore = createSchedulerStore();
    const postMessage = vi.fn().mockResolvedValue(undefined);
    const tool = createProspectReminderTool({
      schedulerStore,
      prospectStore,
      timezone: 'Asia/Tokyo',
      messageSink: { postMessage },
      reportChannelId: 'report',
      now: () => new Date('2026-07-05T00:00:00.000Z'),
    });
    const execute = tool.execute! as (input: unknown, ctx: unknown) => Promise<Record<string, unknown>>;
    return { prospectStore, schedulerStore, postMessage, execute };
  }

  it('registers a reminder-type oneshot cron job and reports it', async () => {
    const { prospectStore, schedulerStore, postMessage, execute } = await setup();
    const id = await prospectStore.insert({ kind: 'promise', body: 'Bさんと映画を観る', provenance: [1], procVersion: 'test' });

    const result = await execute({ action: 'register', prospect_id: id, remind_at: '2026-07-06T09:00:00+09:00' }, {});
    expect(result.status).toBe('registered');

    const job = schedulerStore.jobs.get(`prospect-reminder-${id}`);
    expect(job).toBeDefined();
    expect(job!.oneshot).toBe(true);
    // リマインダー型に限定: 指示は決定論テキスト + prospect 本文は untrusted タグ内
    expect(job!.instructions).toContain('展望記憶リマインダー');
    expect(job!.instructions).toContain('<prospect>');
    expect(job!.instructions).toContain('Bさんと映画を観る');
    // JST 2026-07-06 09:00 の oneshot cron
    expect(job!.schedule).toBe('0 9 6 7 *');
    expect(postMessage).toHaveBeenCalledWith('report', expect.stringContaining('登録しました'));
  });

  it('enforces the reminder count limit', async () => {
    const { prospectStore, schedulerStore, execute } = await setup();
    for (let i = 0; i < MAX_PROSPECT_REMINDERS; i += 1) {
      schedulerStore.jobs.set(`prospect-reminder-existing-${i}`, {
        name: `prospect-reminder-existing-${i}`,
        schedule: '0 9 * * *',
        instructions: 'x',
        enabled: true,
        sessionMode: 'isolated',
        staggerMs: 0,
        oneshot: true,
      });
    }
    const id = await prospectStore.insert({ kind: 'intention', body: '観光に行きたい', provenance: [1], procVersion: 'test' });

    const result = await execute({ action: 'register', prospect_id: id, remind_at: '2026-07-06T09:00:00+09:00' }, {});
    expect(result.error).toContain('上限');
  });

  it('rejects non-open prospects and past times, and cancels with report', async () => {
    const { prospectStore, postMessage, execute } = await setup();
    const id = await prospectStore.insert({ kind: 'promise', body: '終わった約束', provenance: [1], procVersion: 'test' });
    await prospectStore.updateStatus(id, 'fulfilled');

    expect((await execute({ action: 'register', prospect_id: id, remind_at: '2026-07-06T09:00:00+09:00' }, {})).error).toContain('open');
    expect((await execute({ action: 'register', prospect_id: 999, remind_at: '2020-01-01T00:00:00Z' }, {})).error).toContain('未来');

    const openId = await prospectStore.insert({ kind: 'promise', body: '生きてる約束', provenance: [1], procVersion: 'test' });
    await execute({ action: 'register', prospect_id: openId, remind_at: '2026-07-06T09:00:00+09:00' }, {});
    const cancelled = await execute({ action: 'cancel', prospect_id: openId }, {});
    expect(cancelled.status).toBe('cancelled');
    expect(postMessage).toHaveBeenCalledWith('report', expect.stringContaining('解除しました'));
  });

  it('builds oneshot cron expressions in the configured timezone', () => {
    expect(buildOneshotCronExpression(new Date('2026-07-06T00:00:00.000Z'), 'Asia/Tokyo')).toBe('0 9 6 7 *');
    expect(buildOneshotCronExpression(new Date('2026-12-31T23:30:00.000Z'), 'UTC')).toBe('30 23 31 12 *');
  });
});
