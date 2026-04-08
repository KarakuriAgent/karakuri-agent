# 設定 詳細設計

## 概要

環境変数から型付きの設定オブジェクトを生成する。
必須項目の欠落は起動時エラーとして検出する。

## 主要ファイル: `src/config.ts`

## 環境変数

| 変数名 | 必須 | デフォルト | 説明 |
| --- | --- | --- | --- |
| `DISCORD_BOT_TOKEN` | ✅ | - | Discord Bot トークン |
| `DISCORD_PUBLIC_KEY` | ✅ | - | Discord Interactions 用の公開鍵 |
| `DISCORD_APPLICATION_ID` | ✅ | - | Discord Application ID |
| `LLM_API_KEY` | ✅ | - | メイン会話 LLM の API キー（`OPENAI_API_KEY` alias あり） |
| `LLM_BASE_URL` |  | - | メイン会話 LLM の Base URL（`http` / `https` のみ、末尾 `/` は正規化） |
| `LLM_MODEL` |  | `openai/gpt-4o` | メイン会話 LLM のモデルセレクタ |
| `POST_RESPONSE_LLM_API_KEY` |  | fallback to `LLM_API_KEY` | ポストレスポンス evaluator / memory maintenance 専用 API キー |
| `POST_RESPONSE_LLM_BASE_URL` |  | fallback to `LLM_BASE_URL` | ポストレスポンス evaluator / memory maintenance 専用 Base URL |
| `POST_RESPONSE_LLM_MODEL` |  | fallback to `LLM_MODEL` | ポストレスポンス evaluator / memory maintenance 専用モデルセレクタ |
| `BRAVE_API_KEY` |  | - | Brave Search API キー（設定時のみ `webSearch` を有効化） |
| `KARAKURI_WORLD_API_BASE_URL` |  | - | karakuri-world API の Base URL（`KARAKURI_WORLD_API_KEY` と両方あるときのみ、`KARAKURI_WORLD_BOT_IDS` に一致する Discord ユーザーへ KW モードを有効化） |
| `KARAKURI_WORLD_API_KEY` |  | - | karakuri-world API の Bearer token |
| `SNS_PROVIDER` |  | - | SNS provider 種別。`mastodon` / `x` |
| `SNS_INSTANCE_URL` |  | - | Mastodon instance の Base URL（`SNS_PROVIDER=mastodon` のとき必須。標準添付 skill は system 専用） |
| `SNS_ACCESS_TOKEN` |  | - | SNS API 用の access token（X では必須、Mastodon でも使用） |
| `SNS_CLIENT_ID` |  | - | X OAuth 2.0 client id |
| `SNS_CLIENT_SECRET` |  | - | X OAuth 2.0 client secret（任意） |
| `SNS_REFRESH_TOKEN` |  | - | X OAuth 2.0 refresh token（任意、rotation 後は `DATA_DIR/sns-token-state.json` に永続化） |
| `SNS_API_KEY` |  | - | X OAuth 1.0a / consumer key（任意） |
| `SNS_API_SECRET` |  | - | X OAuth 1.0a / consumer secret（任意） |
| `SNS_ACCESS_TOKEN_SECRET` |  | - | X OAuth 1.0a access token secret（任意） |
| `DATA_DIR` |  | `./data` | memory / session / user / bot state ファイルの保存ディレクトリ |
| `TIMEZONE` |  | `Asia/Tokyo` | diary 日付の基準タイムゾーン |
| `MAX_STEPS` |  | `10` | ツールループの最大ステップ数 |
| `TOKEN_BUDGET` |  | `80000` | 要約トリガーのトークン予算 |
| `PORT` |  | `3000` | Webhook / healthcheck HTTP サーバーの待受ポート |
| `HEARTBEAT_INTERVAL_MINUTES` |  | `120` | Heartbeat scheduler の実行間隔（API コスト削減のため長めの既定値） |
| `MEMORY_MAINTENANCE_INTERVAL_MINUTES` |  | - | メモリメンテナンス専用ループの実行間隔（分）。設定時のみ有効 |
| `MEMORY_MAINTENANCE_RECENT_DIARY_DAYS` |  | `30` | メモリメンテナンスが diary 本文を読み込む日数。全 diary 日付一覧は常に参照しつつ、より古い本文も見せたい場合に広げる |
| `SNS_LOOP_MIN_INTERVAL_MINUTES` |  | `60` | SNS 専用ループの最短実行間隔（分） |
| `SNS_LOOP_MAX_INTERVAL_MINUTES` |  | `180` | SNS 専用ループの最長実行間隔（分）。`MIN` 以上である必要がある |
| `ALLOWED_CHANNEL_IDS` |  | - | `postMessage` で送信可能なチャンネル ID 一覧（`,` 区切り） |
| `REPORT_CHANNEL_ID` |  | - | Heartbeat / Cron / memory maintenance / SNS ループの実行レポートや各種診断通知向けの専用チャンネル ID。`allowedChannelIds` には含まれるが `postMessageChannelIds` には自動追加しない |
| `ADMIN_USER_IDS` |  | - | admin-only tool を使えるユーザー ID 一覧（`,` 区切り） |
| `KARAKURI_WORLD_BOT_IDS` |  | - | KW モード専用の bot ユーザー ID 一覧（`,` 区切り。`ADMIN_USER_IDS` とは独立） |
| `LLM_ENABLE_THINKING` |  | `true` | `false` / `0` / `no` なら OpenAI 互換 LLM 呼び出しで no-thinking fetch + provider options を使う。通常応答・要約・post-response evaluator に反映される。memory maintenance はこの設定に関係なく常に no-thinking |

## モデルセレクタ

`LLM_MODEL` / `POST_RESPONSE_LLM_MODEL` は API 面も含めた selector として扱う。

- `openai/<model>`: OpenAI Responses API を使う
- `openai/chat/<model>`: OpenAI Chat API を使う
- bare model 名（例: `gpt-4o`）も互換用に受け付け、内部では `openai/gpt-4o` として正規化する

`LLM_BASE_URL` / `POST_RESPONSE_LLM_BASE_URL` は canonical 化して保持する。具体的には:

- 空文字は未設定として扱う
- `http` / `https` 以外は拒否する
- credentials / query / fragment を含む URL は拒否する
- 末尾の `/` は削除してから SDK に渡す

## ポストレスポンス evaluator / memory maintenance のフォールバック

ポストレスポンス evaluator と memory maintenance runner は、それぞれ `src/agent/core.ts` / `src/index.ts` で以下の独立したフォールバックを行う。

- model selector: `postResponseLlmModelSelector ?? llmModelSelector`
- API key: `postResponseLlmApiKey ?? llmApiKey`
- base URL: `postResponseLlmBaseUrl ?? llmBaseUrl`

つまり:

- `POST_RESPONSE_LLM_MODEL` だけ設定 → 同じ provider/baseURL/API key のまま evaluator / memory maintenance だけ別モデルに切り替え
- `POST_RESPONSE_LLM_API_KEY` / `POST_RESPONSE_LLM_BASE_URL` だけ設定 → evaluator / memory maintenance 用 client を別資格情報 / 別 endpoint で生成し、モデルはメイン設定を継続利用
- 3 つ全て未設定 → evaluator / memory maintenance もメイン会話 LLM 設定をそのまま利用

## 設定オブジェクト

```typescript
type SnsProviderType = 'mastodon' | 'x';

type SnsCredentials =
  | { provider: 'mastodon'; instanceUrl: string; accessToken: string }
  | {
      provider: 'x';
      accessToken: string;
      clientId?: string | undefined;
      clientSecret?: string | undefined;
      refreshToken?: string | undefined;
      apiKey?: string | undefined;
      apiSecret?: string | undefined;
      accessTokenSecret?: string | undefined;
    };

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
  postResponseLlmApiKey?: string | undefined;
  postResponseLlmBaseUrl?: string | undefined;
  postResponseLlmModel?: string | undefined;
  postResponseLlmModelSelector?: {
    provider: 'openai';
    api: 'responses' | 'chat';
    modelId: string;
    selector: string;
  } | undefined;
  braveApiKey?: string | undefined;
  karakuriWorld?: {
    apiBaseUrl: string;
    apiKey: string;
  } | undefined;
  sns?: SnsCredentials | undefined;
  dataDir: string;
  timezone: string;
  maxSteps: number;
  tokenBudget: number;
  port: number;
  heartbeatIntervalMinutes?: number | undefined;
  memoryMaintenanceIntervalMinutes?: number | undefined;
  memoryMaintenanceRecentDiaryDays?: number | undefined;
  snsLoopMinIntervalMinutes: number;
  snsLoopMaxIntervalMinutes: number;
  postMessageChannelIds?: string[] | undefined;
  allowedChannelIds?: string[] | undefined;
  reportChannelId?: string | undefined;
  adminUserIds?: string[] | undefined;
  karakuriWorldBotIds?: string[] | undefined;
  llmEnableThinking: boolean;
}
```

`llmModel` / `postResponseLlmModel` は常に canonical な selector 文字列を保持する。
`postMessageChannelIds` は `ALLOWED_CHANNEL_IDS` 由来の「送信可能チャンネル」のみを保持し、
`allowedChannelIds` は `REPORT_CHANNEL_ID` をマージした bot 全体の許可チャンネル一覧を保持する。
`karakuriWorld` は `KARAKURI_WORLD_API_BASE_URL` と `KARAKURI_WORLD_API_KEY` が両方そろったときだけ含まれる。
`memoryMaintenanceIntervalMinutes` は `MEMORY_MAINTENANCE_INTERVAL_MINUTES` を空文字列なら `undefined` に正規化したうえで保持する。
`memoryMaintenanceRecentDiaryDays` は `MEMORY_MAINTENANCE_RECENT_DIARY_DAYS` を空文字列なら `undefined` に正規化したうえで保持し、未設定時は runner 側の既定値 30 日を使う。
`sns` は `SNS_PROVIDER` 設定時のみ検討される。`mastodon` では `SNS_INSTANCE_URL` + `SNS_ACCESS_TOKEN`、`x` では `SNS_ACCESS_TOKEN` が必須で、その他の X 認証情報は任意で含まれる。既存の Mastodon 環境も `SNS_PROVIDER=mastodon` を追加しない限り SNS は無効として扱われる。
`llmEnableThinking` は `LLM_ENABLE_THINKING` を boolean に正規化した値で、`false` のときは通常応答・要約・post-response evaluator が no-thinking 設定を使う。memory maintenance は別途常時 no-thinking で実行される。

## `loadConfig()` の動作

```typescript
function loadConfig(): Config {
  // dotenv で .env を読み込む
  // 必須項目が未設定の場合は起動時に Error をスロー
  // 任意項目はデフォルト値を使用
  // LLM selector を parse して canonical 形式へ正規化する
  // post-response evaluator 用 selector / endpoint も同様に解決する
  // KARAKURI_WORLD_* は 2 変数の部分設定を fail-fast で拒否する
  // SNS_LOOP_MIN_INTERVAL_MINUTES <= SNS_LOOP_MAX_INTERVAL_MINUTES を検証する
  // MEMORY_MAINTENANCE_INTERVAL_MINUTES は空文字列を undefined に正規化して optional number として扱う
  // MEMORY_MAINTENANCE_RECENT_DIARY_DAYS は空文字列を undefined に正規化して optional number として扱う
  // SNS_* は SNS_PROVIDER がある場合だけ provider ごとの必須項目を検証する
  // LLM_ENABLE_THINKING は true/false/1/0/yes/no を受け付け、通常応答・要約・post-response evaluator に反映する
}
```

## セキュリティ

- `.env` は `.gitignore` に含め、リポジトリにコミットしない
- `DISCORD_BOT_TOKEN` / `LLM_API_KEY` などのシークレットをログに出力しない
- `SNS_INSTANCE_URL` は `SNS_PROVIDER=mastodon` のときだけ `LLM_BASE_URL` と同様に `http` / `https` のみ許可し、credentials / query / fragment を含む URL を拒否する

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
