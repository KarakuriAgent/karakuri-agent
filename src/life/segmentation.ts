/**
 * エピソード分節化（event segmentation）— M3。
 *
 * 体験は複数イベントにまたがるため「開いたエピソード（ドラフト）」を持つ。
 * 判定機構は 3 段:
 * 1. 前段ルール（LLM に聞かない）: 会話終了イベント→強制 close、睡眠開始→全 close。
 *    イベント種別の判定は kind マッピング側（normalize.ts）の差し替え可能な写像
 * 2. LLM 判定: 統合 appraisal の segmentation 出力（open/continue/close/close_and_open/oneshot）
 * 3. 後段ガードレール: 最大ビート数 / 最大継続時間で強制 close（LLM は continue を
 *    選びがち。エピソードが開いたままにならない決定論の安全弁）
 *
 * 割り込み中の並行エピソード: 行動（action）と会話（conversation:{thread}）は
 * 別ドラフトとして並行して開く。ドラフトは永続化され、クラッシュ後は
 * 「中断された体験」として機械的に close する。
 */

import { createLogger } from '../utils/logger.js';
import type { GuardedAppraisal } from './appraisal.js';
import type { EpisodeDraft, IEpisodeStore } from './episodes.js';
import { classifyKwBoundary, extractKwRawKindFromEvent } from './normalize.js';
import { EVENT_KINDS, type NormalizedEvent } from './types.js';

const logger = createLogger('SegmentationEngine');

export const SEGMENTATION_DEFAULTS = {
  /** ドラフトの最大ビート数。超えたら強制 close */
  maxBeats: 30,
  /** ドラフトの最大継続時間（時間）。超えたら強制 close */
  maxDraftHours: 12,
  /** salience → importance の基準値 */
  importanceByLabel: { low: 0.3, medium: 0.6, high: 0.9 } as Record<string, number>,
} as const;

export interface SegmentationEngineOptions {
  episodeStore: IEpisodeStore;
  procVersion: string;
  maxBeats?: number | undefined;
  maxDraftHours?: number | undefined;
  /** エピソード確定時に呼ばれる（埋め込み付与などの後処理）。失敗しても確定は成立する */
  onEpisodeFinalized?: ((episodeId: number, body: string) => void) | undefined;
}

export interface SegmentationEventInput {
  event: NormalizedEvent;
  eventId?: number | undefined;
  guarded: GuardedAppraisal;
}

export class SegmentationEngine {
  private readonly store: IEpisodeStore;
  private readonly procVersion: string;
  private readonly maxBeats: number;
  private readonly maxDraftHours: number;
  private readonly onEpisodeFinalized: ((episodeId: number, body: string) => void) | undefined;

  constructor({
    episodeStore,
    procVersion,
    maxBeats = SEGMENTATION_DEFAULTS.maxBeats,
    maxDraftHours = SEGMENTATION_DEFAULTS.maxDraftHours,
    onEpisodeFinalized,
  }: SegmentationEngineOptions) {
    this.store = episodeStore;
    this.procVersion = procVersion;
    this.maxBeats = maxBeats;
    this.maxDraftHours = maxDraftHours;
    this.onEpisodeFinalized = onEpisodeFinalized;
  }

  /** appraisal の入力文脈用: このイベントに関係する開いたドラフトの要約を返す */
  async getOpenDraftsFor(event: NormalizedEvent): Promise<Array<{ target: 'action' | 'conversation'; startedAt: string; beats: string[] }>> {
    const drafts = await this.store.listDrafts();
    return drafts
      .filter((draft) => draft.channel === event.channel)
      .map((draft) => ({
        target: draft.threadKey.startsWith('conversation') ? 'conversation' as const : 'action' as const,
        startedAt: draft.startedAt,
        beats: draft.beats.map((beat) => beat.text),
      }));
  }

  /** イベント 1 件ぶんの分節化を適用する。失敗は上位（AppraisalService）で吸収される */
  async handleEvent({ event, eventId, guarded }: SegmentationEventInput): Promise<void> {
    const receivedAtIso = event.receivedAt.toISOString();

    // 1. 前段ルール（決定論）
    const rawKind = event.channel.startsWith('kw:') ? extractKwRawKindFromEvent(event) : null;
    const boundary = classifyKwBoundary(rawKind);
    if (guarded.sleep === 'fell_asleep') {
      await this.closeAllDrafts(event.channel, receivedAtIso, guarded);
    } else if (boundary === 'conversation_end') {
      const threadKey = this.conversationThreadKey(event);
      await this.forceClose(event.channel, threadKey, receivedAtIso, guarded, 'conversation_end');
    }

    // 2. LLM 判定（appraisal の segmentation 出力）
    for (const decision of guarded.segmentation) {
      await this.applyDecision(event, eventId, guarded, decision, receivedAtIso);
    }

    // 3. 後段ガードレール: 最大ビート数 / 最大継続時間で強制 close
    await this.enforceLimits(event.channel, event.receivedAt, guarded);
  }

  /**
   * クラッシュ回復・起動時処理: 最大継続時間を超えたドラフトを
   * 「中断された体験」として機械的に close する。
   * channels を渡すと該当チャネルのドラフトのみ対象にする
   * （reprocessing がリプレイ対象外の生きたドラフトを閉じないため）。
   */
  async recoverStaleDrafts(now: Date, channels?: string[]): Promise<number> {
    const allDrafts = await this.store.listDrafts();
    const drafts = channels != null
      ? allDrafts.filter((draft) => channels.includes(draft.channel))
      : allDrafts;
    let closed = 0;
    for (const draft of drafts) {
      const ageHours = Math.max(0, (now.getTime() - new Date(draft.lastEventAt).getTime()) / 3_600_000);
      if (ageHours >= this.maxDraftHours) {
        await this.finalizeDraft(draft, buildMechanicalBody(draft, '（この体験は途中で途切れた）'), null, now.toISOString());
        closed += 1;
      }
    }
    if (closed > 0) {
      logger.info('Recovered stale episode drafts', { closed });
    }
    return closed;
  }

  private conversationThreadKey(event: NormalizedEvent): string {
    return `conversation:${event.actor ?? 'unknown'}`;
  }

  private threadKeyFor(event: NormalizedEvent, target: 'action' | 'conversation'): string {
    return target === 'conversation' ? this.conversationThreadKey(event) : 'action';
  }

  private async applyDecision(
    event: NormalizedEvent,
    eventId: number | undefined,
    guarded: GuardedAppraisal,
    decision: GuardedAppraisal['segmentation'][number],
    receivedAtIso: string,
  ): Promise<void> {
    const threadKey = this.threadKeyFor(event, decision.target);
    const existing = await this.store.getDraft(event.channel, threadKey);

    switch (decision.decision) {
      case 'open': {
        if (existing != null) {
          // 既にドラフトがある場合は continue として扱う（重複 open の矯正）
          await this.appendBeat(existing, event, eventId, guarded, decision.beat, receivedAtIso);
          return;
        }
        await this.openDraft(event, eventId, guarded, threadKey, decision.beat, receivedAtIso);
        return;
      }
      case 'continue': {
        if (existing == null) {
          // 存在しないドラフトへの判定: open として救済する（ビートを失わない）
          await this.openDraft(event, eventId, guarded, threadKey, decision.beat, receivedAtIso);
          return;
        }
        await this.appendBeat(existing, event, eventId, guarded, decision.beat, receivedAtIso);
        return;
      }
      case 'close': {
        if (existing == null) {
          logger.debug('Close decision for a nonexistent draft rejected', { threadKey });
          return;
        }
        await this.closeDraft(existing, event, eventId, guarded, decision, receivedAtIso);
        return;
      }
      case 'close_and_open': {
        if (existing != null) {
          await this.closeDraft(existing, event, eventId, guarded, decision, receivedAtIso);
        }
        await this.openDraft(event, eventId, guarded, threadKey, decision.beat, receivedAtIso);
        return;
      }
      case 'oneshot': {
        const body = decision.final_body?.trim();
        if (body == null || body.length === 0) {
          logger.debug('Oneshot decision without final_body rejected');
          return;
        }
        const episodeId = await this.store.insert({
          occurredAt: receivedAtIso,
          channel: event.channel,
          body,
          importance: this.resolveImportance(decision.final_importance, [guarded.deltas.valence]),
          emotion: { valenceDeltas: [guarded.deltas.valence] },
          participants: event.actor != null ? [event.actor] : [],
          provenance: eventId != null ? [eventId] : [],
          procVersion: this.procVersion,
        });
        this.onEpisodeFinalized?.(episodeId, body);
        return;
      }
      default:
        return;
    }
  }

  private async openDraft(
    event: NormalizedEvent,
    eventId: number | undefined,
    guarded: GuardedAppraisal,
    threadKey: string,
    beat: string | undefined,
    receivedAtIso: string,
  ): Promise<void> {
    const beatText = beat?.trim();
    if (beatText == null || beatText.length === 0) {
      logger.debug('Open decision without beat rejected', { threadKey });
      return;
    }
    await this.store.upsertDraft({
      channel: event.channel,
      threadKey,
      startedAt: receivedAtIso,
      lastEventAt: receivedAtIso,
      beats: [{ at: receivedAtIso, text: beatText }],
      participants: event.actor != null ? [event.actor] : [],
      emotions: [guarded.deltas.valence],
      provenance: eventId != null ? [eventId] : [],
    });
  }

  private async appendBeat(
    draft: EpisodeDraft,
    event: NormalizedEvent,
    eventId: number | undefined,
    guarded: GuardedAppraisal,
    beat: string | undefined,
    receivedAtIso: string,
  ): Promise<void> {
    const beatText = beat?.trim();
    await this.store.upsertDraft({
      channel: draft.channel,
      threadKey: draft.threadKey,
      startedAt: draft.startedAt,
      lastEventAt: receivedAtIso,
      beats: beatText != null && beatText.length > 0
        ? [...draft.beats, { at: receivedAtIso, text: beatText }]
        : draft.beats,
      // participants は actor（規約 ID）から機械的に取る。LLM の出す名前は使わない
      participants: mergeParticipants(draft.participants, event.actor),
      emotions: [...draft.emotions, guarded.deltas.valence],
      provenance: eventId != null ? [...draft.provenance, eventId] : draft.provenance,
    });
  }

  private async closeDraft(
    draft: EpisodeDraft,
    event: NormalizedEvent,
    eventId: number | undefined,
    guarded: GuardedAppraisal,
    decision: GuardedAppraisal['segmentation'][number],
    receivedAtIso: string,
  ): Promise<void> {
    const withFinalBeat: EpisodeDraft = {
      ...draft,
      beats: decision.beat != null && decision.beat.trim().length > 0
        ? [...draft.beats, { at: receivedAtIso, text: decision.beat.trim() }]
        : draft.beats,
      participants: mergeParticipants(draft.participants, event.actor),
      emotions: [...draft.emotions, guarded.deltas.valence],
      provenance: eventId != null ? [...draft.provenance, eventId] : draft.provenance,
    };
    const body = decision.final_body?.trim();
    await this.finalizeDraft(
      withFinalBeat,
      body != null && body.length > 0 ? body : buildMechanicalBody(withFinalBeat),
      decision.final_importance ?? null,
      receivedAtIso,
    );
  }

  private async closeAllDrafts(channel: string, receivedAtIso: string, _guarded: GuardedAppraisal): Promise<void> {
    const drafts = await this.store.listDrafts();
    for (const draft of drafts.filter((candidate) => candidate.channel === channel)) {
      await this.finalizeDraft(draft, buildMechanicalBody(draft), null, receivedAtIso);
    }
  }

  private async forceClose(
    channel: string,
    threadKey: string,
    receivedAtIso: string,
    _guarded: GuardedAppraisal,
    reason: string,
  ): Promise<void> {
    const draft = await this.store.getDraft(channel, threadKey);
    if (draft == null) {
      return;
    }
    logger.debug('Force closing draft (front rule)', { channel, threadKey, reason });
    await this.finalizeDraft(draft, buildMechanicalBody(draft), null, receivedAtIso);
  }

  private async enforceLimits(channel: string, receivedAt: Date, _guarded: GuardedAppraisal): Promise<void> {
    const drafts = await this.store.listDrafts();
    for (const draft of drafts.filter((candidate) => candidate.channel === channel)) {
      // 未読キュー経由（M8）の過去時刻イベントで負にならないようクランプする
      const ageHours = Math.max(0, (receivedAt.getTime() - new Date(draft.startedAt).getTime()) / 3_600_000);
      if (draft.beats.length >= this.maxBeats || ageHours >= this.maxDraftHours) {
        logger.info('Force closing draft (guardrail limit)', {
          channel,
          threadKey: draft.threadKey,
          beats: draft.beats.length,
          ageHours: Math.round(ageHours * 10) / 10,
        });
        await this.finalizeDraft(draft, buildMechanicalBody(draft), null, receivedAt.toISOString());
      }
    }
  }

  /** ドラフトをエピソードとして確定し、ドラフトを消す */
  private async finalizeDraft(
    draft: EpisodeDraft,
    body: string,
    importanceLabel: string | null,
    _closedAtIso: string,
  ): Promise<void> {
    const importance = this.resolveImportance(importanceLabel, draft.emotions);
    const episodeId = await this.store.insert({
      occurredAt: draft.startedAt,
      channel: draft.channel,
      body,
      importance,
      emotion: { valenceDeltas: draft.emotions },
      participants: draft.participants,
      provenance: draft.provenance,
      procVersion: this.procVersion,
    });
    await this.store.deleteDraft(draft.channel, draft.threadKey);
    logger.debug('Episode finalized from draft', { episodeId, threadKey: draft.threadKey, importance });
    this.onEpisodeFinalized?.(episodeId, body);
  }

  /** 重要度 = ラベル基準値と感情推移のピーク/累積の大きい方 */
  private resolveImportance(label: string | null | undefined, valenceDeltas: number[]): number {
    const base = label != null
      ? SEGMENTATION_DEFAULTS.importanceByLabel[label] ?? 0.3
      : 0.3;
    const peak = valenceDeltas.reduce((max, delta) => Math.max(max, Math.abs(delta)), 0);
    const cumulative = Math.abs(valenceDeltas.reduce((sum, delta) => sum + delta, 0));
    const emotional = Math.min(1, Math.max(peak * 2, cumulative));
    return Math.min(1, Math.max(base, emotional));
  }
}

function mergeParticipants(participants: string[], actor: string | undefined): string[] {
  if (actor == null || participants.includes(actor)) {
    return participants;
  }
  return [...participants, actor];
}

/** LLM を介さない機械的な確定本文（強制 close・クラッシュ回復用） */
function buildMechanicalBody(draft: EpisodeDraft, suffix?: string): string {
  const beats = draft.beats.map((beat) => beat.text).join('。');
  const body = beats.length > 0 ? `${beats}。` : '何があったかの記録は残っていない。';
  return suffix != null ? `${body}${suffix}` : body;
}

/** unknown 種別も含め、分節化対象になりうるイベントか（own_action は自分の行動として対象） */
export function isSegmentableEvent(event: NormalizedEvent): boolean {
  return event.kind !== EVENT_KINDS.seed;
}
