import { describe, expect, it } from 'vitest';

import {
  DISCORD_CHANNEL,
  defaultKwKindMapper,
  kwChannel,
  normalizeDiscordChatTurn,
  normalizeDiscordOwnResponse,
  normalizeKwNotification,
  normalizeKwOwnAction,
  normalizeSnsNotification,
  normalizeSnsOwnAction,
  snsChannel,
} from '../src/life/normalize.js';
import { EVENT_KINDS } from '../src/life/types.js';

const receivedAt = new Date('2026-07-05T12:00:00.000Z');

describe('defaultKwKindMapper', () => {
  it('maps conversation-like kinds to conversation', () => {
    expect(defaultKwKindMapper('conversation_start')).toBe(EVENT_KINDS.conversation);
    expect(defaultKwKindMapper('interrupt_message')).toBe(EVENT_KINDS.conversation);
  });

  it('maps world-event-like kinds to world_event', () => {
    expect(defaultKwKindMapper('action_complete')).toBe(EVENT_KINDS.worldEvent);
    expect(defaultKwKindMapper('idle_reminder')).toBe(EVENT_KINDS.worldEvent);
    expect(defaultKwKindMapper('server_event')).toBe(EVENT_KINDS.worldEvent);
  });

  it('falls back to unknown for unmapped kinds', () => {
    expect(defaultKwKindMapper('totally_new_notification_type')).toBe(EVENT_KINDS.unknown);
  });
});

describe('normalizeKwNotification', () => {
  it('keeps the whole envelope verbatim and maps the kind', () => {
    const notificationResponse = {
      ok: true,
      notification_id: 'n-1',
      stale: false,
      notification: {
        schema_version: 1,
        kind: 'conversation_start',
        summary: 'B さんが話しかけてきた',
        choices: [],
        payload: { from: { agent_id: 'agent-b', name: 'B' } },
        future_field: 'preserved',
      },
    };

    const event = normalizeKwNotification({ botId: 'bot-1', notificationResponse, receivedAt });
    expect(event.channel).toBe(kwChannel('bot-1'));
    expect(event.channel).toBe('kw:bot-1');
    expect(event.kind).toBe(EVENT_KINDS.conversation);
    expect(event.actor).toBe('kw:agent:agent-b');
    expect(event.payload).toBe(notificationResponse);
  });

  it('records unknown kinds without dropping the event', () => {
    const event = normalizeKwNotification({
      botId: 'bot-1',
      notificationResponse: { notification: { kind: 'brand_new_mystery', choices: [] } },
      receivedAt,
    });
    expect(event.kind).toBe(EVENT_KINDS.unknown);
    expect(event.payload).toEqual({ notification: { kind: 'brand_new_mystery', choices: [] } });
  });

  it('handles envelopes without a kind at all', () => {
    const event = normalizeKwNotification({
      botId: 'bot-1',
      notificationResponse: { some: 'unexpected shape' },
      receivedAt,
    });
    expect(event.kind).toBe(EVENT_KINDS.unknown);
    expect(event.actor).toBeUndefined();
  });

  it('extracts npc actors with name fallback when no id exists', () => {
    const event = normalizeKwNotification({
      botId: 'bot-1',
      notificationResponse: {
        notification: {
          kind: 'conversation_start',
          payload: { speaker: { type: 'npc', name: '店主' } },
        },
      },
      receivedAt,
    });
    expect(event.actor).toBe('kw:npc:店主');
  });

  it('extracts typed ids and plain string actors', () => {
    const typed = normalizeKwNotification({
      botId: 'bot-1',
      notificationResponse: { notification: { kind: 'x_message', payload: { from: { type: 'npc', id: 'npc-7' } } } },
      receivedAt,
    });
    expect(typed.actor).toBe('kw:npc:npc-7');

    const plain = normalizeKwNotification({
      botId: 'bot-1',
      notificationResponse: { notification: { kind: 'x_message', payload: { from: 'somebody' } } },
      receivedAt,
    });
    expect(plain.actor).toBe('kw:actor:somebody');
  });
});

describe('normalizeKwOwnAction', () => {
  it('records the issued command as own_action', () => {
    const event = normalizeKwOwnAction({
      botId: 'bot-1',
      command: 'conversation_start',
      params: { target: 'agent-b' },
      comment: '映画に誘ってみよう',
      notificationId: 'n-1',
      receivedAt,
    });
    expect(event.channel).toBe('kw:bot-1');
    expect(event.kind).toBe(EVENT_KINDS.ownAction);
    expect(event.payload).toEqual({
      command: 'conversation_start',
      params: { target: 'agent-b' },
      comment: '映画に誘ってみよう',
      notification_id: 'n-1',
    });
  });
});

describe('Discord normalizers', () => {
  it('normalizes a user chat turn with discord actor convention', () => {
    const event = normalizeDiscordChatTurn({
      userId: 'user-1',
      userName: 'Kohei',
      text: 'こんにちは',
      sessionId: 'thread-1',
      receivedAt,
    });
    expect(event.channel).toBe(DISCORD_CHANNEL);
    expect(event.kind).toBe(EVENT_KINDS.chatTurn);
    expect(event.actor).toBe('discord:user-1');
    expect(event.payload).toEqual({
      userId: 'user-1',
      userName: 'Kohei',
      text: 'こんにちは',
      sessionId: 'thread-1',
    });
  });

  it('normalizes own responses as own_action', () => {
    const event = normalizeDiscordOwnResponse({
      text: 'こんにちは！',
      sessionId: 'thread-1',
      inReplyToUserId: 'user-1',
      receivedAt,
    });
    expect(event.kind).toBe(EVENT_KINDS.ownAction);
    expect(event.payload).toEqual({
      text: 'こんにちは！',
      sessionId: 'thread-1',
      in_reply_to_user_id: 'discord:user-1',
    });
  });
});

describe('SNS normalizers', () => {
  it('normalizes provider notifications with sns actor convention', () => {
    const notification = {
      id: 'notif-1',
      type: 'mention',
      accountId: 'acct-9',
      accountHandle: 'alice',
      post: { id: 'p1', text: 'hi' },
    };
    const event = normalizeSnsNotification({ provider: 'mastodon', notification, receivedAt });
    expect(event.channel).toBe(snsChannel('mastodon'));
    expect(event.kind).toBe(EVENT_KINDS.snsEvent);
    expect(event.actor).toBe('sns:mastodon:acct-9');
    expect(event.payload).toBe(notification);
  });

  it('normalizes own SNS actions', () => {
    const event = normalizeSnsOwnAction({
      provider: 'elyth',
      action: 'post',
      detail: { post_id: 'p1', text: '今日はいい天気' },
      receivedAt,
    });
    expect(event.channel).toBe('sns:elyth');
    expect(event.kind).toBe(EVENT_KINDS.ownAction);
    expect(event.payload).toEqual({ action: 'post', detail: { post_id: 'p1', text: '今日はいい天気' } });
  });
});
