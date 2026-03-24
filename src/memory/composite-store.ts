import { createLogger } from '../utils/logger.js';
import type { ICoreMemoryStore, IDiaryStore, DiaryEntry, IMemoryStore } from './types.js';

const logger = createLogger('CompositeMemoryStore');

export class CompositeMemoryStore implements IMemoryStore {
  constructor(
    private readonly coreMemoryStore: ICoreMemoryStore,
    private readonly diaryStore: IDiaryStore,
  ) {}

  readCoreMemory(): Promise<string> {
    return this.coreMemoryStore.readCoreMemory();
  }

  writeCoreMemory(content: string, mode: 'append'): Promise<void> {
    return this.coreMemoryStore.writeCoreMemory(content, mode);
  }

  readDiary(date: string): Promise<string | null> {
    return this.diaryStore.readDiary(date);
  }

  writeDiary(date: string, content: string): Promise<void> {
    return this.diaryStore.writeDiary(date, content);
  }

  getRecentDiaries(days: number): Promise<DiaryEntry[]> {
    return this.diaryStore.getRecentDiaries(days);
  }

  listDiaryDates(): Promise<string[]> {
    return this.diaryStore.listDiaryDates();
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled([
      this.coreMemoryStore.close(),
      this.diaryStore.close(),
    ]);
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    for (const failure of failures) {
      logger.warn('Store close failed', failure.reason);
    }
    if (failures[0] != null) {
      throw failures[0].reason;
    }
  }
}
