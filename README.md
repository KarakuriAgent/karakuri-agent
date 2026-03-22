# Karakuri-Agent

OpenClaw 風の AI エージェント。Vercel AI SDK + Chat SDK + OpenAI 互換 LLM + Discord で構築する。

## 特徴

- ファイルベースのメモリ・セッション管理（write-through キャッシュ付き）
- `data/AGENT.md` / `data/RULES.md` / `data/skills/*/SKILL.md` による Markdown-first の prompt / skill 拡張
- trusted prompt context / skills は `fs.watch()` で eager reload、memory は write-through + watcher で外部変更に追随
- `webFetch` / `webSearch` による Web 情報取得（Readability + Brave Search API）
- `data/HEARTBEAT.md` と `data/cron/*/CRON.md` による Heartbeat / Cron 実行
- `postMessage` / `manageCron` ツールによる管理者限定のプロアクティブ投稿と Cron 管理
- `REPORT_CHANNEL_ID` への Heartbeat / Cron 実行結果、Cron 登録変更、チャット処理エラー詳細の通知
- Discord メッセージに処理状態を表すリアクション絵文字を表示（完了は 2 秒後に除去、エラーは保持）
- 各層をインターフェースで抽象化し、実装の差し替えが容易
- v1 はテキストメッセージのみ対応

## セットアップ

1. `cp .env.example .env`
2. `.env` に Discord / LLM の設定を入力（`LLM_BASE_URL` は OpenAI 互換 API を使うときのみ設定。`http` / `https` のみ受け付け、末尾の `/` は正規化される。`BRAVE_API_KEY` を設定すると `webSearch` も有効化。未設定でも `webFetch` は利用可能）
   - `LLM_MODEL` は `openai/gpt-4o` のような OpenAI Responses API セレクタ、または `openai/chat/gpt-4o` のような OpenAI Chat API セレクタで指定する
   - 旧形式の bare model 名（例: `gpt-4o`）も互換用に受け付けるが、内部では `openai/gpt-4o` として扱う
   - `LLM_API_KEY` 未設定時のエラーでは legacy alias の `OPENAI_API_KEY` も案内する
   - Heartbeat / Cron を使う場合は `ALLOWED_CHANNEL_IDS` と `ADMIN_USER_IDS` を設定し、必要に応じて `REPORT_CHANNEL_ID` / `HEARTBEAT_INTERVAL_MINUTES` も指定
3. `cp -r data.example data`
4. `npm install`
5. `npm run dev`

`data.example/` にはサンプルの `AGENT.md`・`RULES.md`・スキル定義に加えて、`HEARTBEAT.md` と `cron/daily-summary/CRON.md` も含まれている。
`data/` はユーザーごとにカスタマイズするため `.gitignore` で除外されている。

Discord Developer Portal では `DISCORD_PUBLIC_KEY` / `DISCORD_APPLICATION_ID` を取得し、
Interactions Endpoint を `POST /webhooks/discord` に向ける。通常メッセージ受信には
Gateway 接続も必要なため、`npm run dev` / `npm run start` は HTTP サーバーと
Discord Gateway listener を同時に起動する。

## スクリプト

- `npm run dev` - 開発起動
- `npm run start` - 本番起動
- `npm run typecheck` - TypeScript 型検査
- `npm test` - unit test 実行

## 実装メモ

- `data/AGENT.md` はエージェント人格、`data/RULES.md` は trusted な行動ルール、`data/skills/*/SKILL.md` は追加スキル定義
- `data/HEARTBEAT.md` があると定期 Heartbeat を実行し、`data/cron/*/CRON.md` で Cron ジョブを定義できる
- スキルが有効なときだけ `loadSkill` ツールが公開され、一覧だけをシステムプロンプトへ注入する
- `webFetch` は常に有効。URL を取得し Readability + Turndown で Markdown 化して返す
- `webFetch` は private / loopback / link-local 宛てや、そこへ向かう redirect を拒否して SSRF を抑止する
- `webSearch` は `BRAVE_API_KEY` 設定時のみ有効。Brave Search API で Web 検索を行う
- `postMessage` / `manageCron` は `ALLOWED_CHANNEL_IDS` と `ADMIN_USER_IDS` が設定された管理者コンテキストでのみ公開される
- Heartbeat は `ALLOWED_CHANNEL_IDS` 設定時のみ有効化され、`REPORT_CHANNEL_ID` は空欄のままでも省略設定として扱われる
- `REPORT_CHANNEL_ID` を設定すると Heartbeat / Cron の実行成否、`manageCron` による登録/解除、チャット処理エラー詳細を自動投稿する（エージェント応答本文は自動投稿しない）
- Chat SDK の state は `DATA_DIR/state/chat-state.json` に保存するカスタム JSON アダプターを使用
- Memory / Session も `data/` 配下にファイル保存
- 元メッセージへのリアクションで `queued` / `thinking` / tool 実行中 / `done` / `error` を表示し、`done` は 2 秒後に自動除去する
- 添付ファイルは未対応。添付付きメッセージはテキスト部分のみ処理し、注意メッセージを返す

## ドキュメント

- [高レベル設計](docs/design/README.md)
- [Memory 層 詳細設計](docs/design/memory.md)
- [Session 層 詳細設計](docs/design/session.md)
- [Agent 層 詳細設計](docs/design/agent.md)
- [Skill 層 詳細設計](docs/design/skill.md)
- [Bot 層 詳細設計](docs/design/bot.md)
- [設定 詳細設計](docs/design/config.md)
