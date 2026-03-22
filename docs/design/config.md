# 設定 詳細設計

## 概要

環境変数から型付きの設定オブジェクトを生成する。
必須項目の欠落は起動時エラーとして検出する。

## 主要ファイル: `src/config.ts`

## 環境変数

| 変数名              | 必須 | デフォルト          | 説明 |
| ------------------- | ---- | ------------------- | ---- |
| `DISCORD_BOT_TOKEN` | ✅   | -                   | Discord Bot トークン |
| `DISCORD_PUBLIC_KEY` | ✅  | -                   | Discord Interactions 用の公開鍵 |
| `DISCORD_APPLICATION_ID` | ✅ | -                | Discord Application ID |
| `LLM_API_KEY`       | ✅   | -                   | OpenAI 互換 LLM API キー |
| `LLM_BASE_URL`      |      | -                   | OpenAI 互換 API の Base URL（`http` / `https` のみ、末尾 `/` は正規化） |
| `BRAVE_API_KEY`     |      | -                   | Brave Search API キー（設定時のみ `webSearch` を有効化） |
| `DATA_DIR`          |      | `./data`            | memory / session / bot state ファイルの保存ディレクトリ |
| `TIMEZONE`          |      | `Asia/Tokyo`        | diary 日付の基準タイムゾーン |
| `LLM_MODEL`         |      | `openai/gpt-4o`     | 使用するモデルセレクタ |
| `MAX_STEPS`         |      | `10`                | ツールループの最大ステップ数 |
| `TOKEN_BUDGET`      |      | `8000`              | 要約トリガーのトークン予算 |
| `PORT`              |      | `3000`              | Webhook / healthcheck HTTP サーバーの待受ポート |

## モデルセレクタ

`LLM_MODEL` は API 面も含めた selector として扱う。

- `openai/<model>`: OpenAI Responses API を使う
- `openai/chat/<model>`: OpenAI Chat API を使う
- bare model 名（例: `gpt-4o`）も互換用に受け付け、内部では `openai/gpt-4o` として正規化する

`LLM_BASE_URL` は canonical 化して保持する。具体的には:

- 空文字は未設定として扱う
- `http` / `https` 以外は拒否する
- credentials / query / fragment を含む URL は拒否する
- 末尾の `/` は削除してから SDK に渡す

## 設定オブジェクト

```typescript
interface Config {
  discordApplicationId: string;
  discordPublicKey: string;
  discordBotToken: string;
  llmApiKey: string;
  llmBaseUrl?: string | undefined;
  llmModel: string;
  llmModelSelector: {
    provider: 'openai';
    api: 'responses' | 'chat';
    modelId: string;
    selector: string;
  };
  braveApiKey?: string | undefined;
  dataDir: string;
  timezone: string;
  maxSteps: number;
  tokenBudget: number;
  port: number;
}
```

`llmModel` は常に canonical な selector 文字列を保持し、`llmModelSelector` は Agent 層が利用する構造化済み情報を保持する。

## `loadConfig()` の動作

```typescript
function loadConfig(): Config {
  // dotenv で .env を読み込む
  // 必須項目が未設定の場合は起動時に Error をスロー
  // 任意項目はデフォルト値を使用
  // LLM selector を parse して canonical 形式へ正規化する
}
```

## セキュリティ

- `.env` は `.gitignore` に含め、リポジトリにコミットしない
- `DISCORD_BOT_TOKEN` / `LLM_API_KEY` などのシークレットをログに出力しない

## 互換用エイリアス

実装では既存設定との互換性のため、以下のエイリアスも受け付ける:

- `DISCORD_TOKEN` → `DISCORD_BOT_TOKEN`
- `OPENAI_API_KEY` → `LLM_API_KEY`
- `OPENAI_BASE_URL` → `LLM_BASE_URL`
- `OPENAI_MODEL` → `LLM_MODEL`
- `AGENT_MODEL` → `LLM_MODEL`
- `AGENT_MAX_STEPS` → `MAX_STEPS`
- `AGENT_TOKEN_BUDGET` → `TOKEN_BUDGET`

`LLM_API_KEY` が見つからない場合のエラーメッセージでも `OPENAI_API_KEY` alias を案内する。

## 将来の拡張

モデルセレクタは provider / API 面を拡張できる形にしてあり、今後 provider registry を追加することで他社 LLM や別 API surface にも広げやすい。
エージェント名やペルソナ等のプロンプト設定は、後のフェーズで設定ファイル（YAML / TOML 等）に移行予定。
初期実装ではハードコードで対応する。
