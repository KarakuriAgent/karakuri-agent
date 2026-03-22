import { Cron } from 'croner';

import type { CronJobDefinition, SchedulerSessionMode } from './types.js';

const FRONTMATTER_DELIMITER = '---';
const QUOTED_VALUE_PATTERN = /^("([\s\S]*)"|'([\s\S]*)')$/;

export const CRON_JOB_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function parseCronMarkdown(jobName: string, markdown: string): CronJobDefinition {
  if (!CRON_JOB_NAME_PATTERN.test(jobName)) {
    throw new Error('Cron job name must match /^[a-z0-9][a-z0-9-]*$/');
  }

  const normalized = markdown.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');

  if (!normalized.startsWith(`${FRONTMATTER_DELIMITER}\n`)) {
    throw new Error('CRON.md must start with frontmatter');
  }

  const closingIndex = normalized.indexOf(`\n${FRONTMATTER_DELIMITER}\n`, FRONTMATTER_DELIMITER.length + 1);
  if (closingIndex < 0) {
    throw new Error('CRON.md frontmatter must end with a closing delimiter');
  }

  const frontmatterBlock = normalized.slice(FRONTMATTER_DELIMITER.length + 1, closingIndex);
  const body = normalized.slice(closingIndex + `\n${FRONTMATTER_DELIMITER}\n`.length).trim();

  if (body.length === 0) {
    throw new Error('CRON.md body must not be empty');
  }

  const metadata = parseFrontmatter(frontmatterBlock);
  const schedule = parseRequiredString(metadata, 'schedule');
  const sessionMode = parseOptionalSessionMode(metadata, 'session-mode') ?? 'isolated';
  const enabled = parseOptionalBoolean(metadata, 'enabled') ?? true;
  const staggerMs = parseOptionalInteger(metadata, 'stagger-ms') ?? 0;

  assertValidCronSchedule(schedule);
  assertNoUnknownKeys(metadata);

  return {
    name: jobName,
    schedule,
    instructions: body,
    enabled,
    sessionMode,
    staggerMs,
  };
}

export function renderCronMarkdown(job: CronJobDefinition): string {
  const instructions = job.instructions.trim();
  if (instructions.length === 0) {
    throw new Error('Cron job instructions must not be empty');
  }

  return [
    FRONTMATTER_DELIMITER,
    `schedule: "${job.schedule}"`,
    `session-mode: ${job.sessionMode}`,
    `enabled: ${job.enabled ? 'true' : 'false'}`,
    `stagger-ms: ${job.staggerMs}`,
    FRONTMATTER_DELIMITER,
    instructions,
    '',
  ].join('\n');
}

function parseFrontmatter(frontmatterBlock: string): Map<string, string> {
  const metadata = new Map<string, string>();

  for (const rawLine of frontmatterBlock.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }

    const separatorIndex = line.indexOf(':');
    if (separatorIndex <= 0) {
      throw new Error(`Invalid frontmatter line: ${rawLine}`);
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    if (value.length === 0) {
      throw new Error(`Frontmatter value is required for ${key}`);
    }

    if (metadata.has(key)) {
      throw new Error(`Duplicate frontmatter key: ${key}`);
    }

    metadata.set(key, unwrapQuotedValue(value));
  }

  return metadata;
}

function parseRequiredString(metadata: Map<string, string>, key: string): string {
  const value = metadata.get(key)?.trim();
  if (value == null || value.length === 0) {
    throw new Error(`Frontmatter ${key} is required`);
  }

  return value;
}

function parseOptionalBoolean(metadata: Map<string, string>, key: string): boolean | undefined {
  const value = metadata.get(key);
  if (value == null) {
    return undefined;
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  throw new Error(`Frontmatter ${key} must be true or false`);
}

function parseOptionalSessionMode(metadata: Map<string, string>, key: string): SchedulerSessionMode | undefined {
  const value = metadata.get(key);
  if (value == null) {
    return undefined;
  }

  if (value === 'isolated' || value === 'shared') {
    return value;
  }

  throw new Error(`Frontmatter ${key} must be isolated or shared`);
}

function parseOptionalInteger(metadata: Map<string, string>, key: string): number | undefined {
  const value = metadata.get(key);
  if (value == null) {
    return undefined;
  }

  if (!/^\d+$/.test(value)) {
    throw new Error(`Frontmatter ${key} must be a non-negative integer`);
  }

  return Number.parseInt(value, 10);
}

function assertNoUnknownKeys(metadata: Map<string, string>): void {
  for (const key of metadata.keys()) {
    if (!['schedule', 'session-mode', 'enabled', 'stagger-ms'].includes(key)) {
      throw new Error(`Unknown frontmatter key: ${key}`);
    }
  }
}

function assertValidCronSchedule(schedule: string): void {
  if (schedule.trim().split(/\s+/).length !== 5) {
    throw new Error(`Invalid cron schedule: ${schedule}`);
  }

  try {
    const cron = new Cron(schedule, { paused: true });
    if (cron.nextRun() == null) {
      throw new Error('no future run');
    }
  } catch (error) {
    throw new Error(`Invalid cron schedule: ${schedule}`, { cause: error });
  }
}

function unwrapQuotedValue(value: string): string {
  const match = QUOTED_VALUE_PATTERN.exec(value);
  if (match == null) {
    return value;
  }

  return match[2] ?? match[3] ?? '';
}
