# AGENT.md

このファイルはリポジトリで作業する際のガイドラインを AI コーディングアシスタントに提供します。

## プロジェクト概要

Discord を主導線にした TypeScript 製の AI エージェント。Vercel AI SDK + Chat SDK + OpenAI 互換 LLM で応答を生成し、ファイルベースのコアメモリ / セッション管理、SQLite による日記・ユーザー・SNS 活動の永続化、Heartbeat / Cron / メモリメンテナンスによる system turn 実行、Mastodon / X 連携、Karakuri World 専用モードを備える。

## コマンド

- `npm run dev` — 開発起動（`LOG_LEVEL=debug tsx watch src/index.ts`）
- `npm run start` — 本番相当で起動（`tsx src/index.ts`）
- `npm test` — Vitest を一括実行（`vitest run`）
- `npm run typecheck` — TypeScript 型検査（`tsc --noEmit`）
- `npx vitest run tests/<file>.test.ts` — 単一テストファイル実行
- `npx vitest run -t "テスト名"` — テスト名でフィルタ実行
- `npm run docker:build` — Docker イメージをビルド
- `npm run docker:up` — Docker Compose をバックグラウンド起動
- `npm run docker:dev` — 開発用 Compose をフォアグラウンド起動
- `npm run docker:dev:up` — 開発用 Compose をバックグラウンド起動
- `npm run docker:down` — Compose を停止

補足:
- Node.js 20 以上が前提（`package.json#engines`）。
- ローカルの `npm run build` は存在しない。配布用ビルドは Dockerfile 内で `tsc -p tsconfig.build.json` を使って `dist/` を生成する。

## TypeScript 設定

- ES2022 / NodeNext / strict モード
- ESM（`"type": "module"`）— import パスに `.js` 拡張子が必要
- `noImplicitOverride: true`
- `noUncheckedIndexedAccess: true` — インデックスアクセスは `T | undefined`
- `exactOptionalPropertyTypes: true` — optional property に `undefined` を明示代入不可
- `resolveJsonModule: true`
- `isolatedModules: true`
- `verbatimModuleSyntax: true` — type-only import を明示する
- `tsconfig.json` は `src/**/*.ts`・`tests/**/*.ts`・`vitest.config.ts` を含む
- `tsconfig.build.json` は `src/**/*.ts` のみを対象にし、テストを除外して `dist/` を出力する

## テスト

- Vitest / `node` environment
- テストは `tests/**/*.test.ts` に配置
- カバレッジ収集はデフォルト無効
- テストファイル名は概ねソースのモジュール構造に対応（例: `agent.core.test.ts`, `session.manager.test.ts`）

## アーキテクチャ

### レイヤー構成（`src/` 配下）

```text
src/index.ts                  — 設定ロード → 各ストア/ランナー初期化 → Bot/Scheduler 起動 → HTTP/healthz 提供 → graceful shutdown
src/bot.ts                    — Chat SDK + Discord adapter 統合、Webhook/Gateway 受付、スレッド単位の排他制御、応答投稿
src/agent/core.ts             — generateText による応答生成、セッション要約判定、ツール構築、system/user turn 制御
src/agent/prompt.ts           — システムプロンプト構築、AGENT.md / RULES.md 読み込み
src/agent/prompt-context.ts   — trusted / untrusted 文脈の分離などプロンプト用コンテキスト構築
src/agent/tools/              — builtin ツール群（recallDiary, webFetch, webSearch, userLookup, loadSkill, postMessage, manageCron, sns_*, karakuri_world_*）
src/session/                  — JSON ファイルベースのセッション保存。ハッシュ化ファイル名 + メモリキャッシュを使用
src/memory/                   — FileMemoryStore（core memory）+ SqliteDiaryStore（日記）+ CompositeMemoryStore + maintenance runner
src/skill/                    — `data/skills/` と `data/system-skills/` を監視する frontmatter 付き SKILL.md ストア
src/scheduler/                — HEARTBEAT.md 読み込み、CRON.md frontmatter 解釈、Heartbeat/Cron 実行、scheduler store
src/sns/                      — Mastodon / X provider、活動ログの SQLite ストア、SNS skill dynamic context、SNS 専用ループ
src/user/                     — SqliteUserStore と PostResponseEvaluator によるユーザープロファイル永続化・更新
src/state/                    — Chat SDK の state adapter を `data/state/chat-state.json` に永続化
src/status-reaction.ts        — Discord 上の進行状態リアクション制御
src/karakuri-world/           — Karakuri World 専用のビルトイン指示
src/llm/                      — OpenAI 互換 API / Chat Completions 切り替え、no-thinking fetch 調整
src/shutdown.ts               — サーバー、scheduler、bot、各種ストアを段階的に停止する graceful shutdown 補助
src/config.ts                 — Zod ベースの環境変数バリデーションと runtime config 構築
```

### 主要な設計パターン

- **インターフェース抽象化**: Agent / MemoryStore / SessionManager / SkillStore / SnsProvider など主要コンポーネントは interface 越しに扱う。
- **ファイル監視ベースの runtime reload**: `AGENT.md`、`RULES.md`、スキル、scheduler 定義は `fs.watch` ベースの watcher で外部変更へ追随する。
- **Markdown + frontmatter の使い分け**:
  - `AGENT.md` / `RULES.md` / `HEARTBEAT.md` は生の Markdown / text をそのまま読む。
  - `SKILL.md` と `CRON.md` は frontmatter 必須。
- **Skill-gated ツール**: 一部ツールはスキル経由でのみ解放される。SNS 系ツールは `loadSkill("sns")`、または runtime が auto-load したスキルを通じて公開される。
- **Admin-gated ツール**: `postMessage` と `manageCron` は管理者権限が必要。特に `manageCron` は scheduler store が存在しても admin 以外には公開されない。
- **トークンバジェット管理**: セッションはトークン見積りで管理し、しきい値超過時は `KarakuriAgent` が要約して最近の turn を保持する。
- **System turn の直列化**: heartbeat・cron・memory maintenance はグローバル mutex で system turn を直列実行し、共有セッションの破損や競合を防ぐ。
- **メモリ永続化の直列化**: post-response evaluator と SNS 観測ユーザー評価は、core memory snapshot read と LLM 評価を lock 外で行い、append/write の apply 段階だけ共有 persistence mutex を通す。memory maintenance は同じ mutex を read → LLM → overwrite / replace / delete 全体で保持し、maintenance overwrite と background append の更新ロストを防ぎつつ、system turn が evaluator の LLM 待ちで長時間ブロックされないようにする。同一 user の後続 evaluator は agent 側 mutex で直列化される。
- **スレッド単位排他**: Discord 側のユーザー会話処理は thread ごとに mutex で直列化する。
- **ファイルベース state**: Chat SDK の subscription / cache / lock 状態は `data/state/chat-state.json` に保存される。
- **SNS の重複防止と専用ループ**: SNS 活動は SQLite に記録し、like / repost / reply / quote の重複防止を行う。SNS 自動実行は heartbeat から分離した専用ループで行う。
- **SNS 投稿の 140 文字制限**: `sns_post` の投稿本文は全プロバイダ共通で 140 文字以内に制限される（Zod スキーマ + ツール description + ビルトインスキル instructions の 3 層制御）。プラットフォーム固有の上限ではなく、エージェントの投稿スタイルとしての設計判断。
- **Karakuri World 専用モード**: `KARAKURI_WORLD_BOT_IDS` に一致する相手では専用ツールセットのみを公開する。

### Scheduler / proactive messaging の注意点

- Heartbeat は `HEARTBEAT.md` が存在するだけでは動かない。`postMessageChannelIds`（`ALLOWED_CHANNEL_IDS` 由来）が 1 件以上あるときに有効化される。
- `REPORT_CHANNEL_ID` 単独では heartbeat は有効にならない。
- `MEMORY_MAINTENANCE_INTERVAL_MINUTES` を設定すると、メモリメンテナンス専用ループが有効になり、report には要約サマリーを送る。
- Cron ジョブ実行自体は admin 権限不要。admin 権限が必要なのは `manageCron` ツール経由の操作。
- `CRON.md` の frontmatter では少なくとも以下を扱う:
  - `schedule`
  - `session-mode` (`isolated` / `shared`)
  - `enabled`
  - `stagger-ms`
  - `oneshot`

## データディレクトリ（`data/`）

`data/` は `.gitignore` 対象。通常は `data.example/` をコピーして使う。主な runtime artifact は以下。

- `data/AGENT.md` — エージェント基本指示
- `data/RULES.md` — 追加ルール
- `data/HEARTBEAT.md` — heartbeat 用 system 指示
- `data/skills/*/SKILL.md` — ユーザー向けスキル（frontmatter 必須）
- `data/system-skills/*/SKILL.md` — system 用スキル（frontmatter 必須）
- `data/cron/*/CRON.md` — cron ジョブ定義（frontmatter 必須）
- `data/memory/core/memory.md` — コアメモリ
- `data/memory/diary/*.md` — 旧形式の日記。起動時に `diary.db` へ一度だけ import されうる
- `data/sessions/{hash}.json` — セッションファイル
- `data/state/chat-state.json` — Chat SDK の永続 state
- `data/diary.db` — 日記ストア
- `data/users.db` — ユーザープロファイルストア
- `data/sns-activity.db` — SNS 活動履歴 / 通知予約ストア

## セキュリティ

- `utils/safe-fetch.ts` は SSRF 対策の中核で、private / loopback / link-local 宛ての拒否、DNS pinning、redirect ごとの再検証を行う。
- `webFetch` と `sns_upload_media` は同じ safe-fetch 系の URL 検証基盤を利用する。
- `webFetch` は http/https のみを受け付け、レスポンスサイズ上限と HTML/XHTML の抽出処理を持つ。
- プロンプトでは `<memory>`、`<user-profile>`、`<diary>`、`<skill-dynamic-context>`、`<summary>` と、`recallDiary` / `userLookup` / `webFetch` / `webSearch` / skill-gated tool の結果を untrusted content として扱う。
- trusted instruction と untrusted context は XML ライクなタグで分離され、下位コンテキストによる上書きを避ける前提で設計されている。
