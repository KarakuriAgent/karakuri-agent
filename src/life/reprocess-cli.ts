/**
 * reprocessing 運用 CLI（M7）。
 *
 * 使い方:
 *   npx tsx src/life/reprocess-cli.ts --from 2026-06-01T00:00:00Z --to 2026-07-01T00:00:00Z [--target episodes] [--rederive] [--reembed] [--dry-run]
 *
 * - --target episodes: 期間内の episodes を破棄して experience_log からリプレイ再構築
 * - --rederive:        KW イベントの kind / actor 索引を現行の写像・抽出ルールで遡及再導出
 * - --reembed:         全 episodes を現行の埋め込みモデルで再埋め込み（vec テーブル作り直し）
 * - --dry-run:         件数レポートのみ（書き込みなし）
 *
 * オフライン一括での実行を推奨（進行中の運用と干渉しない）。appraisal は
 * LLM_APPRAISAL_MODEL を使い、区間リプレイ評価（replay-appraisal.ts）と共通の基盤に立つ。
 */

import { pathToFileURL } from 'node:url';

import { loadConfig } from '../config.js';
import { createConfiguredOpenAiModelFactory } from '../llm/model-selector.js';
import { createNoThinkingFetch, noThinkingProviderOptions } from '../llm/no-thinking-fetch.js';
import { applyAppraisalGuardrails, appraisalEventText, appraiseEvent, resolveSleepTransition } from './appraisal.js';
import { openLifeDatabase } from './db.js';
import { OpenAiEmbeddingProvider } from './embeddings.js';
import { SqliteEpisodeStore } from './episodes.js';
import { SqliteExperienceLogStore } from './experience-log.js';
import { toUtcIso } from '../utils/date.js';
import { defaultInnerState, describeInnerState } from './inner-state.js';
import { reembedAllEpisodes, rederiveKwEventIndexes, Reprocessor } from './reprocess.js';
import { buildAppraisalProcVersion } from './tuning.js';

interface CliArgs {
  from?: string;
  to?: string;
  target?: string;
  rederive: boolean;
  reembed: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { rederive: false, reembed: false, dryRun: false };
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
      case '--target':
        if (value != null) {
          args.target = value;
          i += 1;
        }
        break;
      case '--rederive':
        args.rederive = true;
        break;
      case '--reembed':
        args.reembed = true;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      default:
        break;
    }
  }
  return args;
}

export async function runReprocessCli(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const config = loadConfig();
  const db = openLifeDatabase({ dataDir: config.dataDir });
  const experienceLogStore = new SqliteExperienceLogStore({ db });
  const episodeStore = new SqliteEpisodeStore({ db });

  try {
    // 境界は CLI の入口で一度だけ UTC ISO へ正規化する。レポートの countBetween /
    // listByPeriod も保存値との辞書順比較なので、オフセット形式のまま渡すと
    // レポートと実際の破壊的操作が異なる範囲を見てしまう
    const from = toUtcIso(args.from ?? '1970-01-01T00:00:00.000Z');
    const to = toUtcIso(args.to ?? new Date().toISOString());

    // 差分レポート（前）。件数は listBetween の limit に切られない countBetween で数える
    const eventsInRange = await experienceLogStore.countBetween(from, to);
    const episodesBefore = (await episodeStore.listByPeriod(from, to)).length;
    console.log(`Range: ${from} 〜 ${to}`);
    console.log(`- experience_log events in range: ${eventsInRange}`);
    console.log(`- episodes in range (before): ${episodesBefore}`);

    if (args.dryRun) {
      console.log('(dry-run: 何も変更しません)');
      return;
    }

    if (args.rederive) {
      // 単一スキャンで kind / actor 両索引を再導出する
      const rederived = rederiveKwEventIndexes(db, from, to);
      console.log(`- kind rederived: ${rederived.kinds} events`);
      console.log(`- actor rederived: ${rederived.actors} events`);
    }

    if (args.target === 'episodes') {
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
      const neutralState = describeInnerState(defaultInnerState(new Date()));
      const reprocessor = new Reprocessor({
        experienceLogStore,
        episodeStore,
        procVersion: buildAppraisalProcVersion(selector.selector),
        appraise: async (event) => {
          const output = await appraiseEvent({
            model,
            event,
            currentStateDescription: neutralState,
            providerOptions: noThinkingProviderOptions(selector.api),
            abortSignal: AbortSignal.timeout(60_000),
          });
          if (output == null) {
            return null;
          }
          const guarded = applyAppraisalGuardrails(output, undefined, {
            eventKind: event.kind,
            eventText: appraisalEventText(event.payload),
          });
          // 睡眠アクションの決定論検出（#102）: 稼働時の core.ts 発行時フックと
          // 分節化境界（fell_asleep → 全ドラフト close）の判定を揃える。
          // 経路依存の sleeping 状態はリプレイで追跡しないため stateless な規則のみ
          const sleepResolution = resolveSleepTransition(event, false, guarded.sleep);
          return sleepResolution.sleep !== guarded.sleep
            ? { ...guarded, sleep: sleepResolution.sleep, deltas: { ...guarded.deltas, energy: Math.max(0, guarded.deltas.energy) } }
            : guarded;
        },
      });
      const result = await reprocessor.reprocessEpisodes(from, to);
      console.log(`- episodes deleted: ${result.deletedEpisodes} (straddling protected: ${result.protectedEpisodes}, drafts cleared: ${result.clearedDrafts})`);
      console.log(`- events replayed: ${result.replayedEvents} (skipped as protected: ${result.skippedEvents}, appraisal failures: ${result.appraisalFailures})`);
      console.log(`- episodes created: ${result.createdEpisodes}`);
    }

    if (args.reembed) {
      if (config.embeddingModel == null) {
        console.log('- reembed skipped: EMBEDDING_MODEL is not configured');
      } else {
        const provider = new OpenAiEmbeddingProvider({
          model: config.embeddingModel,
          apiKey: config.embeddingApiKey ?? config.llmApiKey,
          baseURL: config.embeddingBaseUrl ?? config.llmBaseUrl,
        });
        const { result } = await reembedAllEpisodes(db, provider, config.embeddingDimensions);
        console.log(`- re-embedded: ${result.indexed}/${result.queued} episodes`);
      }
    }

    const episodesAfter = (await episodeStore.listByPeriod(from, to)).length;
    console.log(`- episodes in range (after): ${episodesAfter}`);
  } finally {
    if (db.open) {
      db.close();
    }
  }
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runReprocessCli(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
