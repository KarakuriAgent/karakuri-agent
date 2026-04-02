# Karakuri-Agent

OpenClaw 風の AI エージェント。Vercel AI SDK + Chat SDK + OpenAI 互換 LLM + Discord で構築する。

## 特徴

- ファイルベースのコアメモリ・セッション管理（write-through キャッシュ付き）
- SQLite による日記永続化と直近範囲検索
- SQLite によるユーザー情報・プロフィール永続化と応答後の自動評価更新
- `data/AGENT.md` / `data/RULES.md` / `data/skills/*/SKILL.md` / `data/system-skills/*/SKILL.md` による Markdown-first の prompt / skill 拡張
- trusted prompt context / skills は `fs.watch()` で eager reload、memory は write-through + watcher で外部変更に追随
- `webFetch` / `webSearch` による Web 情報取得（Readability + Brave Search API）
- `KARAKURI_WORLD_BOT_IDS` に一致する Discord ユーザー向けの karakuri-world 専用 KW モード（`karakuri_world_*` のみ登録、1通知=1アクション、`comment` を返信に使用）
- `sns_*` ツールによる Mastodon / X 向け SNS 投稿・取得・通知確認・メディアアップロード（`scheduled_at` による遅延実行対応、skill-gated、system heartbeat ではビルトインスキルを自動ロード。X は `public` 投稿のみ対応で、再起動をまたぐ scheduled like / repost の crash recovery は完全保証しない）
- `data/HEARTBEAT.md` と `data/cron/*/CRON.md` による Heartbeat / Cron 実行
- `postMessage` / `manageCron` ツールによる管理者限定のプロアクティブ投稿と Cron 管理
- `REPORT_CHANNEL_ID` への Heartbeat / Cron 実行結果、Cron 登録変更、チャット処理エラー詳細の通知
- Discord メッセージに処理状態を表すリアクション絵文字を表示（完了は 2 秒後に除去、エラーは保持）
- 各層をインターフェースで抽象化し、実装の差し替えが容易
- v1 はテキストメッセージのみ対応

## セットアップ

1. `cp .env.example .env`
2. `.env` に Discord / LLM の設定を入力（`LLM_BASE_URL` は OpenAI 互換 API を使うときのみ設定。`http` / `https` のみ受け付け、末尾の `/` は正規化される。`BRAVE_API_KEY` を設定すると `webSearch` も有効化。未設定でも `webFetch` は利用可能。`KARAKURI_WORLD_API_BASE_URL` と `KARAKURI_WORLD_API_KEY` を両方設定すると、`KARAKURI_WORLD_BOT_IDS` に一致する Discord ユーザーは karakuri-world 専用 KW モードで動作し、`karakuri_world_*` ツールだけが直接登録される。`comment` フィールドの内容が Discord 返信として使われる。`SNS_PROVIDER=mastodon` では `SNS_INSTANCE_URL` / `SNS_ACCESS_TOKEN`、`SNS_PROVIDER=x` では `SNS_ACCESS_TOKEN`（必要なら `SNS_CLIENT_ID` / `SNS_CLIENT_SECRET` / `SNS_REFRESH_TOKEN` または `SNS_API_KEY` / `SNS_API_SECRET` / `SNS_ACCESS_TOKEN_SECRET`）を設定すると、system ユーザー向けにビルトイン SNS スキルが利用可能になり、heartbeat では動的コンテキストと `sns_*` ツールが自動ロードされる。cron では通常どおり `loadSkill("sns")` を使う。`data/system-skills/sns/SKILL.md` は不要で、存在してもすべての system ユーザー文脈ではビルトイン定義が優先される。対話ユーザーにも公開したい場合は、運用側で `data/skills/*/SKILL.md` に shared skill を追加する。必要なら `POST_RESPONSE_LLM_MODEL` / `POST_RESPONSE_LLM_API_KEY` / `POST_RESPONSE_LLM_BASE_URL` で応答後評価専用モデルを分離できる）
   - 既存の Mastodon 運用を更新する場合も `SNS_PROVIDER=mastodon` の追加が必須。以前の `SNS_INSTANCE_URL` + `SNS_ACCESS_TOKEN` だけの設定は、そのままだと SNS 機能が無効扱いになる
   - X で `SNS_REFRESH_TOKEN` を使う場合、OAuth 2.0 の refresh-token rotation 後の状態は `DATA_DIR/sns-token-state.json` に保存される。再起動後も継続利用するには `DATA_DIR` を永続化する
   - `LLM_MODEL` は `openai/gpt-4o` のような OpenAI Responses API セレクタ、または `openai/chat/gpt-4o` のような OpenAI Chat API セレクタで指定する
   - 旧形式の bare model 名（例: `gpt-4o`）も互換用に受け付けるが、内部では `openai/gpt-4o` として扱う
   - `LLM_API_KEY` 未設定時のエラーでは legacy alias の `OPENAI_API_KEY` も案内する
   - Heartbeat / Cron を使う場合は `ALLOWED_CHANNEL_IDS` と `ADMIN_USER_IDS` を設定し、必要に応じて `REPORT_CHANNEL_ID` / `HEARTBEAT_INTERVAL_MINUTES` も指定（デフォルトは 120 分）
3. `cp -r data.example data`
4. `npm install`
5. `npm run dev`

`data.example/` にはサンプルの `AGENT.md`・`RULES.md`・スキル定義に加えて、`HEARTBEAT.md` と `cron/daily-summary/CRON.md` も含まれている。
`data/` はユーザーごとにカスタマイズするため `.gitignore` で除外されている。
SNS 自動ロード対応へ更新する既存環境では、ローカルの `data/HEARTBEAT.md` も手動で見直す。以前の `loadSkill("sns")` / SNS 活動手順 / `data/system-skills/sns/SKILL.md` 前提の記述が残っている場合は削除し、必要なら `data.example/HEARTBEAT.md` をベースにチェック項目だけを残す。
同様に KW モード移行後は、ローカルの `data/skills/karakuri-world/SKILL.md` と `data/system-skills/karakuri-world/SKILL.md` を削除する。これらの legacy ファイルは通常モードでは無視されるが、今後の運用混乱を避けるためにも手動で消しておく。

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
- `data/HEARTBEAT.md` があると定期 Heartbeat を実行し、Heartbeat は単発の ephemeral session で走る。SNS が設定されている system heartbeat では、ビルトイン SNS スキルの動的コンテキストと `sns_*` ツールが自動ロードされる。`data/cron/*/CRON.md` で Cron ジョブも定義できる
- 既存環境の `data/HEARTBEAT.md` は `.gitignore` されて自動更新されないため、SNS 自動ロード導入前の `loadSkill("sns")` や手動 SNS 指示が残っていないか確認する。heartbeat 側の SNS 指示はコード内ビルトインが正本
- 1 つ以上のスキルが存在するときだけ `loadSkill` ツールが公開され、システムプロンプトには利用可能なスキル一覧だけを注入する
- 通常ユーザーには `data/skills/*/SKILL.md` のみ公開され、`data/system-skills/*/SKILL.md` は `userId === 'system'` のときだけ一覧表示・`loadSkill` 対象になる
- `allowed-tools` を持つスキルは `loadSkill` 後に対応ツールを動的登録する。`karakuri-world` は `allowed-tools` の有無に関係なく通常の skill discovery / `loadSkill` から常に除外され、`karakuri_world_*` は `KARAKURI_WORLD_*` 設定済みかつ `KARAKURI_WORLD_BOT_IDS` に一致する Discord ユーザーの KW モードでのみ直接公開する
- `SNS_*` 設定時は system ユーザー向けにビルトイン SNS skill が追加される。Mastodon と X は `SNS_PROVIDER` で切り替える。cron では `loadSkill("sns")` で `sns_*` ツール群を遅延公開し、heartbeat では同じスキルが自動ロードされる。`data/system-skills/sns/SKILL.md` は不要で、存在してもすべての system ユーザー文脈ではビルトイン定義が優先される。動的コンテキストには新着通知・トレンド・直近行動ログ・スケジュール済みアクションが含まれ、重複いいね/リポスト/返信/引用をツール層で防ぐ。heartbeat の活動レポートは `REPORT_CHANNEL_ID` が `postMessage` の送信許可チャンネルにも含まれる構成でのみ案内される。`sns_post` / `sns_like` / `sns_repost` は `scheduled_at` に未来のタイムゾーン付き日時（例: `Z`, `+09:00`）を指定すると SQLite キューへ登録され、専用ランナーが指定時刻に直接 API 実行する。X は `sns_post` の公開範囲が `public` のみで、再起動をまたぐ scheduled like / repost の crash recovery は API 制約により完全保証されない。対話ユーザーに公開する場合は運用側で shared skill を定義する
- `webFetch` は常に有効。URL を取得し Readability + Turndown で Markdown 化して返す
- `webFetch` は各 redirect hop を再検証し、`http` / `https` 以外のスキームや private / loopback / link-local 宛てへの遷移を拒否して SSRF を抑止する。15 秒のタイムアウトは DNS 解決も含めて適用する
- `sns_upload_media` も `webFetch` と同じ URL 検証を使い、`http` / `https` 以外のスキームや private / loopback / link-local 宛て、そこへ向かう redirect を拒否する。こちらも DNS 解決を含めてタイムアウトを適用する
- Mastodon のメディア処理が非同期な場合、`sns_upload_media` は `GET /api/v1/media/:id` を短時間ポーリングして ready を確認する。X では chunked upload (`initializeUpload` / `appendUpload` / `finalizeUpload`) の完了を待つ。制限時間内に ready にならない場合はエラーとして再試行を促す
- `webSearch` は `BRAVE_API_KEY` 設定時のみ有効。Brave Search API で Web 検索を行う
- `postMessage` / `manageCron` は `ALLOWED_CHANNEL_IDS` と `ADMIN_USER_IDS` が設定された管理者コンテキストでのみ公開される
- Heartbeat は `ALLOWED_CHANNEL_IDS` 設定時のみ有効化され、`REPORT_CHANNEL_ID` は空欄のままでも省略設定として扱われる
- `REPORT_CHANNEL_ID` を設定すると Heartbeat / Cron の実行成否、`manageCron` による登録/解除、チャット処理エラー詳細を自動投稿する（エージェント応答本文は自動投稿しない）
- Chat SDK の state は `DATA_DIR/state/chat-state.json` に保存するカスタム JSON アダプターを使用
- コアメモリ / Session は `data/` 配下にファイル保存し、日記は `DATA_DIR/diary.db` に保存する
- 初回起動時は旧 `DATA_DIR/memory/diary/*.md` を検出すると `diary.db` へ一度だけ自動インポートする
- ユーザー情報は `DATA_DIR/users.db` に保存され、`userLookup` ツールと `<user-profile>` コンテキストに利用される
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
