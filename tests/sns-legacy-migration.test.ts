import { mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { migrateLegacySnsActivityDb } from '../src/sns/legacy-migration.js';

const dirs: string[] = [];

async function makeDataDir() {
  const dir = join(process.env.TMPDIR ?? '.tmp-test', `karakuri-sns-migration-${Date.now()}-${dirs.length}`);
  await mkdir(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('migrateLegacySnsActivityDb', () => {
  it('requires explicit migration target when legacy DB exists', async () => {
    const dataDir = await makeDataDir();
    await writeFile(join(dataDir, 'sns-activity.db'), 'legacy');

    expect(() => migrateLegacySnsActivityDb({ dataDir, snsProviders: ['mastodon'] })).toThrow('SNS_LEGACY_DB_MIGRATE_TO');
  });

  it('renames legacy DB to the selected provider DB', async () => {
    const dataDir = await makeDataDir();
    await writeFile(join(dataDir, 'sns-activity.db'), 'legacy');
    await writeFile(join(dataDir, 'sns-activity.db-wal'), 'wal');
    await writeFile(join(dataDir, 'sns-activity.db-shm'), 'shm');

    migrateLegacySnsActivityDb({ dataDir, snsProviders: ['mastodon'], migrateTo: 'mastodon' });

    await expect(stat(join(dataDir, 'sns-activity-mastodon.db'))).resolves.toBeDefined();
    await expect(stat(join(dataDir, 'sns-activity-mastodon.db-wal'))).resolves.toBeDefined();
    await expect(stat(join(dataDir, 'sns-activity-mastodon.db-shm'))).resolves.toBeDefined();
    await expect(stat(join(dataDir, 'sns-activity.db'))).rejects.toThrow();
  });

  it('renames skipped legacy DB aside', async () => {
    const dataDir = await makeDataDir();
    await writeFile(join(dataDir, 'sns-activity.db'), 'legacy');

    migrateLegacySnsActivityDb({ dataDir, snsProviders: [], migrateTo: 'skip' });

    await expect(stat(join(dataDir, 'sns-activity.legacy.db'))).resolves.toBeDefined();
  });

  it('refuses migration when target provider is not configured', async () => {
    const dataDir = await makeDataDir();
    await writeFile(join(dataDir, 'sns-activity.db'), 'legacy');

    expect(() => migrateLegacySnsActivityDb({ dataDir, snsProviders: ['mastodon'], migrateTo: 'x' }))
      .toThrow('requires that provider to be configured in snsList');
    await expect(stat(join(dataDir, 'sns-activity.db'))).resolves.toBeDefined();
  });

  it('refuses migration when destination already exists', async () => {
    const dataDir = await makeDataDir();
    await writeFile(join(dataDir, 'sns-activity.db'), 'legacy');
    await writeFile(join(dataDir, 'sns-activity-mastodon.db-wal'), 'pre-existing-wal');

    expect(() => migrateLegacySnsActivityDb({ dataDir, snsProviders: ['mastodon'], migrateTo: 'mastodon' }))
      .toThrow('destination already exists');
    await expect(stat(join(dataDir, 'sns-activity.db'))).resolves.toBeDefined();
  });

  it('is idempotent on subsequent startups (legacy DB absent)', async () => {
    const dataDir = await makeDataDir();
    await writeFile(join(dataDir, 'sns-activity-mastodon.db'), 'already-migrated');

    expect(() => migrateLegacySnsActivityDb({ dataDir, snsProviders: ['mastodon'] })).not.toThrow();
    expect(() => migrateLegacySnsActivityDb({ dataDir, snsProviders: ['mastodon'], migrateTo: 'mastodon' })).not.toThrow();
  });
});
