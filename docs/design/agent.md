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
   a. coreMemory, recentDiaries, AGENT.md / RULES.md, skills, ensured user を取得
   b. additionalTokens = tokens(可変長の trusted prompt context
      + "<memory>...</memory>"
      + "<user-profile>...</user-profile>"
      + "<diary>...</diary>"
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
   ├── <memory> ... </memory>          memory.md の内容（常時注入）
   ├── <user-profile> ... </user-profile>
   │    ├── Display name: ensureUser/getUser で得た保存済み表示名
   │    ├── User ID: Discord user ID
   │    └── Profile: 保存済みプロフィール
    ├── <diary> ... </diary>            直近3日分の diary（自動注入）
    ├── <skill-context> ... </skill-context>
    │    └── heartbeat の SNS 自動ロード時に、動的コンテキスト + スキル指示を事前注入
    ├── session.summary（あれば注入）
    ├── Available skills（通常は shared skills、system user のときは system skills を含む。ビルトイン SNS skill は cron / 手動の system turn ではここに出るが、heartbeat 自動ロード時は除外される）
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
6. post-response evaluator をバックグラウンド enqueue
   - real user: profile / core memory / diary の永続化判断を含む
   - system user: userStore へのプロフィール書き込みをスキップし、core memory / diary のみ評価
   - SNS ツール経由で観測したユーザーにも enqueueSnsUserEvaluation で profile 評価を実行
   - user ごとに直列化（別 user 同士は並行しうる）
   - evaluator 実行直前に currentProfile / currentCoreMemory を再読込
   - `POST_RESPONSE_LLM_*` があれば evaluator 専用 model / client を使用
   - 失敗は warn ログのみで握りつぶし、返信結果は変えない
```

> **注**: trusted prompt context（AGENT.md / RULES.md / skills 一覧）と
> `coreMemory` / `recentDiaries` のトークン数は Session 層のスコープ外のため、
> Agent 層がステップ 3b で `src/utils/token-counter.ts` を使って計算し `additionalTokens` として渡す。
> トークン数は **プロンプトに埋め込む最終形**（`<memory>...</memory>`, `<user-profile>...</user-profile>`, `<diary>...</diary>`, `<skill-context>...</skill-context>` タグを含む文字列）に対してカウントする。
> `additionalTokens` の対象は **可変長の外部コンテキスト**（AGENT.md / RULES.md / skills 一覧 / coreMemory / current user profile / recentDiaries / auto-loaded skill contexts / skill activity instructions / extra system prompt）。
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

### `recallDiary` (`src/agent/tools/recall-diary.ts`)

| パラメータ | 型       | 説明                               |
| ---------- | -------- | ---------------------------------- |
| `date`     | `string` | 取得する日記の日付（YYYY-MM-DD）   |

- 直近 3 日は自動注入されるため、それより古い日付の取得に使用する

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

### `sns_*` skill-gated tools (`src/agent/tools/sns.ts`, `src/sns/*`)

- `SNS_PROVIDER` / `SNS_INSTANCE_URL` / `SNS_ACCESS_TOKEN` がすべて設定されると、system ユーザー向けにビルトイン SNS skill が利用可能になる
- cron では `loadSkill("sns")` したターンで `sns_*` ツールが公開される。heartbeat では `isSystemUser && ephemeral && snsContextRegistry != null && effectiveSkills にビルトイン SNS skill が含まれる` のときに自動ロードされ、`<skill-context>` と `sns_*` ツールが事前注入される
- heartbeat の活動指示にある `postMessage` レポート要求は、実際に `postMessage` ツールが公開され、かつ `REPORT_CHANNEL_ID` がその送信許可先にも含まれる構成のときだけ含める
- cron/manual で返すビルトイン SNS skill の本文でも、`scheduled_at` は未来の日時かつ明示的なタイムゾーン付き（例: `Z`, `+09:00`）で指定するよう案内する
- `data/system-skills/sns/SKILL.md` は存在しなくてもビルトイン定義で動作する。legacy な同名ファイルが残っていてもすべての system ユーザー文脈ではビルトイン側を優先し、対話ユーザーに公開したい場合は運用側で `data/skills/*` に shared skill を追加する
- 初期実装 provider は Mastodon
- 公開ツール:
  - `sns_post`
  - `sns_get_post`
  - `sns_like`
  - `sns_repost`
  - `sns_upload_media`
  - `sns_get_thread`
- `loadSkill("sns")` 時に、新着通知・トレンド・直近行動ログ・スケジュール済みアクションを動的コンテキストとして注入する
- `sns_post` / `sns_like` / `sns_repost` は SQLite の SNS activity store と schedule store を参照し、重複返信・引用・いいね・リポストを API 呼び出し前に抑止する
- `scheduled_at` を指定した `sns_post` / `sns_like` / `sns_repost` は即時 API 実行せず `sns_scheduled_actions` にキュー投入し、専用ランナーが指定時刻に直接 API 実行する
- `sns_upload_media` は remote URL を直接渡してアップロードできるが、`webFetch` と同じ SSRF 対策を共有し、`http` / `https` 以外のスキーム、private / loopback / link-local 宛て、およびそれらへ到達する redirect を拒否する
- remote media はサイズ上限付きで読み込み、Mastodon が `202 Accepted` を返した場合は `GET /api/v1/media/:id` を短時間ポーリングして ready を待つ。所定回数で ready にならなければエラーにする

## 要約処理 (`Agent.summarizeSession`)

- 別途 `generateText()` で要約専用の LLM 呼び出しを行う（通常応答と同じ selector を使って OpenAI Responses API / Chat API を選択）
- 既存 `summary` があれば結合して要約する
- 要約プロンプト: 重要な事実・決定・ユーザーの好み・コンテキストを保持するよう指示

## システムプロンプト構築 (`src/agent/prompt.ts`)

```
[AGENT.md またはデフォルト指示]

[CORE_SAFETY_INSTRUCTIONS]

[RULES.md がある場合]

<memory>
{coreMemory の内容}
</memory>

<user-profile>
Display name: {保存済み表示名 or 現在の userName}
User ID: {Discord user ID}
Profile:
{現在ユーザーの保存済みプロフィール}
</user-profile>

<diary>
{直近3日分の diary（日付付き）}
</diary>

[auto-loaded skill contexts がある場合]
<skill-context>
### sns
{動的コンテキスト + スキル指示}
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

`<memory>` / `<user-profile>` / `<diary>` / `<skill-dynamic-context>` / `<summary>` タグで untrusted data を明示し、
instruction 部分と明確に分離することで prompt injection を防ぐ。
`<skill-context>` 内のスキル指示はコード定義の trusted コンテンツ。外部 API から取得した動的データ（通知・トレンド等）は `<skill-dynamic-context>` タグで囲み、safety instructions で untrusted 宣言する。
AGENT.md / RULES.md / skills は trusted ファイルとして扱い、`fs.watch()` で eager reload する。

## ポストレスポンス評価と shutdown

- `handleMessage()` は main reply 完了後に `enqueuePostResponseEvaluation()` を呼び、プロフィール / core memory / diary の永続化判断をバックグラウンドで進める
- evaluator には `userId`, `userName`, `savedDisplayName`, 最新 user message, assistant response, current profile, current core memory, timezone を渡す
- user row が未作成（`ensureUser` 失敗等）の場合は evaluator に `userStore` を渡さず、プロフィール関連の書き込みをスキップする
- `drainPendingEvaluations()` は未完了 evaluator を `Promise.allSettled()` で待つ
- `src/index.ts` の graceful shutdown では
  1. HTTP server / scheduler / SNS schedule runner / bot を停止
  2. `agent.drainPendingEvaluations()` で evaluator を待機
  3. memory / user / prompt / skill / scheduler store を close
  の順で drain する

## テスト方針

Agent 層は LLM 呼び出しを含むため、`sessionManager` / `memoryStore` をモックしてテストする。

| テストケース | 検証内容 |
| --- | --- |
| additionalTokens の計算 | AGENT/RULES/skills 一覧 + coreMemory + recentDiaries のプロンプト埋め込み最終形に対してトークン数が計算される |
| 要約トリガーの連携 | additionalTokens を含むトークン数で予算超過時に summarizeSession が呼ばれる |
| 要約トリガーなし | 予算以内の場合に summarizeSession が呼ばれない |
| システムプロンプト構築 | memory / user-profile / diary / summary がタグ付きで正しく組み立てられる |
| ツール実行 | recallDiary / userLookup / webFetch / webSearch / loadSkill / karakuri-world KW mode / sns skill-gated tools が想定どおり呼ばれる |
| lifecycle callback 配線 | AgentLifecycleCallbacks が generateText の step/tool callback へ同期で橋渡しされる |
| 応答メッセージ保存 | result.response.messages が sessionManager.addMessages で保存される |
| post-response evaluation | reply を先に返しつつ evaluator がバックグラウンドで動き、drainPendingEvaluations で待機できる |

## セキュリティ

- memory / user-profile / diary / summary はすべてタグで囲い、instruction と分離
- 応答後の永続化判断はポストレスポンス評価 LLM に集約する
- `webFetch` は DNS 解決と各 redirect hop を検査し、危険なスキームや private / loopback / link-local への SSRF を拒否する。15 秒タイムアウトは DNS 解決も含めて適用する
- `sns_upload_media` も同じ safe-fetch 実装を共有し、危険なスキームや private 宛て redirect を拒否する。タイムアウトは DNS 解決も含めて適用する
- ツールのステップ数上限（`stopWhen: stepCountIs(n)`）を設定して無限ループを防ぐ
