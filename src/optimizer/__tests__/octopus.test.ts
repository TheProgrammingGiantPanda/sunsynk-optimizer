import { describe, it, expect } from 'vitest';
import { getFixedExportRate } from '../octopus';

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
