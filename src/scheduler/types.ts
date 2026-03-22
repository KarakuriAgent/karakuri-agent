export type SchedulerSessionMode = 'isolated' | 'shared';

export interface CronJobDefinition {
  name: string;
  schedule: string;
  instructions: string;
  enabled: boolean;
  sessionMode: SchedulerSessionMode;
  staggerMs: number;
}

export interface RegisterCronJobInput {
  name: string;
  schedule: string;
  instructions: string;
  enabled?: boolean;
  sessionMode?: SchedulerSessionMode;
  staggerMs?: number;
}

export interface SchedulerSnapshot {
  heartbeatInstructions: string | null;
  cronJobs: CronJobDefinition[];
}

export type SchedulerReloadListener = (snapshot: SchedulerSnapshot) => void | Promise<void>;

export interface ISchedulerStore {
  readHeartbeatInstructions(): Promise<string | null>;
  listCronJobs(): Promise<CronJobDefinition[]>;
  registerJob(input: RegisterCronJobInput): Promise<CronJobDefinition>;
  unregisterJob(name: string): Promise<boolean>;
  setReloadListener(listener: SchedulerReloadListener | undefined): void;
  close(): Promise<void>;
}

export interface IMessageSink {
  postMessage(channelId: string, text: string): Promise<void>;
}
