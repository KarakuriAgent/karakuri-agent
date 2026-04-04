# Karakuri-Agent 高レベル設計

## Context

OpenClaw 風の AI エージェントを、Vercel AI SDK + vercel/chat (Chat SDK) + OpenAI 互換 LLM + Discord で構築する。
ファイルベースのメモリ・セッション管理、各層の抽象化による機能改変容易性を重視。
v1 はテキストメッセージのみ対応（添付ファイル非対応）。

## アーキテクチャ概要

```
Discord ──→ Chat SDK (bot.ts) ──→ Agent Core
                │                      │
                │                      ├── OpenAI-compatible LLM (via @ai-sdk/openai, selector-based routing)
                │                      ├── Tools (recallDiary, userLookup*, webFetch, webSearch*, loadSkill*, skill-gated tools*)
                │                      ├── Prompt Context (AGENT.md / RULES.md, eager reload)
                │                      ├── Skills (data/skills/* + data/system-skills/*, eager reload)
                │                      ├── Memory (CompositeMemoryStore: file core + SQLite diary)
                │                      └── Session (file-based, write-through cache + turn単位管理)
                │
                └── State (JSON file-backed custom adapter)
                    └── thread subscriptionの永続化
```

`webSearch*` は `BRAVE_API_KEY` 設定時のみ、`loadSkill*` は 1 つ以上のスキルが存在するときのみ公開される。skill-gated tools は `loadSkill` 実行後かつ対応環境変数がそろったときのみ使える。現状の skill-gated ツールは `SNS_*` で公開する Mastodon / X 向け `sns_*` のみで、`karakuri_world_*` は `loadSkill` では一切公開しない。代わりに `karakuriWorld` 設定があり、かつ `KARAKURI_WORLD_BOT_IDS` に一致するユーザーからのメッセージ時に KW モードとして `karakuri_world_*` を直接登録し、`toolChoice: 'required'` + 1 通知 1 アクションで実行する。`data/skills/*/SKILL.md` は全ユーザー向け、`data/system-skills/*/SKILL.md` は `userId === 'system'` の system turn（cron / heartbeat / SNS loop）でのみ参照される。加えて `config.sns` 設定時は system ユーザー向けのビルトイン SNS skill をコード内定義で自動追加し、SNS 専用ループでは `loadSkill` を介さず SNS を自動ロードして、動的コンテキスト・指示・`sns_*` ツールをシステムプロンプトへ事前注入する。cron では通常どおり `loadSkill("sns")` で使う。`data/system-skills/sns/SKILL.md` は不要で、残っていてもすべての system ユーザー文脈ではビルトインが優先される。対話ユーザーに公開したい場合は運用側で shared skill を追加する。

各層はインターフェースで抽象化し、実装の差し替えを容易にする:

| 層      | インターフェース   | 初期実装                    | 差し替え例              |
| ------- | ------------------ | --------------------------- | ----------------------- |
| Channel | Chat SDK adapters  | Discord                     | Slack, Web 等            |
| Agent   | `IAgent`           | generateText + OpenAI-compatible LLM | モデル/API切替、スキル追加  |
| Memory  | `IMemoryStore`     | CompositeMemoryStore（file core + SQLite diary） | object storage, external DB |
| Session | `ISessionManager`  | JSON ファイル (write-through cache) | Redis, DB |

## プロジェクト構造

```
karakuri-agent/
├── src/
│   ├── bot.ts                  # Chat SDK初期化 + Discordアダプター + イベントハンドラー
│   ├── agent/
│   │   ├── core.ts             # Agent: generateText() + ツールループ
│   │   ├── prompt.ts           # システムプロンプト構築（AGENT/RULES/skills + メモリ注入）
│   │   ├── prompt-context.ts   # AGENT.md / RULES.md の eager reload
│   │   └── tools/
│   │       ├── index.ts           # ツールレジストリ
│   │       ├── gated-tools.ts     # スキル→ToolSet マッピング（動的ツール解決）
│   │       ├── karakuri-world.ts  # karakuri-world API クライアント + ツール定義
│   │       ├── sns.ts             # Mastodon / X 向け SNS ツール定義（skill-gated）
│   │       ├── load-skill.ts      # スキル本文ロード + 動的ツール登録
│   │       ├── recall-diary.ts    # 日記検索ツール
│   │       ├── user-lookup.ts     # 保存済みユーザープロフィール検索
│   │       ├── web-fetch.ts       # URL取得 + Readability/Turndown
│   │       └── web-search.ts      # Brave Search API 連携
│   ├── sns/
│   │   ├── action-locks.ts        # SNS重複実行防止ロック
│   │   ├── activity-store.ts      # SNS行動ログのSQLite実装
│   │   ├── builtin-skill.ts       # system 向けビルトイン SNS skill / SNS loop 用活動指示
│   │   ├── context-provider.ts    # SNS動的コンテキスト生成（通知/トレンド/行動ログ）
│   │   ├── index.ts               # SNS provider factory
│   │   ├── mastodon.ts            # Mastodon API 実装
│   │   ├── x.ts                   # X API 実装
│   │   ├── loop-runner.ts         # SNS 専用ループ
│   │   └── types.ts               # SNS provider 共通型
│   ├── memory/
│   │   ├── composite-store.ts  # IMemoryStore + CompositeMemoryStore
│   │   ├── diary-store.ts      # SqliteDiaryStore (SQLite diary)
│   │   ├── store.ts            # FileMemoryStore (core memory only)
│   │   └── types.ts
│   ├── skill/
│   │   ├── context-provider.ts # skillごとの動的コンテキスト注入と commit/abort hook
│   │   ├── frontmatter.ts      # SKILL.md frontmatter parser
│   │   ├── store.ts            # skill store + eager reload
│   │   └── types.ts
│   ├── session/
│   │   ├── manager.ts          # ISessionManager + FileSessionManager (write-through cache)
│   │   └── types.ts
│   ├── state/
│   │   └── file-state.ts       # Chat SDK StateAdapter の JSON ファイル実装
│   ├── utils/
│   │   ├── file-watcher.ts     # fs.watch ベースの debounce 付き watcher
│   │   ├── mutex.ts            # ファイルI/O用の簡易mutex
│   │   ├── message-splitter.ts # Discord 2000文字分割（コードフェンス維持）
│   │   └── token-counter.ts    # トークン予算管理
│   ├── config.ts               # 設定読み込み
│   └── index.ts                # エントリポイント
├── tests/                      # Memory / Session / Agent / utility unit test
├── data/                       # .gitignoreで全体を除外
│   ├── diary.db                # 日記（直近3日分は自動注入）
│   ├── memory/
│   │   └── core/
│   │       └── memory.md       # 重要な記憶（常時システムプロンプトに注入）
│   ├── AGENT.md                # 任意: trusted なエージェント人格
│   ├── RULES.md                # 任意: trusted な行動ルール
│   ├── skills/
│   │   └── */SKILL.md          # 任意: 全ユーザー向け trusted skill 定義
│   ├── system-skills/
│   │   └── */SKILL.md          # 任意: `userId === 'system'` 専用 trusted skill 定義（SNS builtin 以外）
│   ├── state/
│   │   └── chat-state.json     # Chat SDK の subscription / cache / history state
│   └── sessions/
│       └── {hashedSessionId}.json
├── .env
├── .env.example               # Docker Compose 用に数値 UID / GID の雛形も定義
├── .dockerignore
├── Dockerfile
├── docker-compose.yml
├── docker-compose.dev.yml
├── .gitignore                  # data/ 全体を除外
├── package.json
├── package-lock.json           # lockfileをコミット
├── tsconfig.json
└── tsconfig.build.json
```

## 依存パッケージ

```json
{
  "dependencies": {
    "chat": "4.20.2",
    "@chat-adapter/discord": "4.20.2",
    "ai": "6.0.116",
    "@ai-sdk/openai": "3.0.41",
    "@mozilla/readability": "0.6.0",
    "zod": "3.25.76",
    "dotenv": "17.3.1",
    "linkedom": "0.18.12",
    "turndown": "7.2.2"
  },
  "devDependencies": {
    "typescript": "5.9.3",
    "@types/node": "25.5.0",
    "@types/turndown": "5.0.6",
    "tsx": "4.21.0",
    "vitest": "4.1.0"
  }
}
```

> Chat SDK は beta のため **exact version 固定** + **lockfile コミット**必須。

## Docker Compose メモ

- `docker-compose.yml` は container 内の `DATA_DIR` を `/app/data` に固定し、bind mount の保存先とアプリ設定がずれないようにする
- `docker-compose.dev.yml` は `src/` と `tsconfig.json` だけを bind mount し、イメージ内の `/app/node_modules` をそのまま使うことで devDependencies が bind mount で隠れないようにする
- 開発コンテナでは `HOME` / npm cache を `/tmp/karakuri-agent` に向け、任意 UID / GID 実行でも `npx` 系キャッシュが `/` に落ちないようにする

## 実装フェーズ

### Phase 0: Discord Gateway + 永続 state 検証（最優先）

- Chat SDK + `@chat-adapter/discord` で Discord Gateway 接続
- 永続 state の設定（`src/state/file-state.ts` による JSON file-backed custom state）
- echo bot で動作確認（メッセージ → 応答 → 再起動 → follow-up 継続）
- **ここで Chat SDK が長時間稼働で安定するか検証。問題あれば discord.js にフォールバック判断**

### Phase 1: プロジェクトスキャフォールド

- `package.json` (`"type": "module"`) + exact version 固定で依存インストール
- `tsconfig.json` (ES2022, strict, ESM)
- `.env` + `.gitignore` (`data/` 全体を除外)
- ディレクトリ構造作成
- `src/config.ts` (timezone 含む, LLM selector parse)
- `src/utils/mutex.ts`, `src/utils/message-splitter.ts`, `src/utils/token-counter.ts`

### Phase 2: Memory 層

- `src/memory/types.ts` (IMemoryStore / ICoreMemoryStore / IDiaryStore)
- `src/memory/store.ts` (FileMemoryStore: core memory file store)
- `src/memory/diary-store.ts` (SqliteDiaryStore: diary SQLite store)
- `src/memory/composite-store.ts` (CompositeMemoryStore)
- `data/memory/core/memory.md`（空 or 初期内容）
- `data/diary.db`
- **unit test**: core read/write/append/concurrent write, diary append/range/date listing

### Phase 3: Session 層

- `src/session/types.ts` (SessionData with schema version, ISessionManager)
- `src/session/manager.ts` (FileSessionManager: write-through cache + turn 単位管理, トークン予算判定)
- **unit test**: load/save/turn-based summarization trigger/applySummary

### Phase 4: Agent 層

- `src/user/store.ts` / `src/user/post-response-evaluator.ts`（SQLite user store + 応答後の永続化評価）
- `src/agent/tools/recall-diary.ts`
- `src/agent/tools/web-fetch.ts`
- `src/agent/tools/web-search.ts`
- `src/agent/tools/index.ts`
- `src/agent/prompt.ts` (untrusted data 区切り付き)
- `src/agent/core.ts` (response.messages 保存, turn 単位圧縮, selector に応じた OpenAI API 切替)

### Phase 5: Bot 層 + 統合

- `src/bot.ts` (Chat SDK + Discord Gateway + 永続 state)
- `src/index.ts` (エントリポイント + graceful shutdown)
- `src/utils/message-splitter.ts` (コードフェンス維持)
- package.json scripts: `"start": "tsx src/index.ts"`, `"dev": "tsx watch src/index.ts"`, `"test": "vitest"`

### Phase 6: 動作確認

- Discord Bot アプリケーション作成・トークン取得
- `npm run dev` で起動
- Discord でメッセージ送信 → 応答確認（メンション不要）
- 再起動後の follow-up 継続確認（永続 state）
- メモリ保存・読み込み確認（memory.md, diary.db）
- ユーザー情報保存確認（users.db, user profile prompt, userLookup）
- ボット再起動後のメモリ永続化確認
- 長い会話でセッション要約が動作するか確認（turn 単位で壊れないか）
- concurrent write テスト（複数スレッドから memory 同時書き込み）

## リスク・注意点

1. **Chat SDK は beta**: exact version 固定 + lockfile コミット必須。破壊的変更に備える
2. **Discord Gateway 接続**: Chat SDK の Discord アダプターが長時間稼働で安定するか Phase 0 で検証。問題時は discord.js 直接使用にフォールバック
3. **AI SDK v6 API**: `stopWhen: stepCountIs(n)`, `ModelMessage` 型を使用（ai-sdk.dev/docs で確認済み）
4. **永続化競合**: memory.md は mutex + atomic write、diary は SQLite WAL で整合性を保つ
5. **Prompt injection**: memory/diary/user profile 内容はタグで区切り、instruction 部分と明確分離する
6. **コンテキスト予算**: メッセージ件数ではなくトークン予算ベースで要約トリガー管理
7. **Timezone**: diary 日付は `config.timezone`（デフォルト `Asia/Tokyo`）基準
8. **セッション ID**: raw thread ID ではなく hash/base64url 化してファイル名安全性を確保
9. **State 永続化**: v1 は JSON file-backed custom state を使う。単一プロセス前提なので、複数インスタンス化や外部ストレージが必要になったら `StateAdapter` 実装を差し替える

## 詳細設計

各層の詳細設計は以下のドキュメントを参照:

- [Memory 層](memory.md)
- [Session 層](session.md)
- [Agent 層](agent.md)
- [Skill 層](skill.md)
- [Bot 層](bot.md)
- [設定](config.md)
