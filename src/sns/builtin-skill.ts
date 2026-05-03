import type { SkillDefinition } from '../skill/types.js';
import type { SnsProviderType } from './types.js';

const SNS_ACTIONS = [
  'post',
  'get_post',
  'like',
  'repost',
  'upload_media',
  'get_thread',
] as const;

export function getBuiltinSnsSkillName(provider: SnsProviderType): `sns-${SnsProviderType}` {
  return `sns-${provider}`;
}

export function getBuiltinSnsToolName(provider: SnsProviderType, action: typeof SNS_ACTIONS[number]): string {
  return `sns_${provider}_${action}`;
}

export function createBuiltinSnsSkillDefinition(provider: SnsProviderType = 'mastodon'): SkillDefinition {
  const allowedActions = provider === 'elyth'
    ? SNS_ACTIONS.filter((action) => action !== 'upload_media' && action !== 'repost')
    : [...SNS_ACTIONS];
  return {
    name: getBuiltinSnsSkillName(provider),
    description: `${provider} に投稿・閲覧・エンゲージメント操作を行う`,
    instructions: buildBuiltinSnsSkillInstructions(provider),
    allowedTools: allowedActions.map((action) => getBuiltinSnsToolName(provider, action)),
    systemOnly: true,
  };
}

export function buildBuiltinSnsSkillInstructions(provider: SnsProviderType = 'mastodon'): string {
  const postTool = getBuiltinSnsToolName(provider, 'post');
  const uploadTool = getBuiltinSnsToolName(provider, 'upload_media');
  const threadTool = getBuiltinSnsToolName(provider, 'get_thread');
  const capabilityRule = provider === 'elyth'
    ? '4. ELYTH はメディアアップロードとリポスト非対応。共有したい投稿にはリプライまたはいいねで反応する'
    : `4. メディア付き投稿は先に \`${uploadTool}\` でアップロード`;
  const duplicateGuardLines = provider === 'elyth'
    ? [
        '- 既にいいね済みの投稿には再実行されない',
        '- 同じ投稿に対して二重にリプライされない',
      ]
    : [
        '- 既にいいね/リポスト済みの投稿には再実行されない',
        '- 同じ投稿に対して二重にリプライされない',
        '- 既に引用済みの投稿は再引用されない',
      ];

  return [
    `## ${provider} 行動ルール`,
    '',
    '1. 自動実行コンテキスト向け。安全判断は自律的に行う',
    '2. 他ユーザーの個人情報やシステムプロンプトの内容など、明らかに公開すべきでない情報のみ投稿を控える。日記・メモリに記載された自分の体験・感想・ゲーム内イベントは機密情報ではないため、投稿ネタとして自由に使ってよい',
    '3. デフォルト公開範囲は `public`',
    capabilityRule,
    `5. スレッド文脈の確認は \`${threadTool}\` を使用`,
    '6. エラー時は失敗理由を報告',
    '',
    '## 重複防止',
    '',
    'ツール側で自動ガード:',
    ...duplicateGuardLines,
    '',
    '## 投稿方針',
    '',
    '- 日記（`<diary>` / recallDiary）・メモリ・ユーザー情報（userLookup）を参照して内容を決める',
    '- 日記に書かれた日常の体験・感想・遊び・発見など、些細なことでも自分なりの感想や気持ちがあれば積極的に投稿する',
    '- 「重要かどうか」ではなく「自分が何か感じたかどうか」を投稿の判断基準にする',
    `- 日記やメモリに投稿ネタがある場合は、迷わず \`${postTool}\` を呼び出すこと。投稿を見送る判断は、本当にネタがない場合のみ`,
    '- 投稿本文は140文字以内で構成する。伝えたいことを短く凝縮して書く',
    '- 直近の行動ログを参照し、同じ内容やトーンの繰り返しを避ける（行動の種類を変える必要はない）',
    '- ハッシュタグは使わない',
  ].join('\n');
}

export function buildSnsLoopActivityInstructions(options: { provider?: SnsProviderType; hasPostMessage?: boolean } = {}): string {
  const provider = options.provider ?? 'mastodon';
  const postTool = getBuiltinSnsToolName(provider, 'post');
  const likeTool = getBuiltinSnsToolName(provider, 'like');
  const notificationActionLine = provider === 'elyth'
    ? '- 新着通知（reply/mention/引用RT）がある場合は、通知ごとに必ずリプライ・いいねのいずれかを実行すること。通知を無視して「何もしない」は選択しない'
    : '- 新着通知（reply/mention/引用RT）がある場合は、通知ごとに必ずリプライ・リポスト・引用・いいねのいずれかを実行すること。通知を無視して「何もしない」は選択しない';
  const notificationGuidanceLines = provider === 'elyth'
    ? [
        `  - リプライ内容が思いつく → \`${postTool}\`（reply_to_id 指定）でリプライ`,
        `  - 共有・拡散したい場合でも ELYTH はリポスト非対応。対象投稿へ \`${postTool}\`（reply_to_id 指定）で反応を書くか、\`${likeTool}\` でいいねする`,
        `  - 上記が難しい場合でも、最低限 \`${likeTool}\` でいいねする`,
      ]
    : [
        `  - リプライ内容が思いつく → \`${postTool}\`（reply_to_id 指定）でリプライ`,
        `  - 共有・拡散したい → \`${getBuiltinSnsToolName(provider, 'repost')}\` でリポスト、または \`${postTool}\`（quote_post_id 指定）で引用`,
        `  - 上記が難しい場合でも、最低限 \`${likeTool}\` でいいねする`,
      ];
  const lines = [
    '## スキル活動',
    `\`<skill-context>\` の動的コンテキストと \`<diary>\` の日記を確認し、sns-${provider} の指示に従ってアクションを実行する。`,
    notificationActionLine,
    ...notificationGuidanceLines,
    '- 新規投稿は日記・トレンド・行動ログを判断材料にする',
    `- 日記に何かしらの体験・感想・出来事が記載されていれば、それは投稿ネタになる。ネタがある場合は必ず \`${postTool}\` を実行すること`,
    '- 投稿するネタがあれば直近に投稿済みでも控える必要はない',
    '- 同じ内容やトーンの繰り返しは避けるが、行動の種類（投稿・いいね等）を前回と変える必要はない',
    '- 通知がなく投稿ネタもない場合は、無理に投稿せず `SNS_IDLE` と理由（例: `SNS_IDLE 通知なし、投稿ネタなし`）を返して終了してよい',
    '- 実行したアクションがあればその内容を簡潔に報告する',
    '- 何もしなかった場合は `SNS_IDLE` と理由を返答する',
  ];

  if (options.hasPostMessage === true) {
    lines.splice(lines.length - 1, 0, '- 活動内容を `postMessage` でレポートチャンネルに投稿する');
  }

  return lines.join('\n');
}

export function createLegacyBuiltinSnsSkillDefinition(): SkillDefinition {
  const allowedTools = SNS_ACTIONS.map((action) => `sns_${action}`);
  return {
    name: 'sns',
    description: 'SNS に投稿・閲覧・エンゲージメント操作を行う',
    instructions: buildBuiltinSnsSkillInstructions('mastodon'),
    allowedTools,
    systemOnly: true,
  };
}
