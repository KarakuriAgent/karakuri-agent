# AGENT.md

このファイルはリポジトリで作業する際のガイドラインを AI コーディングアシスタントに提供します。

## プロジェクト概要

Discord を主導線にした TypeScript 製の AI エージェント。Vercel AI SDK + Chat SDK + OpenAI 互換 LLM で応答を生成し、ファイルベースのコアメモリ / セッション管理、SQLite による日記・ユーザー・SNS 活動の永続化、Heartbeat / Cron / メモリメンテナンスによる system turn 実行、Mastodon / X / ELYTH 連携、Karakuri World 専用モードを備える。

## コマンド

- `npm run dev` — 開発起動（`LOG_LEVEL=debug tsx watch src/index.ts`）
- `npm run start` — 本番相当で起動（`tsx src/index.ts`）
- `npm test` — Vitest を一括実行（`vitest run`）
- `npm run typecheck` — TypeScript 型検査（`tsc --noEmit`）
- `npx vitest run tests/<file>.test.ts` — 単一テストファイル実行
- `npx vitest run -t "テスト名"` — テスト名でフィルタ実行
- `npm run docker:build` — Docker イメージをビルド
- `npm run docker:up` — Docker Compose をバックグラウンド起動
- `npm run docker:dev` — 開発用 Compose をフォアグラウンド起動
- `npm run docker:dev:up` — 開発用 Compose をバックグラウンド起動
- `npm run docker:down` — Compose を停止

補足:
- Node.js 20 以上が前提（`package.json#engines`）。
- ローカルの `npm run build` は存在しない。配布用ビルドは Dockerfile 内で `tsc -p tsconfig.build.json` を使って `dist/` を生成する。

## TypeScript 設定

- ES2022 / NodeNext / strict モード
- ESM（`"type": "module"`）— import パスに `.js` 拡張子が必要
- `noImplicitOverride: true`
- `noUncheckedIndexedAccess: true` — インデックスアクセスは `T | undefined`
- `exactOptionalPropertyTypes: true` — optional property に `undefined` を明示代入不可
- `resolveJsonModule: true`
- `isolatedModules: true`
- `verbatimModuleSyntax: true` — type-only import を明示する
- `tsconfig.json` は `src/**/*.ts`・`tests/**/*.ts`・`vitest.config.ts` を含む
- `tsconfig.build.json` は `src/**/*.ts` のみを対象にし、テストを除外して `dist/` を出力する

## テスト

- Vitest / `node` environment
- テストは `tests/**/*.test.ts` に配置
- カバレッジ収集はデフォルト無効
- テストファイル名は概ねソースのモジュール構造に対応（例: `agent.core.test.ts`, `session.manager.test.ts`）

## アーキテクチャ

### レイヤー構成（`src/` 配下）

```text
src/index.ts                  — 設定ロード → 各ストア/ランナー初期化 → Bot/Scheduler 起動 → HTTP/healthz 提供 → graceful shutdown
src/bot.ts                    — Chat SDK + Discord adapter 統合、Webhook/Gateway 受付、スレッド単位の排他制御、応答投稿
src/agent/core.ts             — generateText による応答生成、セッション要約判定、ツール構築、system/user turn 制御
src/agent/prompt.ts           — システムプロンプト構築、AGENT.md / RULES.md 読み込み
src/agent/prompt-context.ts   — trusted / untrusted 文脈の分離などプロンプト用コンテキスト構築
src/agent/tools/              — builtin ツール群（recallDiary, webFetch, webSearch, userLookup, loadSkill, postMessage, manageCron, sns_<provider>_*, karakuri_world_command）
src/session/                  — JSON ファイルベースのセッション保存。ハッシュ化ファイル名 + メモリキャッシュを使用
src/memory/                   — FileMemoryStore（core memory）+ SqliteDiaryStore（日記）+ CompositeMemoryStore + maintenance runner
src/life/                     — 生きたエージェントの記憶基盤（life.db マイグレーション、experience_log 追記専用ストア、イベント正規化、ExperienceRecorder、Perception Buffer、Loop Detector、action_ledger、sqlite-vec / FTS5 検証）
src/skill/                    — `data/skills/` と `data/system-skills/` を監視する frontmatter 付き SKILL.md ストア
src/scheduler/                — HEARTBEAT.md 読み込み、CRON.md frontmatter 解釈、Heartbeat/Cron 実行、scheduler store
src/sns/                      — Mastodon / X / ELYTH provider、provider 別 SQLite 活動ログ、SNS skill dynamic context、provider 別 SNS 専用ループ、レガシー DB 移行
src/user/                     — SqliteUserStore と PostResponseEvaluator によるユーザープロファイル永続化・更新
src/state/                    — Chat SDK の state adapter を `data/state/chat-state.json` に永続化
src/status-reaction.ts        — Discord 上の進行状態リアクション制御
src/karakuri-world/           — Karakuri World 専用のビルトイン指示
src/llm/                      — OpenAI 互換 API / Chat Completions 切り替え、no-thinking fetch 調整
src/shutdown.ts               — サーバー、scheduler、bot、各種ストアを段階的に停止する graceful shutdown 補助
src/config.ts                 — Zod ベースの環境変数バリデーションと runtime config 構築
```

### 主要な設計パターン

- **インターフェース抽象化**: Agent / MemoryStore / SessionManager / SkillStore / SnsProvider など主要コンポーネントは interface 越しに扱う。
- **ファイル監視ベースの runtime reload**: `AGENT.md`、`RULES.md`、スキル、scheduler 定義は `fs.watch` ベースの watcher で外部変更へ追随する。
- **Markdown + frontmatter の使い分け**:
  - `AGENT.md` / `RULES.md` / `HEARTBEAT.md` は生の Markdown / text をそのまま読む。
  - `SKILL.md` と `CRON.md` は frontmatter 必須。
- **Skill-gated ツール**: 一部ツールはスキル経由でのみ解放される。SNS 系ツールは provider 別 skill（`sns-mastodon` / `sns-x` / `sns-elyth`）を `loadSkill` するか、runtime が provider ごとに auto-load したスキルを通じて公開される。
- **Admin-gated ツール**: `postMessage` と `manageCron` は管理者権限が必要。特に `manageCron` は scheduler store が存在しても admin 以外には公開されない。
- **トークンバジェット管理**: セッションはトークン見積りで管理し、しきい値超過時は `KarakuriAgent` が要約して最近の turn を保持する。
- **System turn の直列化**: heartbeat・cron・memory maintenance はグローバル mutex で system turn を直列実行し、共有セッションの破損や競合を防ぐ。
- **メモリの振り分けルール**: post-response evaluator は情報を排他的に振り分ける — ユーザー個別情報（好み・属性・状況）は user profile、ユーザー非依存の長期事実・決定のみ core memory、短期的な出来事は diary（または保存しない）。memory maintenance は core memory に紛れ込んだ期限切れ項目・ユーザー個別項目を rewrite 時に除去する。
- **メモリ永続化の直列化**: post-response evaluator と SNS 観測ユーザー評価は、core memory snapshot read と LLM 評価を lock 外で行い、append/write の apply 段階だけ共有 persistence mutex を通す。memory maintenance は同じ mutex を read → LLM → overwrite / replace / delete 全体で保持し、maintenance overwrite と background append の更新ロストを防ぎつつ、system turn が evaluator の LLM 待ちで長時間ブロックされないようにする。同一 user の後続 evaluator は agent 側 mutex で直列化される。
- **スレッド単位排他**: Discord 側のユーザー会話処理は thread ごとに mutex で直列化する。
- **ファイルベース state**: Chat SDK の subscription / cache / lock 状態は `data/state/chat-state.json` に保存される。
- **SNS の重複防止と専用ループ**: SNS 活動は SQLite に記録し、like / repost / reply / quote の重複防止を行う。SNS 自動実行は heartbeat から分離した専用ループで行う。
- **SNS 投稿の 140 文字制限**: `sns_<provider>_post` の投稿本文は全プロバイダ共通で 140 文字以内に制限される（Zod スキーマ + ツール description + ビルトインスキル instructions の 3 層制御）。プラットフォーム固有の上限ではなく、エージェントの投稿スタイルとしての設計判断。
- **Karakuri World 専用モード**: `KARAKURI_WORLD_BOT_IDS` に一致する相手では専用ツールセットのみを公開する。info 系ツールは戻り値の `data` に実データを inline 返却し、後続 Discord 通知は choices のみを扱う。
- **知覚と記憶の分離（M1）**: KW の状態系（行動選択用）通知はセッション履歴に積まず、Perception Buffer のチャネル別最新 1 件としてシステムプロンプトの `<karakuri-world-perception>`（untrusted）で注入する。会話系・未知種別は履歴に残す。Buffer は再起動時に experience_log から復元される。`KW_PERCEPTION_BUFFER_ENABLED` で無効化可能。
- **内部状態 + Appraisal（M2）**: 気分・元気度・空腹・社交欲求 + 睡眠フラグを life.db（inner_state / inner_state_history）で管理。時間経過はルール（遅延評価・概日リズム・睡眠中の回復下限保証）、出来事の解釈は統合 appraisal（1 イベント 1 LLM コール、`LLM_APPRAISAL_MODEL` で役割別指定）。決定論ガードレール（変化量のみ・符号チェック・クランプ・指示形テキスト棄却）を通し、判定は appraisal_log に proc_version つきで記録。KW は appraisal 先行 → 応答、Discord は応答先行 → appraisal 事後（受信順に直列適用）。失敗はスキップ + report 通知（reprocessing で回収可能）。状態は自然言語化して `<inner-state>`（untrusted）で注入。`APPRAISAL_ENABLED` / `INNER_STATE_INJECTION_ENABLED` で無効化可能。区間リプレイ CLI: `npx tsx src/life/replay-appraisal.ts`
- **エピソード記銘と想起（M3）**: appraisal のサリエンス判定 + 分節化（開いたエピソード/ドラフト永続化、前段ルール・LLM 判定・後段ガードレール（最大ビート数/最大継続時間で強制 close）の 3 段）で episodes（生活の語彙、provenance / proc_version つき）を確定。想起はハイブリッド（FTS5 trigram + LIKE フォールバック + sqlite-vec + 新しさ + importance×buoyancy + 社会的文脈、RRF + MMR）。自動想起は `<episodic-memory>`（untrusted）で注入（`RECALL_INJECTION_ENABLED`）、能動想起は `recallEpisodes` ツール。埋め込みは OpenAI 互換で差し替え可能（`EMBEDDING_MODEL`、失敗時は pending → 非同期 backfill、未設定でも FTS のみで動作）。
- **省察と自伝的階層（M4）**: 省察エンジン（`LLM_REFLECTION_MODEL`、`REFLECTION_ENABLED`）が日次（当日エピソード→日記・感情の消化・信念更新/矛盾の改訂）/ 週次（日記群→テーマ・自己像ドリフト）/ 月次（テーマ群→章 + 浮力減衰 = 忘却、削除しない）を「世界内の行為」（夜判定は差し替え可能な関数）として実行。beliefs は上書きせず supersedes チェーンで改訂し、単一出所の信念は confidence をキャップ + 省察で格下げ（汚染対策）。自己像（kind=self）は省察だけが更新し `<self-image>` で自己語り注入（`SELF_IMAGE_INJECTION_ENABLED`）。想起は章・テーマ→エピソードの階層ドリルダウン。seed 記憶は `data/seed-memories.json` から、既存 diary.db / users.db / memory.md は「移行前の記録」として experience_log 経由で一度だけインポート。
- **動機と展望記憶（M5）**: 生理パラメータを欲求へ変換し「いま一番強い欲求」+ 飽き圧（action_ledger の偏りを「逸脱を促す向き」で）を `<drives>` で KW 行動選択に注入（`DRIVES_INJECTION_ENABLED`）。appraisal の prospect_candidates を prospects（promise/intention/goal、status は open からのみ遷移する経路依存の状態）へ登録し、KW 応答時に `<prospects>` で注入（`PROSPECTS_INJECTION_ENABLED`）。日次省察が棚卸しし、果たせなかった約束は気分へ影響。SNS / Discord 側は `scheduleProspectReminder` ツールで「prospect を時刻 T に想起する」リマインダー型 oneshot cron に限定して自己登録できる（admin-gated の `manageCron` とは別物。上限あり・登録/解除は report 通知・実行時は prospect を untrusted 注入するだけ）。
- **反復対策（M1）**: own_action から action_ledger（頻度台帳）と Loop Detector（同一行動×同一対象の連続カウント）を更新し、`LOOP_DETECTOR_THRESHOLD` 回以上の連続で trusted 側の決定論警告をプロンプトへ注入する（untrusted コンテンツは引用しない）。`LOOP_WARNING_ENABLED` で無効化可能。

### Scheduler / proactive messaging の注意点

- Heartbeat は `HEARTBEAT.md` が存在するだけでは動かない。`postMessageChannelIds`（`ALLOWED_CHANNEL_IDS` 由来）が 1 件以上あるときに有効化される。
- `REPORT_CHANNEL_ID` 単独では heartbeat は有効にならない。
- `MEMORY_MAINTENANCE_INTERVAL_MINUTES` を設定すると、メモリメンテナンス専用ループが有効になり、report には要約サマリーを送る。
- Cron ジョブ実行自体は admin 権限不要。admin 権限が必要なのは `manageCron` ツール経由の操作。
- `CRON.md` の frontmatter では少なくとも以下を扱う:
  - `schedule`
  - `session-mode` (`isolated` / `shared`)
  - `enabled`
  - `stagger-ms`
  - `oneshot`

## データディレクトリ（`data/`）

`data/` は `.gitignore` 対象。通常は `data.example/` をコピーして使う。主な runtime artifact は以下。

- `data/AGENT.md` — エージェント基本指示
- `data/RULES.md` — 追加ルール
- `data/HEARTBEAT.md` — heartbeat 用 system 指示
- `data/seed-memories.json` — 立ち上げ時の seed 記憶（beliefs / narratives。あれば一度だけ取り込み）
- `data/skills/*/SKILL.md` — ユーザー向けスキル（frontmatter 必須）
- `data/system-skills/*/SKILL.md` — system 用スキル（frontmatter 必須）
- `data/cron/*/CRON.md` — cron ジョブ定義（frontmatter 必須）
- `data/memory/core/memory.md` — コアメモリ
- `data/memory/diary/*.md` — 旧形式の日記。起動時に `diary.db` へ一度だけ import されうる
- `data/sessions/{hash}.json` — セッションファイル
- `data/state/chat-state.json` — Chat SDK の永続 state
- `data/diary.db` — 日記ストア
- `data/life.db` — 生きたエージェントの記憶 DB（experience_log。追記専用の一次資料）
- `data/users.db` — ユーザープロファイルストア
- `data/sns-activity-{provider}.db` — provider 別 SNS 活動履歴 / 通知予約ストア（旧 `data/sns-activity.db` は `SNS_LEGACY_DB_MIGRATE_TO` で明示移行）

## セキュリティ

- `utils/safe-fetch.ts` は SSRF 対策の中核で、private / loopback / link-local 宛ての拒否、DNS pinning、redirect ごとの再検証を行う。
- `webFetch` と `sns_mastodon_upload_media` / `sns_x_upload_media` は同じ safe-fetch 系の URL 検証基盤を利用する。
- `webFetch` は http/https のみを受け付け、レスポンスサイズ上限と HTML/XHTML の抽出処理を持つ。
- プロンプトでは `<memory>`、`<user-profile>`、`<diary>`、`<skill-dynamic-context>`、`<summary>` と、`recallDiary` / `userLookup` / `webFetch` / `webSearch` / skill-gated tool の結果を untrusted content として扱う。
- trusted instruction と untrusted context は XML ライクなタグで分離され、下位コンテキストによる上書きを避ける前提で設計されている。

## ユーザー記憶 / alias 運用

- 同一人物の複数アカウントは `linkUser` / `unlinkUser` で admin が手動管理する（KW モードでは非公開）。
- primary は `discord:` ID を優先。Discord が無い場合は継続的に観測されるアカウント（KW 側、または最初に観測した SNS account）を primary にする。
- alias からの profile 更新は primary に集約される。alias 側の row / display_name は履歴として残す。
- `userLookup` は primary の `aliases` と alias 側の `alias_of` を表示する。

## Multi SNS provider

- SNS skill は `sns-mastodon` / `sns-x` / `sns-elyth`、tool は `sns_<provider>_<action>` 形式（例: `sns_mastodon_post`, `sns_x_like`）。
- 複数 provider は同時有効化され、SNS loop は provider ごとに独立して走る。`SNS_LOOP_MIN/MAX_INTERVAL_MINUTES` は共通設定。
- 旧 `SNS_PROVIDER` / `SNS_*` env は使わない。旧 `data/sns-activity.db` は `SNS_LEGACY_DB_MIGRATE_TO` で明示移行する。
