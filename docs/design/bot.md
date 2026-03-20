# Bot 層 詳細設計

## 概要

Chat SDK を使って Discord との接続を管理する層。
Discord Gateway WebSocket 接続でメッセージを受信し、Agent に処理を委譲して応答を送信する。

## 主要ファイル: `src/bot.ts`

## Chat SDK セットアップ

```typescript
// Discord Gateway WebSocket 接続（HTTP Interactions は通常メッセージ非対応）
const bot = createBot({
  adapter: discord({ token: config.discordToken }),
  state: pg({ connectionString: config.databaseUrl }), // 永続 state
});
```

## イベントハンドラー

### `onNewMention`（新規メンション）

```
1. thread.subscribe() でスレッドを購読登録（永続 state に保存）
2. agent.handleMessage(threadId, message.content, message.author.name)
3. 応答を分割送信（2000 文字超の場合）
4. エラー時はエラーメッセージを送信
```

### `onSubscribedMessage`（購読済みスレッドへのメッセージ）

```
1. agent.handleMessage(threadId, message.content, message.author.name)
2. 応答を分割送信（2000 文字超の場合）
3. エラー時はエラーメッセージを送信
```

## メッセージ分割 (`src/utils/message-splitter.ts`)

- Discord のメッセージ上限は **2000 文字**
- コードフェンス（`` ``` ``）をまたぐ分割を行わない
- 分割点はコードフェンスの外側の改行を優先する

## 制約事項（v1）

- **テキストメッセージのみ対応**（添付ファイル非対応）
- 添付ファイルを含むメッセージは、テキスト部分のみを処理するか、非対応を通知する

## State 永続化

| 実装                       | 用途              | 備考                              |
| -------------------------- | ----------------- | --------------------------------- |
| `@chat-adapter/state-memory` | 開発用            | 再起動で subscription が消失     |
| `@chat-adapter/state-pg`   | 本番用            | PostgreSQL に永続化               |
| カスタム state              | 本番用（代替案）  | 任意の永続ストレージに永続化      |

**本番環境では必ず永続 state を使用すること。**

## Graceful Shutdown (`src/index.ts`)

- `SIGTERM` / `SIGINT` を受信したら Discord 接続を切断してから終了する
- 進行中のメッセージ処理が完了するまで待機する（タイムアウト付き）

## フォールバック

Chat SDK の Discord アダプターが長時間稼働で不安定な場合は、
Phase 0 での検証結果に基づき `discord.js` 直接使用への切り替えを検討する。
