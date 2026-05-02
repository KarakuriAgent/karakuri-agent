import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';

import type { SnsProviderType } from './types.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SnsLegacyMigration');

export interface MigrateLegacySnsActivityDbOptions {
  dataDir: string;
  snsProviders: SnsProviderType[];
  migrateTo?: SnsProviderType | 'skip' | undefined;
}

export function migrateLegacySnsActivityDb({ dataDir, snsProviders, migrateTo }: MigrateLegacySnsActivityDbOptions): void {
  const legacyPath = join(dataDir, 'sns-activity.db');
  if (!existsSync(legacyPath)) {
    return;
  }
  if (migrateTo == null) {
    throw new Error('Legacy data/sns-activity.db exists. Set SNS_LEGACY_DB_MIGRATE_TO=mastodon|x|elyth|skip before starting. See CHANGELOG for migration details.');
  }

  const destination = migrateTo === 'skip'
    ? join(dataDir, 'sns-activity.legacy.db')
    : join(dataDir, `sns-activity-${migrateTo}.db`);
  if (migrateTo !== 'skip' && !snsProviders.includes(migrateTo)) {
    throw new Error(`SNS_LEGACY_DB_MIGRATE_TO=${migrateTo} requires that provider to be configured in snsList.`);
  }

  const renamePlan: Array<{ from: string; to: string }> = [];
  for (const suffix of ['', '-wal', '-shm']) {
    const from = `${legacyPath}${suffix}`;
    const to = `${destination}${suffix}`;
    if (existsSync(to)) {
      throw new Error(`Cannot migrate legacy SNS activity DB because destination already exists: ${to}`);
    }
    if (!existsSync(from)) {
      continue;
    }
    renamePlan.push({ from, to });
  }

  const completed: Array<{ from: string; to: string }> = [];
  try {
    for (const step of renamePlan) {
      renameSync(step.from, step.to);
      completed.push(step);
    }
  } catch (error) {
    for (const step of completed.reverse()) {
      try {
        renameSync(step.to, step.from);
      } catch (rollbackError) {
        logger.error('Failed to rollback partial legacy SNS DB migration; manual recovery required', {
          step,
          rollbackError,
        });
      }
    }
    throw error;
  }
  logger.info('Migrated legacy sns-activity.db', { from: legacyPath, to: destination });
}
