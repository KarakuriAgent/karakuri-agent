/**
 * チャネル固有のイベントを NormalizedEvent（共通封筒）へ正規化する。
 * 正規化は封筒を揃えるだけで中身の解釈はしない。
 *
 * kind / actor は payload から再導出可能な索引であり、ここの写像・抽出ルールの
 * 改善は reprocessing（M7）で過去ログに遡及適用できる。M0 で完璧は求めない。
 */

import { EVENT_KINDS, type NormalizedEvent } from './types.js';

export const DISCORD_CHANNEL = 'discord';

export function kwChannel(botId: string): string {
  return `kw:${botId}`;
}

export function snsChannel(provider: string): string {
  return `sns:${provider}`;
}

/** KW 通知種別 → エージェント所有の抽象語彙。差し替え可能な写像。 */
export type KwKindMapper = (rawKind: string) => string;

const KW_CONVERSATION_KIND_PATTERN = /conversation|message|chat|talk|speech|interrupt/i;
const KW_WORLD_EVENT_KIND_PATTERN = /action|move|arriv|complete|finish|timeout|remind|event|server|world|idle|wake|sleep|choice|turn|login|logout/i;

/**
 * 既定の KW kind 写像。KW の通知種別一覧は「変わりうる詳細」なので網羅は狙わず、
 * 写像にない種別は unknown として必ず記録する（落とさない）。
 */
export const defaultKwKindMapper: KwKindMapper = (rawKind) => {
  if (KW_CONVERSATION_KIND_PATTERN.test(rawKind)) {
    return EVENT_KINDS.conversation;
  }
  if (KW_WORLD_EVENT_KIND_PATTERN.test(rawKind)) {
    return EVENT_KINDS.worldEvent;
  }
  return EVENT_KINDS.unknown;
};

/**
 * KW 通知種別からのエピソード境界判定（M3 の分節化前段ルール）。
 * イベント種別の判定を kind マッピングと同じ差し替え可能な写像側に置き、
 * KW の通知種別をコードに焼き付けない。写像にない種別は null（境界ではない）。
 */
export type KwBoundary = 'conversation_end' | 'action_end' | null;

const KW_CONVERSATION_END_PATTERN = /conversation_(end|closed|finish|timeout)|chat_end/i;
const KW_ACTION_END_PATTERN = /action_(complete|end|finish|done)|arriv/i;

export function classifyKwBoundary(rawKind: string | null | undefined): KwBoundary {
  if (rawKind == null) {
    return null;
  }
  if (KW_CONVERSATION_END_PATTERN.test(rawKind)) {
    return 'conversation_end';
  }
  if (KW_ACTION_END_PATTERN.test(rawKind)) {
    return 'action_end';
  }
  return null;
}

/** NormalizedEvent（KW 通知）から通知封筒の生 kind を取り出す */
export function extractKwRawKindFromEvent(event: NormalizedEvent): string | null {
  return extractKwRawKind(event.payload);
}

/**
 * own_action（KW コマンド）からの睡眠開始検出（M2 の前段ルール — #102）。
 * LLM は fell_asleep をほぼ出さない（実機 0/382）ため、行動 ID の写像で
 * 決定論に検出する。写像にない睡眠表現は LLM 判定に委ねる。
 */
const KW_SLEEP_ACTION_PATTERN = /sleep|nap|就寝|寝る/i;

export function detectKwSleepActionStart(event: NormalizedEvent): boolean {
  if (event.kind !== EVENT_KINDS.ownAction || !event.channel.startsWith('kw:')) {
    return false;
  }
  const payload = event.payload;
  if (typeof payload !== 'object' || payload == null) {
    return false;
  }
  const params = (payload as { params?: unknown }).params;
  if (typeof params !== 'object' || params == null) {
    return false;
  }
  const actionId = (params as { action_id?: unknown }).action_id;
  return typeof actionId === 'string' && KW_SLEEP_ACTION_PATTERN.test(actionId);
}

export interface NormalizeKwNotificationOptions {
  botId: string;
  /** get_notification のレスポンス封筒ごと逐語で。strict 検証はしない（未知フィールドも素通し） */
  notificationResponse: unknown;
  receivedAt: Date;
  kindMapper?: KwKindMapper;
}

export function normalizeKwNotification({
  botId,
  notificationResponse,
  receivedAt,
  kindMapper = defaultKwKindMapper,
}: NormalizeKwNotificationOptions): NormalizedEvent {
  const rawKind = extractKwRawKind(notificationResponse);
  const actor = extractKwActorFromPayload(notificationResponse);
  return {
    receivedAt,
    channel: kwChannel(botId),
    kind: rawKind != null ? kindMapper(rawKind) : EVENT_KINDS.unknown,
    ...(actor != null ? { actor } : {}),
    payload: notificationResponse,
  };
}

export interface NormalizeKwOwnActionOptions {
  botId: string;
  command: string;
  params: unknown;
  comment?: string | undefined;
  notificationId?: string | undefined;
  receivedAt: Date;
}

export function normalizeKwOwnAction({
  botId,
  command,
  params,
  comment,
  notificationId,
  receivedAt,
}: NormalizeKwOwnActionOptions): NormalizedEvent {
  return {
    receivedAt,
    channel: kwChannel(botId),
    kind: EVENT_KINDS.ownAction,
    payload: {
      command,
      params,
      ...(comment != null ? { comment } : {}),
      ...(notificationId != null ? { notification_id: notificationId } : {}),
    },
  };
}

export interface NormalizeKwFailedAttemptOptions {
  botId: string;
  command: string;
  params: unknown;
  comment?: string | undefined;
  /** informational 変換後の status（busy / same_node / stale 等） */
  status: string;
  /** サーバー hint（失敗理由の最重要情報） */
  hint?: string | undefined;
  notificationId?: string | undefined;
  receivedAt: Date;
}

/**
 * 実行されなかった KW コマンドの試み（#103 の informational 変換で案内へ落ちたもの）を
 * own_action と別種別で残す。実機で 409 ループが 19 時間続いた際、失敗が一切
 * 記録されず「毎サイクル失敗を初体験する」状態になったための軽量記録。
 */
export function normalizeKwFailedAttempt({
  botId,
  command,
  params,
  comment,
  status,
  hint,
  notificationId,
  receivedAt,
}: NormalizeKwFailedAttemptOptions): NormalizedEvent {
  return {
    receivedAt,
    channel: kwChannel(botId),
    kind: EVENT_KINDS.failedAttempt,
    payload: {
      command,
      params,
      status,
      ...(comment != null ? { comment } : {}),
      ...(hint != null ? { hint } : {}),
      ...(notificationId != null ? { notification_id: notificationId } : {}),
    },
  };
}

export interface NormalizeDiscordChatTurnOptions {
  userId: string;
  userName: string;
  text: string;
  sessionId: string;
  receivedAt: Date;
}

export function normalizeDiscordChatTurn({
  userId,
  userName,
  text,
  sessionId,
  receivedAt,
}: NormalizeDiscordChatTurnOptions): NormalizedEvent {
  return {
    receivedAt,
    channel: DISCORD_CHANNEL,
    kind: EVENT_KINDS.chatTurn,
    actor: `discord:${userId}`,
    payload: { userId, userName, text, sessionId },
  };
}

export interface NormalizeDiscordOwnResponseOptions {
  text: string;
  sessionId: string;
  inReplyToUserId?: string | undefined;
  receivedAt: Date;
}

export function normalizeDiscordOwnResponse({
  text,
  sessionId,
  inReplyToUserId,
  receivedAt,
}: NormalizeDiscordOwnResponseOptions): NormalizedEvent {
  return {
    receivedAt,
    channel: DISCORD_CHANNEL,
    kind: EVENT_KINDS.ownAction,
    payload: {
      text,
      sessionId,
      ...(inReplyToUserId != null ? { in_reply_to_user_id: `discord:${inReplyToUserId}` } : {}),
    },
  };
}

export interface NormalizeSnsNotificationOptions {
  provider: string;
  /** provider から届いた通知オブジェクトを逐語で */
  notification: unknown;
  receivedAt: Date;
}

export function normalizeSnsNotification({
  provider,
  notification,
  receivedAt,
}: NormalizeSnsNotificationOptions): NormalizedEvent {
  const accountId = extractStringField(notification, 'accountId');
  return {
    receivedAt,
    channel: snsChannel(provider),
    kind: EVENT_KINDS.snsEvent,
    ...(accountId != null ? { actor: `sns:${provider}:${accountId}` } : {}),
    payload: notification,
  };
}

export interface NormalizeSnsOwnActionOptions {
  provider: string;
  action: string;
  detail: unknown;
  receivedAt: Date;
}

export function normalizeSnsOwnAction({
  provider,
  action,
  detail,
  receivedAt,
}: NormalizeSnsOwnActionOptions): NormalizedEvent {
  return {
    receivedAt,
    channel: snsChannel(provider),
    kind: EVENT_KINDS.ownAction,
    payload: { action, detail },
  };
}

function extractKwRawKind(notificationResponse: unknown): string | null {
  const notification = extractObjectField(notificationResponse, 'notification');
  const kind = extractStringField(notification, 'kind');
  return kind ?? extractStringField(notificationResponse, 'kind') ?? null;
}

/**
 * KW payload からの best-effort な actor 抽出（reprocessing の遡及再導出でも使う）。
 * 規約: kw:agent:{id} / kw:npc:{id|name} / 型不明の文字列は kw:actor:{value}。
 * 同一性の統合（alias）は M6 の relations の仕事であり、ここでは行わない。
 */
export function extractKwActorFromPayload(notificationResponse: unknown): string | undefined {
  const notification = extractObjectField(notificationResponse, 'notification');
  const payload = extractObjectField(notification, 'payload')
    ?? extractObjectField(notificationResponse, 'payload');
  if (payload == null) {
    return undefined;
  }

  for (const field of ['actor', 'from', 'speaker', 'partner', 'sender', 'agent', 'npc']) {
    const candidate = payload[field];
    const actorId = kwActorIdFromCandidate(candidate, field);
    if (actorId != null) {
      return actorId;
    }
  }

  return undefined;
}

function kwActorIdFromCandidate(candidate: unknown, fieldName: string): string | undefined {
  if (typeof candidate === 'string' && candidate.trim().length > 0) {
    const value = candidate.trim();
    if (fieldName === 'agent') {
      return `kw:agent:${value}`;
    }
    if (fieldName === 'npc') {
      return `kw:npc:${value}`;
    }
    return `kw:actor:${value}`;
  }

  if (typeof candidate !== 'object' || candidate == null) {
    return undefined;
  }

  const record = candidate as Record<string, unknown>;
  const agentId = firstNonEmptyString(record.agent_id, record.agentId);
  if (agentId != null) {
    return `kw:agent:${agentId}`;
  }
  const npcId = firstNonEmptyString(record.npc_id, record.npcId);
  if (npcId != null) {
    return `kw:npc:${npcId}`;
  }
  const type = firstNonEmptyString(record.type);
  const id = firstNonEmptyString(record.id);
  if (type != null && id != null) {
    return `kw:${type}:${id}`;
  }
  // ID が無い・変わる相手（現行 KW でも NPC の ID は optional）には名前ベースのフォールバック
  const name = firstNonEmptyString(record.name);
  if (name != null) {
    return `kw:npc:${name}`;
  }
  return undefined;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function extractObjectField(value: unknown, field: string): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value == null) {
    return undefined;
  }
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === 'object' && candidate != null
    ? candidate as Record<string, unknown>
    : undefined;
}

function extractStringField(value: unknown, field: string): string | undefined {
  if (typeof value !== 'object' || value == null) {
    return undefined;
  }
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate : undefined;
}
