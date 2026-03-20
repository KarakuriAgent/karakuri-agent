# Karakuri-Agent

OpenClaw 風の AI エージェント。Vercel AI SDK + Chat SDK + OpenAI + Discord で構築する。

## 特徴

- ファイルベースのメモリ・セッション管理
- 各層をインターフェースで抽象化し、実装の差し替えが容易
- v1 はテキストメッセージのみ対応

## セットアップ

1. `cp .env.example .env`
2. `.env` に Discord / OpenAI の設定を入力
3. `npm install`
4. `npm run dev`

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

- Chat SDK の state は `DATA_DIR/state/chat-state.json` に保存するカスタム JSON アダプターを使用
- Memory / Session も `data/` 配下にファイル保存
- 添付ファイルは未対応。添付付きメッセージはテキスト部分のみ処理し、注意メッセージを返す

## ドキュメント

- [高レベル設計](docs/design/README.md)
- [Memory 層 詳細設計](docs/design/memory.md)
- [Session 層 詳細設計](docs/design/session.md)
- [Agent 層 詳細設計](docs/design/agent.md)
- [Bot 層 詳細設計](docs/design/bot.md)
- [設定 詳細設計](docs/design/config.md)
