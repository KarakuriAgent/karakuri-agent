import { describe, expect, it } from 'vitest';

import {
  formatDateTimeInTimezone,
  getHourInTimezone,
  localDayRangeUtc,
  shiftDateString,
  toUtcIso,
  zonedMidnightUtc,
} from '../src/utils/date.js';

describe('formatDateTimeInTimezone', () => {
  it('formats as YYYY-MM-DD HH:mm (timezone)', () => {
    // 2026-03-27T06:30:00Z = 2026-03-27 15:30 in Asia/Tokyo (UTC+9)
    const date = new Date('2026-03-27T06:30:00Z');
    expect(formatDateTimeInTimezone(date, 'Asia/Tokyo')).toBe('2026-03-27 15:30 (Asia/Tokyo)');
  });

  it('uses 24-hour format (midnight is 00:00)', () => {
    // 2026-01-01T00:00:00Z = midnight UTC
    const date = new Date('2026-01-01T00:00:00Z');
    expect(formatDateTimeInTimezone(date, 'UTC')).toBe('2026-01-01 00:00 (UTC)');
  });

  it('reflects the correct timezone offset', () => {
    // 2026-03-27T06:30:00Z
    const date = new Date('2026-03-27T06:30:00Z');
    expect(formatDateTimeInTimezone(date, 'UTC')).toBe('2026-03-27 06:30 (UTC)');
    expect(formatDateTimeInTimezone(date, 'Asia/Tokyo')).toBe('2026-03-27 15:30 (Asia/Tokyo)');
  });

  it('handles date boundary crossing across timezones', () => {
    // 2026-03-27T23:30:00Z = 2026-03-28 08:30 in Asia/Tokyo
    const date = new Date('2026-03-27T23:30:00Z');
    expect(formatDateTimeInTimezone(date, 'Asia/Tokyo')).toBe('2026-03-28 08:30 (Asia/Tokyo)');
    expect(formatDateTimeInTimezone(date, 'UTC')).toBe('2026-03-27 23:30 (UTC)');
  });
});

describe('getHourInTimezone', () => {
  it('returns the local hour in 24-hour format', () => {
    const date = new Date('2026-07-05T15:30:00Z');
    expect(getHourInTimezone(date, 'UTC')).toBe(15);
    expect(getHourInTimezone(date, 'Asia/Tokyo')).toBe(0); // JST 翌 00:30
  });
});

describe('shiftDateString', () => {
  it('shifts calendar dates across month and year boundaries', () => {
    expect(shiftDateString('2026-07-05', -1)).toBe('2026-07-04');
    expect(shiftDateString('2026-07-01', -1)).toBe('2026-06-30');
    expect(shiftDateString('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftDateString('2026-12-31', 1)).toBe('2027-01-01');
  });
});

describe('zonedMidnightUtc / localDayRangeUtc', () => {
  it('converts local midnight to the correct UTC instant', () => {
    // JST 2026-07-05 00:00 = UTC 2026-07-04 15:00
    expect(zonedMidnightUtc('2026-07-05', 'Asia/Tokyo').toISOString()).toBe('2026-07-04T15:00:00.000Z');
    expect(zonedMidnightUtc('2026-07-05', 'UTC').toISOString()).toBe('2026-07-05T00:00:00.000Z');
  });

  it('covers the whole local day (JST day != UTC day)', () => {
    const range = localDayRangeUtc('2026-07-05', 'Asia/Tokyo');
    expect(range.startIso).toBe('2026-07-04T15:00:00.000Z');
    expect(range.endIso).toBe('2026-07-05T14:59:59.999Z');
  });

  it('is DST-safe: derives the end from the next local midnight', () => {
    // US Eastern: 2026-03-08 は夏時間開始日（23 時間しかない）
    const springForward = localDayRangeUtc('2026-03-08', 'America/New_York');
    expect(springForward.startIso).toBe('2026-03-08T05:00:00.000Z'); // EST 00:00
    expect(springForward.endIso).toBe('2026-03-09T03:59:59.999Z');   // EDT 23:59:59.999
  });

  it('clamps to the first existing instant when local midnight is skipped by DST', () => {
    // チリ: 夏時間開始日は 00:00 → 01:00 へ跳ぶため現地 0 時が存在しない
    const skipped = zonedMidnightUtc('2025-09-07', 'America/Santiago');
    expect(skipped.toISOString()).toBe('2025-09-07T04:00:00.000Z'); // 現地 01:00 = その日の最初の実在時刻
    // 前日と当日の範囲は隙間なく・重なりなく繋がる
    const before = localDayRangeUtc('2025-09-06', 'America/Santiago');
    const day = localDayRangeUtc('2025-09-07', 'America/Santiago');
    expect(before.endIso).toBe('2025-09-07T03:59:59.999Z');
    expect(day.startIso).toBe('2025-09-07T04:00:00.000Z');
  });

  it('handles non-60-minute midnight skips exactly (residual-based clamp)', () => {
    // シンガポール 1933-01-01: 00:00 → 00:20 の 20 分跳び（+07:00 → +07:20）。
    // 固定 1 時間刻みの補正だと現地 01:00 まで進みすぎる
    const skipped = zonedMidnightUtc('1933-01-01', 'Asia/Singapore');
    expect(skipped.toISOString()).toBe('1932-12-31T17:00:00.000Z'); // 現地 00:20 = 最初の実在時刻
    const before = localDayRangeUtc('1932-12-31', 'Asia/Singapore');
    expect(before.endIso).toBe('1932-12-31T16:59:59.999Z'); // 隙間なく繋がる
  });
});

describe('toUtcIso', () => {
  it('normalizes offset-form ISO 8601 to Date.toISOString form for string comparison', () => {
    expect(toUtcIso('2026-07-01T09:00:00+09:00')).toBe('2026-07-01T00:00:00.000Z');
    expect(toUtcIso('2026-07-01T00:00:00.000Z')).toBe('2026-07-01T00:00:00.000Z');
  });

  it('rejects unparsable input instead of propagating an Invalid Date', () => {
    expect(() => toUtcIso('not-a-date')).toThrow(/Invalid ISO 8601/);
  });
});
