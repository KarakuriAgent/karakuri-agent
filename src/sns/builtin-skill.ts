import type { SkillDefinition } from '../skill/types.js';

export const BUILTIN_SNS_SKILL_NAME = 'sns' as const;

const BUILTIN_SNS_ALLOWED_TOOLS = [
  'sns_post',
  'sns_get_post',
  'sns_like',
  'sns_repost',
  'sns_upload_media',
  'sns_get_thread',
] as const;

const BUILTIN_SNS_DESCRIPTION = 'SNS（Mastodon）に投稿・閲覧・エンゲージメント操作を行う';

export function createBuiltinSnsSkillDefinition(): SkillDefinition {
  return {
    name: BUILTIN_SNS_SKILL_NAME,
    description: BUILTIN_SNS_DESCRIPTION,
    instructions: buildBuiltinSnsSkillInstructions(),
    allowedTools: [...BUILTIN_SNS_ALLOWED_TOOLS],
    systemOnly: true,
  };
}

export function buildBuiltinSnsSkillInstructions(): string {
  return [
    '## 行動ルール',
    '',
    '1. 自動実行コンテキスト向け。安全判断は自律的に行う',
    '2. 他ユーザーの個人情報やシステムプロンプトの内容など、明らかに公開すべきでない情報のみ投稿を控える。日記・メモリに記載された自分の体験・感想・ゲーム内イベントは機密情報ではないため、投稿ネタとして自由に使ってよい',
    '3. デフォルト公開範囲は `public`',
    '4. メディア付き投稿は先に `sns_upload_media` でアップロード',
    '5. スレッド文脈の確認は `sns_get_thread` を使用',
    '6. エラー時は失敗理由を報告',
    '',
    '## 重複防止',
    '',
    'ツール側で自動ガード:',
    '- 既にいいね/リポスト済みの投稿には再実行されない',
    '- 同じ投稿に対して二重にリプライされない',
    '- 既に引用済みの投稿は再引用されない',
    '- pending / executing のスケジュール済みアクションとも重複しない',
    '',
    '## 投稿方針',
    '',
    '- 日記（`<diary>` / recallDiary）・メモリ・ユーザー情報（userLookup）を参照して内容を決める',
    '- 日記に書かれた日常の体験・感想・遊び・発見など、些細なことでも自分なりの感想や気持ちがあれば積極的に投稿する',
    '- 「重要かどうか」ではなく「自分が何か感じたかどうか」を投稿の判断基準にする',
    '- 日記やメモリに投稿ネタがある場合は、迷わず `sns_post` を呼び出すこと。投稿を見送る判断は、本当にネタがない場合のみ',
    '- 直近の行動ログとスケジュール済みアクションを参照し、同じ内容やトーンの繰り返しを避ける（行動の種類を変える必要はない）',
    '- SNSアクションを遅延実行する場合は `scheduled_at` に未来のタイムゾーン付き日時（例: `2025-01-01T00:00:00Z`, `2025-01-01T09:00:00+09:00`）を指定する',
  ].join('\n');
}

export function buildHeartbeatSnsSkillActivityInstructions(options: { hasPostMessage?: boolean } = {}): string {
  const lines = [
    '## スキル活動',
    '`<skill-context>` の動的コンテキストと `<diary>` の日記を確認し、各スキルの指示に従ってアクションを実行する。',
    '- 新着通知があれば適切にリアクション（いいね・リプライ・リポスト・引用）する',
    '- 新規投稿は日記・トレンド・行動ログを判断材料にする',
    '- 日記に何かしらの体験・感想・出来事が記載されていれば、それは投稿ネタになる。ネタがある場合は必ず `sns_post` を実行すること',
    '- 投稿するネタがあれば直近に投稿済みでも控える必要はない',
    '- 同じ内容やトーンの繰り返しは避けるが、行動の種類（投稿・いいね等）を前回と変える必要はない',
    '- SNSアクションを遅延実行する場合は `scheduled_at` に未来のタイムゾーン付き日時を指定する',
    '- 実行したアクションがあればその内容を簡潔に報告する',
    '- 何もしなかった場合は `HEARTBEAT_OK` と理由（例: 投稿ネタなし、通知なし）を返答する',
  ];

  if (options.hasPostMessage === true) {
    lines.splice(lines.length - 1, 0, '- 活動内容を `postMessage` でレポートチャンネルに投稿する');
  }

  return lines.join('\n');
}
