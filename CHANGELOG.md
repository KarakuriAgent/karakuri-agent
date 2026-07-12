# Changelog

## Unreleased

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
