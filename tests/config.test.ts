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
    expect(config.tokenBudget).toBe(8_000);
    expect(config.port).toBe(3_000);
    expect(config.heartbeatIntervalMinutes).toBe(120);
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
      apiBaseUrl: 'https://example.com/world',
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

  it('loads SNS settings only when all three env vars are set', () => {
    const config = loadConfig({
      ...validEnv,
      SNS_PROVIDER: 'mastodon',
      SNS_INSTANCE_URL: 'https://social.example/',
      SNS_ACCESS_TOKEN: 'sns-token',
    });

    expect(config.sns).toEqual({
      provider: 'mastodon',
      instanceUrl: 'https://social.example',
      accessToken: 'sns-token',
    });
  });

  it('omits SNS settings when all three env vars are absent', () => {
    expect(loadConfig(validEnv).sns).toBeUndefined();
  });

  it('throws when SNS configuration is only partially set', () => {
    expect(() => loadConfig({
      ...validEnv,
      SNS_PROVIDER: 'mastodon',
      SNS_INSTANCE_URL: 'https://social.example',
    })).toThrow('Partial SNS configuration');

    expect(() => loadConfig({
      ...validEnv,
      SNS_INSTANCE_URL: 'https://social.example',
      SNS_ACCESS_TOKEN: 'sns-token',
    })).toThrow('Partial SNS configuration');
  });

  it('rejects invalid SNS_INSTANCE_URL with the correct label', () => {
    expect(() => loadConfig({
      ...validEnv,
      SNS_PROVIDER: 'mastodon',
      SNS_INSTANCE_URL: 'not-a-url',
      SNS_ACCESS_TOKEN: 'sns-token',
    })).toThrow('SNS_INSTANCE_URL must be a valid URL');
  });

  it('rejects invalid SNS_PROVIDER values', () => {
    expect(() => loadConfig({
      ...validEnv,
      SNS_PROVIDER: 'x',
      SNS_INSTANCE_URL: 'https://social.example',
      SNS_ACCESS_TOKEN: 'sns-token',
    })).toThrow(/Invalid configuration: .*mastodon/i);
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
