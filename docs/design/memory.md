# Memory 層 詳細設計

## 概要

会話から得た重要な記憶（`core`）と日付ごとの日記（`diary`）を永続化する層。
コアメモリはファイル、日記は SQLite に保存し、`CompositeMemoryStore` が既存の `IMemoryStore` を維持したまま両者を束ねる。

## インターフェース: `src/memory/types.ts`

```typescript
interface ICoreMemoryStore {
  readCoreMemory(): Promise<string>;
  writeCoreMemory(content: string, mode: 'append'): Promise<void>;
  close(): Promise<void>;
}

interface IDiaryStore {
  readDiary(date: string): Promise<string | null>;
  writeDiary(date: string, content: string): Promise<void>;
  getRecentDiaries(days: number): Promise<Array<{ date: string; content: string }>>;
  listDiaryDates(): Promise<string[]>;
  close(): Promise<void>;
}

interface IMemoryStore extends ICoreMemoryStore, IDiaryStore {}
```

## 実装構成

### `FileMemoryStore` (`src/memory/store.ts`)

- `DATA_DIR/memory/core/memory.md` を管理する core memory 専用ストア
- `write-through cache + watcher` で外部変更を再読込する
- `memory.md` の追記は `KeyedMutex` + atomic write で保護する

### `SqliteDiaryStore` (`src/memory/diary-store.ts`)

- `DATA_DIR/diary.db` を管理する diary 専用ストア
- SQLite pragma は `journal_mode=WAL`, `synchronous=NORMAL`
- append-only な `diary_entries` テーブルに日記を蓄積する
- 同日複数エントリは `id ASC` 順に結合して返す
- 直近 N 日の取得は SQL で日付範囲を絞り、TypeScript 側で日付単位にグルーピングする
- 旧 `DATA_DIR/memory/diary/YYYY-MM-DD.md` が残っている場合、未移行の日付だけを初回オープン時に `diary.db` へ自動インポートする

```sql
CREATE TABLE IF NOT EXISTS diary_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_diary_entries_date ON diary_entries(date);
```

### `CompositeMemoryStore` (`src/memory/composite-store.ts`)

- `ICoreMemoryStore` と `IDiaryStore` を受け取り、`IMemoryStore` として委譲する
- `close()` は `Promise.allSettled` で両方のストアを確実に閉じる

## データ配置

```text
{dataDir}/
├── diary.db
└── memory/
    └── core/
        └── memory.md
```

## 実装方針

- **core memory**
  - 初回 read 時にキャッシュへ載せ、同一プロセス内の後続 read はキャッシュから返す
  - `fs.watch()` で親ディレクトリを監視し、外部変更も eager reload する
  - append 時は mutex 取得 → atomic write で更新ロストを防ぐ
- **diary**
  - 空文字列は保存しない
  - 書き込み時に trim し、読取時は同日の複数エントリを `\n\n` で結合する
  - `listDiaryDates()` は `SELECT DISTINCT date ... ORDER BY date ASC` で取得する
  - `getRecentDiaries()` はタイムゾーン基準の日付文字列で範囲検索し、未来日付を除外する
  - legacy diary import は `legacy_diary_imports` で冪等管理し、同日の SQLite 行が既に存在しても未移行の legacy file は 1 回だけ追加取り込みする

## 並行性

| 対象 | 方式 |
| --- | --- |
| `memory/core/memory.md` | `KeyedMutex` + atomic write |
| `diary.db` | SQLite WAL ロック |

`memory.md` は read-modify-write があるためアプリ側 mutex を使う。diary は append-only INSERT のため SQLite のロック制御に委譲する。

## セキュリティ: Prompt Injection 対策

- memory / diary の内容はシステムプロンプトの instruction 部分と明確に区切る
- `<memory>` / `<diary>` タグ等で **untrusted data** であることを明示する

## テスト方針

| テストケース | 検証内容 |
| --- | --- |
| core read/write | `memory.md` の既定値・追記・外部更新反映 |
| concurrent write core | mutex により内容が失われないこと |
| diary write/read | 指定日の内容が保存され読み込めること |
| diary multi-append | 同日複数エントリが挿入順で結合されること |
| diary recent window | 直近 N 日・未来日付除外が正しく機能すること |
| diary dates | 保存済み日付が昇順で一覧取得できること |
| legacy diary import | 旧 `memory/diary/*.md` が一度だけ SQLite へ移行されること |
| composite delegation | core/diary の各メソッドが正しい store に委譲されること |
| composite close | 片方の close が失敗しても両方を close すること |
