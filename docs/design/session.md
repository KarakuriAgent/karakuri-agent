# Session 層 詳細設計

## 概要

会話履歴をファイルに永続化し、トークン予算を超えたタイミングで LLM による要約を行う層。
turn 単位（user → assistant の往復）で管理することで tool-call/tool-result ペアの整合性を保つ。

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
   * @param additionalTokens session の外側に注入されるトークン数（coreMemory + recentDiaries）。
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

### トークン予算判定 (`needsSummarization`)

メッセージ**件数**ではなく**トークン予算（概算）**で要約トリガーを判定する:

```
使用トークン ≈ tokens(session.summary)
             + tokens(session.messages)
             + additionalTokens            // 呼び出し側が渡す: tokens(coreMemory) + tokens(recentDiaries)
```

合計が設定値（デフォルト: 8000 トークン）を超えたら `needsSummarization()` が `true` を返す。

`coreMemory` と `recentDiaries` は Session 層のスコープ外（Memory 層）のため、
それらのトークン数は Agent 層で計算し `additionalTokens` として渡す。
渡す外部コンテキストがない場合は明示的に `0` を指定する。

> **注**: エージェント基本指示やツール使用説明など固定長のプロンプト部分は
> `additionalTokens` の対象外とする。これらは変動しないため、
> トークン予算の設定値側（例: コンテキスト上限の 70%）で余裕を持たせて吸収する。
> `additionalTokens` が対象とするのは **可変長の外部コンテキスト**（coreMemory, recentDiaries）のみ。

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
| applySummary                     | 指定 turn 数が保持され、tool ペアが壊れていないことを確認 |
