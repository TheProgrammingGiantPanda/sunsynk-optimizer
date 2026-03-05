import { describe, it, expect } from 'vitest';
import { getFixedExportRate, getTouRates } from '../octopus';

describe('getFixedExportRate', () => {
  it('returns 0 for empty schedule', () => {
    expect(getFixedExportRate('')).toBe(0);
  });

  it('returns the single entry when date is after its start', () => {
    const date = new Date('2025-01-15');
    expect(getFixedExportRate('15:2024-01-01', date)).toBe(15);
  });

  it('returns 0 when date is before the first entry', () => {
    const date = new Date('2023-12-31');
    expect(getFixedExportRate('15:2024-01-01', date)).toBe(0);
  });

  it('returns the later rate after its start date', () => {
    const schedule = '15:2024-01-01,10:2026-04-01';
    expect(getFixedExportRate(schedule, new Date('2026-04-01'))).toBe(10);
  });

  it('returns the earlier rate before the later start date', () => {
    const schedule = '15:2024-01-01,10:2026-04-01';
    expect(getFixedExportRate(schedule, new Date('2025-06-01'))).toBe(15);
  });

  it('returns the correct rate on the boundary date itself', () => {
    const schedule = '15:2024-01-01,10:2026-04-01';
    expect(getFixedExportRate(schedule, new Date('2024-01-01'))).toBe(15);
  });

  it('handles whitespace around entries', () => {
    const schedule = ' 15:2024-01-01 , 10:2026-04-01 ';
    expect(getFixedExportRate(schedule, new Date('2026-06-01'))).toBe(10);
  });

  it('ignores malformed entries and returns valid ones', () => {
    const schedule = 'bad,15:2024-01-01,also-bad';
    expect(getFixedExportRate(schedule, new Date('2025-01-01'))).toBe(15);
  });

  it('handles decimal rates', () => {
    expect(getFixedExportRate('14.5:2024-01-01', new Date('2025-01-01'))).toBe(14.5);
  });
});

// January 15 2025 is a winter day (UTC = Europe/London, no DST offset)
// Using UTC timestamps so local minutes are predictable in tests.

describe('getTouRates', () => {
  it('returns the correct number of slots for a 36-hour horizon', () => {
    // 36h × 2 slots/h = 72 slots
    const from = new Date('2025-01-15T07:00:00Z');
    const slots = getTouRates('00:00-07:30:7.5,07:30-00:00:28', 36, from);
    expect(slots.length).toBe(72);
  });

  it('assigns cheap rate to slots within the cheap window', () => {
    // 07:00 local (= 07:00 UTC in Jan) → inside 00:00-07:30 cheap window
    const from = new Date('2025-01-15T07:00:00Z');
    const slots = getTouRates('00:00-07:30:7.5,07:30-00:00:28', 1, from);
    expect(slots[0].value_inc_vat).toBe(7.5);
    expect(slots[0].value_exc_vat).toBeCloseTo(7.5 / 1.05, 5);
    expect(slots[0].payment_method).toBeNull();
  });

  it('assigns expensive rate to slots in the expensive window', () => {
    // 07:30 local → inside 07:30-00:00 expensive window
    const from = new Date('2025-01-15T07:30:00Z');
    const slots = getTouRates('00:00-07:30:7.5,07:30-00:00:28', 1, from);
    expect(slots[0].value_inc_vat).toBe(28);
  });

  it('handles midnight-crossing cheap period (e.g. Economy 7 style)', () => {
    // Schedule: cheap 23:00-07:00, expensive 07:00-23:00
    // 23:30 local is inside the midnight-crossing cheap window
    const from = new Date('2025-01-15T23:30:00Z');
    const slots = getTouRates('23:00-07:00:7.5,07:00-23:00:28', 1, from);
    expect(slots[0].value_inc_vat).toBe(7.5);

    // 06:30 local (next morning) is also inside the midnight-crossing cheap window
    const from2 = new Date('2025-01-16T06:30:00Z');
    const slots2 = getTouRates('23:00-07:00:7.5,07:00-23:00:28', 1, from2);
    expect(slots2[0].value_inc_vat).toBe(7.5);

    // 10:00 local is in the expensive window
    const from3 = new Date('2025-01-15T10:00:00Z');
    const slots3 = getTouRates('23:00-07:00:7.5,07:00-23:00:28', 1, from3);
    expect(slots3[0].value_inc_vat).toBe(28);
  });

  it('slots have valid ISO 8601 valid_from and valid_to, each 30 min apart', () => {
    const from = new Date('2025-01-15T08:00:00Z');
    const slots = getTouRates('00:00-07:30:7.5,07:30-00:00:28', 2, from);
    for (const slot of slots) {
      const diff = new Date(slot.valid_to).getTime() - new Date(slot.valid_from).getTime();
      expect(diff).toBe(30 * 60 * 1000);
    }
  });

  it('slots are contiguous', () => {
    const from = new Date('2025-01-15T08:00:00Z');
    const slots = getTouRates('00:00-07:30:7.5,07:30-00:00:28', 4, from);
    for (let i = 1; i < slots.length; i++) {
      expect(slots[i].valid_from).toBe(slots[i - 1].valid_to);
    }
  });

  it('throws on a completely malformed segment', () => {
    expect(() => getTouRates('badvalue')).toThrow(/[Mm]alformed/);
  });

  it('throws on a segment missing the price', () => {
    expect(() => getTouRates('00:00-07:30')).toThrow();
  });

  it('throws on an empty schedule', () => {
    expect(() => getTouRates('')).toThrow();
  });

  it('handles a four-period schedule correctly', () => {
    // Economy-7-style: cheap 00:30-07:30, mid-day cheap 13:00-16:00, expensive otherwise
    const schedule = '00:30-07:30:7.5,13:00-16:00:7.5,07:30-13:00:28,16:00-00:30:28';

    // 01:00 local → cheap
    const from1 = new Date('2025-01-15T01:00:00Z');
    const slots1 = getTouRates(schedule, 1, from1);
    expect(slots1[0].value_inc_vat).toBe(7.5);

    // 14:00 local → cheap
    const from2 = new Date('2025-01-15T14:00:00Z');
    const slots2 = getTouRates(schedule, 1, from2);
    expect(slots2[0].value_inc_vat).toBe(7.5);

    // 09:00 local → expensive
    const from3 = new Date('2025-01-15T09:00:00Z');
    const slots3 = getTouRates(schedule, 1, from3);
    expect(slots3[0].value_inc_vat).toBe(28);
  });
});
