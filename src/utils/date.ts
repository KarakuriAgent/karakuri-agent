/**
 * Intl.DateTimeFormat は生成コストが高く、呼び出し元（想起の整形・内部状態の
 * 減衰ループ等）は行単位・時間単位で繰り返し呼ぶため、timezone × 用途ごとに
 * キャッシュする。formatter は format 用途に対して状態を持たないため共有できる。
 */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function cachedFormatter(key: string, create: () => Intl.DateTimeFormat): Intl.DateTimeFormat {
  let formatter = formatterCache.get(key);
  if (formatter == null) {
    formatter = create();
    formatterCache.set(key, formatter);
  }
  return formatter;
}

function dateFormatter(timezone: string): Intl.DateTimeFormat {
  return cachedFormatter(`date|${timezone}`, () => new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }));
}

function hourFormatter(timezone: string): Intl.DateTimeFormat {
  return cachedFormatter(`hour|${timezone}`, () => new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hourCycle: 'h23',
  }));
}

function wallClockFormatter(timezone: string): Intl.DateTimeFormat {
  return cachedFormatter(`wallclock|${timezone}`, () => new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }));
}

function dateTimeFormatter(timezone: string): Intl.DateTimeFormat {
  return cachedFormatter(`datetime|${timezone}`, () => new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }));
}

/**
 * Format a Date as YYYY-MM-DD in the given IANA timezone.
 */
export function formatDateInTimezone(date: Date, timezone: string): string {
  const parts = dateFormatter(timezone).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;

  if (year == null || month == null || day == null) {
    throw new Error(`Could not format date in timezone ${timezone}`);
  }

  return `${year}-${month}-${day}`;
}

/**
 * Get the local hour (0-23) of a Date in the given IANA timezone.
 */
export function getHourInTimezone(date: Date, timezone: string): number {
  const hour = Number(hourFormatter(timezone).format(date));
  if (!Number.isFinite(hour)) {
    throw new Error(`Could not get hour in timezone ${timezone}`);
  }
  return hour;
}

/**
 * Shift a YYYY-MM-DD date string by the given number of calendar days.
 * Pure calendar arithmetic — timezone-independent.
 */
export function shiftDateString(date: string, days: number): string {
  const shifted = new Date(new Date(`${date}T00:00:00.000Z`).getTime() + days * 86_400_000);
  return shifted.toISOString().slice(0, 10);
}

/**
 * 任意の ISO 8601 入力（オフセット形式含む）を UTC ISO（Date.toISOString 形式）へ
 * 正規化する。保存値は全て Date.toISOString 形式なので、範囲比較の前に必ず
 * これを通す（オフセット形式のまま辞書順比較すると誤判定になる）。
 */
export function toUtcIso(input: string): string {
  const parsed = new Date(input);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ISO 8601 date: ${input}`);
  }
  return parsed.toISOString();
}

/**
 * UTC instant of local midnight (00:00:00.000) of the given YYYY-MM-DD date
 * in the given IANA timezone. Converges in one pass for fixed-offset zones and
 * within the iteration budget across DST transitions.
 */
export function zonedMidnightUtc(date: string, timezone: string): Date {
  const target = Date.parse(`${date}T00:00:00.000Z`);
  let guess = target;
  for (let i = 0; i < 3; i += 1) {
    const shown = wallClockAsUtc(new Date(guess), timezone);
    const diff = shown - target;
    if (diff === 0) {
      break;
    }
    guess -= diff;
  }
  // 現地 0 時が存在しない日（0 時をまたぐ DST 跳び）では収束せず、guess が
  // 前日側で止まりうる。その場合の残差 = スキップ幅なので、残差ぶんだけ進める
  // とその日の最初に実在する時刻になる（60 分以外の跳び幅にも正確）
  let result = new Date(guess);
  if (formatDateInTimezone(result, timezone) < date) {
    const residual = wallClockAsUtc(result, timezone) - target;
    result = new Date(result.getTime() - residual);
  }
  return result;
}

/**
 * UTC instant range [start, end] covering the whole local calendar day
 * (YYYY-MM-DD) in the given IANA timezone. DST-safe: the end is derived from
 * the next day's local midnight, not from a fixed 24-hour offset.
 */
export function localDayRangeUtc(date: string, timezone: string): { startIso: string; endIso: string } {
  const start = zonedMidnightUtc(date, timezone);
  const nextStart = zonedMidnightUtc(shiftDateString(date, 1), timezone);
  return {
    startIso: start.toISOString(),
    endIso: new Date(nextStart.getTime() - 1).toISOString(),
  };
}

/** Interpret the wall-clock reading of `date` in `timezone` as if it were UTC. */
function wallClockAsUtc(date: Date, timezone: string): number {
  const parts = wallClockFormatter(timezone).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value;
    if (value == null) {
      throw new Error(`Could not read wall clock in timezone ${timezone}`);
    }
    return Number(value);
  };
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
}

/**
 * Format a Date as "MM-DD HH:mm" in the given IANA timezone.
 * 受信時刻プレフィックス（#111）などプロンプト内の短い時刻表記用。
 */
export function formatShortDateTimeInTimezone(date: Date, timezone: string): string {
  const parts = dateTimeFormatter(timezone).formatToParts(date);
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  const hour = parts.find((part) => part.type === 'hour')?.value;
  const minute = parts.find((part) => part.type === 'minute')?.value;

  if (month == null || day == null || hour == null || minute == null) {
    throw new Error(`Could not format date/time in timezone ${timezone}`);
  }

  return `${month}-${day} ${hour}:${minute}`;
}

/**
 * Format a Date as "YYYY-MM-DD HH:mm (timezone)" in the given IANA timezone.
 */
export function formatDateTimeInTimezone(date: Date, timezone: string): string {
  const parts = dateTimeFormatter(timezone).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  const hour = parts.find((part) => part.type === 'hour')?.value;
  const minute = parts.find((part) => part.type === 'minute')?.value;

  if (year == null || month == null || day == null || hour == null || minute == null) {
    throw new Error(`Could not format date/time in timezone ${timezone}`);
  }

  return `${year}-${month}-${day} ${hour}:${minute} (${timezone})`;
}
