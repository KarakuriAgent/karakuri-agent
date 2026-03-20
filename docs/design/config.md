# 設定 詳細設計

## 概要

環境変数から型付きの設定オブジェクトを生成する。
必須項目の欠落は起動時エラーとして検出する。

## 主要ファイル: `src/config.ts`

## 環境変数

| 変数名              | 必須 | デフォルト      | 説明                                             |
| ------------------- | ---- | --------------- | ------------------------------------------------ |
| `DISCORD_TOKEN`     | ✅   | -               | Discord Bot トークン                             |
| `OPENAI_API_KEY`    | ✅   | -               | OpenAI API キー                                  |
| `DATABASE_URL`      | ✅   | -               | 永続 state 用 PostgreSQL 接続文字列              |
| `DATA_DIR`          |      | `./data`        | memory / session ファイルの保存ディレクトリ      |
| `TIMEZONE`          |      | `Asia/Tokyo`    | diary 日付の基準タイムゾーン                     |
| `OPENAI_MODEL`      |      | `gpt-4o`        | 使用する OpenAI モデル名                         |
| `MAX_STEPS`         |      | `10`            | ツールループの最大ステップ数                     |
| `TOKEN_BUDGET`      |      | モデル依存      | 要約トリガーのトークン予算（コンテキスト上限の割合） |

## 設定オブジェクト

```typescript
interface Config {
  discordToken: string;
  openaiApiKey: string;
  databaseUrl: string;
  dataDir: string;
  timezone: string;
  openaiModel: string;
  maxSteps: number;
  tokenBudget: number;
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
- `DISCORD_TOKEN` / `OPENAI_API_KEY` などのシークレットをログに出力しない

## 将来の拡張

エージェント名やペルソナ等のプロンプト設定は、後のフェーズで設定ファイル（YAML / TOML 等）に移行予定。
初期実装ではハードコードで対応する。
