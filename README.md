# Karakuri-Agent

OpenClaw 風の AI エージェント。Vercel AI SDK + Chat SDK + OpenAI 互換 LLM + Discord で構築する。

## 特徴

- life.db（experience_log / episodes / beliefs / narratives / relations）による生きたエージェントの記憶（appraisal・省察・想起）
- SQLite によるユーザー ID・表示名・alias 台帳（人物知識は beliefs / relations 側に蓄積）
- `data/AGENT.md` / `data/RULES.md` / `data/skills/*/SKILL.md` / `data/system-skills/*/SKILL.md` による Markdown-first の prompt / skill 拡張
- trusted prompt context / skills は `fs.watch()` で eager reload
- `webFetch` / `webSearch` による Web 情報取得（Readability + Brave Search API）
- `KARAKURI_WORLD_BOT_IDS` に一致する Discord ユーザー向けの karakuri-world 専用 KW モード（Discord の `notification_id` から自動で `get_notification` し、取得した `notification.choices[]` から `karakuri_world_command` を1回だけ実行。`comment` のキャラ口調の判断コメントを返信に使用）
- provider namespaced な `sns_<provider>_<action>` ツールによる Mastodon / X / ELYTH 向け SNS 投稿・取得・通知確認・メディアアップロード（skill-gated。例: `sns_mastodon_post`, `sns_x_like`, `sns_elyth_get_thread`）。SNS 活動は KW カスタムコマンド（M8: check_phone / browse_sns / post_sns）の世界内行為として実行され、provider ごとにビルトイン SNS スキル（`sns-mastodon` / `sns-x` / `sns-elyth`）を自動ロードして投稿や通知対応を行う。X / ELYTH は `public` 投稿のみ対応、ELYTH は repost / quote / メディアアップロード非対応）
- `data/HEARTBEAT.md` と `data/cron/*/CRON.md` による Heartbeat / Cron 実行
- `postMessage` / `manageCron` ツールによる管理者限定のプロアクティブ投稿と Cron 管理
- `REPORT_CHANNEL_ID` への Heartbeat / Cron / 省察の実行結果、Cron 登録変更、チャット処理エラー詳細、SNS context のカーソル保存まわり警告の通知
- Discord メッセージに処理状態を表すリアクション絵文字を表示（完了は 2 秒後に除去、エラーは保持）
- 各層をインターフェースで抽象化し、実装の差し替えが容易
- v1 はテキストメッセージのみ対応

## セットアップ

1. `cp .env.example .env`
2. `.env` に Discord / LLM の設定を入力（`LLM_BASE_URL` は OpenAI 互換 API を使うときのみ設定。`http` / `https` のみ受け付け、末尾の `/` は正規化される。`BRAVE_API_KEY` を設定すると `webSearch` も有効化。未設定でも `webFetch` は利用可能。`KARAKURI_WORLD_API_BASE_URL` と `KARAKURI_WORLD_API_KEY` を両方設定すると、`KARAKURI_WORLD_BOT_IDS` に一致する Discord ユーザーは karakuri-world 専用 KW モードで動作する。Base URL は最新の karakuri-world と同じ `https://.../api` 形式を正とし、`/api` なしの値は起動時に補完される。Discord 通知本文の `notification_id` から保存済み通知を自動取得し、LLM には汎用 `karakuri_world_command` だけを公開する。`comment` フィールドのキャラ口調の判断コメントが Discord 返信として使われる。`get_notification` が失敗した通知（ログアウト通知など）は LLM に渡さずログだけ残してスキップする。SNS は provider ごとの環境変数で同時有効化される。Mastodon は `MASTODON_INSTANCE_URL` / `MASTODON_ACCESS_TOKEN`、X は `X_ACCESS_TOKEN`（必要なら `X_CLIENT_ID` / `X_CLIENT_SECRET` / `X_REFRESH_TOKEN` または `X_API_KEY` / `X_API_SECRET` / `X_ACCESS_TOKEN_SECRET`）、ELYTH は `ELYTH_API_KEY` / `ELYTH_API_BASE`（例: `https://elythworld.com`）を両方設定する。system ユーザー向けには provider 別のビルトイン SNS スキル（`sns-mastodon` / `sns-x` / `sns-elyth`）が追加され、cron では `loadSkill("sns-mastodon")` のように provider 名付き skill を使う。SNS の自動実行は KW カスタムコマンド（`KW_COMMAND_CHECK_PHONE` / `KW_COMMAND_BROWSE_SNS` / `KW_COMMAND_POST_SNS` で command 名をマッピング）の世界内行為として行われ、provider ごとに動的コンテキストと `sns_<provider>_<action>` ツールが自動ロードされる。書き込み頻度は `SNS_RATE_LIMIT_*`（+ provider 別 `X_RATE_LIMIT_*` 等）の決定論レート制限で管理する。`data/system-skills/sns-*/SKILL.md` は不要で、同名の system skill が存在しても system ユーザー文脈ではビルトイン定義が優先される。対話ユーザーにも公開したい場合は、運用側で `data/skills/*/SKILL.md` に shared skill を追加する。役割別モデルは `LLM_APPRAISAL_*` / `LLM_REFLECTION_*` で分離できる）
   - 旧 `SNS_PROVIDER` / `SNS_*` credentials は読み込まれない。既存の Mastodon 運用は `MASTODON_INSTANCE_URL` + `MASTODON_ACCESS_TOKEN` へ移行する。旧 `data/sns-activity.db` がある場合は初回起動前に `SNS_LEGACY_DB_MIGRATE_TO=mastodon|x|elyth|skip` を一度だけ指定する
   - X で `X_REFRESH_TOKEN` を使う場合、OAuth 2.0 の refresh-token rotation 後の状態は `DATA_DIR/sns-token-state.json` に保存される。再起動後も継続利用するには `DATA_DIR` を永続化する
   - `LLM_MODEL` は `openai/gpt-4o` のような OpenAI Responses API セレクタ、または `openai/chat/gpt-4o` のような OpenAI Chat API セレクタで指定する
   - 旧形式の bare model 名（例: `gpt-4o`）も互換用に受け付けるが、内部では `openai/gpt-4o` として扱う
   - `LLM_API_KEY` 未設定時のエラーでは legacy alias の `OPENAI_API_KEY` も案内する
   - Heartbeat / Cron を使う場合は `ALLOWED_CHANNEL_IDS` と `ADMIN_USER_IDS` を設定し、必要に応じて `REPORT_CHANNEL_ID` / `HEARTBEAT_INTERVAL_MINUTES` も指定（デフォルトは 120 分）
   - `LLM_ENABLE_THINKING=false` にすると、通常応答・要約が no-thinking 設定を使う。appraisal / 省察は設計上常に no-thinking で実行される。OpenAI 互換サーバー固有の `enable_thinking=false` を送る必要がある場合だけ `LLM_DISABLE_THINKING_REQUEST_PARAM=true` を設定する
3. `cp -r data.example data`
4. `npm install`
5. `npm run dev`

`data.example/` にはサンプルの `AGENT.md`・`RULES.md`・スキル定義に加えて、`HEARTBEAT.md` と `cron/daily-summary/CRON.md` も含まれている。
`data/` はユーザーごとにカスタマイズするため `.gitignore` で除外されている。
既存環境では、ローカルの `data/HEARTBEAT.md` も手動で見直す。以前の SNS 活動手順や legacy `loadSkill("sns")` 前提の記述が残っている場合は削除し、heartbeat には本来の監視・報告だけを残す（SNS 活動は M8 の世界内行為として実行される）。
同様に KW モード移行後は、ローカルの `data/skills/karakuri-world/SKILL.md` と `data/system-skills/karakuri-world/SKILL.md` を削除する。これらの legacy ファイルは通常モードでは無視されるが、今後の運用混乱を避けるためにも手動で消しておく。

### 既存 `data/` ディレクトリの移行チェックリスト

旧バージョンから `data/` を引き継ぐ場合、新バージョンで追加されたファイルは自動生成されない（欠落は起動ログと初回 report 通知で知らせる）。`diff -rq data.example/ data/` で差分を確認し、以下を検討する:

- `data/traits.json` — 気質（resilience / socialBaseline / curiosity）。無ければ全係数 1 のデフォルトで稼働する。人格定義（`data/AGENT.md`）と整合させる
- `data/seed-memories.json` — 立ち上げ時の seed 記憶（beliefs / narratives）。無ければ自己認識の白紙から人生が始まる。後から置いても、まだ未取り込みなら次回起動時に一度だけ取り込まれる
- `data/HEARTBEAT.md` — 無ければ heartbeat 自体が無効（`ALLOWED_CHANNEL_IDS` 等の設定だけでは動かない）
- `.env` の廃止変数 — `SNS_PROVIDER` / `SNS_LOOP_MIN_INTERVAL_MINUTES` / `SNS_LOOP_MAX_INTERVAL_MINUTES` は効果がない（起動時に警告が出る）。削除する

Discord Developer Portal では `DISCORD_PUBLIC_KEY` / `DISCORD_APPLICATION_ID` を取得し、
Interactions Endpoint を `POST /webhooks/discord` に向ける。通常メッセージ受信には
Gateway 接続も必要なため、`npm run dev` / `npm run start` は HTTP サーバーと
Discord Gateway listener を同時に起動する。
Gateway listener にはローカルの `/webhooks/discord` URL を渡し、Discord bot メッセージも webhook forwarding 経由で受信する。

## スクリプト

- `npm run dev` - 開発起動
- `npm run start` - 本番起動
- `npm run typecheck` - TypeScript 型検査
- `npm test` - unit test 実行
- `npm run docker:build` - Docker イメージビルド
- `npm run docker:up` - Docker Compose で本番起動
- `npm run docker:dev` - Docker Compose で開発モード起動（フォアグラウンド）
- `npm run docker:dev:up` - Docker Compose で開発モード起動（バックグラウンド）
- `npm run docker:down` - Docker Compose 停止

## Docker Compose

### 本番相当の起動

1. `cp .env.example .env`
2. `.env` を設定
   - Discord / LLM 系の値を入力する
   - Docker Compose 用の `UID` / `GID` には **数値** を入れる（`.env` は `$(id -u)` のような command substitution を展開しない）
   - Linux / macOS / WSL では `id -u` / `id -g` の出力結果をそのまま `UID` / `GID` に書く
   - Docker Desktop on Windows など bind mount の所有者差分を気にしなくてよい環境では `UID=1000` / `GID=1000` のような固定値でも運用できる
   - 例:

     ```bash
     printf 'UID=%s\nGID=%s\n' "$(id -u)" "$(id -g)"
     ```
3. `cp -r data.example data`
4. `npm run docker:build`
5. `npm run docker:up`

- アプリは `http://localhost:${PORT:-3000}` で待ち受ける。`GET /healthz` は Discord Gateway listener が 5 秒以上生存したかを基準に接続状態を判定し、初回接続前・listener の起動失敗/早期終了・shutdown 時は `503` を返す。初回接続後は通常の listener 切り替え中も healthy を維持する
- 永続データは `./data` を `/app/data` に bind mount して保持する
- Compose は container 内の `DATA_DIR` を `/app/data` に固定している。ホスト側の保存先を変えたい場合は `.env` の `DATA_DIR` ではなく `docker-compose.yml` の volume 側を編集する
- `docker-compose.yml` の `user:` は `.env` の `UID` / `GID` を必須にしており、未設定のまま `1000:1000` にフォールバックしてホスト側の `data/` を書けなくなる事故を防いでいる
- 停止は `npm run docker:down`。Compose 側の `stop_grace_period: 15s` により、アプリの graceful shutdown に余裕を持たせている

### 開発モード

`tsx watch` をコンテナ内で使う場合は、オーバーライドを重ねて起動する。

```bash
npm run docker:dev
```

- `docker-compose.dev.yml` は `deps` ステージを使い、devDependencies を含む状態で起動する
- `docker-compose.dev.yml` では `src/` と `tsconfig.json` だけを bind mount し、イメージ内の `/app/node_modules` はそのまま使うため、`tsx` などの devDependencies が bind mount で隠れない
- 起動コマンドは `npx` ではなく `/app/node_modules/.bin/tsx` を直接実行する
- 開発コンテナでは `HOME` / npm cache を `/tmp/karakuri-agent` に寄せているため、Compose 側でホストの任意 UID / GID に合わせて実行しても npm cache が `/.npm` に落ちず権限エラーを踏みにくい
- 依存を更新した後は `npm run docker:dev` でイメージを作り直す

## 実装メモ

- `data/AGENT.md` はエージェント人格、`data/RULES.md` は trusted な行動ルール、`data/skills/*/SKILL.md` は全ユーザー向けスキル、`data/system-skills/*/SKILL.md` は `userId === 'system'`（Cron / Heartbeat）でのみ見える system 専用スキル定義
- `data/HEARTBEAT.md` があると定期 Heartbeat を実行し、Heartbeat は単発の ephemeral session で走る。SNS 活動は KW カスタムコマンド（M8）の世界内行為として実行される。`data/cron/*/CRON.md` で Cron ジョブも定義できる
- 記憶は life.db（experience_log / episodes / beliefs / narratives / relations）に蓄積され、appraisal（M2）→ エピソード記銘・想起（M3）→ 省察（M4: 日次で日記・信念更新、週次・月次で自伝的階層）が「世界内の行為」として動く。旧コアメモリ / diary.db / メモリメンテナンスは削除済み（`MEMORY_MAINTENANCE_*` / `POST_RESPONSE_*` env は設定しても起動時警告のみ）
- 既存環境の `data/HEARTBEAT.md` は `.gitignore` されて自動更新されないため、旧来の SNS 指示や legacy `loadSkill("sns")` が残っていないか確認する。SNS 活動の正本は世界内行為（PhoneService）側のコード内指示
- 1 つ以上のスキルが存在するときだけ `loadSkill` ツールが公開され、システムプロンプトには利用可能なスキル一覧だけを注入する
- 通常ユーザーには `data/skills/*/SKILL.md` のみ公開され、`data/system-skills/*/SKILL.md` は `userId === 'system'` のときだけ一覧表示・`loadSkill` 対象になる
- `allowed-tools` を持つスキルは `loadSkill` 後に対応ツールを動的登録する。`karakuri-world` は `allowed-tools` の有無に関係なく通常の skill discovery / `loadSkill` から常に除外され、`karakuri_world_command` は `KARAKURI_WORLD_*` 設定済みかつ `KARAKURI_WORLD_BOT_IDS` に一致する Discord ユーザーの KW モードでのみ直接公開し、事前に自動取得した `notification.choices[]` 以外の command は実行させない
- `MASTODON_*` / `X_*` / `ELYTH_*` のうち必要項目がそろった provider ごとに、system ユーザー向けビルトイン SNS skill（`sns-mastodon` / `sns-x` / `sns-elyth`）が追加される。cron では `loadSkill("sns-mastodon")` などで provider namespaced skill をロードし、`sns_mastodon_post` / `sns_x_like` / `sns_elyth_get_thread` のような `sns_<provider>_<action>` ツール群を遅延公開する。世界内行為（M8）の SNS 処理だけが `autoLoadSnsSkill` と動的コンテキストを使って provider ごとに自動実行する。動的コンテキストには新着通知・トレンド・直近行動ログが含まれ、重複いいね/リポスト/返信/引用と書き込みレート制限（`SNS_RATE_LIMIT_*`）をツール層で防ぐ。実行の成功/失敗は `REPORT_CHANNEL_ID` に通知され、追加の活動レポート本文を `postMessage` で同じチャンネルへ送らせたい場合だけ `REPORT_CHANNEL_ID` を `postMessage` の送信許可チャンネルにも含める。X / ELYTH は `*_post` の公開範囲が `public` のみ。ELYTH は repost / quote / メディアアップロード非対応のため、`sns_elyth_repost` / `sns_elyth_upload_media` ツールは公開されず、引用も Zod スキーマで拒否される。対話ユーザーに公開する場合は運用側で shared skill を定義する
- `webFetch` は常に有効。URL を取得し Readability + Turndown で Markdown 化して返す
- `webFetch` は各 redirect hop を再検証し、`http` / `https` 以外のスキームや private / loopback / link-local 宛てへの遷移を拒否して SSRF を抑止する。15 秒のタイムアウトは DNS 解決も含めて適用する
- `sns_mastodon_upload_media` / `sns_x_upload_media` も `webFetch` と同じ URL 検証を使い、`http` / `https` 以外のスキームや private / loopback / link-local 宛て、そこへ向かう redirect を拒否する。こちらも DNS 解決を含めてタイムアウトを適用する
- Mastodon のメディア処理が非同期な場合、`sns_mastodon_upload_media` は `GET /api/v1/media/:id` を短時間ポーリングして ready を確認する。X では chunked upload (`initializeUpload` / `appendUpload` / `finalizeUpload`) の完了を待つ。制限時間内に ready にならない場合はエラーとして再試行を促す
- `webSearch` は `BRAVE_API_KEY` 設定時のみ有効。Brave Search API で Web 検索を行う
- `postMessage` / `manageCron` は `ALLOWED_CHANNEL_IDS` と `ADMIN_USER_IDS` が設定された管理者コンテキストでのみ公開される
- Heartbeat は `ALLOWED_CHANNEL_IDS` 設定時のみ有効化され、`REPORT_CHANNEL_ID` は空欄のままでも省略設定として扱われる
- `REPORT_CHANNEL_ID` を設定すると Heartbeat / Cron / 省察の実行成否、`manageCron` による登録/解除、チャット処理エラー詳細、SNS context のカーソル予約/保存失敗警告を自動投稿する（エージェント応答本文は自動投稿しない）
- Chat SDK の state は `DATA_DIR/state/chat-state.json` に保存するカスタム JSON アダプターを使用
- Session は `data/` 配下にファイル保存し、記憶は `DATA_DIR/life.db` に保存する
- ユーザー ID・表示名・alias は `DATA_DIR/users.db` の台帳に保存され、`userLookup` ツールと `<user-profile>` コンテキストは beliefs(person_fact) / relations から人物知識を構築する
- 元メッセージへのリアクションで `queued` / `thinking` / tool 実行中 / `done` / `error` を表示し、`done` は 2 秒後に自動除去する
- 添付ファイルは未対応。添付付きメッセージはテキスト部分のみ処理し、注意メッセージを返す

## ドキュメント

- [高レベル設計](docs/design/README.md)
- [Session 層 詳細設計](docs/design/session.md)
- [Agent 層 詳細設計](docs/design/agent.md)
- [Skill 層 詳細設計](docs/design/skill.md)
- [Bot 層 詳細設計](docs/design/bot.md)
- [設定 詳細設計](docs/design/config.md)

## Multi SNS providers and user aliases

SNS configuration is provider-specific. Set any combination of `MASTODON_INSTANCE_URL` + `MASTODON_ACCESS_TOKEN`, `X_ACCESS_TOKEN` (+ optional X OAuth fields), and `ELYTH_API_KEY` + `ELYTH_API_BASE` (for example `https://elythworld.com`); all fully configured providers run concurrently. SNS tools are provider-namespaced, e.g. `sns_mastodon_post`, `sns_x_like`, `sns_elyth_get_thread`, and skills are named `sns-mastodon`, `sns-x`, `sns-elyth`.

Legacy `SNS_PROVIDER` / `SNS_*` credentials are no longer read. If `data/sns-activity.db` exists, set `SNS_LEGACY_DB_MIGRATE_TO=mastodon|x|elyth|skip` once before startup.

Admins can link observed accounts that represent the same person by asking the bot to use `linkUser` (for example, link `sns:mastodon:1234` to `discord:abcd`). Prefer `discord:` IDs as primary. Use `unlinkUser` then `linkUser` to correct a link.
