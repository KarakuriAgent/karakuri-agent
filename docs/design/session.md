# Session 層 詳細設計

## 概要

会話履歴をファイルに永続化し、トークン予算を超えたタイミングで LLM による要約を行う層。
turn 単位（user → assistant の往復）で管理することで tool-call/tool-result ペアの整合性を保つ。

## データ型: `SessionData` (`src/session/types.ts`)

```typescript
interface SessionData {
  /** スキーマバージョン（破壊的変更時に移行処理を行うため） */
  schemaVersion: number;
  /** セッション識別子（hashed thread ID） */
  id: string;
  /** 会話メッセージ列（tool-call/tool-result を含む） */
  messages: ModelMessage[];
  /** 要約済みの古いコンテキスト（なければ undefined） */
  summary?: string;
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
  addMessages(sessionId: string, messages: ModelMessage[]): Promise<void>;

  /**
   * トークン予算ベースで要約が必要か判定
   * memory + diary + summary + messages の合計が予算を超えたら true
   */
  needsSummarization(session: SessionData): boolean;

  /**
   * 要約適用: 古いメッセージを削除し直近 N turns を保持
   * tool-call/tool-result のペアが壊れないよう保証する
   */
  applySummary(
    sessionId: string,
    summary: string,
    keepRecentTurns: number,
  ): Promise<void>;
}
```

## 実装: `FileSessionManager` (`src/session/manager.ts`)

### ファイルレイアウト

```
{dataDir}/
└── sessions/
    └── {hashedSessionId}.json
```

- セッション ID は raw thread ID を hash/base64url 化したものをファイル名に使用

### トークン予算判定 (`needsSummarization`)

メッセージ**件数**ではなく**トークン予算（概算）**で要約トリガーを判定する:

```
使用トークン ≈ tokens(coreMemory)
             + tokens(recentDiaries)
             + tokens(session.summary)
             + tokens(session.messages)
```

合計が設定値（例: モデルのコンテキスト上限の 70%）を超えたら `needsSummarization()` が `true` を返す。

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
| applySummary                     | 指定 turn 数が保持され、tool ペアが壊れていないことを確認 |
