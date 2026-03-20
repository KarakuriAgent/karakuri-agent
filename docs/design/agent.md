# Agent 層 詳細設計

## 概要

LLM（OpenAI）を使って会話を処理するコア層。
セッション・メモリ・ツールを統合し、ユーザーメッセージに対して応答を生成する。

## インターフェース: `IAgent` (`src/agent/core.ts`)

```typescript
interface IAgent {
  /** ユーザーメッセージを処理して応答文字列を返す */
  handleMessage(
    sessionId: string,
    userMessage: string,
    userName: string,
  ): Promise<string>;

  /** セッション履歴を LLM で要約して返す */
  summarizeSession(sessionId: string): Promise<string>;
}
```

## メッセージ処理フロー (`Agent.handleMessage`)

```
1. セッション読み込み           sessionManager.loadSession(sessionId)
        ↓
2. ユーザーメッセージ追加
        ↓
3. 要約チェック（トークン予算）  needsSummarization() が true
        │                              ↓
        │                        summarizeSession() で LLM 要約
        │                        sessionManager.applySummary() で圧縮
        ↓
4. システムプロンプト構築
   ├── エージェント基本指示（初期はハードコード、後のフェーズで設定ファイル化）
   ├── <memory> ... </memory>          memory.md の内容（常時注入）
   ├── <diary> ... </diary>            直近3日分の diary（自動注入）
   ├── session.summary（あれば注入）
   └── ツール使用説明
        ↓
5. generateText() + tools + stopWhen: stepCountIs(n)
        ↓
6. result.response.messages を sessionManager に保存して応答文字列を返す
```

## ツール

### `saveMemory` (`src/agent/tools/save-memory.ts`)

| パラメータ | 型                    | 説明                                      |
| ---------- | --------------------- | ----------------------------------------- |
| `target`   | `'core' \| 'diary'`   | 書き込み先                                |
| `content`  | `string`              | 書き込む内容                              |
| `date`     | `string` (オプション) | diary 書き込み時の日付（デフォルト: 今日）|

- core への書き込みは **append のみ**（prompt injection 固定化防止）
- 日付は `config.timezone` 基準で決定

### `recallDiary` (`src/agent/tools/recall-diary.ts`)

| パラメータ | 型       | 説明                               |
| ---------- | -------- | ---------------------------------- |
| `date`     | `string` | 取得する日記の日付（YYYY-MM-DD）   |

- 直近 3 日は自動注入されるため、それより古い日付の取得に使用する

## 要約処理 (`Agent.summarizeSession`)

- 別途 `generateText()` で要約専用の LLM 呼び出しを行う
- 既存 `summary` があれば結合して要約する
- 要約プロンプト: 重要な事実・決定・ユーザーの好み・コンテキストを保持するよう指示

## システムプロンプト構築 (`src/agent/prompt.ts`)

```
[エージェント基本指示]

<memory>
{coreMemory の内容}
</memory>

<diary>
{直近3日分の diary（日付付き）}
</diary>

[session.summary がある場合]
<summary>
{summary の内容}
</summary>

[ツール使用説明]
```

`<memory>` / `<diary>` / `<summary>` タグで untrusted data を明示し、
instruction 部分と明確に分離することで prompt injection を防ぐ。

## セキュリティ

- memory / diary / summary はすべてタグで囲い、instruction と分離
- `saveMemory` の `mode: replace` は実装しない
- ツールのステップ数上限（`stopWhen: stepCountIs(n)`）を設定して無限ループを防ぐ
