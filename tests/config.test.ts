import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

const validEnv = {
  DISCORD_APPLICATION_ID: 'app',
  DISCORD_BOT_TOKEN: 'token',
  DISCORD_PUBLIC_KEY: 'public',
  OPENAI_API_KEY: 'openai',
};

describe('loadConfig', () => {
  it('loads valid config with defaults', () => {
    const config = loadConfig({
      ...validEnv,
      DATA_DIR: './tmp-data',
    });

    expect(config.dataDir).toBe(resolve('./tmp-data'));
    expect(config.timezone).toBe('Asia/Tokyo');
    expect(config.openaiModel).toBe('gpt-4o');
    expect(config.maxSteps).toBe(10);
    expect(config.tokenBudget).toBe(8_000);
    expect(config.port).toBe(3_000);
    expect(config.heartbeatIntervalMinutes).toBe(30);
    expect(config.braveApiKey).toBeUndefined();
    expect(config.postMessageChannelIds).toBeUndefined();
    expect(config.allowedChannelIds).toBeUndefined();
    expect(config.adminUserIds).toBeUndefined();
  });

  it('parses channel and admin allowlists', () => {
    const config = loadConfig({
      ...validEnv,
      ALLOWED_CHANNEL_IDS: 'channel-1, channel-2',
      REPORT_CHANNEL_ID: 'report-1',
      ADMIN_USER_IDS: 'admin-1, admin-2',
      HEARTBEAT_INTERVAL_MINUTES: '15',
    });

    expect(config.postMessageChannelIds).toEqual(['channel-1', 'channel-2']);
    expect(config.allowedChannelIds).toEqual(['channel-1', 'channel-2', 'report-1']);
    expect(config.reportChannelId).toBe('report-1');
    expect(config.adminUserIds).toEqual(['admin-1', 'admin-2']);
    expect(config.heartbeatIntervalMinutes).toBe(15);
  });

  it('treats an empty REPORT_CHANNEL_ID as omitted', () => {
    const config = loadConfig({
      ...validEnv,
      ALLOWED_CHANNEL_IDS: 'channel-1, channel-2',
      REPORT_CHANNEL_ID: '   ',
    });

    expect(config.reportChannelId).toBeUndefined();
    expect(config.postMessageChannelIds).toEqual(['channel-1', 'channel-2']);
    expect(config.allowedChannelIds).toEqual(['channel-1', 'channel-2']);
  });

  it('keeps report-only channels out of the postMessage allowlist', () => {
    const config = loadConfig({
      ...validEnv,
      REPORT_CHANNEL_ID: 'report-1',
    });

    expect(config.postMessageChannelIds).toBeUndefined();
    expect(config.allowedChannelIds).toEqual(['report-1']);
    expect(config.reportChannelId).toBe('report-1');
  });

  it('accepts DISCORD_TOKEN as alias for DISCORD_BOT_TOKEN', () => {
    const config = loadConfig({
      DISCORD_APPLICATION_ID: 'app',
      DISCORD_TOKEN: 'alias-token',
      DISCORD_PUBLIC_KEY: 'public',
      OPENAI_API_KEY: 'openai',
    });

    expect(config.discordBotToken).toBe('alias-token');
  });

  it('accepts AGENT_MODEL as alias for OPENAI_MODEL', () => {
    const config = loadConfig({
      ...validEnv,
      AGENT_MODEL: 'gpt-4o-mini',
    });

    expect(config.openaiModel).toBe('gpt-4o-mini');
  });

  it('accepts AGENT_MAX_STEPS as alias for MAX_STEPS', () => {
    const config = loadConfig({
      ...validEnv,
      AGENT_MAX_STEPS: '5',
    });

    expect(config.maxSteps).toBe(5);
  });

  it('accepts AGENT_TOKEN_BUDGET as alias for TOKEN_BUDGET', () => {
    const config = loadConfig({
      ...validEnv,
      AGENT_TOKEN_BUDGET: '4000',
    });

    expect(config.tokenBudget).toBe(4_000);
  });

  it('accepts BRAVE_API_KEY as an optional setting', () => {
    const config = loadConfig({
      ...validEnv,
      BRAVE_API_KEY: 'brave-key',
    });

    expect(config.braveApiKey).toBe('brave-key');
  });

  it('treats empty BRAVE_API_KEY as undefined', () => {
    const config = loadConfig({
      ...validEnv,
      BRAVE_API_KEY: '',
    });

    expect(config.braveApiKey).toBeUndefined();
  });

  it('throws when a required field is missing', () => {
    expect(() => loadConfig({
      DISCORD_APPLICATION_ID: 'app',
      DISCORD_PUBLIC_KEY: 'public',
      OPENAI_API_KEY: 'openai',
    })).toThrow('Invalid configuration');
  });

  it('throws for an invalid timezone', () => {
    expect(() => loadConfig({
      ...validEnv,
      TIMEZONE: 'Invalid/Zone',
    })).toThrow('Invalid TIMEZONE');
  });

  it('throws for PORT below 1', () => {
    expect(() => loadConfig({
      ...validEnv,
      PORT: '0',
    })).toThrow('Invalid configuration');
  });

  it('throws for PORT above 65535', () => {
    expect(() => loadConfig({
      ...validEnv,
      PORT: '65536',
    })).toThrow('Invalid configuration');
  });
});
