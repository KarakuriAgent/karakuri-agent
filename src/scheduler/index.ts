import type { IAgent } from '../agent/core.js';
import type { Config } from '../config.js';
import type { IMessageSink } from './types.js';
import { CronRunner } from './cron-runner.js';
import { HeartbeatRunner } from './heartbeat.js';
import { FileSchedulerStore } from './store.js';

export interface CreateSchedulerOptions {
  agent: IAgent;
  config: Pick<Config, 'dataDir' | 'timezone' | 'heartbeatIntervalMinutes' | 'reportChannelId' | 'postMessageChannelIds'>;
  messageSink?: IMessageSink | undefined;
  store?: FileSchedulerStore;
}

export interface SchedulerRuntime {
  store: FileSchedulerStore;
  close(): Promise<void>;
}

export async function createScheduler({
  agent,
  config,
  messageSink,
  store: existingStore,
}: CreateSchedulerOptions): Promise<SchedulerRuntime> {
  const store = existingStore ?? await FileSchedulerStore.create({ dataDir: config.dataDir });
  const heartbeatRunner = new HeartbeatRunner({
    agent,
    schedulerStore: store,
    intervalMinutes: config.heartbeatIntervalMinutes ?? 120,
    messageSink,
    reportChannelId: config.reportChannelId,
    enabled: (config.postMessageChannelIds?.length ?? 0) > 0,
  });
  const cronRunner = new CronRunner({
    agent,
    schedulerStore: store,
    timezone: config.timezone,
    messageSink,
    reportChannelId: config.reportChannelId,
  });

  store.setReloadListener(async (snapshot) => {
    await Promise.all([
      heartbeatRunner.sync(snapshot.heartbeatInstructions),
      cronRunner.syncJobs(),
    ]);
  });
  await heartbeatRunner.sync();
  await cronRunner.syncJobs();

  return {
    store,
    async close(): Promise<void> {
      store.setReloadListener(undefined);
      await Promise.all([
        heartbeatRunner.close(),
        cronRunner.close(),
      ]);
      if (existingStore == null) {
        await store.close();
      }
    },
  };
}

export { CronRunner } from './cron-runner.js';
export { parseCronMarkdown, renderCronMarkdown } from './frontmatter.js';
export { HeartbeatRunner } from './heartbeat.js';
export { DiscordMessageSink } from './message-sink.js';
export { FileSchedulerStore } from './store.js';
export type { CronJobDefinition, IMessageSink, ISchedulerStore, RegisterCronJobInput } from './types.js';
