import { describe, expect, it } from 'vitest';

import { parseCronMarkdown, renderCronMarkdown } from '../src/scheduler/frontmatter.js';

describe('parseCronMarkdown', () => {
  it('parses valid cron markdown with defaults', () => {
    const job = parseCronMarkdown('daily-summary', `---\nschedule: "0 9 * * *"\n---\nSend the summary.`);

    expect(job).toEqual({
      name: 'daily-summary',
      schedule: '0 9 * * *',
      instructions: 'Send the summary.',
      enabled: true,
      sessionMode: 'isolated',
      staggerMs: 0,
      oneshot: false,
    });
  });

  it('round-trips rendered markdown', () => {
    const markdown = renderCronMarkdown({
      name: 'daily-summary',
      schedule: '0 9 * * *',
      instructions: 'Send the summary.',
      enabled: false,
      sessionMode: 'shared',
      staggerMs: 500,
      oneshot: true,
    });

    expect(parseCronMarkdown('daily-summary', markdown)).toEqual({
      name: 'daily-summary',
      schedule: '0 9 * * *',
      instructions: 'Send the summary.',
      enabled: false,
      sessionMode: 'shared',
      staggerMs: 500,
      oneshot: true,
    });
  });

  it('rejects invalid schedules and unknown keys', () => {
    expect(() => parseCronMarkdown('daily-summary', `---\nschedule: invalid\n---\nRun.`)).toThrow(/Invalid cron schedule/);
    expect(() => parseCronMarkdown('daily-summary', `---\nschedule: "0 9 * * *"\ntimezone: UTC\n---\nRun.`)).toThrow(/Unknown frontmatter key/);
  });
});
