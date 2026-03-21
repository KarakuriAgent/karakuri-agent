import { resolve } from 'node:path';

import { config as loadDotEnv } from 'dotenv';
import { ZodError, z } from 'zod';

import { createLogger } from './utils/logger.js';

const logger = createLogger('Config');

const configSchema = z.object({
  discordApplicationId: z.string().trim().min(1, 'DISCORD_APPLICATION_ID is required'),
  discordBotToken: z.string().trim().min(1, 'DISCORD_BOT_TOKEN is required'),
  discordPublicKey: z.string().trim().min(1, 'DISCORD_PUBLIC_KEY is required'),
  openaiApiKey: z.string().trim().min(1, 'OPENAI_API_KEY is required'),
  braveApiKey: z.string().trim().min(1).optional(),
  dataDir: z.string().trim().default('./data'),
  timezone: z.string().trim().default('Asia/Tokyo'),
  openaiModel: z.string().trim().default('gpt-4o'),
  maxSteps: z.coerce.number().int().positive().default(10),
  tokenBudget: z.coerce.number().int().positive().default(8_000),
  port: z.coerce.number().int().min(1).max(65_535).default(3_000),
});

export interface Config {
  discordApplicationId: string;
  discordBotToken: string;
  discordPublicKey: string;
  openaiApiKey: string;
  braveApiKey?: string | undefined;
  dataDir: string;
  timezone: string;
  openaiModel: string;
  maxSteps: number;
  tokenBudget: number;
  port: number;
}

function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error(`Invalid TIMEZONE: ${timezone}`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  loadDotEnv({ quiet: true });

  const rawConfig = {
    discordApplicationId: env.DISCORD_APPLICATION_ID,
    discordBotToken: env.DISCORD_BOT_TOKEN ?? env.DISCORD_TOKEN,
    discordPublicKey: env.DISCORD_PUBLIC_KEY,
    openaiApiKey: env.OPENAI_API_KEY,
    braveApiKey: env.BRAVE_API_KEY || undefined,
    dataDir: env.DATA_DIR,
    timezone: env.TIMEZONE,
    openaiModel: env.OPENAI_MODEL ?? env.AGENT_MODEL,
    maxSteps: env.MAX_STEPS ?? env.AGENT_MAX_STEPS,
    tokenBudget: env.TOKEN_BUDGET ?? env.AGENT_TOKEN_BUDGET,
    port: env.PORT,
  };

  try {
    const parsed = configSchema.parse(rawConfig);
    assertValidTimezone(parsed.timezone);

    const config = {
      ...parsed,
      dataDir: resolve(parsed.dataDir),
    };
    logger.debug('Config parsed', { dataDir: config.dataDir, timezone: config.timezone, model: config.openaiModel, port: config.port });
    return config;
  } catch (error) {
    if (error instanceof ZodError) {
      const message = error.issues.map((issue) => issue.message).join('; ');
      throw new Error(`Invalid configuration: ${message}`);
    }

    throw error;
  }
}
