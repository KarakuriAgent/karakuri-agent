/**
 * experience_log の区間リプレイ評価 CLI（M2）。
 *
 * 過去ログの範囲に appraisal を実行し、判定（状態Δ / サリエンス / 抽出 / 棄却）を
 * 人間がレビューできる形で出力する。状態には一切適用しない（dry-run）。
 * M7 Reprocessor の縮小版・先取りであり、品質実測・プロンプト改良の共通基盤になる。
 *
 * 使い方:
 *   npx tsx src/life/replay-appraisal.ts [--from ISO8601] [--to ISO8601] [--limit N] [--channel CH]
 *
 * モデルは LLM_APPRAISAL_MODEL（未指定は LLM_MODEL）を使う。
 */

import { pathToFileURL } from 'node:url';

import { loadConfig } from '../config.js';
import { createConfiguredOpenAiModelFactory } from '../llm/model-selector.js';
import { createNoThinkingFetch, noThinkingProviderOptions } from '../llm/no-thinking-fetch.js';
import {
  applyAppraisalGuardrails,
  appraisalEventText,
  appraiseEvent,
  isIdleAppraisalEvent,
} from './appraisal.js';
import { openLifeDatabase } from './db.js';
import { defaultInnerState, describeInnerState } from './inner-state.js';
import { buildAppraisalProcVersion } from './tuning.js';

interface ReplayArgs {
  from?: string;
  to?: string;
  channel?: string;
  limit: number;
}

function parseArgs(argv: string[]): ReplayArgs {
  const args: ReplayArgs = { limit: 20 };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--from':
        if (value != null) {
          args.from = value;
          i += 1;
        }
        break;
      case '--to':
        if (value != null) {
          args.to = value;
          i += 1;
        }
        break;
      case '--channel':
        if (value != null) {
          args.channel = value;
          i += 1;
        }
        break;
      case '--limit':
        if (value != null) {
          args.limit = Math.max(1, Number(value) || 20);
          i += 1;
        }
        break;
      default:
        break;
    }
  }
  return args;
}

interface ReplayRow {
  id: number;
  received_at: string;
  channel: string;
  kind: string;
  payload: string;
}

export async function runReplay(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const config = loadConfig();
  const db = openLifeDatabase({ dataDir: config.dataDir });

  const conditions: string[] = [];
  const parameters: Array<string | number> = [];
  if (args.from != null) {
    conditions.push('received_at >= ?');
    parameters.push(args.from);
  }
  if (args.to != null) {
    conditions.push('received_at <= ?');
    parameters.push(args.to);
  }
  if (args.channel != null) {
    conditions.push('channel = ?');
    parameters.push(args.channel);
  }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare<Array<string | number>, ReplayRow>(`
    SELECT id, received_at, channel, kind, payload
    FROM experience_log
    ${whereClause}
    ORDER BY id ASC
    LIMIT ?
  `).all(...parameters, args.limit);

  if (rows.length === 0) {
    console.log('No experience_log rows matched.');
    db.close();
    return;
  }

  const selector = config.appraisalLlmModelSelector ?? config.llmModelSelector;
  const modelFactory = createConfiguredOpenAiModelFactory({
    apiKey: config.appraisalLlmApiKey ?? config.llmApiKey,
    ...((config.appraisalLlmBaseUrl ?? config.llmBaseUrl) != null
      ? { baseURL: config.appraisalLlmBaseUrl ?? config.llmBaseUrl }
      : {}),
    fetch: createNoThinkingFetch({
      disableThinkingRequestParam: config.llmDisableThinkingRequestParam,
    }),
  });
  const model = modelFactory(selector);
  const procVersion = buildAppraisalProcVersion(selector.selector);
  const neutralState = describeInnerState(defaultInnerState(new Date()));

  console.log(`Replaying ${rows.length} events with ${procVersion} (dry-run; no state is applied)\n`);

  for (const row of rows) {
    let parsedPayload: unknown;
    try {
      parsedPayload = JSON.parse(row.payload);
    } catch {
      parsedPayload = row.payload;
    }

    try {
      const output = await appraiseEvent({
        model,
        event: {
          receivedAt: new Date(row.received_at),
          channel: row.channel,
          kind: row.kind,
          payload: parsedPayload,
        },
        currentStateDescription: neutralState,
        providerOptions: noThinkingProviderOptions(selector.api),
        abortSignal: AbortSignal.timeout(60_000),
      });
      if (output == null) {
        console.log(`#${row.id} [${row.received_at}] ${row.channel}/${row.kind} → (no structured output)`);
        continue;
      }
      const guarded = applyAppraisalGuardrails(output, undefined, {
        eventKind: row.kind,
        eventText: appraisalEventText(parsedPayload),
        idleEvent: isIdleAppraisalEvent({
          receivedAt: new Date(row.received_at),
          channel: row.channel,
          kind: row.kind,
          payload: parsedPayload,
        }),
      });
      console.log([
        `#${row.id} [${row.received_at}] ${row.channel}/${row.kind}`,
        `  deltas: valence=${guarded.deltas.valence.toFixed(3)} energy=${guarded.deltas.energy.toFixed(3)} hunger=${guarded.deltas.hunger.toFixed(3)} social=${guarded.deltas.social.toFixed(3)} sleep=${guarded.sleep}`,
        `  salience: ${guarded.salience}`,
        guarded.relationCandidates.length > 0 ? `  relations: ${JSON.stringify(guarded.relationCandidates)}` : null,
        guarded.prospectCandidates.length > 0 ? `  prospects: ${JSON.stringify(guarded.prospectCandidates)}` : null,
        guarded.rejections.length > 0 ? `  rejections: ${JSON.stringify(guarded.rejections)}` : null,
      ].filter((line): line is string => line != null).join('\n'));
    } catch (error) {
      console.log(`#${row.id} [${row.received_at}] ${row.channel}/${row.kind} → FAILED: ${error instanceof Error ? error.message : error}`);
    }
  }

  db.close();
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runReplay(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
