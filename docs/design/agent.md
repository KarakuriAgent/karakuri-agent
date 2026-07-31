# Agent 層 詳細設計

## 概要

LLM（OpenAI 互換 API を含む）を使って会話を処理するコア層。
セッション・メモリ・ツールを統合し、ユーザーメッセージに対して応答を生成する。

## インターフェース: `IAgent` (`src/agent/core.ts`)

```typescript
interface AgentLifecycleCallbacks {
  onThinking(): void;
  onToolCallStart(toolName: string): void;
  onToolCallFinish(toolName: string): void;
}

interface HandleMessageOptions {
  lifecycle?: AgentLifecycleCallbacks;
  extraSystemPrompt?: string;
  userId?: string;
  ephemeral?: boolean;
  skillActivityInstructions?: string | undefined;
  /**
   * provider 名を渡すと該当 SNS skill を auto-load する。
   * `true` は legacy 互換で `'mastodon'` 相当（または `config.sns` legacy fixture では builtin 'sns' skill）にマップする。
   */
  autoLoadSnsSkill?: SnsProviderType | boolean | undefined;
}

interface IAgent {
  /** ユーザーメッセージを処理して応答文字列を返す */
  handleMessage(
    sessionId: string,
    userMessage: string,
    userName: string,
    options?: HandleMessageOptions,
  ): Promise<string>;

  /** セッション履歴を LLM で要約して返す */
  summarizeSession(sessionId: string): Promise<string>;
}
```

## メッセージ処理フロー (`Agent.handleMessage`)

```
0. （real user かつ userStore ありの場合）ensureUser(userId, userName) を fire-and-forget で開始
   - display name / profile を壊さない best-effort 登録
   - 失敗しても会話は継続
        ↓
1. ユーザーメッセージ追加
   - 通常 turn: `sessionManager.addMessages(sessionId, [...])`
   - `ephemeral: true`: インメモリの単発 SessionData を構築（disk write / cache 更新なし）
   （履歴には Discord から来た生の userName を残す）
        ↓
2. 要約チェック（トークン予算）
   a. AGENT.md / RULES.md, skills, ensured user を取得
   b. additionalTokens = tokens(可変長の trusted prompt context
      + "<user-profile>...</user-profile>"
      + "<skill-context>...</skill-context>"
      + skill list
      + 利用可能ツール説明
      + skill activity instructions)
   c. `ephemeral !== true` かつ needsSummarization(session, additionalTokens) が true
         │                              ↓
         │                        summarizeSession() で LLM 要約
         │                        sessionManager.applySummary() で圧縮
         ↓
3. システムプロンプト構築
   ├── AGENT.md（なければデフォルト指示）
   ├── CORE_SAFETY_INSTRUCTIONS（不変）
   ├── RULES.md（あれば trusted に追加）
   ├── <user-profile> ... </user-profile>
   │    ├── Display name: ensureUser で得た保存済み表示名（alias の場合 alias 自身の displayName）
   │    ├── User ID: Discord user ID（alias の場合は alias 自身の ID）
   │    ├── Alias of User ID: primary user ID（alias の場合のみ）
   │    └── Profile: life.db の beliefs(person_fact) から構築した人物知識
    ├── <skill-context> ... </skill-context>
    │    └── SNS 専用ループの自動ロード時に、動的コンテキスト + スキル指示を事前注入
    ├── session.summary（あれば注入）
    ├── Available skills（通常は shared skills、system user のときは system skills を含む。ビルトイン SNS skill は cron / 手動の system turn ではここに出るが、SNS 専用ループの自動ロード時は除外される）
    └── ツール使用説明
        ↓
4. generateText() + tools + stopWhen: stepCountIs(n)
   ├── `config.llmModelSelector` を見て LLM factory abstraction 経由で
   │   OpenAI Responses API / Chat API を切り替える
   ├── userStore があると `userLookup` を公開
   └── options.lifecycle がある場合は experimental_onStepStart /
        experimental_onToolCallStart / experimental_onToolCallFinish を配線
         ↓
5. 応答メッセージ保存
   - 通常 turn: `result.response.messages` を sessionManager に保存
   - `ephemeral: true`: 保存しない
        ↓
6. appraisal をバックグラウンド enqueue（M2）
   - 体験の解釈・記憶への反映は appraisal → episodes / beliefs / relations 経由で行う
   - 失敗はスキップ + report 通知で握りつぶし、返信結果は変えない
```

> **注**: trusted prompt context（AGENT.md / RULES.md / skills 一覧）のトークン数は Session 層のスコープ外のため、
> Agent 層がステップ 3b で `src/utils/token-counter.ts` を使って計算し `additionalTokens` として渡す。
> トークン数は **プロンプトに埋め込む最終形**（`<user-profile>...</user-profile>`, `<skill-context>...</skill-context>` タグを含む文字列）に対してカウントする。
> `additionalTokens` の対象は **可変長の外部コンテキスト**（AGENT.md / RULES.md / skills 一覧 / current user profile / auto-loaded skill contexts / skill activity instructions / extra system prompt）。
> 将来さらに可変長の trusted prompt context を追加した場合もここへ含める。

## ツール

### `userLookup` (`src/agent/tools/user-lookup.ts`)

| パラメータ | 型 | 説明 |
| --- | --- | --- |
| `query` | `string` | 名前やプロフィールでの検索語。空文字なら最近アクティブな既知ユーザー一覧 |
| `limit` | `number` | 返却件数（省略時 5, 最大 10） |
| `offset` | `number` | ページング用オフセット |

- `userStore` が設定されているときのみ公開
- 保存済みプロフィールから他ユーザー情報を検索する
- 空クエリ時は `updated_at DESC` で最近アクティブだった既知ユーザーを返す

### `linkUser` / `unlinkUser` (`src/agent/tools/user-alias.ts`)

| パラメータ | 型 | 説明 |
| --- | --- | --- |
| `alias_user_id` | `string` | alias 側の user ID |
| `primary_user_id` | `string` | primary 側の user ID（`linkUser` のみ） |
| `note` | `string?` | 任意メモ（最大 500 文字、`linkUser` のみ） |

- 同一人物の複数アカウントを admin が手動で紐付ける／解除する。alias → primary の片方向リンク
- admin (`ADMIN_USER_IDS`) かつ KW モードでないときのみ公開（KW モードでは非公開）
- primary の選び方: Discord ID (`discord:` prefix) を優先。Discord アカウントが片方にしかない場合は最も継続的に観測されているアカウント（KW モードなら KW 側、SNS のみなら最初に観測した SNS account）を primary にする
- `linkUser` は次のいずれかの場合に拒否する: `self_link` / `not_found`（双方が `users` テーブルに存在しない） / `already_linked` / `chain_detected`（primary が他レコードの alias） / `cannot_demote_primary`（alias 側がすでに primary として使われている）
- `unlinkUser` は対象 alias が登録されていないと `not_linked` エラーを返す
- 修正・primary 入れ替えは `unlinkUser` → `linkUser` の 2 ステップで対応する（force / 上書き API は提供しない）

### `recallEpisodes` (`src/agent/tools/recall-episodes.ts`)

- 能動想起ツール（M3）。自動想起（`<episodic-memory>` 注入）より古い・具体的な記憶を検索する
- ハイブリッド検索（FTS5 + sqlite-vec + 新しさ + importance×buoyancy + 社会的文脈）は living-agent.md を参照

### `webFetch` (`src/agent/tools/web-fetch.ts`)

| パラメータ | 型       | 説明                                       |
| ---------- | -------- | ------------------------------------------ |
| `url`      | `string` | 取得する URL（`http` / `https` のみ）      |

- 常に有効
- HTML / XHTML のみを対象に fetch し、Readability + Turndown で Markdown に変換する
- タイムアウト 15 秒、本文 2 MB、出力 20,000 文字で制限する。タイムアウトには DNS 解決も含める
- 各 redirect hop を再検証し、`http` / `https` 以外のスキームや private / loopback / link-local 宛てへの遷移は SSRF 対策として拒否する
- Readability で本文抽出できない場合はフォールバック文字列を返す

### `webSearch` (`src/agent/tools/web-search.ts`)

| パラメータ | 型       | 説明                                 |
| ---------- | -------- | ------------------------------------ |
| `query`    | `string` | Brave Search へ渡す検索クエリ        |
| `count`    | `number` | 返却件数（省略時 5、最大 10）        |

- `BRAVE_API_KEY` が設定されているときのみ公開
- Brave Search API の Web 検索結果から `title` / `url` / `snippet` を返す

### `loadSkill` (`src/agent/tools/load-skill.ts`)

| パラメータ | 型       | 説明                     |
| ---------- | -------- | ------------------------ |
| `name`     | `string` | 取得する skill の名前    |

- 利用可能な skill が 1 つ以上あるときのみ公開
- 通常ユーザーの `loadSkill` は shared skill のみ、system user の `loadSkill` は system skill も取得できる
- `allowedTools` を持つ skill では、本文返却と同時に対応する skill-gated tool を現在ターンの `tools` オブジェクトへ動的登録する
- 本文の全文は必要になったときだけロードさせ、システムプロンプトには skill 一覧のみ注入する

### `sns_<provider>_<action>` skill-gated tools (`src/agent/tools/sns.ts`, `src/sns/*`)

- `config.snsList` に含まれる provider ごとに system ユーザー向けビルトイン SNS skill が利用可能になる。設定は provider-specific で、Mastodon は `MASTODON_INSTANCE_URL` + `MASTODON_ACCESS_TOKEN`、X は `X_ACCESS_TOKEN`、ELYTH は `ELYTH_API_KEY` + `ELYTH_API_BASE` が必須
- cron では `loadSkill("sns-mastodon")` / `loadSkill("sns-x")` / `loadSkill("sns-elyth")` したターンで、対応する `sns_<provider>_<action>` ツールが公開される。SNS 専用ループでは provider 名（`'mastodon'` / `'x'` / `'elyth'`）を `autoLoadSnsSkill` に渡し、`skillActivityInstructions` を provider ごとに渡したときだけ自動ロードされ、`<skill-context>` と `sns_<provider>_*` ツールが事前注入される（`autoLoadSnsSkill: true` は legacy 互換のために `'mastodon'` 相当へマップされる）
- SNS ループの活動指示にある `postMessage` レポート要求は、実際に `postMessage` ツールが公開され、かつ `REPORT_CHANNEL_ID` がその送信許可先にも含まれる構成のときだけ含める
- `data/system-skills/sns-*/SKILL.md` は存在しなくてもビルトイン定義で動作する。同名の system skill が残っていても system ユーザー文脈ではビルトイン側を優先し、対話ユーザーに公開したい場合は運用側で `data/skills/*` に shared skill を追加する
- provider は Mastodon / X / ELYTH をサポート
- 公開ツール（`<provider>` は `mastodon` / `x` / `elyth`）:
  - `sns_<provider>_post`
  - `sns_<provider>_get_post`
  - `sns_<provider>_like`
  - `sns_mastodon_repost` / `sns_x_repost`（ELYTH は非対応）
  - `sns_mastodon_upload_media` / `sns_x_upload_media`（ELYTH は非対応）
  - `sns_<provider>_get_thread`
- provider 別 SNS skill のロード時に、新着通知・トレンド・直近行動ログを動的コンテキストとして注入する
- `sns_<provider>_post` の投稿本文は 140 文字以内に制限される（Zod スキーマの `.max(140)` + ツール description + ビルトインスキル instructions の 3 層で制御）。プラットフォームごとの上限ではなく、エージェントの投稿スタイルとして全 SNS プロバイダ共通で適用する設計判断
- `sns_<provider>_post` / `sns_<provider>_like` / `sns_<provider>_repost` は provider 別 SQLite SNS activity store（`DATA_DIR/sns-activity-{provider}.db`）を参照し、重複返信・引用・いいね・リポストを API 呼び出し前に抑止する。旧 `DATA_DIR/sns-activity.db` は `SNS_LEGACY_DB_MIGRATE_TO` で明示移行する
- `sns_<provider>_post` / `sns_<provider>_like` / `sns_<provider>_repost` は即時 API 実行のみをサポートする。X / ELYTH では post の visibility は `public` のみ許可する。ELYTH は repost / quote posts / media uploads いずれも非対応
- `sns_mastodon_upload_media` / `sns_x_upload_media` は remote URL を直接渡してアップロードできるが、`webFetch` と同じ SSRF 対策を共有し、`http` / `https` 以外のスキーム、private / loopback / link-local 宛て、およびそれらへ到達する redirect を拒否する
- remote media はサイズ上限付きで読み込む。Mastodon が `202 Accepted` を返した場合は `GET /api/v1/media/:id` を短時間ポーリングし、X では chunked upload の `getUploadStatus()` をポーリングして ready を待つ。所定回数で ready にならなければエラーにする

## 要約処理 (`Agent.summarizeSession`)

- 別途 `generateText()` で要約専用の LLM 呼び出しを行う（通常応答と同じ selector を使って OpenAI Responses API / Chat API を選択）
- 既存 `summary` があれば結合して要約する
- 要約プロンプト: 重要な事実・決定・ユーザーの好み・コンテキストを保持するよう指示

## システムプロンプト構築 (`src/agent/prompt.ts`)

```
[AGENT.md またはデフォルト指示]

[CORE_SAFETY_INSTRUCTIONS]

[RULES.md がある場合]

<user-profile>
Display name: {保存済み表示名 or 現在の userName}
User ID: {Discord user ID}
Alias of User ID: {primary user ID}  # alias の場合のみ
Profile:
{life.db の beliefs(person_fact) から構築した人物知識}
</user-profile>

[auto-loaded skill contexts がある場合]
<skill-context>
### sns-<provider>
{provider 別の動的コンテキスト + スキル指示}
</skill-context>

[session.summary がある場合]
<summary>
{summary の内容}
</summary>

[skills がある場合]
Available skills:
- ...
  - skill に `allowed-tools` がある場合は `(tools: ...)` も表示

[ツール使用説明]
- auto-loaded skill の `allowedTools` がある場合は、`loadSkill` 前提ではなく現在ターンで使えるツールとして `Available tools:` にも列挙する

[auto-loaded skill activity section がある場合]
## スキル活動
...
```

`<user-profile>` / `<skill-dynamic-context>` / `<summary>` タグ（と life 系注入セクション）で untrusted data を明示し、
instruction 部分と明確に分離することで prompt injection を防ぐ。
`<skill-context>` 内のスキル指示はコード定義の trusted コンテンツ。外部 API から取得した動的データ（通知・トレンド等）は `<skill-dynamic-context>` タグで囲み、safety instructions で untrusted 宣言する。
AGENT.md / RULES.md / skills は trusted ファイルとして扱い、`fs.watch()` で eager reload する。

## 応答後の記憶反映と shutdown

- `handleMessage()` は main reply 完了後に appraisal（M2）を enqueue し、体験の解釈と記憶への反映（inner_state / episodes / beliefs / relations / prospects）をバックグラウンドで進める
- `drainPendingEvaluations()` は appraisal キューの drain を待つ
- `src/index.ts` の graceful shutdown では
  1. HTTP server / scheduler / bot を停止
  2. experience recorder の flush → `agent.drainPendingEvaluations()` + phone service drain
  3. user / life / prompt / skill / scheduler store を close
  の順で drain する

## テスト方針

Agent 層は LLM 呼び出しを含むため、`sessionManager` / 各種ストアをモックしてテストする。

| テストケース | 検証内容 |
| --- | --- |
| additionalTokens の計算 | AGENT/RULES/skills 一覧 + user profile のプロンプト埋め込み最終形に対してトークン数が計算される |
| 要約トリガーの連携 | additionalTokens を含むトークン数で予算超過時に summarizeSession が呼ばれる |
| 要約トリガーなし | 予算以内の場合に summarizeSession が呼ばれない |
| システムプロンプト構築 | user-profile / summary がタグ付きで正しく組み立てられる |
| ツール実行 | recallEpisodes / userLookup / webFetch / webSearch / loadSkill / karakuri-world KW mode / provider-namespaced SNS skill-gated tools が想定どおり呼ばれる |
| lifecycle callback 配線 | AgentLifecycleCallbacks が generateText の step/tool callback へ同期で橋渡しされる |
| 応答メッセージ保存 | result.response.messages が sessionManager.addMessages で保存される |
| appraisal 連携 | reply を先に返しつつ appraisal がバックグラウンドで enqueue され、drainPendingEvaluations で待機できる |

## セキュリティ

- user-profile / summary / 記憶注入セクションはすべてタグで囲い、instruction と分離
- 応答後の記憶反映は appraisal / 省察パイプラインに集約する
- `webFetch` は DNS 解決と各 redirect hop を検査し、危険なスキームや private / loopback / link-local への SSRF を拒否する。15 秒タイムアウトは DNS 解決も含めて適用する
- `sns_mastodon_upload_media` / `sns_x_upload_media` も同じ safe-fetch 実装を共有し、危険なスキームや private 宛て redirect を拒否する。タイムアウトは DNS 解決も含めて適用する
- ツールのステップ数上限（`stopWhen: stepCountIs(n)`）を設定して無限ループを防ぐ
