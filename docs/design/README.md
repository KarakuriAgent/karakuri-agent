# Karakuri-Agent 高レベル設計

## Context

OpenClaw 風の AI エージェントを、Vercel AI SDK + vercel/chat (Chat SDK) + OpenAI + Discord で構築する。
ファイルベースのメモリ・セッション管理、各層の抽象化による機能改変容易性を重視。
v1 はテキストメッセージのみ対応（添付ファイル非対応）。

## アーキテクチャ概要

```
Discord ──→ Chat SDK (bot.ts) ──→ Agent Core
                │                      │
                │                      ├── OpenAI (via @ai-sdk/openai)
                │                      ├── Tools (saveMemory, recallDiary)
                │                      ├── Memory (file-based, mutex付き)
                │                      └── Session (file-based, turn単位管理)
                │
                └── State (永続化必須: state-pg/state-redis/custom)
                    └── thread subscriptionの永続化
```

各層はインターフェースで抽象化し、実装の差し替えを容易にする:

| 層      | インターフェース   | 初期実装                    | 差し替え例              |
| ------- | ------------------ | --------------------------- | ----------------------- |
| Channel | Chat SDK adapters  | Discord                     | Slack, Web 等            |
| Agent   | `IAgent`           | generateText + OpenAI       | モデル切替、スキル追加  |
| Memory  | `IMemoryStore`     | ファイルベース (mutex 付き)  | SQLite, PostgreSQL      |
| Session | `ISessionManager`  | JSON ファイル               | Redis, DB               |

## プロジェクト構造

```
karakuri-agent/
├── src/
│   ├── bot.ts                  # Chat SDK初期化 + Discordアダプター + イベントハンドラー
│   ├── agent/
│   │   ├── core.ts             # Agent: generateText() + ツールループ
│   │   ├── prompt.ts           # システムプロンプト構築（メモリ注入）
│   │   └── tools/
│   │       ├── index.ts        # ツールレジストリ
│   │       ├── save-memory.ts  # メモリ書き込みツール
│   │       └── recall-diary.ts # 日記検索ツール
│   ├── memory/
│   │   ├── store.ts            # IMemoryStore + FileMemoryStore (mutex + atomic write)
│   │   └── types.ts
│   ├── session/
│   │   ├── manager.ts          # ISessionManager + FileSessionManager
│   │   └── types.ts
│   ├── utils/
│   │   ├── mutex.ts            # ファイルI/O用の簡易mutex
│   │   ├── message-splitter.ts # Discord 2000文字分割（コードフェンス維持）
│   │   └── token-counter.ts    # トークン予算管理
│   ├── config.ts               # 設定読み込み
│   └── index.ts                # エントリポイント
├── data/                       # .gitignoreで全体を除外
│   ├── memory/
│   │   ├── core/
│   │   │   └── memory.md       # 重要な記憶（常時システムプロンプトに注入）
│   │   └── diary/
│   │       └── YYYY-MM-DD.md   # 日記（直近3日分は自動注入）
│   └── sessions/
│       └── {hashedSessionId}.json
├── .env
├── .gitignore                  # data/ 全体を除外
├── package.json
├── package-lock.json           # lockfileをコミット
└── tsconfig.json
```

## 依存パッケージ

```json
{
  "dependencies": {
    "chat": "実装時にexact versionを固定",
    "@chat-adapter/discord": "実装時にexact versionを固定",
    "@chat-adapter/state-pg": "実装時にexact versionを固定（永続state）",
    "ai": "^6",
    "@ai-sdk/openai": "実装時にexact versionを固定",
    "zod": "^3.23.0",
    "dotenv": "^16.4.0"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "@types/node": "^22.0.0",
    "tsx": "^4.19.0",
    "vitest": "latest"
  }
}
```

> Chat SDK は beta のため **exact version 固定** + **lockfile コミット**必須。

## 実装フェーズ

### Phase 0: Discord Gateway + 永続 state 検証（最優先）

- Chat SDK + `@chat-adapter/discord` で Discord Gateway 接続
- 永続 state の設定（`state-pg` or カスタム）
- echo bot で動作確認（メンション → 応答 → 再起動 → follow-up 継続）
- **ここで Chat SDK が長時間稼働で安定するか検証。問題あれば discord.js にフォールバック判断**

### Phase 1: プロジェクトスキャフォールド

- `package.json` (`"type": "module"`) + exact version 固定で依存インストール
- `tsconfig.json` (ES2022, strict, ESM)
- `.env` + `.gitignore` (`data/` 全体を除外)
- ディレクトリ構造作成
- `src/config.ts` (timezone 含む)
- `src/utils/mutex.ts`, `src/utils/message-splitter.ts`, `src/utils/token-counter.ts`

### Phase 2: Memory 層

- `src/memory/types.ts` (IMemoryStore)
- `src/memory/store.ts` (FileMemoryStore: mutex + atomic write)
- `data/memory/core/memory.md`（空 or 初期内容）
- **unit test**: read/write/append/concurrent write

### Phase 3: Session 層

- `src/session/types.ts` (SessionData with schema version, ISessionManager)
- `src/session/manager.ts` (FileSessionManager: turn 単位管理, トークン予算判定)
- **unit test**: load/save/turn-based summarization trigger/applySummary

### Phase 4: Agent 層

- `src/agent/tools/save-memory.ts` (append のみ, timezone 対応)
- `src/agent/tools/recall-diary.ts`
- `src/agent/tools/index.ts`
- `src/agent/prompt.ts` (untrusted data 区切り付き)
- `src/agent/core.ts` (response.messages 保存, turn 単位圧縮)

### Phase 5: Bot 層 + 統合

- `src/bot.ts` (Chat SDK + Discord Gateway + 永続 state)
- `src/index.ts` (エントリポイント + graceful shutdown)
- `src/utils/message-splitter.ts` (コードフェンス維持)
- package.json scripts: `"start": "tsx src/index.ts"`, `"dev": "tsx watch src/index.ts"`, `"test": "vitest"`

### Phase 6: 動作確認

- Discord Bot アプリケーション作成・トークン取得
- `npm run dev` で起動
- Discord でメンション → 応答確認
- 再起動後の follow-up 継続確認（永続 state）
- メモリ保存・読み込み確認（memory.md, diary）
- ボット再起動後のメモリ永続化確認
- 長い会話でセッション要約が動作するか確認（turn 単位で壊れないか）
- concurrent write テスト（複数スレッドから memory 同時書き込み）

## リスク・注意点

1. **Chat SDK は beta**: exact version 固定 + lockfile コミット必須。破壊的変更に備える
2. **Discord Gateway 接続**: Chat SDK の Discord アダプターが長時間稼働で安定するか Phase 0 で検証。問題時は discord.js 直接使用にフォールバック
3. **AI SDK v6 API**: `stopWhen: stepCountIs(n)`, `ModelMessage` 型を使用（ai-sdk.dev/docs で確認済み）
4. **ファイル I/O 競合**: memory.md・当日 diary は全スレッド共有。mutex + atomic write 必須
5. **Prompt injection**: memory/diary 内容は `<memory>` タグで区切り、instruction 部分と明確分離。saveMemory の replace モードは非開放
6. **コンテキスト予算**: メッセージ件数ではなくトークン予算ベースで要約トリガー管理
7. **Timezone**: diary 日付は `config.timezone`（デフォルト `Asia/Tokyo`）基準
8. **セッション ID**: raw thread ID ではなく hash/base64url 化してファイル名安全性を確保
9. **State 永続化**: `state-memory` は開発用。本番は `state-pg` 等の永続 state が必須

## 詳細設計

各層の詳細設計は以下のドキュメントを参照:

- [Memory 層](memory.md)
- [Session 層](session.md)
- [Agent 層](agent.md)
- [Bot 層](bot.md)
- [設定](config.md)
