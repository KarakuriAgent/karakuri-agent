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
1. ユーザーメッセージ追加         sessionManager.addMessages(sessionId, [...])
   （セッション読み込み＋追加を一括処理）
        ↓
2. 要約チェック（トークン予算）
   a. coreMemory, recentDiaries, AGENT.md / RULES.md, enabled skills を取得
   b. additionalTokens = tokens(可変長の trusted prompt context + "<memory>...</memory>" + "<diary>...</diary>" + skill list)
   c. needsSummarization(session, additionalTokens) が true
        │                              ↓
        │                        summarizeSession() で LLM 要約
        │                        sessionManager.applySummary() で圧縮
        ↓
3. システムプロンプト構築
   ├── AGENT.md（なければデフォルト指示）
   ├── CORE_SAFETY_INSTRUCTIONS（不変）
   ├── RULES.md（あれば trusted に追加）
   ├── <memory> ... </memory>          memory.md の内容（常時注入）
   ├── <diary> ... </diary>            直近3日分の diary（自動注入）
   ├── session.summary（あれば注入）
   ├── Available skills（enabled skill の一覧）
   └── ツール使用説明
        ↓
4. generateText() + tools + stopWhen: stepCountIs(n)
        ↓
5. result.response.messages を sessionManager に保存して応答文字列を返す
```

> **注**: trusted prompt context（AGENT.md / RULES.md / skills 一覧）と
> `coreMemory` / `recentDiaries` のトークン数は Session 層のスコープ外のため、
> Agent 層がステップ 3b で `src/utils/token-counter.ts` を使って計算し `additionalTokens` として渡す。
> トークン数は **プロンプトに埋め込む最終形**（`<memory>...</memory>`, `<diary>...</diary>` タグを含む文字列）に対してカウントする。
> `additionalTokens` の対象は **可変長の外部コンテキスト**（AGENT.md / RULES.md / skills 一覧 / coreMemory / recentDiaries）。
> 将来さらに可変長の trusted prompt context を追加した場合もここへ含める。

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

### `loadSkill` (`src/agent/tools/load-skill.ts`)

| パラメータ | 型       | 説明                     |
| ---------- | -------- | ------------------------ |
| `name`     | `string` | 取得する skill の名前    |

- enabled な skill が 1 つ以上あるときのみ公開
- 本文の全文は必要になったときだけロードさせ、システムプロンプトには skill 一覧のみ注入する

## 要約処理 (`Agent.summarizeSession`)

- 別途 `generateText()` で要約専用の LLM 呼び出しを行う
- 既存 `summary` があれば結合して要約する
- 要約プロンプト: 重要な事実・決定・ユーザーの好み・コンテキストを保持するよう指示

## システムプロンプト構築 (`src/agent/prompt.ts`)

```
[AGENT.md またはデフォルト指示]

[CORE_SAFETY_INSTRUCTIONS]

[RULES.md がある場合]

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

[enabled skills がある場合]
Available skills:
- ...

[ツール使用説明]
```

`<memory>` / `<diary>` / `<summary>` タグで untrusted data を明示し、
instruction 部分と明確に分離することで prompt injection を防ぐ。
AGENT.md / RULES.md / skills は trusted ファイルとして扱い、`fs.watch()` で eager reload する。

## テスト方針

Agent 層は LLM 呼び出しを含むため、`sessionManager` / `memoryStore` をモックしてテストする。

| テストケース | 検証内容 |
| --- | --- |
| additionalTokens の計算 | AGENT/RULES/skills 一覧 + coreMemory + recentDiaries のプロンプト埋め込み最終形に対してトークン数が計算される |
| 要約トリガーの連携 | additionalTokens を含むトークン数で予算超過時に summarizeSession が呼ばれる |
| 要約トリガーなし | 予算以内の場合に summarizeSession が呼ばれない |
| システムプロンプト構築 | memory / diary / summary がタグ付きで正しく組み立てられる |
| ツール実行 | saveMemory / recallDiary / loadSkill が対応ストアを呼ぶ |
| 応答メッセージ保存 | result.response.messages が sessionManager.addMessages で保存される |

## セキュリティ

- memory / diary / summary はすべてタグで囲い、instruction と分離
- `saveMemory` の `mode: replace` は実装しない
- ツールのステップ数上限（`stopWhen: stepCountIs(n)`）を設定して無限ループを防ぐ
