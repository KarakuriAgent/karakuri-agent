# Bot 層 詳細設計

## 概要

Chat SDK を使って Discord との接続を管理する層。
Discord Gateway WebSocket 接続でメッセージを受信し、Agent に処理を委譲して応答を送信する。
実装では long-running な Node プロセスとして起動し、HTTP webhook サーバーと Gateway listener を同時に立ち上げる。

## 主要ファイル: `src/bot.ts`

## Chat SDK セットアップ

```typescript
// Discord Gateway WebSocket 接続（HTTP Interactions は通常メッセージ非対応）
const bot = createBot({
  adapter: discord({ token: config.discordToken }),
  state: createFileStateAdapter({ dataDir: config.dataDir }), // 永続 state
});
```

## イベントハンドラー

### `onNewMessage(/./)` （未購読スレッドの新規メッセージ）

メンションの有無に関わらず、1文字以上のテキストを含むすべてのメッセージに反応する。

```
0. processable なメッセージなら元メッセージに 👀 を付ける（mutex の外）
1. thread.subscribe() でスレッドを購読登録（永続 state に保存）
2. `StatusReactionController` を通じて 💭 / ツール絵文字 / ✅ / ❌ を制御しながら agent.handleMessage(...)
3. 応答を分割送信（2000 文字超の場合）
4. 投稿成功後に ✅ を付け、2 秒後に除去
5. エラー時は ❌ を残したままエラーメッセージを送信
```

### `onSubscribedMessage`（購読済みスレッドへのメッセージ）

```
0. processable なメッセージなら元メッセージに 👀 を付ける（mutex の外）
1. `StatusReactionController` を通じて 💭 / ツール絵文字 / ✅ / ❌ を制御しながら agent.handleMessage(...)
2. 応答を分割送信（2000 文字超の場合）
3. 投稿成功後に ✅ を付け、2 秒後に除去
4. エラー時は ❌ を残したままエラーメッセージを送信
```

## スレッド単位キューイング

同一スレッドに連続してメッセージが送られた場合、会話履歴の整合性が崩れることを防ぐため、`KeyedMutex`（`src/utils/mutex.ts`）を使ってスレッド ID をキーに `handleThreadMessage` を直列化する。

- `onNewMessage` / `onSubscribedMessage` の両ハンドラーで `threadMutex.runExclusive(message.threadId, ...)` を使用
- `thread.subscribe()` も mutex 内に含めることで、subscribe 前に次のメッセージが来ても順序を保証
- ただし `queued`（👀）は mutex の外で先に適用し、ロック待ち中のメッセージも視覚的に分かるようにする
- 異なるスレッド間は並行処理を維持（スレッド間の独立性を損なわない）

## ステータスリアクション (`src/status-reaction.ts`)

- `StatusReactionController` は元メッセージ上のリアクション 1 個だけを保つ reconcile 型 state machine
- `queued` → `thinking` → tool（`saveMemory` / `recallDiary` は 📝、`webFetch` / `webSearch` は 🔍、`loadSkill` は 📖）→ `thinking` を繰り返す
- 応答投稿完了後は ✅ を付け、2 秒後に除去してクリーンな状態へ戻す
- エラー時は ❌ に遷移して保持する
- Agent 層との接続は `AgentLifecycleCallbacks` を経由し、Discord 依存を Bot 層と controller に閉じ込める

## メッセージ分割 (`src/utils/message-splitter.ts`)

- Discord のメッセージ上限は **2000 文字**
- コードフェンス（`` ``` ``）をまたぐ分割を行わない
- 分割点はコードフェンスの外側の改行を優先する

## 制約事項（v1）

- **テキストメッセージのみ対応**（添付ファイル非対応）
- 添付ファイルを含むメッセージは、テキスト部分のみを処理し、添付未対応であることを通知する

## State 永続化

| 実装                          | 用途              | 備考                                               |
| ----------------------------- | ----------------- | -------------------------------------------------- |
| `@chat-adapter/state-memory`  | 開発用            | 再起動で subscription が消失                       |
| `src/state/file-state.ts`     | v1 本番用         | `{DATA_DIR}/state/chat-state.json` に保存。単一プロセス前提 |
| カスタム state（将来差し替え） | 本番用（代替案）  | Redis / DB / 外部ストレージ等へ差し替え可能         |

**本番環境では必ず永続 state を使用すること。**
v1 は file-backed custom state で再起動後も購読状態を維持し、将来は `StateAdapter` 差し替えで DB などへ移行できるようにする。

## Graceful Shutdown (`src/index.ts`)

- `SIGTERM` / `SIGINT` を受信したら Discord 接続を切断してから終了する
- 進行中のメッセージ処理が完了するまで待機する（タイムアウト付き）

## フォールバック

Chat SDK の Discord アダプターが長時間稼働で不安定な場合は、
Phase 0 での検証結果に基づき `discord.js` 直接使用への切り替えを検討する。

### 実装メモ

- HTTP server は `src/index.ts` で起動し、`/webhooks/:platform` と `/healthz` を提供する
- `/healthz` は `BotRuntime.isGatewayConnected()` を参照し、Discord Gateway 未接続時は `503` を返す
- Gateway listener は `startGatewayListener()` をループ実行して長時間接続を維持する
- 接続済み判定は adapter ログに依存せず、`listenerTask` が 5 秒以上生存したかどうかで判定する
- ready 済み listener が通常終了しても、置き換え listener の起動確認中は直前の healthy 状態を維持し、再起動の継ぎ目で healthcheck が誤検知しないようにする
