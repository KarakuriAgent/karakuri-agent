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

  /** 指定日の diary 読み込み（存在しなければ null） */
  readDiary(date: string): Promise<string | null>;

  /** 指定日の diary に追記 */
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
- **write-through cache + watcher**:
  - `memory.md` は初回 read 時にメモリへ載せ、同一プロセス内の後続 read はキャッシュから返す。`fs.watch()` で親ディレクトリを監視し、外部変更も eager reload する
  - diary 本文は date 単位の lazy cache を維持し、外部変更時は watcher でキャッシュを無効化して次回 read で再ロードする
  - diary 日付一覧はキャッシュし、watcher で外部変更を検知したら無効化する
- **mutex + atomic write**: memory.md と当日 diary は全スレッドから共有アクセスされるため、
  書き込み時は mutex 取得 → temp ファイル書き込み → `rename`（atomic）で更新ロスト防止
- diary は日付ごとの追記型ファイルとし、同じ日付への複数回の書き込みを保持する
- `listDiaryDates()` はキャッシュ済み配列をそのまま返さず、常にコピーを返して内部状態の破壊を防ぐ

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
- watcher 監視は親ディレクトリ単位で行い、atomic rename と整合するようにする

## テスト方針

| テストケース             | 検証内容                                      |
| ------------------------ | --------------------------------------------- |
| read core（存在なし）    | 空文字列 or デフォルト値を返す                |
| write + read core        | append した内容が読み込める                   |
| concurrent write core    | mutex により内容が失われないことを確認         |
| write + read diary       | 指定日の内容が追記され、読み込める            |
| getRecentDiaries         | 直近 N 日分が昇順（時系列順）で返る            |
| listDiaryDates           | 保存済み日付が一覧で返る                      |
| cached diary date update | cache 温存中に古い日付を後から追加しても sort 順が壊れない |
| defensive copy           | `listDiaryDates()` の返り値を mutate しても内部 cache が壊れない |
| external change reload   | 外部から memory / diary を更新しても watcher 経由で反映される |
