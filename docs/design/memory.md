# Memory 層 詳細設計

## 概要

会話から得た重要な記憶（`core`）と日付ごとの日記（`diary`）をファイルで永続化する層。
複数スレッドからの同時アクセスを mutex + atomic write で保護する。

## インターフェース: `IMemoryStore` (`src/memory/types.ts`)

```typescript
interface IMemoryStore {
  /** memory.md 読み込み */
  readCoreMemory(): Promise<string>;

  /**
   * memory.md 書き込み（append のみ）
   * replace はモデルに開放しない（prompt injection 固定化防止）
   */
  writeCoreMemory(content: string, mode: 'append'): Promise<void>;

  /** 指定日の diary 読み込み */
  readDiary(date: string): Promise<string>;

  /** 指定日の diary 書き込み */
  writeDiary(date: string, content: string): Promise<void>;

  /** 直近 N 日分の diary を取得 */
  getRecentDiaries(days: number): Promise<Array<{ date: string; content: string }>>;

  /** 保存済みの diary 日付一覧 */
  listDiaryDates(): Promise<string[]>;
}
```

## 実装: `FileMemoryStore` (`src/memory/store.ts`)

### ファイルレイアウト

```
{dataDir}/
└── memory/
    ├── core/
    │   └── memory.md          # 重要な記憶を蓄積（常時システムプロンプトに注入）
    └── diary/
        └── YYYY-MM-DD.md      # 日付ごとの日記
```

### 実装方針

- `node:fs/promises` で読み書き
- ディレクトリは `{ recursive: true }` で遅延作成
- **mutex + atomic write**: memory.md と当日 diary は全スレッドから共有アクセスされるため、
  書き込み時は mutex 取得 → temp ファイル書き込み → `rename`（atomic）で更新ロスト防止

### mutex の適用範囲

| ファイル                      | 操作     | mutex 必要 |
| ----------------------------- | -------- | ---------- |
| `memory/core/memory.md`       | 読み込み | 不要       |
| `memory/core/memory.md`       | 書き込み | **必須**   |
| `memory/diary/YYYY-MM-DD.md`  | 読み込み | 不要       |
| `memory/diary/YYYY-MM-DD.md`（当日）| 書き込み | **必須** |
| `memory/diary/YYYY-MM-DD.md`（過去）| 書き込み | 不要（上書き禁止が望ましい） |

## セキュリティ: Prompt Injection 対策

- memory / diary の内容はシステムプロンプトの instruction 部分と明確に区切る
- `<memory>` / `<diary>` タグ等で **untrusted data** であることを明示
- `saveMemory` の `mode: replace` は開放しない（append のみ）

## テスト方針

| テストケース             | 検証内容                                      |
| ------------------------ | --------------------------------------------- |
| read core（存在なし）    | 空文字列 or デフォルト値を返す                |
| write + read core        | append した内容が読み込める                   |
| concurrent write core    | mutex により内容が失われないことを確認         |
| write + read diary       | 指定日の内容が読み込める                      |
| getRecentDiaries         | 直近 N 日分が降順で返る                       |
| listDiaryDates           | 保存済み日付が一覧で返る                      |
