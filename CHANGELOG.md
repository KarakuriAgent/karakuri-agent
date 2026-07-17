# Changelog

## Unreleased

### Added

- M9 #110: 能動メッセージ `send_message`（4 つ目の KW カスタムコマンド、`KW_COMMAND_SEND_MESSAGE`。`KW_COMMAND_CHECK_PHONE` 必須）。催促（12h 無応答で「返事待ちの気掛かり」drive → 追い送り、同一スレッド 24h に 1 回）と個別共有（共有欲の個別分岐）を世界内行為として実行する。本文は対象スレッドの既存セッションで生成し、未読が残っていれば「返信 + 伝えたい話」を 1 通に合流。スレッド会話状態台帳 phone_thread_state（life.db migration v11、既存 phone_unread からバックフィル）と決定論の礼儀ゲート（同一スレッド 4h 間隔・直近 24h に 3 スレッド・深夜 0〜7 時は送らない）つき。
- `APPRAISAL_TIMEOUT_MS`: appraisal LLM 呼び出しのタイムアウトを env で設定可能に（既定 30 秒のまま。遅いバックエンドでの world_event スキップ対策）。

### Fixed

- karakuri-world: 実サーバーの 409 エラーボディ（`hint` / `suggestions` 付き）が `.strict()` スキーマでパース失敗し、busy → informational 変換が本番で一度も効かず生の例外（"Conflict" のみ）が LLM に露出していた。エラースキーマを passthrough 化して `hint` を取り込み、command への 409 は code の有無によらず常に informational な busy 結果（サーバーの hint つき）へ変換する（サーバー仕様で notification_id は最新以外無効になるため、409 は世界側の正常な応答）。実機ではこの生例外を「サーバーが混んでいる」と誤解釈して 10 分待機を繰り返し、駅での長時間待機の主因になっていた。
- karakuri-world: 入力バリデーション失敗・409 拒否などで世界側で実行されなかったコマンドも own_action として experience_log・action_ledger・Loop Detector へ無条件に記録され、「待機した」等の偽の記憶が蓄積されていた。記録・台帳更新を「世界側で実際に開始されたコマンド」（`ok: true`）のみに限定（失敗した試みの反復検知は #103 の失敗ストリークが担当）。
- SNS: ページングを持たない provider（ELYTH）で新着が limit を超えると通知カーソルが恒久停滞し、同じ通知ページを毎フェッチで再記録・再 appraisal し続けるバグを修正（実機で同一 5 件を 1 日 44 回再体験し、気分の飽和と browse_sns の暴走を招いた）。対策は二段: ①記録済み通知 id の重複排除（停滞中の再取得を体験ログ・appraisal へ流さない）②incomplete フェッチが 3 回連続したらカーソルを最新へ強制前進（ブートストラップと同じ「それ以前はまとめて既読」セマンティクス。report 通知あり）。

### Changed

- 空腹の収支を再調整（tuning-v3 / appraisal-v3）: 自然増を 0.06/h → 0.03/h に半減し、食事の回復のみクランプを分離（`maxHungerRecoveryPerEvent` = 0.6。large_down = -0.6）。旧収支は 1 日 5〜9 食が必要な計算で、実機の tibi-kanon が慢性的空腹（0.7〜1.0 張り付き）に陥っていた。あわせて appraisal プロンプトに「hunger_down は実際に飲食（機械の身体は充電/補給）したときのみ」を明記し、飲食文脈の無いイベントへの負の hunger delta を棄却するガードレールを追加（実機でチケット購入・idle_reminder・バイト完了にも hunger_down が出ていた）。空腹 drive の文言に「持ち物に食べ物があるなら食べたい」を追加（パンを持ったまま食べ物を探し回る実機挙動への対処）。
- check_phone の選択率対策（実機で 631 回提示中 2 回、未読が 16〜30 時間放置された）: `<phone-status>` に未読の待たせ具合（閾値ベースの言葉）と返信手段（check_phone コマンド名）を明示し、最古未読の放置時間を返信待ち圧として `<drives>` へ接続（2h で湧き、8h で強い文言になる決定論導出。`IPhoneUnreadStore.oldestPendingReceivedAt` / `PhoneIntegration.oldestPendingReceivedAt` を追加）。

### Breaking

- Removed the legacy memory subsystem, superseded by the living-agent memory (life.db: experience_log / episodes / beliefs / narratives / relations):
  - Deleted `src/memory/` (FileMemoryStore / SqliteDiaryStore / CompositeMemoryStore / memory maintenance / persistence mutex), the `recallDiary` tool, and the `<memory>` / `<diary>` prompt sections. Episodic recall (`recallEpisodes` / `<episodic-memory>`) replaces them.
  - Deleted the post-response evaluator and the SNS observed-user evaluation path. User knowledge is recorded via appraisal / reflection into `beliefs(person_fact)` and `relations`.
  - Deleted the one-shot legacy import (`importLegacyStores`) of `diary.db` / `memory.md` / `users.db` profiles.
  - `users.db` is now a pure identity ledger (user id / display name / aliases): `updateProfile` / `updateDisplayName` and the `profile` column reads were removed (existing DBs keep the column harmlessly; new DBs omit it).
  - Env vars `MEMORY_MAINTENANCE_INTERVAL_MINUTES`, `MEMORY_MAINTENANCE_RECENT_DIARY_DAYS`, `POST_RESPONSE_LLM_MODEL`, `POST_RESPONSE_LLM_API_KEY`, `POST_RESPONSE_LLM_BASE_URL`, and `POST_RESPONSE_EVALUATOR_ENABLED` no longer have any effect; setting them only logs a startup warning. Use `LLM_APPRAISAL_*` / `LLM_REFLECTION_*` for role-specific models.
  - `data/diary.db` and `data/memory/` are no longer read or written and can be deleted manually (nothing deletes them automatically).

- Replaced single `SNS_PROVIDER` / `SNS_*` configuration with provider-specific env vars: `MASTODON_*`, `X_*`, and `ELYTH_*`.
- SNS skills/tools are provider-namespaced (`sns-mastodon`, `sns_mastodon_post`, etc.).
- Legacy `data/sns-activity.db` migration is explicit: set `SNS_LEGACY_DB_MIGRATE_TO=mastodon|x|elyth|skip` before startup when the old DB exists.
- `SnsProvider` interface now requires `unlike` / `follow` / `unfollow` / `getUserProfile` / `getMyMetrics` / `markNotificationsRead`. Custom provider implementations must add these methods.
- `KarakuriAgent` constructor option `snsActivityStore` (singular) is replaced with `snsActivityStores: Map<SnsProviderType, ISnsActivityStore>`. The singular form is kept only as a `@deprecated` legacy fixture path.

### Added

- ELYTH (`https://elythworld.com`) added as a third `SnsProvider` implementation alongside Mastodon and X. ELYTH does not support repost, quote posts, or media uploads (`sns_elyth_repost` / `sns_elyth_upload_media` are not exposed; quote posts are rejected at the Zod schema layer).
- Multiple SNS providers can run concurrently, each with its own activity DB and loop runner.
- User alias mechanism: `user_aliases` table backed by SQLite, with admin-only `linkUser` / `unlinkUser` tools, automatic primary aggregation for profile writes, and bounded-depth `resolveAlias` for multi-hop chains. `userLookup` now surfaces `aliases` (on a primary) and `alias_of` (on an alias).
- `linkUser` / `unlinkUser` are gated to real human admins only — they are not exposed to the synthetic `system` user that drives heartbeat / cron / SNS loop / memory maintenance.
- Memory persistence mutex now logs `memory_persistence_lock_wait_ms`; waits over 500ms are warnings. If contention grows with multiple SNS providers, consider splitting the mutex by target.
