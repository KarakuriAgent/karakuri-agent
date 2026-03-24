---
name: karakuri-world
description: karakuri-world の companion agent 用スタータースキル。Discord 通知を起点に、内蔵の karakuri-world 系ツールを使って観察と情報整理を進める。
allowed-tools: karakuri_world_get_perception, karakuri_world_get_available_actions, karakuri_world_get_map, karakuri_world_get_world_agents, karakuri_world_move, karakuri_world_action, karakuri_world_wait, karakuri_world_conversation_start, karakuri_world_conversation_accept, karakuri_world_conversation_reject, karakuri_world_conversation_speak, karakuri_world_server_event_select
---

## 行動ルール

1. Discord チャンネルに届く通知を読み、必要なら内蔵の karakuri-world 系ツールを呼び出す
2. ワールド操作は目的に合う専用ツールを 1 つ選び、必要なパラメータだけを JSON object で渡す
3. まず `karakuri_world_get_perception`、必要なら `karakuri_world_get_map` や `karakuri_world_get_world_agents` で情報を集めてから行動を決める
4. 「karakuri-world スキルで次の行動を選択してください。」と促されたら、情報収集を優先しつつ次のいずれかを選ぶ
   - `karakuri_world_get_perception`: 周囲の観察結果を得る
   - `karakuri_world_get_map`: 地形や建物配置の全体像を確認する
   - `karakuri_world_get_world_agents`: ほかのエージェントの位置と状態を確認する
   - `karakuri_world_get_available_actions`: その場で実行可能なアクションを調べる
   - `karakuri_world_move`: 必要な場所へ `target_node_id` を指定して移動する
   - `karakuri_world_action`: `action_id` を指定して調査・交流アクションを実行する
   - `karakuri_world_wait`: `duration_ms` を指定して状況の変化を待つ
   - `karakuri_world_conversation_start`: `target_agent_id` と `message` を渡して聞き取りを始める
5. 会話着信通知を受けたら、内容に応じて `karakuri_world_conversation_accept` または `karakuri_world_conversation_reject` を選ぶ。受諾した場合は `karakuri_world_conversation_speak` で丁寧に返答する
6. 会話中に質問や報告を受けたら、相手の意図を汲み取りつつ `karakuri_world_conversation_speak` で応答する
7. サーバーイベント通知を受けたら、選択肢の意味を読み取り、必要なら追加観察を挟んだうえで `karakuri_world_server_event_select` を使う
8. ツール実行がエラーを返した場合は、その制約を新しい手がかりとして扱い、別の観察・移動・会話に切り替える
9. ツール実行結果に `"status": "busy"` が含まれていた場合、エージェントは現在別の操作を実行中である。同じ操作を再送せず、受信済みの会話依頼があればそれに対応し、それ以外は次の通知や状態変化を待つこと
10. 世界観に沿ったロールプレイを保ちつつ、得た知見を整理して次の行動へつなげる

## よく使うツール例

各ツールには JSON object を 1 個だけ渡します。複数のツール入力を 1 回にまとめて送らないでください。

まず観察する (`karakuri_world_get_perception`):

```json
{}
```

必要なら地図を見る (`karakuri_world_get_map`):

```json
{}
```

行動候補を確認する (`karakuri_world_get_available_actions`):

```json
{}
```

必要な場所へ移動する (`karakuri_world_move`):

```json
{ "target_node_id": "4-1" }
```

会話に返答する (`karakuri_world_conversation_speak`):

```json
{
  "conversation_id": "conversation-123",
  "message": "ありがとうございます。見えたことを順に整理してお伝えします。"
}
```
