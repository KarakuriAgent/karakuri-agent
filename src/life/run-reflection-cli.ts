/**
 * 省察の手動実行 CLI（M4）。
 *
 * 夜間スケジューラが失敗したまま日付が進むと、その日の日次省察（週次・月次も同型）は
 * 通常経路では二度と実行されない。この CLI は指定した対象を単発実行し、
 * 実行済みマークは前進方向のみ更新する（スケジューラの進行を巻き戻さない）。
 *
 * 使い方（稼働プロセスは止めて実行を推奨 — 書き込みが競合しないように）:
 *   npx tsx src/life/run-reflection-cli.ts --daily 2026-07-20
 *   npx tsx src/life/run-reflection-cli.ts --weekly 2026-07-19   # 週の最終日（日曜）を指定
 *   npx tsx src/life/run-reflection-cli.ts --monthly 2026-06     # 対象月
 *
 * モデル・出力モードは LLM_REFLECTION_*（未指定は LLM_MODEL）を使う。
 */

import { pathToFileURL } from 'node:url';

import { loadConfig } from '../config.js';
import { createConfiguredOpenAiModelFactory } from '../llm/model-selector.js';
import { createNoThinkingFetch, noThinkingProviderOptions } from '../llm/no-thinking-fetch.js';
import { shiftDateString } from '../utils/date.js';
import { SqliteBeliefStore } from './beliefs.js';
import { getLifeMeta, openLifeDatabase, setLifeMeta } from './db.js';
import { SqliteEpisodeStore } from './episodes.js';
import { InnerStateService, SqliteInnerStateStore } from './inner-state.js';
import { SqliteNarrativeStore } from './narratives.js';
import { SqliteProspectStore } from './prospects.js';
import { buildReflectionProcVersion, ReflectionEngine } from './reflection.js';
import { isoWeekKey, META_DAILY, META_MONTHLY, META_WEEKLY } from './reflection-runner.js';
import { applyTraitsToTuning, loadTraits } from './traits.js';

interface CliArgs {
  daily?: string;
  weekly?: string;
  monthly?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--daily':
        if (value != null) {
          args.daily = value;
          i += 1;
        }
        break;
      case '--weekly':
        if (value != null) {
          args.weekly = value;
          i += 1;
        }
        break;
      case '--monthly':
        if (value != null) {
          args.monthly = value;
          i += 1;
        }
        break;
      default:
        break;
    }
  }
  return args;
}

/**
 * マークは前進方向のみ更新する（過去分の手動回収でスケジューラを巻き戻さない）。
 * 週キー（YYYY-Wn）は週番号がゼロ埋めされておらず辞書順比較が壊れるため、
 * toOrdinal で数値化してから比較する
 */
function advanceMeta(
  db: ReturnType<typeof openLifeDatabase>,
  key: string,
  value: string,
  toOrdinal: (value: string) => string | number = (v) => v,
): void {
  const current = getLifeMeta(db, key);
  if (current == null || toOrdinal(current) < toOrdinal(value)) {
    setLifeMeta(db, key, value);
    console.log(`  mark ${key}: ${current ?? '(none)'} → ${value}`);
  } else {
    console.log(`  mark ${key}: ${current} のまま（対象 ${value} は過去方向）`);
  }
}

function weekKeyOrdinal(key: string): number {
  const match = /^(\d{4})-W(\d+)$/.exec(key);
  return match ? Number(match[1]) * 100 + Number(match[2]) : -1;
}

export async function runReflectionCli(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.daily == null && args.weekly == null && args.monthly == null) {
    console.log('Usage: npx tsx src/life/run-reflection-cli.ts --daily YYYY-MM-DD | --weekly YYYY-MM-DD(週の最終日) | --monthly YYYY-MM');
    return;
  }
  if (args.daily != null && !/^\d{4}-\d{2}-\d{2}$/.test(args.daily)) {
    throw new Error(`--daily は YYYY-MM-DD 形式で指定する: ${args.daily}`);
  }
  if (args.weekly != null && !/^\d{4}-\d{2}-\d{2}$/.test(args.weekly)) {
    throw new Error(`--weekly は YYYY-MM-DD 形式（週の最終日）で指定する: ${args.weekly}`);
  }
  if (args.monthly != null && !/^\d{4}-\d{2}$/.test(args.monthly)) {
    throw new Error(`--monthly は YYYY-MM 形式で指定する: ${args.monthly}`);
  }

  const config = loadConfig();
  const db = openLifeDatabase({ dataDir: config.dataDir });
  const selector = config.reflectionLlmModelSelector ?? config.llmModelSelector;
  const modelFactory = createConfiguredOpenAiModelFactory({
    apiKey: config.reflectionLlmApiKey ?? config.llmApiKey,
    ...((config.reflectionLlmBaseUrl ?? config.llmBaseUrl) != null
      ? { baseURL: config.reflectionLlmBaseUrl ?? config.llmBaseUrl }
      : {}),
    fetch: createNoThinkingFetch({
      disableThinkingRequestParam: config.llmDisableThinkingRequestParam,
    }),
  });
  const traits = loadTraits(config.dataDir);
  const innerStateService = new InnerStateService({
    store: new SqliteInnerStateStore({ db }),
    timezone: config.timezone,
    tuning: applyTraitsToTuning(traits),
  });
  const procVersion = buildReflectionProcVersion(selector.selector, config.reflectionOutputMode);
  const engine = new ReflectionEngine({
    model: modelFactory(selector),
    procVersion,
    episodeStore: new SqliteEpisodeStore({ db }),
    narrativeStore: new SqliteNarrativeStore({ db }),
    beliefStore: new SqliteBeliefStore({ db }),
    innerStateService,
    prospectStore: new SqliteProspectStore({ db }),
    timezone: config.timezone,
    providerOptions: noThinkingProviderOptions(selector.api),
    outputMode: config.reflectionOutputMode,
    ...(config.reflectionTimeoutMs != null ? { timeoutMs: config.reflectionTimeoutMs } : {}),
    onDrop: (message) => {
      console.log(`  (dropped) ${message}`);
    },
  });

  console.log(`Reflection manual run with ${procVersion} (mode: ${config.reflectionOutputMode})`);
  try {
    if (args.daily != null) {
      console.log(`\n--daily ${args.daily}`);
      const result = await engine.runDaily(args.daily, new Date());
      if (result == null) {
        console.log('  対象日のエピソードなし（何も書かれませんでした）');
      } else {
        console.log(`  日記 narrative id: ${result.diaryNarrativeId ?? '(なし)'} / 新しい信念 ${result.newBeliefs} / 改訂 ${result.revisions} / 失効 ${result.deactivations} / 展望 fulfilled ${result.prospectsFulfilled} / abandoned ${result.prospectsAbandoned}`);
      }
      advanceMeta(db, META_DAILY, args.daily);
    }

    if (args.weekly != null) {
      const periodStart = shiftDateString(args.weekly, -6);
      console.log(`\n--weekly ${periodStart} 〜 ${args.weekly}`);
      const result = await engine.runWeekly(periodStart, args.weekly);
      if (result == null) {
        console.log('  対象期間の日記なし');
      } else {
        console.log(`  テーマ ${result.themes} 件 / 自己像の更新 ${result.selfUpdates} 件`);
      }
      advanceMeta(db, META_WEEKLY, isoWeekKey(args.weekly), weekKeyOrdinal);
    }

    if (args.monthly != null) {
      const [yearText, monthText] = args.monthly.split('-');
      const start = `${args.monthly}-01`;
      const end = new Date(Date.UTC(Number(yearText), Number(monthText), 0)).toISOString().slice(0, 10);
      console.log(`\n--monthly ${start} 〜 ${end}`);
      const result = await engine.runMonthly(start, end, new Date());
      if (result == null) {
        console.log('  対象月のテーマなし・減衰対象なし');
      } else {
        console.log(`  章 ${result.chapters} 件 / 浮力減衰 ${result.decayed} 件`);
      }
      // 月次マークは「実行済みの月キー」ではなく「次に走るべき境界」を持つため、
      // 対象月の翌月キーへ前進させる（スケジューラの二重実行を防ぐ）
      const nextMonthDate = new Date(Date.UTC(Number(yearText), Number(monthText), 1));
      advanceMeta(db, META_MONTHLY, nextMonthDate.toISOString().slice(0, 7));
    }
  } finally {
    db.close();
  }
}

const isDirectRun = process.argv[1] != null
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  runReflectionCli(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
