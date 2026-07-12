import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

const validEnv = {
  DISCORD_APPLICATION_ID: 'app',
  DISCORD_BOT_TOKEN: 'token',
  DISCORD_PUBLIC_KEY: 'public',
  LLM_API_KEY: 'openai',
};

describe('loadConfig', () => {
  it('loads valid config with defaults', () => {
    const config = loadConfig({
      ...validEnv,
      DATA_DIR: './tmp-data',
    });

    expect(config.dataDir).toBe(resolve('./tmp-data'));
    expect(config.timezone).toBe('Asia/Tokyo');
    expect(config.llmModel).toBe('openai/gpt-4o');
    expect(config.llmModelSelector).toEqual({
      provider: 'openai',
      api: 'responses',
      modelId: 'gpt-4o',
      selector: 'openai/gpt-4o',
    });
    expect(config.llmBaseUrl).toBeUndefined();
    expect(config.maxSteps).toBe(10);
    expect(config.tokenBudget).toBe(80_000);
    expect(config.port).toBe(3_000);
    expect(config.heartbeatIntervalMinutes).toBe(120);
    expect(config.memoryMaintenanceIntervalMinutes).toBeUndefined();
    expect(config.memoryMaintenanceRecentDiaryDays).toBeUndefined();
    expect(config.snsRateLimits.defaults).toEqual({
      postPerHour: 3,
      postPerDay: 20,
      postMinIntervalMinutes: 15,
      replyPerHour: 10,
      likePerHour: 30,
      repostPerHour: 10,
    });
    expect(config.snsRateLimits.perProvider).toEqual({});
    expect(config.snsRateLimits.fetchIntervals).toEqual({
      notificationsMinutes: 10,
      timelineMinutes: 30,
      trendsMinutes: 60,
    });
    expect(config.worldActionCommands).toEqual({});
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
      MEMORY_MAINTENANCE_INTERVAL_MINUTES: '45',
      MEMORY_MAINTENANCE_RECENT_DIARY_DAYS: '120',
    });

    expect(config.postMessageChannelIds).toEqual(['channel-1', 'channel-2']);
    expect(config.allowedChannelIds).toEqual(['channel-1', 'channel-2', 'report-1']);
    expect(config.reportChannelId).toBe('report-1');
    expect(config.adminUserIds).toEqual(['admin-1', 'admin-2']);
    expect(config.heartbeatIntervalMinutes).toBe(15);
    expect(config.memoryMaintenanceIntervalMinutes).toBe(45);
    expect(config.memoryMaintenanceRecentDiaryDays).toBe(120);
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

  it('treats an empty MEMORY_MAINTENANCE_INTERVAL_MINUTES as undefined', () => {
    const config = loadConfig({
      ...validEnv,
      MEMORY_MAINTENANCE_INTERVAL_MINUTES: '',
    });

    expect(config.memoryMaintenanceIntervalMinutes).toBeUndefined();
  });

  it('treats an empty MEMORY_MAINTENANCE_RECENT_DIARY_DAYS as undefined', () => {
    const config = loadConfig({
      ...validEnv,
      MEMORY_MAINTENANCE_RECENT_DIARY_DAYS: '',
    });

    expect(config.memoryMaintenanceRecentDiaryDays).toBeUndefined();
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
      LLM_API_KEY: 'openai',
    });

    expect(config.discordBotToken).toBe('alias-token');
  });

  it('accepts OPENAI_API_KEY as alias for LLM_API_KEY', () => {
    const config = loadConfig({
      DISCORD_APPLICATION_ID: 'app',
      DISCORD_BOT_TOKEN: 'token',
      DISCORD_PUBLIC_KEY: 'public',
      OPENAI_API_KEY: 'openai',
    });

    expect(config.llmApiKey).toBe('openai');
  });

  it('falls back to OPENAI_API_KEY when LLM_API_KEY is blank', () => {
    const config = loadConfig({
      DISCORD_APPLICATION_ID: 'app',
      DISCORD_BOT_TOKEN: 'token',
      DISCORD_PUBLIC_KEY: 'public',
      LLM_API_KEY: '   ',
      OPENAI_API_KEY: 'openai',
    });

    expect(config.llmApiKey).toBe('openai');
  });

  it('accepts LLM_BASE_URL as an optional setting', () => {
    const config = loadConfig({
      ...validEnv,
      LLM_BASE_URL: 'https://example.com/v1',
    });

    expect(config.llmBaseUrl).toBe('https://example.com/v1');
  });

  it('normalizes trailing slashes from LLM_BASE_URL', () => {
    const config = loadConfig({
      ...validEnv,
      LLM_BASE_URL: 'https://example.com/v1/',
    });

    expect(config.llmBaseUrl).toBe('https://example.com/v1');
  });

  it('treats empty LLM_BASE_URL as undefined', () => {
    const config = loadConfig({
      ...validEnv,
      LLM_BASE_URL: '   ',
    });

    expect(config.llmBaseUrl).toBeUndefined();
  });

  it('accepts OPENAI_BASE_URL as alias for LLM_BASE_URL', () => {
    const config = loadConfig({
      ...validEnv,
      OPENAI_BASE_URL: 'https://example.com/v1/',
    });

    expect(config.llmBaseUrl).toBe('https://example.com/v1');
  });

  it('falls back to OPENAI_BASE_URL when LLM_BASE_URL is blank', () => {
    const config = loadConfig({
      ...validEnv,
      LLM_BASE_URL: '   ',
      OPENAI_BASE_URL: 'https://example.com/v1',
    });

    expect(config.llmBaseUrl).toBe('https://example.com/v1');
  });

  it('accepts LLM_MODEL as the primary model setting', () => {
    const config = loadConfig({
      ...validEnv,
      LLM_MODEL: 'openai/gpt-4o-mini',
    });

    expect(config.llmModel).toBe('openai/gpt-4o-mini');
    expect(config.llmModelSelector.api).toBe('responses');
  });

  it('accepts an OpenAI Chat API selector', () => {
    const config = loadConfig({
      ...validEnv,
      LLM_MODEL: 'openai/chat/gpt-4o-mini',
    });

    expect(config.llmModel).toBe('openai/chat/gpt-4o-mini');
    expect(config.llmModelSelector).toEqual({
      provider: 'openai',
      api: 'chat',
      modelId: 'gpt-4o-mini',
      selector: 'openai/chat/gpt-4o-mini',
    });
  });

  it('normalizes bare model ids to the OpenAI Responses selector', () => {
    const config = loadConfig({
      ...validEnv,
      LLM_MODEL: 'gpt-4o-mini',
    });

    expect(config.llmModel).toBe('openai/gpt-4o-mini');
    expect(config.llmModelSelector.api).toBe('responses');
  });

  it('accepts OPENAI_MODEL as alias for LLM_MODEL', () => {
    const config = loadConfig({
      ...validEnv,
      OPENAI_MODEL: 'openai/gpt-4o-mini',
    });

    expect(config.llmModel).toBe('openai/gpt-4o-mini');
  });

  it('falls back to OPENAI_MODEL when LLM_MODEL is blank', () => {
    const config = loadConfig({
      ...validEnv,
      LLM_MODEL: '   ',
      OPENAI_MODEL: 'openai/gpt-4o-mini',
    });

    expect(config.llmModel).toBe('openai/gpt-4o-mini');
  });

  it('accepts AGENT_MODEL as a legacy alias for LLM_MODEL', () => {
    const config = loadConfig({
      ...validEnv,
      AGENT_MODEL: 'openai/gpt-4o-mini',
    });

    expect(config.llmModel).toBe('openai/gpt-4o-mini');
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

  it('parses optional post-response LLM settings', () => {
    const config = loadConfig({
      ...validEnv,
      POST_RESPONSE_LLM_MODEL: 'openai/gpt-4o-mini',
      POST_RESPONSE_LLM_API_KEY: 'post-key',
      POST_RESPONSE_LLM_BASE_URL: 'https://example.com/post/',
    });

    expect(config.postResponseLlmModel).toBe('openai/gpt-4o-mini');
    expect(config.postResponseLlmModelSelector?.selector).toBe('openai/gpt-4o-mini');
    expect(config.postResponseLlmApiKey).toBe('post-key');
    expect(config.postResponseLlmBaseUrl).toBe('https://example.com/post');
  });

  it('treats blank post-response LLM settings as undefined', () => {
    const config = loadConfig({
      ...validEnv,
      POST_RESPONSE_LLM_MODEL: '   ',
      POST_RESPONSE_LLM_API_KEY: '   ',
      POST_RESPONSE_LLM_BASE_URL: '   ',
    });

    expect(config.postResponseLlmModel).toBeUndefined();
    expect(config.postResponseLlmModelSelector).toBeUndefined();
    expect(config.postResponseLlmApiKey).toBeUndefined();
    expect(config.postResponseLlmBaseUrl).toBeUndefined();
  });

  it('rejects invalid POST_RESPONSE_LLM_BASE_URL with correct label', () => {
    expect(() => loadConfig({
      ...validEnv,
      POST_RESPONSE_LLM_BASE_URL: 'not-a-url',
    })).toThrow('POST_RESPONSE_LLM_BASE_URL must be a valid URL');
  });

  it('rejects POST_RESPONSE_LLM_BASE_URL with credentials', () => {
    expect(() => loadConfig({
      ...validEnv,
      POST_RESPONSE_LLM_BASE_URL: 'https://user:pass@example.com',
    })).toThrow('POST_RESPONSE_LLM_BASE_URL must not include credentials');
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


  it('loads karakuri-world settings only when both env vars are set', () => {
    const config = loadConfig({
      ...validEnv,
      KARAKURI_WORLD_API_BASE_URL: 'https://example.com/world/',
      KARAKURI_WORLD_API_KEY: 'world-key',
    });

    expect(config.karakuriWorld).toEqual({
      apiBaseUrl: 'https://example.com/world/api',
      apiKey: 'world-key',
    });
  });

  it('keeps karakuri-world API base URLs that already include /api', () => {
    const config = loadConfig({
      ...validEnv,
      KARAKURI_WORLD_API_BASE_URL: 'https://example.com/world/api/',
      KARAKURI_WORLD_API_KEY: 'world-key',
    });

    expect(config.karakuriWorld).toEqual({
      apiBaseUrl: 'https://example.com/world/api',
      apiKey: 'world-key',
    });
  });

  it('throws when only KARAKURI_WORLD_API_BASE_URL is set', () => {
    expect(() => loadConfig({
      ...validEnv,
      KARAKURI_WORLD_API_BASE_URL: 'https://example.com/world/',
    })).toThrow('Partial karakuri-world configuration');
  });

  it('throws when only KARAKURI_WORLD_API_KEY is set', () => {
    expect(() => loadConfig({
      ...validEnv,
      KARAKURI_WORLD_API_KEY: 'world-key',
    })).toThrow('Partial karakuri-world configuration');
  });

  it('omits karakuri-world settings when both env vars are absent', () => {
    expect(loadConfig(validEnv).karakuriWorld).toBeUndefined();
  });

  it('rejects invalid KARAKURI_WORLD_API_BASE_URL with the correct label', () => {
    expect(() => loadConfig({
      ...validEnv,
      KARAKURI_WORLD_API_BASE_URL: 'not-a-url',
      KARAKURI_WORLD_API_KEY: 'world-key',
    })).toThrow('KARAKURI_WORLD_API_BASE_URL must be a valid URL');
  });

  it('loads multiple SNS provider settings when required env vars are set', () => {
    const config = loadConfig({
      ...validEnv,
      MASTODON_INSTANCE_URL: 'https://social.example/',
      MASTODON_ACCESS_TOKEN: 'mastodon-token',
      X_ACCESS_TOKEN: 'x-token',
      X_CLIENT_ID: 'client-id',
      X_REFRESH_TOKEN: 'refresh-token',
      ELYTH_API_KEY: 'elyth-key',
      ELYTH_API_BASE: 'https://elythworld.com/',
    });

    expect(config.snsList).toEqual([
      { provider: 'mastodon', instanceUrl: 'https://social.example', accessToken: 'mastodon-token' },
      { provider: 'x', accessToken: 'x-token', clientId: 'client-id', refreshToken: 'refresh-token' },
      { provider: 'elyth', apiKey: 'elyth-key', apiBase: 'https://elythworld.com' },
    ]);
  });

  it('uses an empty SNS provider list when provider env vars are absent', () => {
    expect(loadConfig(validEnv).snsList).toEqual([]);
  });

  it('throws when Mastodon SNS configuration is partially set', () => {
    expect(() => loadConfig({
      ...validEnv,
      MASTODON_INSTANCE_URL: 'https://social.example',
    })).toThrow('Partial Mastodon configuration: both MASTODON_INSTANCE_URL and MASTODON_ACCESS_TOKEN must be set.');
  });

  it('rejects invalid MASTODON_INSTANCE_URL with the correct label', () => {
    expect(() => loadConfig({
      ...validEnv,
      MASTODON_INSTANCE_URL: 'not-a-url',
      MASTODON_ACCESS_TOKEN: 'sns-token',
    })).toThrow('MASTODON_INSTANCE_URL must be a valid URL');
  });

  it('loads X SNS settings without instanceUrl', () => {
    const config = loadConfig({
      ...validEnv,
      X_ACCESS_TOKEN: 'sns-token',
      X_CLIENT_ID: 'client-id',
      X_REFRESH_TOKEN: 'refresh-token',
    });

    expect(config.snsList).toEqual([{
      provider: 'x',
      accessToken: 'sns-token',
      clientId: 'client-id',
      refreshToken: 'refresh-token',
    }]);
  });

  it('loads ELYTH SNS settings', () => {
    const config = loadConfig({
      ...validEnv,
      ELYTH_API_KEY: 'elyth-key',
      ELYTH_API_BASE: 'https://elythworld.com/',
    });

    expect(config.snsList).toEqual([{
      provider: 'elyth',
      apiKey: 'elyth-key',
      apiBase: 'https://elythworld.com',
    }]);
  });

  it('requires ELYTH_API_KEY and ELYTH_API_BASE for elyth', () => {
    expect(() => loadConfig({
      ...validEnv,
      ELYTH_API_BASE: 'https://elythworld.com',
    })).toThrow('Partial ELYTH configuration: both ELYTH_API_KEY and ELYTH_API_BASE must be set.');
    expect(() => loadConfig({
      ...validEnv,
      ELYTH_API_KEY: 'elyth-key',
    })).toThrow('Partial ELYTH configuration: both ELYTH_API_KEY and ELYTH_API_BASE must be set.');
  });

  it('ignores removed legacy SNS_* env vars', () => {
    expect(loadConfig({
      ...validEnv,
      SNS_PROVIDER: 'mastodon',
      SNS_INSTANCE_URL: 'not-a-url',
      SNS_ACCESS_TOKEN: 'sns-token',
    }).snsList).toEqual([]);
  });

  it('parses SNS rate limit overrides and world action commands', () => {
    const config = loadConfig({
      ...validEnv,
      KARAKURI_WORLD_API_BASE_URL: 'https://kw.example.com',
      KARAKURI_WORLD_API_KEY: 'kw-key',
      REPORT_CHANNEL_ID: 'report-1',
      KW_COMMAND_CHECK_PHONE: 'check_phone',
      KW_COMMAND_BROWSE_SNS: 'browse_sns',
      SNS_RATE_LIMIT_POST_PER_HOUR: '2',
      X_RATE_LIMIT_POST_PER_DAY: '5',
      X_RATE_LIMIT_LIKE_PER_HOUR: '4',
      SNS_FETCH_MIN_INTERVAL_TRENDS_MINUTES: '120',
    });

    expect(config.worldActionCommands).toEqual({ checkPhone: 'check_phone', browseSns: 'browse_sns' });
    expect(config.snsRateLimits.defaults.postPerHour).toBe(2);
    expect(config.snsRateLimits.perProvider).toEqual({ x: { postPerDay: 5, likePerHour: 4 } });
    expect(config.snsRateLimits.fetchIntervals.trendsMinutes).toBe(120);
  });

  it('throws when KW_COMMAND_* is set without karakuri-world credentials', () => {
    expect(() => loadConfig({
      ...validEnv,
      KW_COMMAND_CHECK_PHONE: 'check_phone',
    })).toThrow('World action commands require karakuri-world integration');
  });

  it('throws when world action command names collide', () => {
    expect(() => loadConfig({
      ...validEnv,
      KARAKURI_WORLD_API_BASE_URL: 'https://kw.example.com',
      KARAKURI_WORLD_API_KEY: 'kw-key',
      KW_COMMAND_CHECK_PHONE: 'same',
      KW_COMMAND_POST_SNS: 'same',
    })).toThrow('must be distinct command names');
  });

  it('throws when KW_COMMAND_CHECK_PHONE is set without a reply sink', () => {
    expect(() => loadConfig({
      ...validEnv,
      KARAKURI_WORLD_API_BASE_URL: 'https://kw.example.com',
      KARAKURI_WORLD_API_KEY: 'kw-key',
      KW_COMMAND_CHECK_PHONE: 'check_phone',
    })).toThrow('requires a Discord message sink');
  });

  it('throws on an invalid provider rate limit override', () => {
    expect(() => loadConfig({
      ...validEnv,
      X_RATE_LIMIT_POST_PER_HOUR: '-1',
    })).toThrow('Invalid X_RATE_LIMIT_POST_PER_HOUR value');
  });

  it('throws when a required field is missing', () => {
    expect(() => loadConfig({
      DISCORD_APPLICATION_ID: 'app',
      DISCORD_PUBLIC_KEY: 'public',
      LLM_API_KEY: 'openai',
    })).toThrow('Invalid configuration');
  });

  it('mentions the OPENAI_API_KEY alias when the API key is missing', () => {
    expect(() => loadConfig({
      DISCORD_APPLICATION_ID: 'app',
      DISCORD_BOT_TOKEN: 'token',
      DISCORD_PUBLIC_KEY: 'public',
    })).toThrow('LLM_API_KEY is required (OPENAI_API_KEY is also accepted)');
  });

  it('throws for an invalid LLM_BASE_URL', () => {
    expect(() => loadConfig({
      ...validEnv,
      LLM_BASE_URL: 'not-a-url',
    })).toThrow('LLM_BASE_URL must be a valid URL');
  });

  it('throws for an unsupported LLM_BASE_URL protocol', () => {
    expect(() => loadConfig({
      ...validEnv,
      LLM_BASE_URL: 'ftp://example.com/v1',
    })).toThrow('LLM_BASE_URL must use http or https');
  });

  it('throws when LLM_BASE_URL includes credentials', () => {
    expect(() => loadConfig({
      ...validEnv,
      LLM_BASE_URL: 'https://user:pass@example.com/v1',
    })).toThrow('LLM_BASE_URL must not include credentials');
  });

  it('throws when LLM_BASE_URL includes query parameters', () => {
    expect(() => loadConfig({
      ...validEnv,
      LLM_BASE_URL: 'https://example.com/v1?foo=bar',
    })).toThrow('LLM_BASE_URL must not include query parameters or fragments');
  });

  it('throws for an invalid LLM_MODEL selector', () => {
    expect(() => loadConfig({
      ...validEnv,
      LLM_MODEL: 'anthropic/claude-sonnet-4.5',
    })).toThrow('LLM_MODEL must use an OpenAI selector');
  });

  it('throws when the OpenAI selector has no model id', () => {
    expect(() => loadConfig({
      ...validEnv,
      LLM_MODEL: 'openai/chat/',
    })).toThrow('LLM_MODEL must include a model name');
  });

  it('throws when the OpenAI chat selector omits the model name without a trailing slash', () => {
    expect(() => loadConfig({
      ...validEnv,
      LLM_MODEL: 'openai/chat',
    })).toThrow('LLM_MODEL must include a model name');
  });

  it('throws when the OpenAI selector contains an empty path segment', () => {
    expect(() => loadConfig({
      ...validEnv,
      LLM_MODEL: 'openai//gpt-4o',
    })).toThrow('LLM_MODEL must not contain empty path segments');
  });

  it('defaults llmEnableThinking to true when LLM_ENABLE_THINKING is not set', () => {
    const config = loadConfig(validEnv);
    expect(config.llmEnableThinking).toBe(true);
  });

  it('defaults llmEnableThinking to true when LLM_ENABLE_THINKING is empty', () => {
    const config = loadConfig({ ...validEnv, LLM_ENABLE_THINKING: '   ' });
    expect(config.llmEnableThinking).toBe(true);
  });

  it.each([
    ['false', false],
    ['0', false],
    ['no', false],
    ['true', true],
    ['1', true],
    ['yes', true],
    ['TRUE', true],
    ['FALSE', false],
  ])('parses LLM_ENABLE_THINKING=%s as %s', (input, expected) => {
    const config = loadConfig({ ...validEnv, LLM_ENABLE_THINKING: input });
    expect(config.llmEnableThinking).toBe(expected);
  });

  it('throws for an invalid LLM_ENABLE_THINKING value', () => {
    expect(() => loadConfig({ ...validEnv, LLM_ENABLE_THINKING: 'maybe' })).toThrow(
      'Invalid LLM_ENABLE_THINKING value: "maybe"',
    );
  });

  it('defaults llmDisableThinkingRequestParam to false when LLM_DISABLE_THINKING_REQUEST_PARAM is not set', () => {
    const config = loadConfig(validEnv);
    expect(config.llmDisableThinkingRequestParam).toBe(false);
  });

  it.each([
    ['false', false],
    ['0', false],
    ['no', false],
    ['true', true],
    ['1', true],
    ['yes', true],
  ])('parses LLM_DISABLE_THINKING_REQUEST_PARAM=%s as %s', (input, expected) => {
    const config = loadConfig({ ...validEnv, LLM_DISABLE_THINKING_REQUEST_PARAM: input });
    expect(config.llmDisableThinkingRequestParam).toBe(expected);
  });

  it('throws for an invalid LLM_DISABLE_THINKING_REQUEST_PARAM value', () => {
    expect(() => loadConfig({ ...validEnv, LLM_DISABLE_THINKING_REQUEST_PARAM: 'maybe' })).toThrow(
      'Invalid LLM_DISABLE_THINKING_REQUEST_PARAM value: "maybe"',
    );
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

  it('parses AGENT_SELF_NAMES into agentSelfNames (#106)', () => {
    const config = loadConfig({
      ...validEnv,
      AGENT_SELF_NAMES: 'ちび花音, kanon',
    });
    expect(config.agentSelfNames).toEqual(['ちび花音', 'kanon']);
  });

  it('warns about deprecated env vars without failing (#108)', () => {
    // 廃止変数が設定されていても起動は成功する（警告のみ）
    const config = loadConfig({
      ...validEnv,
      SNS_LOOP_MIN_INTERVAL_MINUTES: '240',
      SNS_PROVIDER: 'mastodon',
    });
    expect(config.llmModel).toBe('openai/gpt-4o');
  });
});
