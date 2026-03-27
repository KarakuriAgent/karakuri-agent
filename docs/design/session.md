# Session 層 詳細設計

## 概要

会話履歴をファイルに永続化し、トークン予算を超えたタイミングで LLM による要約を行う層。
turn 単位（user → assistant の往復）で管理することで tool-call/tool-result ペアの整合性を保つ。
Heartbeat のような単発 system turn では Agent 層が ephemeral session をインメモリ構築し、この層をバイパスできる。

## データ型: `SessionData` (`src/session/types.ts`)

```typescript
interface SessionData {
  /** スキーマバージョン（破壊的変更時に移行処理を行うため） */
  schemaVersion: number;
  /** 元のセッション識別子（Discord thread ID 等） */
  sessionId: string;
  /** 会話メッセージ列（tool-call/tool-result を含む） */
  messages: ModelMessage[];
  /** 要約済みの古いコンテキスト（なければ null） */
  summary: string | null;
  /** 作成日時（ISO 8601） */
  createdAt: string;
  /** 最終更新日時（ISO 8601） */
  updatedAt: string;
}
```

## インターフェース: `ISessionManager` (`src/session/types.ts`)

```typescript
interface ISessionManager {
  /** セッション読み込み（存在しなければ新規作成） */
  loadSession(sessionId: string): Promise<SessionData>;

  /** セッション保存 */
  saveSession(session: SessionData): Promise<void>;

  /** 複数メッセージを一括追加 */
  addMessages(sessionId: string, messages: ModelMessage[]): Promise<SessionData>;

  /**
   * トークン予算ベースで要約が必要か判定
   * session 外部のコンテキスト（coreMemory や recentDiaries）のトークン数は
   * 呼び出し側（Agent 層）が計算して `additionalTokens` として渡す。
   * summary + messages + additionalTokens の合計が予算を超えたら true を返す。
   *
   * @param session         判定対象のセッションデータ
   * @param additionalTokens session の外側に注入されるトークン数
   *                         （AGENT.md / RULES.md / skills 一覧 / coreMemory / recentDiaries）。
   *                         渡す外部コンテキストがない場合は明示的に 0 を指定する。
   */
  needsSummarization(session: SessionData, additionalTokens: number): boolean;

  /**
   * 要約適用: 古いメッセージを削除し直近 N turns を保持
   * tool-call/tool-result のペアが壊れないよう保証する
   */
  applySummary(
    sessionId: string,
    summary: string,
    keepRecentTurns: number,
  ): Promise<SessionData>;
}
```

## 実装: `FileSessionManager` (`src/session/manager.ts`)

### ファイルレイアウト

```
{dataDir}/
└── sessions/
    └── {hashedSessionId}.json
```

- セッション ID は raw thread ID を hash/base64url 化したものを**ファイル名**に使用し、
  JSON 本体には元の `sessionId` を保持する
- 未対応の `schemaVersion` を読み込んだ場合は、将来の migration 実装まで明示的にエラーとする

### write-through cache (`sessionCache`)

- `loadSession()` は初回のみディスクから読み込み、以降は `sessionCache` から返す
- cache から返す `SessionData` は `structuredClone()` で複製し、呼び出し側の mutate で内部状態が壊れないようにする
- `saveSession()` / `addMessages()` / `applySummary()` は最終的に `writeSessionFile()` を通り、
  ディスク write 完了後に cache を更新する
- ファイル未作成の空セッションは cache しない。再起動、または別プロセスで更新された内容を拾うには
  新しい `FileSessionManager` インスタンスを生成する

### トークン予算判定 (`needsSummarization`)

メッセージ**件数**ではなく**トークン予算（概算）**で要約トリガーを判定する:

```
使用トークン ≈ tokens(session.summary)
             + tokens(session.messages)
             + additionalTokens            // 呼び出し側が渡す: tokens(AGENT/RULES/skills/coreMemory/recentDiaries)
```

合計が設定値（デフォルト: 80000 トークン）を超えたら `needsSummarization()` が `true` を返す。

trusted prompt context（AGENT.md / RULES.md / skills 一覧）と
`coreMemory` / `recentDiaries` は Session 層のスコープ外のため、
それらのトークン数は Agent 層で計算し `additionalTokens` として渡す。
渡す外部コンテキストがない場合は明示的に `0` を指定する。

> **注**: `additionalTokens` が対象とするのは **可変長の外部コンテキスト**
> （AGENT.md / RULES.md / skills 一覧 / coreMemory / recentDiaries）。
> `CORE_SAFETY_INSTRUCTIONS` のような固定長の不変部分は
> トークン予算の設定値側で余裕を持たせて吸収する。

トークン数の計算には Agent 層・Session 層ともに共通の `src/utils/token-counter.ts` を使用し、
計算方法のずれを防ぐ。

### turn 単位の要約 (`applySummary`)

- user → assistant の往返を **1 turn** とする
- tool-call / tool-result のペアは同一 turn として扱い、分割しない
- `keepRecentTurns` 件の turn を保持し、それ以前を削除して `summary` に置き換える

## テスト方針

| テストケース                     | 検証内容                                               |
| -------------------------------- | ------------------------------------------------------ |
| loadSession（存在なし）          | 空セッションが返る                                     |
| saveSession + loadSession        | 保存した内容が読み込める                               |
| addMessages                      | メッセージが追加される                                 |
| needsSummarization（予算以下）   | false を返す                                           |
| needsSummarization（予算超過）   | true を返す                                            |
| needsSummarization（session 単体は予算以下、additionalTokens で超過） | additionalTokens が判定に反映され true を返す |
| needsSummarization（additionalTokens = 0） | 外部コンテキストなしで正しく判定される         |
| loadSession cache copy          | 返却値を mutate しても cache 内の session が壊れないことを確認 |
| unsupported schema after restart | 新しい manager インスタンスで破損ファイルを読み込むとエラーになる |
| applySummary                     | 指定 turn 数が保持され、tool ペアが壊れていないことを確認 |
