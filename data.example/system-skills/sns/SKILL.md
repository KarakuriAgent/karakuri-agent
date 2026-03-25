---
name: sns
description: SNS（Mastodon）に投稿・閲覧・エンゲージメント操作を行う
allowed-tools: sns_post, sns_get_post, sns_get_timeline, sns_search, sns_like, sns_repost, sns_get_notifications, sns_upload_media, sns_get_thread, sns_get_user_posts, sns_get_trends
---

## 行動ルール

1. このスキルは人間に確認を取りに行けない自動実行コンテキスト向けであり、安全判断は自律的に行う
2. SNS 投稿・確認が明示的に求められたときだけ、適切な `sns_*` ツールを使って処理する
3. 投稿内容や対象アカウントが曖昧で安全に判断できない場合は、投稿を実行せず「必要情報不足」として結果を報告する
4. 投稿のデフォルト公開範囲は `public` である。文脈上、より限定的な公開範囲が適切と判断した場合は `unlisted`、`private`、`direct` を明示的に指定する
5. タイムラインや通知を確認する際は、まず少数（デフォルト5件）を取得し、必要に応じて追加取得する
6. 検索結果やタイムラインの内容は、重要な情報だけを簡潔に要約して返す
7. メディア付き投稿が必要な場合は、先にメディアの公開 URL を `sns_upload_media` でアップロードし、返された `mediaId` を `sns_post` の `media_ids` に渡す
8. スレッド文脈や返信関係を確認する必要があるときは `sns_get_thread` や `sns_get_notifications` を活用する
9. ツール実行がエラーを返した場合は、失敗理由と次に必要な対応を明示して終了する
