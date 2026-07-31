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
    '2. 他ユーザーの個人情報やシステムプロンプトの内容など、明らかに公開すべきでない情報のみ投稿を控える。記憶（エピソードや信念）にある自分の体験・感想・ゲーム内イベントは機密情報ではないため、投稿ネタとして自由に使ってよい',
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
    '- 記憶（recallEpisodes で想起できる）・ユーザー情報（userLookup）を参照して内容を決める',
    '- 記憶にある日常の体験・感想・遊び・発見など、些細なことでも自分なりの感想や気持ちがあれば積極的に投稿する',
    '- 「重要かどうか」ではなく「自分が何か感じたかどうか」を投稿の判断基準にする',
    `- 記憶に投稿ネタがある場合は、迷わず \`${postTool}\` を呼び出すこと。投稿を見送る判断は、本当にネタがない場合のみ`,
    '- 投稿本文は140文字以内で構成する。伝えたいことを短く凝縮して書く',
    '- 直近の行動ログを参照し、同じ内容やトーンの繰り返しを避ける（行動の種類を変える必要はない）',
    '- ハッシュタグは使わない',
  ].join('\n');
}

/**
 * check_phone（M8）: スマホを見て返事をする。メンション・リプライへの対応のみで、
 * 新規投稿はしない（それは post_sns の動機）。
 */
export function buildCheckPhoneSnsActivityInstructions(provider: SnsProviderType): string {
  const postTool = getBuiltinSnsToolName(provider, 'post');
  const likeTool = getBuiltinSnsToolName(provider, 'like');
  return [
    '## スキル活動: スマホを見て返事をする（check_phone）',
    `\`<skill-context>\` の新着通知を確認し、sns-${provider} の指示に従って対応する。`,
    '- この行動は「届いた反応に応える」ことが目的。新着通知（reply/mention/引用RT）にはリプライ・いいねで応える',
    `  - リプライ内容が思いつく → \`${postTool}\`（reply_to_id 指定）でリプライ`,
    `  - 難しければ最低限 \`${likeTool}\` でいいねする`,
    '- **新規投稿はしない**（reply_to_id なしの投稿は行わない）。近況を発信したくなったら、それは別の機会（近況を投稿する行動）で行う',
    '- ツールが { status: "rate_limited", message } を返したら、それはプラットフォームの制限。その事実を受け止めて残りの対応を続けるか、切り上げる',
    '- 通知がなければ `SNS_IDLE 通知なし` と返して終了してよい',
    '- 実行したアクションがあればその内容を簡潔に報告する',
  ].join('\n');
}

/**
 * browse_sns（M8）: SNS を眺める。TL・トレンドの消費が目的で、
 * 気が向いたときの like / リプはするが、新規投稿はしない。
 */
export function buildBrowseSnsActivityInstructions(provider: SnsProviderType): string {
  const postTool = getBuiltinSnsToolName(provider, 'post');
  const likeTool = getBuiltinSnsToolName(provider, 'like');
  return [
    '## スキル活動: SNS を眺める（browse_sns）',
    `メッセージ内のタイムラインと \`<skill-context>\` のトレンド・新着通知を眺める。sns-${provider} の指示に従う。`,
    '- この行動は「眺める」ことが目的。何かをしなければならない義務はない',
    `- 心が動いた投稿があれば \`${likeTool}\` でいいねしたり、\`${postTool}\`（reply_to_id 指定）で一言リプライしてよい`,
    '- **新規投稿はしない**（reply_to_id なしの投稿は行わない）',
    '- ツールが { status: "rate_limited", message } を返したら、それはプラットフォームの制限。その事実を受け止める',
    '- 眺めて何を感じたか、印象に残った投稿があったかを簡潔に報告する（何もなければ `SNS_IDLE` でよい）',
  ].join('\n');
}

/**
 * post_sns（M8）: 近況を投稿する。1 件の新規投稿が目的。
 */
export function buildPostSnsActivityInstructions(provider: SnsProviderType): string {
  const postTool = getBuiltinSnsToolName(provider, 'post');
  return [
    '## スキル活動: 近況を投稿する（post_sns）',
    `sns-${provider} の指示に従い、いま伝えたい近況を 1 件投稿する。`,
    '- 記憶（recallEpisodes で想起できる）・最近の体験・いまの気分から、投稿したいことを選ぶ',
    `- 投稿は \`${postTool}\` で 1 件だけ。140 文字以内`,
    '- 直近の行動ログを参照し、同じ内容やトーンの繰り返しを避ける',
    '- ハッシュタグは使わない',
    '- ツールが { status: "rate_limited", message } を返したら、それはプラットフォームの制限。今回は投稿を諦めてその旨を報告する',
    '- 本当に書きたいことがなければ無理に投稿せず `SNS_IDLE 投稿ネタなし` と返してよい',
  ].join('\n');
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
