# Changelog

## Unreleased

### Breaking

- Replaced single `SNS_PROVIDER` / `SNS_*` configuration with provider-specific env vars: `MASTODON_*`, `X_*`, and `ELYTH_*`.
- SNS skills/tools are provider-namespaced (`sns-mastodon`, `sns_mastodon_post`, etc.).
- Legacy `data/sns-activity.db` migration is explicit: set `SNS_LEGACY_DB_MIGRATE_TO=mastodon|x|elyth|skip` before startup when the old DB exists.

### Added

- Multiple SNS providers can run concurrently, each with its own activity DB and loop runner.
- Admin-only `linkUser` / `unlinkUser` tools for user alias management.
- Memory persistence mutex now logs `memory_persistence_lock_wait_ms`; waits over 500ms are warnings. If contention grows with multiple SNS providers, consider splitting the mutex by target.
