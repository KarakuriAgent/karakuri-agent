/**
 * Life ダッシュボード — 稼働中エージェントの内部状態・注入コンテキスト・記憶の可視化。
 *
 * life.db を読み取り専用で開き、bot 本体には一切影響を与えない（書き込みなし・
 * migration なし）。注入テキストは本体と同じ純関数（describeInnerState /
 * buildDrivesDescription / formatProspectsForPrompt）で組み立てるため、
 * 「いまプロンプトに入る内容」を忠実に再現する。
 *
 * 起動: npm run dashboard（DATA_DIR / DASHBOARD_PORT で調整、既定 ./data : 3900）
 */

import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { buildDrivesDescription, DRIVES_DEFAULTS } from '../src/life/drives.js';
import {
  decayInnerState,
  defaultInnerState,
  describeInnerState,
  type InnerState,
} from '../src/life/inner-state.js';
import { formatProspectsForPrompt, type Prospect } from '../src/life/prospects.js';
import { loadTraits, satiationThresholdFor } from '../src/life/traits.js';
import { LIFE_TUNING } from '../src/life/tuning.js';
import type { ActionLedgerBucket, IActionLedgerStore } from '../src/life/action-ledger.js';

const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), 'data');
const PORT = Number(process.env.DASHBOARD_PORT ?? 3900);
const LIFE_DB_PATH = join(DATA_DIR, 'life.db');

// .env の表示用ホワイトリスト（秘密情報は含めない。KEY / TOKEN / SECRET は読まない）
const ENV_WHITELIST = [
  'TIMEZONE',
  'LLM_MODEL',
  'LLM_APPRAISAL_MODEL',
  'LLM_REFLECTION_MODEL',
  'EMBEDDING_MODEL',
  'EMBEDDING_DIMENSIONS',
  'LLM_DISABLE_THINKING_REQUEST_PARAM',
  'APPRAISAL_ENABLED',
  'INNER_STATE_INJECTION_ENABLED',
  'RECALL_INJECTION_ENABLED',
  'SELF_IMAGE_INJECTION_ENABLED',
  'DRIVES_INJECTION_ENABLED',
  'PROSPECTS_INJECTION_ENABLED',
  'REFLECTION_ENABLED',
  'LOOP_WARNING_ENABLED',
  'LOOP_DETECTOR_THRESHOLD',
  'KW_PERCEPTION_BUFFER_ENABLED',
  'MEMORY_MAINTENANCE_INTERVAL_MINUTES',
  'KW_COMMAND_CHECK_PHONE',
  'KW_COMMAND_BROWSE_SNS',
  'KW_COMMAND_POST_SNS',
  'SNS_RATE_LIMIT_POST_PER_HOUR',
  'SNS_RATE_LIMIT_POST_PER_DAY',
  'SNS_RATE_LIMIT_POST_MIN_INTERVAL_MINUTES',
  'SNS_RATE_LIMIT_REPLY_PER_HOUR',
  'SNS_RATE_LIMIT_LIKE_PER_HOUR',
  'SNS_RATE_LIMIT_REPOST_PER_HOUR',
] as const;

function readEnvWhitelisted(): Record<string, string> {
  const result: Record<string, string> = {};
  const envPath = join(process.cwd(), '.env');
  const fileEntries = new Map<string, string>();
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (match != null && match[1] != null) {
        fileEntries.set(match[1], match[2] ?? '');
      }
    }
  }
  for (const key of ENV_WHITELIST) {
    const value = process.env[key] ?? fileEntries.get(key);
    if (value != null && value.length > 0) {
      result[key] = value;
    }
  }
  return result;
}

const env = readEnvWhitelisted();
const timezone = env['TIMEZONE'] ?? 'Asia/Tokyo';

function openReadonly(): Database.Database {
  return new Database(LIFE_DB_PATH, { readonly: true, fileMustExist: true });
}

interface InnerStateRow {
  updated_at: string;
  valence: number;
  energy: number;
  hunger: number;
  social: number;
  sleeping: number;
  trigger?: string | null;
  recorded_at?: string;
}

function rowToInnerState(row: InnerStateRow): InnerState {
  return {
    updatedAt: row.updated_at,
    valence: row.valence,
    energy: row.energy,
    hunger: row.hunger,
    social: row.social,
    sleeping: row.sleeping !== 0,
  };
}

/** 読み取り専用の action_ledger アダプタ（本体の getCounts と同じ集計） */
function makeLedgerAdapter(db: Database.Database): IActionLedgerStore {
  return {
    increment(): Promise<void> {
      return Promise.reject(new Error('dashboard is read-only'));
    },
    getCounts(bucket: ActionLedgerBucket, since: Date): Promise<Array<{ key: string; count: number }>> {
      const rows = db.prepare(`
        SELECT key, SUM(count) AS total
        FROM action_ledger
        WHERE bucket = ? AND window_start >= ?
        GROUP BY key
        ORDER BY total DESC, key ASC
      `).all(bucket, since.toISOString()) as Array<{ key: string; total: number }>;
      return Promise.resolve(rows.map((row) => ({ key: row.key, count: row.total })));
    },
    close(): Promise<void> {
      return Promise.resolve();
    },
  };
}

async function buildStatePayload(): Promise<Record<string, unknown>> {
  const db = openReadonly();
  try {
    const now = new Date();
    const q = <T>(sql: string, ...params: unknown[]): T[] => db.prepare(sql).all(...params) as T[];

    // 内部状態: 保存値 + 遅延評価（本体の getCurrent と同じ計算）
    const storedRow = db.prepare('SELECT * FROM inner_state WHERE id = 1').get() as InnerStateRow | undefined;
    const stored = storedRow != null ? rowToInnerState(storedRow) : defaultInnerState(now);
    const current = decayInnerState(stored, now, timezone, LIFE_TUNING);
    const history = q<InnerStateRow>(
      'SELECT recorded_at, valence, energy, hunger, social, sleeping, trigger FROM inner_state_history ORDER BY id DESC LIMIT 300',
    ).reverse();

    // 注入テキスト（本体と同じ関数で再現）
    const traits = loadTraits(DATA_DIR);
    const ledger = makeLedgerAdapter(db);
    const drivesText = await buildDrivesDescription(current, ledger, now, {
      satiationThreshold: satiationThresholdFor(traits),
      includeTopicBias: true,
    });

    const prospects = q<Record<string, unknown>>(
      "SELECT * FROM prospects WHERE status = 'open' ORDER BY due_at IS NULL, due_at ASC, id ASC LIMIT 5",
    ).map((row) => ({
      id: row.id,
      kind: row.kind,
      body: row.body,
      counterpart: row.counterpart ?? null,
      dueAt: row.due_at ?? null,
      status: row.status,
      provenance: JSON.parse(String(row.provenance ?? '[]')) as number[],
      procVersion: row.proc_version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })) as Prospect[];
    const prospectsText = prospects.length > 0 ? formatProspectsForPrompt(prospects) : null;

    const selfBeliefs = q<{ body: string; confidence: number; created_at: string }>(
      "SELECT body, confidence, created_at FROM beliefs WHERE kind = 'self' AND active = 1 ORDER BY id DESC LIMIT 10",
    );
    const selfImageText = selfBeliefs.length > 0 ? selfBeliefs.map((b) => `- ${b.body}`).join('\n') : null;

    // Perception Buffer（再起動復元と同じ規則: KW チャネル別の最新 world_event）
    const perception = q<{ channel: string; received_at: string; payload: string }>(`
      SELECT channel, received_at, payload FROM experience_log
      WHERE kind = 'world_event' AND channel LIKE 'kw:%'
        AND id IN (SELECT MAX(id) FROM experience_log WHERE kind = 'world_event' AND channel LIKE 'kw:%' GROUP BY channel)
    `).map((row) => ({
      channel: row.channel,
      receivedAt: row.received_at,
      payload: truncateText(row.payload, 2_000),
    }));

    const appraisals = q<Record<string, unknown>>(
      'SELECT id, event_id, received_at, channel, output, rejections, proc_version FROM appraisal_log ORDER BY id DESC LIMIT 20',
    ).map((row) => ({
      ...row,
      output: JSON.parse(String(row.output)),
      rejections: row.rejections != null ? JSON.parse(String(row.rejections)) : null,
    }));

    const episodes = q<Record<string, unknown>>(
      'SELECT id, occurred_at, channel, body, importance, buoyancy, emotion, proc_version FROM episodes ORDER BY id DESC LIMIT 10',
    );
    const beliefs = q<Record<string, unknown>>(
      'SELECT id, kind, subject, body, confidence, created_at FROM beliefs WHERE active = 1 ORDER BY id DESC LIMIT 15',
    );
    const narratives = q<Record<string, unknown>>(
      'SELECT id, kind, period_start, period_end, body, revision FROM narratives WHERE active = 1 ORDER BY id DESC LIMIT 10',
    );
    const relations = q<Record<string, unknown>>(
      'SELECT subject_id, relation, object_id, strength, affect, observed_at FROM relations ORDER BY observed_at DESC LIMIT 15',
    );

    const since24h = new Date(now.getTime() - 24 * 3_600_000);
    const ledgerCounts = {
      action: await ledger.getCounts('action', since24h),
      topic: await ledger.getCounts('topic', since24h),
      place: await ledger.getCounts('place', since24h),
      target: await ledger.getCounts('target', since24h),
    };

    const eventCounts = q<{ channel: string; kind: string; c: number }>(
      "SELECT channel, kind, COUNT(*) c FROM experience_log WHERE received_at >= ? GROUP BY channel, kind ORDER BY c DESC",
      since24h.toISOString(),
    );
    const recentEvents = q<Record<string, unknown>>(
      'SELECT id, received_at, channel, kind, actor, substr(payload, 1, 300) payload FROM experience_log ORDER BY id DESC LIMIT 15',
    );

    const stats = {
      experienceLog: (q<{ c: number }>('SELECT COUNT(*) c FROM experience_log')[0] ?? { c: 0 }).c,
      episodes: (q<{ c: number }>('SELECT COUNT(*) c FROM episodes')[0] ?? { c: 0 }).c,
      appraisals: (q<{ c: number }>('SELECT COUNT(*) c FROM appraisal_log')[0] ?? { c: 0 }).c,
      beliefs: (q<{ c: number }>('SELECT COUNT(*) c FROM beliefs WHERE active = 1')[0] ?? { c: 0 }).c,
      prospectsOpen: (q<{ c: number }>("SELECT COUNT(*) c FROM prospects WHERE status = 'open'")[0] ?? { c: 0 }).c,
      relations: (q<{ c: number }>('SELECT COUNT(*) c FROM relations')[0] ?? { c: 0 }).c,
      embeddingPending: (q<{ c: number }>('SELECT COUNT(*) c FROM episode_embedding_pending')[0] ?? { c: 0 }).c,
      openDrafts: (q<{ c: number }>('SELECT COUNT(*) c FROM episode_drafts')[0] ?? { c: 0 }).c,
    };

    return {
      now: now.toISOString(),
      timezone,
      dataDir: DATA_DIR,
      innerState: { stored, current, description: describeInnerState(current) },
      history,
      injections: {
        innerState: describeInnerState(current),
        drives: drivesText,
        prospects: prospectsText,
        selfImage: selfImageText,
      },
      perception,
      appraisals,
      episodes,
      beliefs,
      narratives,
      relations,
      prospects,
      ledgerCounts,
      eventCounts,
      recentEvents,
      stats,
      params: {
        env,
        traits,
        tuning: LIFE_TUNING,
        drivesDefaults: DRIVES_DEFAULTS,
        satiationThreshold: satiationThresholdFor(traits),
      },
    };
  } finally {
    db.close();
  }
}

function truncateText(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…(truncated)`;
}

const server = createServer((req, res) => {
  void (async () => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/api/state') {
        const payload = await buildStatePayload();
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(payload));
        return;
      }
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(PAGE_HTML);
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(String(error));
    }
  })();
});

const PAGE_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>karakuri life dashboard</title>
<style>
  :root {
    --surface-1: #fcfcfb; --page: #f9f9f7;
    --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
    --grid: #e1e0d9; --axis: #c3c2b7; --border: rgba(11,11,11,0.10);
    --s-valence: #2a78d6; --s-energy: #1baf7a; --s-hunger: #eda100; --s-social: #008300;
    --tag: #4a3aa7;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --surface-1: #1a1a19; --page: #0d0d0d;
      --ink: #ffffff; --ink-2: #c3c2b7; --muted: #898781;
      --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10);
      --s-valence: #3987e5; --s-energy: #199e70; --s-hunger: #c98500; --s-social: #008300;
      --tag: #9085e9;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--page); color: var(--ink);
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif; font-size: 14px; line-height: 1.55; }
  header { padding: 14px 20px; display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
  header h1 { font-size: 16px; margin: 0; font-weight: 650; }
  header .meta { color: var(--muted); font-size: 12px; }
  main { padding: 0 20px 40px; display: grid; gap: 14px; max-width: 1240px; margin: 0 auto; }
  .card { background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; overflow-x: auto; }
  .card h2 { font-size: 13px; margin: 0 0 10px; color: var(--ink-2); font-weight: 650; letter-spacing: 0.02em; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; }
  .tile { background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }
  .tile .label { font-size: 11px; color: var(--muted); }
  .tile .value { font-size: 22px; font-weight: 650; }
  .tile .sub { font-size: 11px; color: var(--ink-2); }
  .cols2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  @media (max-width: 900px) { .cols2 { grid-template-columns: 1fr; } }
  pre.inject { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: inherit;
    background: var(--page); border-left: 3px solid var(--tag); border-radius: 4px; padding: 8px 10px; }
  .tagname { color: var(--tag); font-family: ui-monospace, monospace; font-size: 12px; }
  .none { color: var(--muted); font-style: italic; }
  table { border-collapse: collapse; width: 100%; font-size: 12.5px; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--grid); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; white-space: nowrap; }
  td.num { font-variant-numeric: tabular-nums; text-align: right; }
  td.nowrap { white-space: nowrap; }
  .legend { display: flex; gap: 14px; font-size: 12px; color: var(--ink-2); margin-bottom: 6px; flex-wrap: wrap; }
  .legend .sw { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: baseline; }
  .chartwrap { position: relative; }
  #tooltip { position: absolute; pointer-events: none; background: var(--surface-1); border: 1px solid var(--border);
    border-radius: 6px; padding: 6px 9px; font-size: 12px; display: none; box-shadow: 0 2px 8px rgba(0,0,0,0.15); z-index: 2; }
  #tooltip .t { color: var(--muted); }
  details summary { cursor: pointer; color: var(--ink-2); font-size: 12.5px; }
  code { font-family: ui-monospace, monospace; font-size: 12px; }
  .err { color: #d03b3b; }
</style>
</head>
<body>
<header>
  <h1>karakuri life dashboard</h1>
  <span class="meta" id="meta">読み込み中…</span>
</header>
<main id="main"></main>
<script>
const SERIES = [
  { key: 'valence', label: '気分 (valence)', color: 'var(--s-valence)' },
  { key: 'energy',  label: '元気 (energy)',  color: 'var(--s-energy)' },
  { key: 'hunger',  label: '空腹 (hunger)',  color: 'var(--s-hunger)' },
  { key: 'social',  label: '社交欲 (social)', color: 'var(--s-social)' },
];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtTime = (iso, tz) => { try { return new Date(iso).toLocaleString('ja-JP', { timeZone: tz, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return iso; } };
const fmtHm = (iso, tz) => { try { return new Date(iso).toLocaleTimeString('ja-JP', { timeZone: tz, hour: '2-digit', minute: '2-digit' }); } catch { return iso; } };
const pct = (v) => (Math.round(v * 100) / 100).toFixed(2);

function injectBlock(tag, note, text) {
  return '<div style="margin-bottom:12px"><div class="tagname">&lt;' + tag + '&gt;</div>' +
    (text != null && text.length > 0
      ? '<pre class="inject">' + esc(text) + '</pre>'
      : '<div class="none">（現在は注入なし' + (note ? ' — ' + note : '') + '）</div>') +
    '</div>';
}

function tableOf(headers, rows) {
  if (rows.length === 0) return '<div class="none">（なし）</div>';
  return '<table><thead><tr>' + headers.map((h) => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' +
    rows.map((r) => '<tr>' + r.join('') + '</tr>').join('') + '</tbody></table>';
}
const td = (v, cls) => '<td' + (cls ? ' class="' + cls + '"' : '') + '>' + esc(v) + '</td>';

function lineChart(history, tz) {
  const W = 1160, H = 260, L = 44, R = 130, T = 12, B = 26;
  const pw = W - L - R, ph = H - T - B;
  if (history.length < 2) return '<div class="none">（履歴が 2 件未満のためチャートなし）</div>';
  const times = history.map((d) => new Date(d.recorded_at).getTime());
  const x0 = Math.min(...times), x1 = Math.max(...times);
  const x = (t) => L + ((t - x0) / Math.max(1, x1 - x0)) * pw;
  const y = (v) => T + (1 - (v + 1) / 2) * ph; // domain [-1, 1]
  let svg = '';
  for (const gv of [-1, -0.5, 0, 0.5, 1]) {
    const gy = y(gv);
    svg += '<line x1="' + L + '" y1="' + gy + '" x2="' + (L + pw) + '" y2="' + gy + '" stroke="var(' + (gv === 0 ? '--axis' : '--grid') + ')" stroke-width="1"/>';
    svg += '<text x="' + (L - 6) + '" y="' + (gy + 4) + '" text-anchor="end" font-size="10" fill="var(--muted)" style="font-variant-numeric:tabular-nums">' + gv + '</text>';
  }
  const nTicks = 5;
  for (let i = 0; i <= nTicks; i++) {
    const t = x0 + ((x1 - x0) * i) / nTicks;
    svg += '<text x="' + x(t) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="10" fill="var(--muted)">' + esc(fmtHm(new Date(t).toISOString(), tz)) + '</text>';
  }
  const last = history[history.length - 1];
  // 直接ラベルの衝突回避: y でソートして最低 13px の間隔を確保する
  const labels = SERIES.map((s) => ({ s, ly: y(last[s.key]) + 4 })).sort((a, b) => a.ly - b.ly);
  for (let i = 1; i < labels.length; i++) {
    if (labels[i].ly - labels[i - 1].ly < 13) labels[i].ly = labels[i - 1].ly + 13;
  }
  for (const s of SERIES) {
    const pts = history.map((d) => x(new Date(d.recorded_at).getTime()).toFixed(1) + ',' + y(d[s.key]).toFixed(1)).join(' ');
    svg += '<polyline points="' + pts + '" fill="none" stroke="' + s.color + '" stroke-width="2" stroke-linejoin="round"/>';
  }
  for (const l of labels) {
    svg += '<text x="' + (L + pw + 6) + '" y="' + l.ly.toFixed(1) + '" font-size="11" fill="var(--ink-2)"><tspan style="fill:' + l.s.color + '">●</tspan> ' + esc(l.s.label.split(' ')[0]) + ' ' + pct(last[l.s.key]) + '</text>';
  }
  svg += '<line id="xhair" x1="0" y1="' + T + '" x2="0" y2="' + (T + ph) + '" stroke="var(--axis)" stroke-width="1" visibility="hidden"/>';
  // <template> 経由は HTML パーサが SVG の自己終了タグを壊すため、文字列のまま保持し
  // hookChart で <svg> 要素の innerHTML（SVG コンテキストでパースされる）へ入れる
  chartBody = svg;
  return '<div class="chartwrap"><svg id="chart" viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" aria-label="内部状態の履歴"></svg><div id="tooltip"></div></div>';
}
let chartBody = '';

function hookChart(history, tz) {
  const svg = document.getElementById('chart');
  if (!svg || chartBody.length === 0) return;
  svg.innerHTML = chartBody;
  const tip = document.getElementById('tooltip');
  const xhair = svg.querySelector('#xhair');
  const W = 1160, L = 44, R = 130;
  const times = history.map((d) => new Date(d.recorded_at).getTime());
  const x0 = Math.min(...times), x1 = Math.max(...times);
  svg.addEventListener('mousemove', (ev) => {
    const rect = svg.getBoundingClientRect();
    const vx = ((ev.clientX - rect.left) / rect.width) * W;
    if (vx < L || vx > W - R) { tip.style.display = 'none'; xhair.setAttribute('visibility', 'hidden'); return; }
    const t = x0 + ((vx - L) / (W - L - R)) * (x1 - x0);
    let best = 0;
    for (let i = 1; i < times.length; i++) if (Math.abs(times[i] - t) < Math.abs(times[best] - t)) best = i;
    const d = history[best];
    const bx = L + ((times[best] - x0) / Math.max(1, x1 - x0)) * (W - L - R);
    xhair.setAttribute('x1', bx); xhair.setAttribute('x2', bx); xhair.setAttribute('visibility', 'visible');
    tip.style.display = 'block';
    tip.style.left = Math.min((bx / W) * rect.width + 12, rect.width - 190) + 'px';
    tip.style.top = '10px';
    tip.innerHTML = '<div class="t">' + esc(fmtTime(d.recorded_at, tz)) + (d.trigger ? ' · ' + esc(d.trigger) : '') + '</div>' +
      SERIES.map((s) => '<div><span class="sw" style="background:' + s.color + ';display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px"></span>' + esc(s.label.split(' ')[0]) + ' <b style="font-variant-numeric:tabular-nums">' + pct(d[s.key]) + '</b></div>').join('') +
      (d.sleeping ? '<div>😴 睡眠中</div>' : '');
  });
  svg.addEventListener('mouseleave', () => { tip.style.display = 'none'; xhair.setAttribute('visibility', 'hidden'); });
}

async function refresh() {
  let s;
  try {
    s = await (await fetch('/api/state')).json();
  } catch (e) {
    document.getElementById('meta').innerHTML = '<span class="err">取得失敗: ' + esc(e) + '</span>';
    return;
  }
  const tz = s.timezone;
  document.getElementById('meta').textContent =
    tz + ' · ' + fmtTime(s.now, tz) + ' 時点 · ' + s.dataDir + '/life.db (read-only) · 10s ごと更新';

  const cur = s.innerState.current;
  // 端値張り付きの可視化（#102）: 現在値が端にあるとき、履歴を遡って連続時間を出す
  const fmtDur = (ms) => { const h = Math.floor(ms / 3600000); return h >= 1 ? h + '時間' : Math.max(1, Math.round(ms / 60000)) + '分'; };
  const pinned = (key, lo, hi) => {
    const v = cur[key];
    const bound = v <= lo + 0.02 ? lo : v >= hi - 0.02 ? hi : null;
    if (bound == null) return '';
    let since = null;
    for (let i = s.history.length - 1; i >= 0; i--) {
      if (Math.abs(s.history[i][key] - bound) <= 0.02) since = s.history[i].recorded_at; else break;
    }
    return since ? ' · ⚠️ 端に' + fmtDur(Date.now() - new Date(since).getTime()) + '張り付き' : '';
  };
  const tiles = [
    ['気分 (valence)', pct(cur.valence), '-1〜1' + pinned('valence', -1, 1)],
    ['元気 (energy)', pct(cur.energy), '0〜1' + pinned('energy', 0, 1)],
    ['空腹 (hunger)', pct(cur.hunger), '0〜1' + pinned('hunger', 0, 1)],
    ['社交欲 (social)', pct(cur.social), '0〜1' + pinned('social', 0, 1)],
    ['睡眠', cur.sleeping ? '😴 中' : '起きている', '最終更新 ' + fmtTime(s.innerState.stored.updatedAt, tz)],
    ['体験ログ', s.stats.experienceLog, 'appraisal ' + s.stats.appraisals + ' 件'],
    ['エピソード', s.stats.episodes, 'ドラフト ' + s.stats.openDrafts + ' / 埋込待ち ' + s.stats.embeddingPending],
    ['beliefs / 約束', s.stats.beliefs + ' / ' + s.stats.prospectsOpen, 'relations ' + s.stats.relations],
  ].map(([l, v, sub]) =>
    '<div class="tile"><div class="label">' + esc(l) + '</div><div class="value">' + esc(v) + '</div><div class="sub">' + esc(sub) + '</div></div>').join('');

  const legend = '<div class="legend">' + SERIES.map((x) =>
    '<span><span class="sw" style="background:' + x.color + '"></span>' + esc(x.label) + '</span>').join('') + '</div>';

  const main = document.getElementById('main');
  main.innerHTML =
    '<div class="tiles">' + tiles + '</div>' +
    '<div class="card"><h2>内部状態の履歴（直近 ' + s.history.length + ' 変化点）</h2>' + legend + lineChart(s.history, tz) + '</div>' +
    '<div class="card"><h2>いま注入されるコンテキスト（本体と同じ関数で再現）</h2>' +
      injectBlock('inner-state', null, s.injections.innerState) +
      injectBlock('drives', '欲求が弱い・偏りなし', s.injections.drives) +
      injectBlock('prospects', 'open の約束・予定・目標なし', s.injections.prospects) +
      injectBlock('self-image', 'self belief なし', s.injections.selfImage) +
    '</div>' +
    '<div class="cols2">' +
      '<div class="card"><h2>appraisal 直近 20 件</h2>' + tableOf(
        ['時刻', 'channel', 'salience', 'Δ', 'seg/rel/pros', '棄却'],
        s.appraisals.map((a) => {
          const o = a.output; const d = o.deltas || {};
          const delta = ['v:' + pct(d.valence ?? 0), 'e:' + pct(d.energy ?? 0), 'h:' + pct(d.hunger ?? 0), 's:' + pct(d.social ?? 0)].join(' ');
          return [td(fmtTime(a.received_at, tz), 'nowrap'), td(a.channel), td(o.salience), td(delta, 'nowrap'),
            td((o.segmentation?.length ?? 0) + '/' + (o.relationCandidates?.length ?? 0) + '/' + (o.prospectCandidates?.length ?? 0), 'num'),
            td(a.rejections ? a.rejections.length : '')];
        })) + '</div>' +
      '<div class="card"><h2>Perception Buffer（KW チャネル別最新 world_event）</h2>' +
        (s.perception.length === 0 ? '<div class="none">（なし）</div>' :
          s.perception.map((p) => '<details><summary>' + esc(p.channel) + ' · ' + esc(fmtTime(p.receivedAt, tz)) + '</summary><pre class="inject">' + esc(p.payload) + '</pre></details>').join('')) +
      '</div>' +
    '</div>' +
    '<div class="cols2">' +
      '<div class="card"><h2>エピソード直近 10 件（総 ' + s.stats.episodes + '）</h2>' + tableOf(
        ['時刻', 'importance', 'buoyancy', '本文'],
        s.episodes.map((e) => [td(fmtTime(e.occurred_at, tz), 'nowrap'), td(pct(e.importance), 'num'), td(pct(e.buoyancy), 'num'), td(e.body)])) + '</div>' +
      '<div class="card"><h2>beliefs（active）/ narratives</h2>' + tableOf(
        ['kind', 'subject', '本文', 'conf'],
        s.beliefs.map((b) => [td(b.kind), td(b.subject ?? ''), td(b.body), td(pct(b.confidence), 'num')])) +
        '<div style="height:8px"></div>' + tableOf(
        ['kind', '期間', '本文'],
        s.narratives.map((n) => [td(n.kind), td(n.period_start.slice(0, 10) + '〜' + n.period_end.slice(0, 10), 'nowrap'), td(n.body)])) + '</div>' +
    '</div>' +
    '<div class="cols2">' +
      '<div class="card"><h2>relations 直近 / 展望記憶（open）</h2>' + tableOf(
        ['subject', 'relation', 'object', 'strength', 'affect'],
        s.relations.map((r) => [td(r.subject_id), td(r.relation), td(r.object_id), td(r.strength != null ? pct(r.strength) : '', 'num'), td(r.affect != null ? pct(r.affect) : '', 'num')])) +
        '<div style="height:8px"></div>' + tableOf(
        ['kind', '本文', '相手', '期日'],
        s.prospects.map((p) => [td(p.kind), td(p.body), td(p.counterpart ?? ''), td(p.dueAt ?? '', 'nowrap')])) + '</div>' +
      '<div class="card"><h2>action_ledger（24h・飽き圧の材料）</h2>' + tableOf(
        ['bucket', 'key', '回数'],
        Object.entries(s.ledgerCounts).flatMap(([bucket, rows]) => rows.slice(0, 6).map((r) => [td(bucket), td(r.key), td(r.count, 'num')]))) +
        '<div class="sub" style="color:var(--muted);font-size:11px;margin-top:6px">飽き閾値: ' + esc(s.params.satiationThreshold) + ' 回 / ' + esc(s.params.drivesDefaults.satiationWindowHours) + 'h</div></div>' +
    '</div>' +
    '<div class="cols2">' +
      '<div class="card"><h2>体験ログ直近 15 件</h2>' + tableOf(
        ['id', '時刻', 'channel', 'kind', 'actor'],
        s.recentEvents.map((e) => [td(e.id, 'num'), td(fmtTime(e.received_at, tz), 'nowrap'), td(e.channel), td(e.kind), td(e.actor ?? '')])) +
        '<div style="height:8px"></div><details><summary>24h のチャネル×種別集計</summary>' + tableOf(
        ['channel', 'kind', '件数'],
        s.eventCounts.map((c) => [td(c.channel), td(c.kind), td(c.c, 'num')])) + '</details></div>' +
      '<div class="card"><h2>パラメータ</h2>' + tableOf(
        ['key', 'value'],
        [...Object.entries(s.params.env).map(([k, v]) => [td(k), td(v)]),
         [td('traits'), td(JSON.stringify(s.params.traits))]]) +
        '<div style="height:8px"></div><details><summary>tuning（LIFE_TUNING）</summary><pre class="inject">' + esc(JSON.stringify(s.params.tuning, null, 2)) + '</pre></details></div>' +
    '</div>';
  hookChart(s.history, tz);
}
refresh();
setInterval(refresh, 10_000);
</script>
</body>
</html>`;

server.listen(PORT, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`life dashboard: http://127.0.0.1:${PORT} (data: ${LIFE_DB_PATH}, read-only)`);
});
