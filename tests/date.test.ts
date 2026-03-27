import { describe, expect, it } from 'vitest';

import { formatDateTimeInTimezone } from '../src/utils/date.js';

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
