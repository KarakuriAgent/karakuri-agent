# Skill 層 詳細設計

## 概要

`data/skills/*/SKILL.md` で trusted な追加スキルを定義し、
システムプロンプトには **一覧だけ** を注入する。
スキル本文は必要になったときだけ `loadSkill` ツールで取得する。

## インターフェース: `ISkillStore` (`src/skill/types.ts`)

```typescript
interface SkillDefinition {
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
}

interface ISkillStore {
  listSkills(): Promise<SkillDefinition[]>;
  getSkill(name: string): Promise<SkillDefinition | null>;
  close(): Promise<void>;
}
```

## ファイルレイアウト

```text
{dataDir}/skills/
└── code-review/
    └── SKILL.md
```

## `SKILL.md` フォーマット

```yaml
---
name: code-review
description: コードレビューを行う
enabled: true
---

セキュリティ、型安全性、パフォーマンスを優先してレビューする。
```

### frontmatter ルール

- `name`: 必須。`/^[a-z0-9][a-z0-9-]*$/` を満たす
- `description`: 必須。スキル一覧に表示する短い説明
- `enabled`: 任意。省略時は `true`
- 不明なキー、重複キー、空値、空本文はすべて **fail-closed**

## 実装: `FileSkillStore` (`src/skill/store.ts`)

### 読み込み

1. 起動時に `data/skills/*` を列挙
2. 各ディレクトリの `SKILL.md` を読み込む
3. `parseSkillMarkdown()` で厳格にパース
4. enabled なスキルだけ `listSkills()` / `loadSkill` から見えるようにする

### eager reload

- ルートの `data/skills` を監視し、スキルディレクトリの追加・削除に追随
- 各 `data/skills/<name>` ディレクトリも監視し、`SKILL.md` 編集を検知
- watcher は `fs.watch()` + debounce を使う
- runtime reload 失敗時は **last-known-good を維持**し、warn ログのみ出す
- startup reload 失敗時は **fail-fast**

### 一貫性

- reload ごとに generation を進め、古い非同期 reload の結果を破棄する
- 同名 skill が複数あれば `Duplicate skill name` で失敗する

## Agent 層との統合

- `buildSystemPrompt()` には enabled skill の一覧だけを注入する
- `createAgentTools()` は enabled skill が 1 つ以上あるときだけ `loadSkill` を追加する
- `loadSkill(name)` は本文をそのまま返し、モデルに必要なときだけ詳細を読ませる

## 信頼境界

- skills は `AGENT.md` / `RULES.md` と同じ **trusted config** 扱い
- `memory` / `diary` / `summary` のような untrusted user-derived context とは分離する

## テスト方針

| テストケース | 検証内容 |
| --- | --- |
| frontmatter 正常系 | `name` / `description` / `enabled` / 本文が正しくパースされる |
| frontmatter 異常系 | unknown key / invalid boolean / 空本文で fail-closed になる |
| store 初期ロード | 有効スキルが読み込まれる |
| runtime reload | 編集後に eager reload される |
| last-known-good | runtime parse error 後も直前のスキルが残る |
| startup fail-fast | 起動時の不正スキルで初期化が失敗する |
