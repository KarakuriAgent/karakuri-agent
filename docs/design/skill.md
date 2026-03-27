# Skill 層 詳細設計

## 概要

`data/skills/*/SKILL.md`（全ユーザー向け）と `data/system-skills/*/SKILL.md`（`userId === 'system'` 専用）で trusted な追加スキルを定義し、
システムプロンプトには **その実行コンテキストで利用可能な一覧だけ** を注入する。
加えて、SNS は `config.sns` 設定時に system ユーザー向けビルトインスキルとしてコード内でも定義される。
スキル本文は通常は必要になったときだけ `loadSkill` ツールで取得するが、heartbeat の SNS だけは自動ロードされる。

## インターフェース: `ISkillStore` (`src/skill/types.ts`)

```typescript
interface SkillDefinition {
  name: string;
  description: string;
  instructions: string;
  allowedTools?: string[];
  systemOnly: boolean;
}

interface SkillFilterOptions {
  includeSystemOnly?: boolean;
}

interface ISkillStore {
  listSkills(options?: SkillFilterOptions): Promise<SkillDefinition[]>;
  getSkill(name: string, options?: SkillFilterOptions): Promise<SkillDefinition | null>;
  close(): Promise<void>;
}
```

## ファイルレイアウト

```text
{dataDir}/
├── skills/              # 全ユーザーが利用可能
│   └── research/
│       └── SKILL.md
└── system-skills/       # system ユーザー（cron / heartbeat）のみ
    └── maintenance/
        └── SKILL.md
```

## `SKILL.md` フォーマット

```yaml
---
name: research-helper
description: 追加の調査手順
allowed-tools: webFetch
---

調査対象の URL を読み、必要なら `webFetch` で本文を確認する。
```

### frontmatter ルール

- `name`: 必須。`/^[a-z0-9][a-z0-9-]*$/` を満たす
- `description`: 必須。スキル一覧に表示する短い説明
- `allowed-tools`: 任意。`,` 区切りのツール名一覧。`loadSkill` 後に追加公開する skill-gated tool を表す
- `systemOnly`: フォルダ由来の実行時メタデータ。frontmatter には含めない
- `karakuri-world`: 予約済みの legacy skill 名。ビルトイン KW モード専用のため通常の skill 名には使わない
- 不明なキー、重複キー、空値、空本文はすべて **fail-closed**
- `system-skills` 配下の本文は automation 前提で書き、人間への確認依頼や対話待ちを前提にしない

## 実装: `FileSkillStore` (`src/skill/store.ts`)

### 読み込み

1. 起動時に `data/skills/*` と `data/system-skills/*` を列挙
2. 各ディレクトリの `SKILL.md` を読み込む
3. `parseSkillMarkdown()` で厳格にパースし、ソースディレクトリに応じて `systemOnly` を付与する
4. `listSkills()` / `getSkill()` は通常ユーザー向けに system skill を隠し、`includeSystemOnly` 指定時のみ返す

### eager reload

- ルートの `data/skills` と `data/system-skills` を監視し、スキルディレクトリの追加・削除に追随
- 各スキルディレクトリも監視し、`SKILL.md` 編集を検知
- watcher は `fs.watch()` + debounce を使う
- runtime reload 失敗時は **last-known-good を維持**し、warn ログのみ出す
- startup reload 失敗時は **fail-fast**

### 一貫性

- reload ごとに generation を進め、古い非同期 reload の結果を破棄する
- 同名 skill が複数あれば `Duplicate skill name "..." found in /path/a and /path/b` で失敗する（重複元のディレクトリパスを含む）
- 名前重複チェックは `skills/` と `system-skills/` をマージした後に行う

## Agent 層との統合

- `buildSystemPrompt()` には skill の一覧だけを注入し、`allowed-tools` があれば `(tools: ...)` も表示する
- `createAgentTools()` は skill が 1 つ以上あるときだけ `loadSkill` を追加する
- system user (`userId === 'system'`) のみ `includeSystemOnly: true` で system skill を参照できる
- `config.sns` がある system user にはビルトイン SNS skill を追加し、同名の `data/system-skills/sns/SKILL.md` が残っていても SNS ビルトインを優先する。heartbeat の自動ロードでも同じ定義と活動指示を使う
- skill-gated tool は初期 `tools` には含めず、`loadSkill(name)` 実行時に `allowedTools` に対応するツールだけを動的登録する
- ただし heartbeat (`isSystemUser && ephemeral && snsContextRegistry != null && effectiveSkills にビルトイン SNS skill が含まれる`) では SNS だけ例外で、自動的にツール登録・動的コンテキスト注入を行い、Available skills からは除外する
- `karakuri-world` は legacy skill 名として予約扱いで、`allowed-tools` の有無に関係なく通常の `listSkills()` / `getSkill()` / `loadSkill()` から除外する。ローカルの `data/skills/karakuri-world/SKILL.md` / `data/system-skills/karakuri-world/SKILL.md` が残っていても KW モード以外では無効
- `karakuri_world_*` は shared skill としては同梱せず、`KARAKURI_WORLD_BOT_IDS` に一致する Discord ユーザーかつ `config.karakuriWorld` 設定済みのときだけ、専用 KW モードで直接登録する
- `handleMessage()` ごとに `tools` オブジェクトを作り直すため、skill-gated tool はターンをまたいで保持されない
- `loadSkill(name)` は本文をそのまま返し、モデルに必要なときだけ詳細を読ませる

## 信頼境界

- skills は `AGENT.md` / `RULES.md` と同じ **trusted config** 扱い
- `memory` / `diary` / `summary` / `skill-dynamic-context` のような untrusted external context とは分離する

## テスト方針

| テストケース | 検証内容 |
| --- | --- |
| frontmatter 正常系 | `name` / `description` / `allowed-tools` / 本文が正しくパースされる |
| frontmatter 異常系 | unknown key / 空本文で fail-closed になる |
| store 初期ロード | shared skill が読み込まれる |
| system skill フィルタ | 通常ユーザーでは system skill が隠れ、system user のみ取得できる |
| runtime reload | 編集後に eager reload される |
| last-known-good | runtime parse error 後も直前のスキルが残る |
| startup fail-fast | 起動時の不正スキルで初期化が失敗する |
