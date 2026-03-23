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
