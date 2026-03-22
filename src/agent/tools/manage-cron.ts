import { tool } from 'ai';
import { z } from 'zod';

import type { ISchedulerStore } from '../../scheduler/types.js';
import { assertAdminUser } from './admin-auth.js';

const manageCronSchema = z.object({
  action: z.enum(['register', 'unregister', 'list']),
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
  schedule: z.string().min(1).optional(),
  instructions: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  sessionMode: z.enum(['isolated', 'shared']).optional(),
  staggerMs: z.number().int().min(0).optional(),
});

export interface ManageCronToolOptions {
  schedulerStore: ISchedulerStore;
  adminUserIds: string[];
  userId?: string | undefined;
}

export function createManageCronTool({ schedulerStore, adminUserIds, userId }: ManageCronToolOptions) {
  return tool({
    description: 'Register, update, unregister, or list cron jobs. For register/unregister, name is required. For register, schedule and instructions are also required.',
    inputSchema: manageCronSchema,
    execute: async (input) => {
      assertAdminUser(userId, adminUserIds);

      switch (input.action) {
        case 'register': {
          if (input.name == null || input.schedule == null || input.instructions == null) {
            throw new Error('register requires name, schedule, and instructions');
          }
          const job = await schedulerStore.registerJob({
            name: input.name,
            schedule: input.schedule,
            instructions: input.instructions,
            ...(input.enabled != null ? { enabled: input.enabled } : {}),
            ...(input.sessionMode != null ? { sessionMode: input.sessionMode } : {}),
            ...(input.staggerMs != null ? { staggerMs: input.staggerMs } : {}),
          });
          return { action: 'register', job };
        }
        case 'unregister': {
          if (input.name == null) {
            throw new Error('unregister requires name');
          }
          const removed = await schedulerStore.unregisterJob(input.name);
          return { action: 'unregister', name: input.name, removed };
        }
        case 'list': {
          const jobs = await schedulerStore.listCronJobs();
          return { action: 'list', jobs };
        }
      }
    },
  });
}
