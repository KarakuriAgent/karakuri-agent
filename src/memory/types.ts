export interface DiaryEntry {
  date: string;
  content: string;
}

export interface ICoreMemoryStore {
  readCoreMemory(): Promise<string>;
  writeCoreMemory(content: string, mode: 'append'): Promise<void>;
  close(): Promise<void>;
}

export interface IDiaryStore {
  readDiary(date: string): Promise<string | null>;
  writeDiary(date: string, content: string): Promise<void>;
  getRecentDiaries(days: number): Promise<DiaryEntry[]>;
  listDiaryDates(): Promise<string[]>;
  close(): Promise<void>;
}

export interface IMemoryStore extends ICoreMemoryStore, IDiaryStore {}
