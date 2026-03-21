export interface DiaryEntry {
  date: string;
  content: string;
}

export interface IMemoryStore {
  readCoreMemory(): Promise<string>;
  writeCoreMemory(content: string, mode: 'append'): Promise<void>;
  readDiary(date: string): Promise<string | null>;
  writeDiary(date: string, content: string): Promise<void>;
  getRecentDiaries(days: number): Promise<DiaryEntry[]>;
  listDiaryDates(): Promise<string[]>;
  close(): Promise<void>;
}
