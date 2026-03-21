# 設定 詳細設計

## 概要

環境変数から型付きの設定オブジェクトを生成する。
必須項目の欠落は起動時エラーとして検出する。

## 主要ファイル: `src/config.ts`

## 環境変数

| 変数名              | 必須 | デフォルト      | 説明                                             |
| ------------------- | ---- | --------------- | ------------------------------------------------ |
| `DISCORD_BOT_TOKEN` | ✅   | -               | Discord Bot トークン                             |
| `DISCORD_PUBLIC_KEY` | ✅  | -               | Discord Interactions 用の公開鍵                  |
| `DISCORD_APPLICATION_ID` | ✅ | -            | Discord Application ID                           |
| `OPENAI_API_KEY`    | ✅   | -               | OpenAI API キー                                  |
| `BRAVE_API_KEY`     |      | -               | Brave Search API キー（設定時のみ `webSearch` を有効化） |
| `DATA_DIR`          |      | `./data`        | memory / session / bot state ファイルの保存ディレクトリ |
| `TIMEZONE`          |      | `Asia/Tokyo`    | diary 日付の基準タイムゾーン                     |
| `OPENAI_MODEL`      |      | `gpt-4o`        | 使用する OpenAI モデル名                         |
| `MAX_STEPS`         |      | `10`            | ツールループの最大ステップ数                     |
| `TOKEN_BUDGET`      |      | `8000`          | 要約トリガーのトークン予算                           |
| `PORT`              |      | `3000`          | Webhook / healthcheck HTTP サーバーの待受ポート  |

## 設定オブジェクト

```typescript
interface Config {
  discordApplicationId: string;
  discordPublicKey: string;
  discordBotToken: string;
  openaiApiKey: string;
  braveApiKey?: string | undefined;
  dataDir: string;
  timezone: string;
  openaiModel: string;
  maxSteps: number;
  tokenBudget: number;
  port: number;
}
```

## `loadConfig()` の動作

```typescript
function loadConfig(): Config {
  // dotenv で .env を読み込む
  // 必須項目が未設定の場合は起動時に Error をスロー
  // 任意項目はデフォルト値を使用
}
```

## セキュリティ

- `.env` は `.gitignore` に含め、リポジトリにコミットしない
- `DISCORD_BOT_TOKEN` / `OPENAI_API_KEY` などのシークレットをログに出力しない

## 互換用エイリアス

実装では既存設定との互換性のため、以下のエイリアスも受け付ける:

- `DISCORD_TOKEN` → `DISCORD_BOT_TOKEN`
- `AGENT_MODEL` → `OPENAI_MODEL`
- `AGENT_MAX_STEPS` → `MAX_STEPS`
- `AGENT_TOKEN_BUDGET` → `TOKEN_BUDGET`

## 将来の拡張

エージェント名やペルソナ等のプロンプト設定は、後のフェーズで設定ファイル（YAML / TOML 等）に移行予定。
初期実装ではハードコードで対応する。
