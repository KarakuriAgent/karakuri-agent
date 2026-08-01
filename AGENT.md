# AGENT.md

このファイルはリポジトリで作業する際のガイドラインを AI コーディングアシスタントに提供します。

## プロジェクト概要

Discord を主導線にした TypeScript 製の AI エージェント。Vercel AI SDK + Chat SDK + OpenAI 互換 LLM で応答を生成し、life.db（experience_log / episodes / beliefs / narratives / relations）による生きたエージェントの記憶、SQLite によるユーザー・SNS 活動の永続化、Heartbeat / Cron による system turn 実行、Mastodon / X / ELYTH 連携、Karakuri World 専用モードを備える。

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
src/agent/tools/              — builtin ツール群（recallEpisodes, webFetch, webSearch, userLookup, loadSkill, postMessage, manageCron, sns_<provider>_*, karakuri_world_command）
src/session/                  — JSON ファイルベースのセッション保存。ハッシュ化ファイル名 + メモリキャッシュを使用
src/life/                     — 生きたエージェントの記憶基盤（life.db マイグレーション、experience_log 追記専用ストア、イベント正規化、ExperienceRecorder、Perception Buffer、Loop Detector、action_ledger、sqlite-vec / FTS5 検証）
src/skill/                    — `data/skills/` と `data/system-skills/` を監視する frontmatter 付き SKILL.md ストア
src/scheduler/                — HEARTBEAT.md 読み込み、CRON.md frontmatter 解釈、Heartbeat/Cron 実行、scheduler store
src/sns/                      — Mastodon / X / ELYTH provider、provider 別 SQLite 活動ログ、SNS skill dynamic context、決定論レートリミッタ、レガシー DB 移行
src/phone/                    — 世界内行為としてのチャット・SNS（M8）: 未読キュー（life.db）と PhoneService（check_phone / browse_sns / post_sns ハンドラ）
src/user/                     — SqliteUserStore（ユーザー ID・表示名・alias の台帳。人物知識は life.db の beliefs / relations が持つ）
src/state/                    — Chat SDK の state adapter を `data/state/chat-state.json` に永続化
src/status-reaction.ts        — Discord 上の進行状態リアクション制御
src/karakuri-world/           — Karakuri World 専用のビルトイン指示
src/llm/                      — OpenAI 互換 API / Chat Completions 切り替え、no-thinking fetch 調整
src/shutdown.ts               — サーバー、scheduler、bot、各種ストアを段階的に停止する graceful shutdown 補助
src/config.ts                 — Zod ベースの環境変数バリデーションと runtime config 構築
```

### 主要な設計パターン

- **インターフェース抽象化**: Agent / SessionManager / SkillStore / SnsProvider / UserStore など主要コンポーネントは interface 越しに扱う。
- **ファイル監視ベースの runtime reload**: `AGENT.md`、`RULES.md`、スキル、scheduler 定義は `fs.watch` ベースの watcher で外部変更へ追随する。
- **Markdown + frontmatter の使い分け**:
  - `AGENT.md` / `RULES.md` / `HEARTBEAT.md` は生の Markdown / text をそのまま読む。
  - `SKILL.md` と `CRON.md` は frontmatter 必須。
- **Skill-gated ツール**: 一部ツールはスキル経由でのみ解放される。SNS 系ツールは provider 別 skill（`sns-mastodon` / `sns-x` / `sns-elyth`）を `loadSkill` するか、runtime が provider ごとに auto-load したスキルを通じて公開される。
- **Admin-gated ツール**: `postMessage` と `manageCron` は管理者権限が必要。特に `manageCron` は scheduler store が存在しても admin 以外には公開されない。
- **トークンバジェット管理**: セッションはトークン見積りで管理し、しきい値超過時は `KarakuriAgent` が要約して最近の turn を保持する。
- **System turn の直列化**: heartbeat・cron はグローバル mutex で system turn を直列実行し、共有セッションの破損や競合を防ぐ。
- **スレッド単位排他**: Discord 側のユーザー会話処理は thread ごとに mutex で直列化する。
- **ファイルベース state**: Chat SDK の subscription / cache / lock 状態は `data/state/chat-state.json` に保存される。
- **SNS の重複防止**: SNS 活動は SQLite に記録し、like / repost / reply / quote の重複防止を行う。SNS 自動実行は世界内行為（M8 の post_sns / browse_sns / check_phone）として行われる。
- **SNS 投稿の 140 文字制限**: `sns_<provider>_post` の投稿本文は全プロバイダ共通で 140 文字以内に制限される（Zod スキーマ + ツール description + ビルトインスキル instructions の 3 層制御）。プラットフォーム固有の上限ではなく、エージェントの投稿スタイルとしての設計判断。
- **Karakuri World 専用モード**: `KARAKURI_WORLD_BOT_IDS` に一致する相手では専用ツールセットのみを公開する。info 系ツールは戻り値の `data` に実データを inline 返却し、後続 Discord 通知は choices のみを扱う。command への 409 はどの形でも「世界側の状態と噛み合わなかった」正常系（行動進行中・応答待ち・通知の置き換え — サーバー仕様で notification_id は最新以外無効）として informational な busy 結果（サーバーの hint つき）へ変換し、生の例外を LLM に見せない。own_action の記録・頻度台帳・M8 フックは世界側で実際に開始されたコマンドのみを対象にする（実行されなかった試みを偽の記憶にしない）。
- **知覚と記憶の分離（M1）**: KW の状態系（行動選択用）通知はセッション履歴に積まず、Perception Buffer のチャネル別最新 1 件としてシステムプロンプトの `<karakuri-world-perception>`（untrusted）で注入する。会話系・未知種別は履歴に残す。Buffer は再起動時に experience_log から復元される。`KW_PERCEPTION_BUFFER_ENABLED` で無効化可能。
- **内部状態 + Appraisal（M2）**: 気分・元気度・空腹・社交欲求 + 睡眠フラグを life.db（inner_state / inner_state_history）で管理。時間経過はルール（遅延評価・概日リズム・睡眠中の回復下限保証）、出来事の解釈は統合 appraisal（1 イベント 1 LLM コール、`LLM_APPRAISAL_MODEL` で役割別指定）。決定論ガードレール（変化量のみ・符号チェック・クランプ（空腹の回復のみ `maxHungerRecoveryPerEvent` の緩い上限）・飲食/エネルギー補給の文脈が無い空腹回復の棄却（文脈判定は KW 通知の summary のみ — payload 全体だと choices のメニュー文言で素通りする）・無行動イベント（idle_reminder / wait_completed / failed_attempt）での消耗・空腹進行の棄却（時間経過はルール減衰が担い、上乗せは二重計上）・指示形テキスト棄却）を通し、判定は appraisal_log に proc_version つきで記録。KW は appraisal 先行 → 応答、Discord は応答先行 → appraisal 事後（受信順に直列適用）。出力取得は `LLM_APPRAISAL_OUTPUT_MODE` で切替: `json_schema`（既定。response_format による構造保証、OpenAI 本家等向け）/ `tool`（強制 tool call ×2 の分割スキーマ — 中核: 状態Δ+睡眠+サリエンス / 周辺: 関係+展望+分節化。json_schema を黙って無視するバックエンド — Featherless 等 — 向けで、モードは proc_version に反映される）。tool モードは中核が検証を通らなければイベント全体をスキップ（部分適用しない）、周辺の失敗は「観測なし + report 通知」に落として中核の適用を守る。不完全な配列要素はどのモードでも捨てて report 通知する（値の捏造・補完はしない）。ECONNRESET 等の一時ネットワーク障害は短バックオフで再試行。スキーマ不一致（json_schema を強制しない互換バックエンド対策）は生テキストからのサルベージ（不完全要素の drop 込み） → 1 回リトライで回収し、それでも失敗・API エラー・タイムアウトはスキップ + report 通知（reprocessing で回収可能）。状態は自然言語化して `<inner-state>`（untrusted）で注入。`APPRAISAL_ENABLED` / `INNER_STATE_INJECTION_ENABLED` で無効化可能。睡眠・飲食の解釈はペルソナ依存（ロボットなら充電が睡眠・補給）のため `KW_SLEEP_ACTION_PATTERN`（睡眠と見なす action_id）/ `APPRAISAL_FOOD_CONTEXT_PATTERN`（空腹回復を認める文脈）の正規表現 env で差し替え可能（設定時は proc_version に `+interp(...)` として反映）。訂正・矛盾（belief_conflict — 相手に認識を訂正された・自分の誤りが判明した）は appraisal が判定し、true なら salience を medium へ決定論で床上げする（#112 — 訂正イベントが低サリエンスで埋もれ、訂正前の省察で確定した誤った belief が丸一日生き残った事故対策）。区間リプレイ CLI: `npx tsx src/life/replay-appraisal.ts`
- **エピソード記銘と想起（M3）**: appraisal のサリエンス判定 + 分節化（開いたエピソード/ドラフト永続化、前段ルール・LLM 判定・後段ガードレール（最大ビート数/最大継続時間で強制 close）の 3 段）で episodes（生活の語彙、provenance / proc_version つき）を確定。想起はハイブリッド（FTS5 trigram + LIKE フォールバック + sqlite-vec + 新しさ + importance×buoyancy + 社会的文脈、RRF + MMR）。自動想起は `<episodic-memory>`（untrusted）で注入（`RECALL_INJECTION_ENABLED`）、能動想起は `recallEpisodes` ツール。埋め込みは OpenAI 互換で差し替え可能（`EMBEDDING_MODEL`、失敗時は pending → 非同期 backfill、行単位の失敗上限で dead-letter 化して後続の飢餓を防ぐ。dead-letter の回収は `--reembed`。未設定でも FTS のみで動作）。
- **省察と自伝的階層（M4）**: 省察エンジン（`LLM_REFLECTION_MODEL`、`REFLECTION_ENABLED`。出力取得は `LLM_REFLECTION_OUTPUT_MODE` で json_schema / tool を切替 — appraisal と同じ共通基盤 structured-output.ts で、一時ネットワーク障害の再試行・1 コールタイムアウト（`REFLECTION_TIMEOUT_MS`、既定 180 秒）・不完全な配列要素の drop + report 通知を持ち、モードは proc_version に反映される。夜間の失敗で日付が進んで取り残された分は `npx tsx src/life/run-reflection-cli.ts --daily YYYY-MM-DD` 等で手動回収できる — 実行済みマークは前進方向のみ更新）が日次（当日エピソード→日記・感情の消化・信念更新/矛盾の改訂）/ 週次（日記群→テーマ・自己像ドリフト）/ 月次（テーマ群→章 + 浮力減衰 = 忘却、削除しない）を「世界内の行為」（夜判定は差し替え可能な関数）として実行。日次は対象日が暦の上で終わってから（夜ウィンドウの 0 時以降の側で）走らせる — 日が終わる前に書くと実行後〜0 時のエピソードがどの省察にも拾われないため。新規信念の provenance は引用エピソードごとの代表イベント id（不変な experience_log id。要素数 = 出所エピソード数）で記録し、reprocess でエピソード id が振り直されても一次資料への追跡が切れない。beliefs は上書きせず supersedes チェーンで改訂し、単一出所の信念は confidence をキャップ + 省察で格下げ（汚染対策）。自己像（kind=self）は省察だけが更新し `<self-image>` で自己語り注入（`SELF_IMAGE_INJECTION_ENABLED`）。想起は章・テーマ→エピソードの階層ドリルダウン。seed 記憶は `data/seed-memories.json` から一度だけインポート（旧ストア diary.db / users.db / memory.md とその legacy import 経路は削除済み）。
- **動機と展望記憶（M5）**: 生理パラメータを欲求へ変換し「いま一番強い欲求」+ 飽き圧（action_ledger の偏りを「逸脱を促す向き」で）を `<drives>` で KW 行動選択に注入（`DRIVES_INJECTION_ENABLED`）。appraisal の prospect_candidates を prospects（promise/intention/goal、status は open からのみ遷移する経路依存の状態）へ登録し、KW 応答時に `<prospects>` で注入（`PROSPECTS_INJECTION_ENABLED`）。日次省察が棚卸しし、果たせなかった約束は気分へ影響。SNS / Discord 側は `scheduleProspectReminder` ツールで「prospect を時刻 T に想起する」リマインダー型 oneshot cron に限定して自己登録できる（admin-gated の `manageCron` とは別物。上限あり・登録/解除は report 通知・実行時は prospect を untrusted 注入するだけ）。
- **SNS・チャット全面反映と気質（M6）**: SNS 通知は appraisal 入力へ接続（応答先行 → 事後）。SNS ループは内部状態・概日リズムで間隔を変調（元気がない日・深夜・睡眠中は投稿が減る）。内部状態・自己像・欲求（+ 話題偏り検出、bucket=topic）は system turn（heartbeat / cron / SNS ループ）にも注入。関係グラフ relations（life.db migration v7、エッジ + 再帰 CTE 1〜2 ホップ、strength/affect は観測の累積）に appraisal のエッジ候補を蓄積し、旧 alias 機構は alias_of エッジへ一度だけ移行、想起の社会的文脈ブーストへ接続。`userLookup` とプロンプトの user profile は新ストア（beliefs person_fact + relations）のみから構築（旧 post-response evaluator と users.db の profile 列は削除済み）。気質（traits）は `data/traits.json`（resilience / socialBaseline / curiosity）で減衰・欲求・飽きの係数を変調する。
- **reprocessing（M7）**: 導出ビューは provenance / proc_version（プロンプト版 + モデル + チューニングセット）を持ち、`npx tsx src/life/reprocess-cli.ts --from … --to … --target episodes [--rederive] [--reembed] [--dry-run]` で experience_log から再構築できる（必ず稼働プロセスの停止中に実行する。リプレイと進行中の分節化が episode_drafts を取り合うため）。episodes は delete → replay で全再構築（再入可能。ドラフトの破棄はリプレイ範囲のチャネルに限定し、範囲外にはみ出すドラフトは退避してリプレイ失敗時も含め必ず復元する。範囲境界を跨ぐ確定済みエピソードも削除せず保護し、保護対象に属するイベントはリプレイしない — 切り詰めや部分重複を作らない。境界は CLI 入口で UTC ISO へ正規化される）、kind/actor 索引は写像改善の遡及再導出（append-only トリガーを一時解除して索引列のみ更新）、埋め込みは vec テーブル作り直しで全再埋め込み。経路依存の状態（prospects.status / relations.strength・affect / inner_state）は保持し、episodes.buoyancy は経過時間から決定論で再計算する。冪等性 = ①モック LLM で決定論部分が同一 ②同一範囲の再実行で重複しない。M2 の区間リプレイ CLI（replay-appraisal.ts）と共通基盤。
- **世界内行為としてのチャット・SNS（M8）**: KW カスタムコマンド 3 種（`KW_COMMAND_CHECK_PHONE` / `KW_COMMAND_BROWSE_SNS` / `KW_COMMAND_POST_SNS` で command 名をマッピング）でチャット返信・SNS 活動を世界内の行動選択に統合。check_phone 設定時、Discord ユーザーメッセージは即応答せず未読キュー（life.db の phone_unread、migration v9）へ積まれ、件数と待たせ具合（閾値ベースの言葉）に加え、Discord 由来の未読は送信者名 + 最新メッセージの要旨（60 字、sanitize 済み）が `<phone-status>` で KW 行動選択へ注入される（#111 — 件数のみでは会話が世界の行動につながらなかった。SNS 由来は件数のみ）。返信・送信後は「直近のやり取り」一行（phone_thread_state.last_outgoing_text、migration v12）も注入される。最古未読の放置時間は返信待ち圧として `<drives>` にも接続される（2h で湧き、8h で強まる決定論導出）。check_phone 実行時に未読スレッドを既存スレッドセッション + `<current-activity>` 構造化注入（現在地・直前の出来事・直近 own_action の comment — #111。報告禁止はしない。反復は topic 偏りで抑制）で返信（1 窓 5 スレッドまで、返信投稿は allowlist 対象外の `postReply` 経路）。未読本文は受信時刻プレフィックス `[MM-DD HH:mm]` つきで注入され、時制ずれの返信を防ぐ（#111）。check_phone / browse_sns の turn では SNS 投稿ツールが reply_to_id 必須の決定論ガードで新規投稿を拒否する（{ status: "reply_required" } — #111）。共有欲（直近 24h に importance の高いエピソードがあり、かつ 8h 以内に投稿していないとき `<drives>` に「誰かに話したい」を注入する決定論導出。8h クールダウンが実質のペースメーカーで最大 3 回/日）が post_sns の動機を供給する。SNS 書き込みは活動ログ sliding window + 最小間隔のツール層ハードゲート（拒否は「プラットフォームの仕様」文面で数値のまま返す — 内発的感情を捏造しない）、読み取りはフェッチ最小間隔 + キャッシュ返却（`SNS_FETCH_MIN_INTERVAL_*`）。通知の取り込みは記録済み id で重複排除し（停滞中の再取得を体験ログ・appraisal へ二重に流さず、プロンプト表示上も「確認済み」として新着と区別する）、incomplete フェッチが閾値回続いたら通知カーソルを最新へ強制前進する（ELYTH のようにページングが無い provider では sinceId がページから消えると恒久停滞するため。「それ以前はまとめて既読」セマンティクス）。KW bot（通知）と report 通知はイベント駆動のまま（admin も未読キュー対象。admin ツールの権限判定は処理時の userId で従来どおり効く）。旧 SNS ループ・チャット即時応答は削除済み。
- **能動メッセージ（M9 #110）**: 4 つ目の KW カスタムコマンド `send_message`（`KW_COMMAND_SEND_MESSAGE`、`KW_COMMAND_CHECK_PHONE` 必須）で、催促（自分の最後の発言から 12h 無応答 → 追い送り、同一スレッド 24h に 1 回）と個別共有（共有欲の個別分岐 — 「SNS に書くのもいいし、○○に直接伝えるのもいい」）を世界内の行動として実行する。1 窓 1 通。本文は対象スレッドの既存セッションで生成（文脈維持）し、対象スレッドに未読が残っていれば「返信 + 伝えたい話」を最終 run に合流して 1 通にする。会話状態はスレッド台帳 phone_thread_state（life.db migration v11。着信は未読 enqueue、発信は返信/送信成功時に記録）が持ち、礼儀ゲート（能動送信は同一スレッド 4h 間隔 + 直近 24h に 3 スレッドまで、深夜 0〜7 時は送らない）は決定論。動機は drives へ「返事待ちの気掛かり」「個別共有の選択肢」として注入され（`send_message` 構成時のみ）、送信先は着信実績のある既知スレッドに構造的に限定される。個別共有のきっかけエピソードには決定論の時刻表現（「今日の朝 10:27」等）と時制ガード文を付与し、半日前の出来事を「今〜したところ」と語る事故を防ぐ（#112）。phone の返信・能動送信セッションには進行中（その相手が counterpart のもの）+ 直近 48h に手仕舞いした prospects を `<prospects>`（untrusted）で注入し、完了済みの約束を古い物語のまま蒸し返す事故を防ぐ（#112）。
- **反復対策（M1）**: 世界側で実際に開始された own_action から action_ledger（頻度台帳）と Loop Detector（同一行動×同一対象の連続カウント）を更新し、`LOOP_DETECTOR_THRESHOLD` 回以上の連続で trusted 側の決定論警告をプロンプトへ注入する（untrusted コンテンツは引用しない）。`LOOP_WARNING_ENABLED` で無効化可能。

### Scheduler / proactive messaging の注意点

- Heartbeat は `HEARTBEAT.md` が存在するだけでは動かない。`postMessageChannelIds`（`ALLOWED_CHANNEL_IDS` 由来）が 1 件以上あるときに有効化される。
- `REPORT_CHANNEL_ID` 単独では heartbeat は有効にならない。
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
- `data/traits.json` — 気質（resilience / socialBaseline / curiosity。人格定義と整合させる）
- `data/skills/*/SKILL.md` — ユーザー向けスキル（frontmatter 必須）
- `data/system-skills/*/SKILL.md` — system 用スキル（frontmatter 必須）
- `data/cron/*/CRON.md` — cron ジョブ定義（frontmatter 必須）
- `data/sessions/{hash}.json` — セッションファイル
- `data/state/chat-state.json` — Chat SDK の永続 state
- `data/life.db` — 生きたエージェントの記憶 DB（experience_log。追記専用の一次資料）
- `data/users.db` — ユーザー ID・表示名・alias の台帳（旧 profile 列は未使用。人物知識は life.db 側）
- `data/sns-activity-{provider}.db` — provider 別 SNS 活動履歴 / 通知予約ストア（旧 `data/sns-activity.db` は `SNS_LEGACY_DB_MIGRATE_TO` で明示移行）

## セキュリティ

- `utils/safe-fetch.ts` は SSRF 対策の中核で、private / loopback / link-local 宛ての拒否、DNS pinning、redirect ごとの再検証を行う。
- `webFetch` と `sns_mastodon_upload_media` / `sns_x_upload_media` は同じ safe-fetch 系の URL 検証基盤を利用する。
- `webFetch` は http/https のみを受け付け、レスポンスサイズ上限と HTML/XHTML の抽出処理を持つ。
- プロンプトでは `<user-profile>`、`<skill-dynamic-context>`、`<summary>` と、life 系注入セクション（`<episodic-memory>` / `<inner-state>` / `<drives>` / `<prospects>` / `<self-image>` 等）、および `recallEpisodes` / `userLookup` / `webFetch` / `webSearch` / skill-gated tool の結果を untrusted content として扱う。
- trusted instruction と untrusted context は XML ライクなタグで分離され、下位コンテキストによる上書きを避ける前提で設計されている。

## ユーザー記憶 / alias 運用

- 同一人物の複数アカウントは `linkUser` / `unlinkUser` で admin が手動管理する（KW モードでは非公開）。
- primary は `discord:` ID を優先。Discord が無い場合は継続的に観測されるアカウント（KW 側、または最初に観測した SNS account）を primary にする。
- 人物知識（profile 相当）は life.db の beliefs(person_fact) / relations に蓄積され、`userLookup` はそれを表示する。alias 側の row / display_name は履歴として残る。
- `userLookup` は primary の `aliases` と alias 側の `alias_of` を表示する。

## Multi SNS provider

- SNS skill は `sns-mastodon` / `sns-x` / `sns-elyth`、tool は `sns_<provider>_<action>` 形式（例: `sns_mastodon_post`, `sns_x_like`）。
- 複数 provider は同時有効化され、世界内行為（M8）の SNS 処理は provider ごとに順に実行される。レート制限は `SNS_RATE_LIMIT_*`（共通既定）+ `X_RATE_LIMIT_*` 等（provider 上書き）で設定する。
- 旧 `SNS_PROVIDER` / `SNS_*` env は使わない。旧 `data/sns-activity.db` は `SNS_LEGACY_DB_MIGRATE_TO` で明示移行する。
