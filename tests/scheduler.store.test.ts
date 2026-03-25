import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FileSchedulerStore } from '../src/scheduler/store.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createDataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'karakuri-scheduler-store-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeCron(dataDir: string, name: string, markdown: string): Promise<void> {
  const directory = join(dataDir, 'cron', name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'CRON.md'), markdown, 'utf8');
}

describe('FileSchedulerStore', () => {
  it('loads heartbeat instructions and cron jobs', async () => {
    const dataDir = await createDataDir();
    await writeFile(join(dataDir, 'HEARTBEAT.md'), 'Check systems.', 'utf8');
    await writeCron(dataDir, 'daily-summary', `---\nschedule: "0 9 * * *"\n---\nSend summary.`);

    const store = await FileSchedulerStore.create({ dataDir });

    await expect(store.readHeartbeatInstructions()).resolves.toBe('Check systems.');
    await expect(store.listCronJobs()).resolves.toEqual([
      {
        name: 'daily-summary',
        schedule: '0 9 * * *',
        instructions: 'Send summary.',
        enabled: true,
        sessionMode: 'isolated',
        staggerMs: 0,
        oneshot: false,
      },
    ]);

    await store.close();
  });

  it('skips invalid startup cron jobs while continuing to load valid ones', async () => {
    const dataDir = await createDataDir();
    await writeCron(dataDir, 'valid-job', `---\nschedule: "0 9 * * *"\n---\nRun.`);
    await writeCron(dataDir, 'broken-job', `---\nschedule: invalid\n---\nRun.`);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = await FileSchedulerStore.create({ dataDir });

    await expect(store.listCronJobs()).resolves.toEqual([
      {
        name: 'valid-job',
        schedule: '0 9 * * *',
        instructions: 'Run.',
        enabled: true,
        sessionMode: 'isolated',
        staggerMs: 0,
        oneshot: false,
      },
    ]);
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
    await store.close();
  });

  it('registers and unregisters cron jobs directly', async () => {
    const dataDir = await createDataDir();
    const store = await FileSchedulerStore.create({ dataDir });

    await expect(store.registerJob({
      name: 'daily-summary',
      schedule: '0 9 * * *',
      instructions: 'Send summary.',
      sessionMode: 'shared',
      staggerMs: 200,
      oneshot: false,
    })).resolves.toEqual({
      name: 'daily-summary',
      schedule: '0 9 * * *',
      instructions: 'Send summary.',
      enabled: true,
      sessionMode: 'shared',
      staggerMs: 200,
      oneshot: false,
    });

    await expect(store.listCronJobs()).resolves.toHaveLength(1);
    await expect(store.unregisterJob('daily-summary')).resolves.toBe(true);
    await expect(store.listCronJobs()).resolves.toEqual([]);

    await store.close();
  });

  it('removes a previously valid cron job when a reload makes it invalid', async () => {
    const dataDir = await createDataDir();
    await writeCron(dataDir, 'daily-summary', `---\nschedule: "0 9 * * *"\n---\nFirst version.`);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = await FileSchedulerStore.create({ dataDir });

    await writeCron(dataDir, 'daily-summary', `---\nschedule: "0 10 * * *"\n---\nSecond version.`);
    await vi.waitFor(async () => {
      await expect(store.listCronJobs()).resolves.toEqual([
        {
          name: 'daily-summary',
          schedule: '0 10 * * *',
          instructions: 'Second version.',
          enabled: true,
          sessionMode: 'isolated',
          staggerMs: 0,
          oneshot: false,
        },
      ]);
    }, { timeout: 1_500 });

    await writeCron(dataDir, 'daily-summary', `---\nschedule: invalid\n---\nBroken.`);
    await vi.waitFor(() => {
      expect(warnSpy).toHaveBeenCalled();
    }, { timeout: 1_500 });

    await expect(store.listCronJobs()).resolves.toEqual([]);

    warnSpy.mockRestore();
    await store.close();
  });
});
