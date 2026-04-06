import { describe, expect, it, vi } from 'vitest';

import { reportSafely } from '../src/utils/report.js';

describe('reportSafely', () => {
  it('suppresses Discord mentions by default', async () => {
    const messageSink = { postMessage: vi.fn(async () => {}) };

    await reportSafely(
      messageSink,
      'report',
      '@everyone pinged <@123> and <#456>',
      { error: vi.fn() },
    );

    expect(messageSink.postMessage).toHaveBeenCalledWith('report', '@​everyone pinged <@​123> and <#​456>');
  });

  it('allows Discord mentions when explicitly requested', async () => {
    const messageSink = { postMessage: vi.fn(async () => {}) };

    await reportSafely(
      messageSink,
      'report',
      '@everyone pinged <@123> and <#456>',
      { error: vi.fn() },
      { suppressDiscordMentions: false },
    );

    expect(messageSink.postMessage).toHaveBeenCalledWith('report', '@everyone pinged <@123> and <#456>');
  });
});
