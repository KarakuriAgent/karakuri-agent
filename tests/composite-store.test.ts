import { describe, expect, it, vi } from 'vitest';

import { CompositeMemoryStore } from '../src/memory/composite-store.js';
import type { ICoreMemoryStore, IDiaryStore } from '../src/memory/types.js';

function createCoreStore(): ICoreMemoryStore {
  return {
    readCoreMemory: vi.fn().mockResolvedValue('core memory'),
    writeCoreMemory: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function createDiaryStore(): IDiaryStore {
  return {
    readDiary: vi.fn().mockResolvedValue('diary entry'),
    writeDiary: vi.fn().mockResolvedValue(undefined),
    replaceDiary: vi.fn().mockResolvedValue(undefined),
    deleteDiary: vi.fn().mockResolvedValue(true),
    getRecentDiaries: vi.fn().mockResolvedValue([{ date: '2025-01-10', content: 'entry' }]),
    listDiaryDates: vi.fn().mockResolvedValue(['2025-01-10']),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('CompositeMemoryStore', () => {
  it('delegates core memory operations to the core store', async () => {
    const coreStore = createCoreStore();
    const diaryStore = createDiaryStore();
    const store = new CompositeMemoryStore(coreStore, diaryStore);

    await expect(store.readCoreMemory()).resolves.toBe('core memory');
    await store.writeCoreMemory('new memory', 'append');
    await store.writeCoreMemory('replacement', 'overwrite');

    expect(coreStore.readCoreMemory).toHaveBeenCalledTimes(1);
    expect(coreStore.writeCoreMemory).toHaveBeenNthCalledWith(1, 'new memory', 'append');
    expect(coreStore.writeCoreMemory).toHaveBeenNthCalledWith(2, 'replacement', 'overwrite');
  });

  it('delegates diary operations to the diary store', async () => {
    const coreStore = createCoreStore();
    const diaryStore = createDiaryStore();
    const store = new CompositeMemoryStore(coreStore, diaryStore);

    await expect(store.readDiary('2025-01-10')).resolves.toBe('diary entry');
    await store.writeDiary('2025-01-10', 'more diary');
    await store.replaceDiary('2025-01-10', 'replacement diary');
    await expect(store.deleteDiary('2025-01-10')).resolves.toBe(true);
    await expect(store.getRecentDiaries(3)).resolves.toEqual([{ date: '2025-01-10', content: 'entry' }]);
    await expect(store.listDiaryDates()).resolves.toEqual(['2025-01-10']);

    expect(diaryStore.readDiary).toHaveBeenCalledWith('2025-01-10');
    expect(diaryStore.writeDiary).toHaveBeenCalledWith('2025-01-10', 'more diary');
    expect(diaryStore.replaceDiary).toHaveBeenCalledWith('2025-01-10', 'replacement diary');
    expect(diaryStore.deleteDiary).toHaveBeenCalledWith('2025-01-10');
    expect(diaryStore.getRecentDiaries).toHaveBeenCalledWith(3);
    expect(diaryStore.listDiaryDates).toHaveBeenCalledTimes(1);
  });

  it('closes both stores', async () => {
    const coreStore = createCoreStore();
    const diaryStore = createDiaryStore();
    const store = new CompositeMemoryStore(coreStore, diaryStore);

    await store.close();

    expect(coreStore.close).toHaveBeenCalledTimes(1);
    expect(diaryStore.close).toHaveBeenCalledTimes(1);
  });

  it('still closes both stores when one close fails', async () => {
    const coreStore = createCoreStore();
    const diaryStore = createDiaryStore();
    vi.mocked(coreStore.close).mockRejectedValueOnce(new Error('core close failed'));
    const store = new CompositeMemoryStore(coreStore, diaryStore);

    await expect(store.close()).rejects.toThrow('core close failed');
    expect(coreStore.close).toHaveBeenCalledTimes(1);
    expect(diaryStore.close).toHaveBeenCalledTimes(1);
  });

  it('throws the first failure when both close calls fail', async () => {
    const coreStore = createCoreStore();
    const diaryStore = createDiaryStore();
    vi.mocked(coreStore.close).mockRejectedValueOnce(new Error('core failed'));
    vi.mocked(diaryStore.close).mockRejectedValueOnce(new Error('diary failed'));
    const store = new CompositeMemoryStore(coreStore, diaryStore);

    await expect(store.close()).rejects.toThrow('core failed');
    expect(coreStore.close).toHaveBeenCalledTimes(1);
    expect(diaryStore.close).toHaveBeenCalledTimes(1);
  });
});
