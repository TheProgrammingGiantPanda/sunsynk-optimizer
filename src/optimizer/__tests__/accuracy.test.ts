import { describe, it, expect } from 'vitest';
import {
  recordForecast, recordActual, getAccuracyStats, suggestConfidenceFactor,
  AccuracyRecord,
} from '../accuracy';

function makeRecord(date: string, forecastP50Wh: number, actualWh: number | null): AccuracyRecord {
  const absErrorPct = (actualWh !== null && actualWh > 0)
    ? Math.round(Math.abs(actualWh - forecastP50Wh) / actualWh * 1000) / 10
    : null;
  return { date, forecastP50Wh, actualWh, absErrorPct };
}

describe('recordForecast', () => {
  it('adds a new record for an unknown date', () => {
    const result = recordForecast([], '2026-03-01', 5000);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ date: '2026-03-01', forecastP50Wh: 5000, actualWh: null });
  });

  it('updates forecastP50Wh for an existing date', () => {
    const base = recordForecast([], '2026-03-01', 4000);
    const result = recordForecast(base, '2026-03-01', 5500);
    expect(result).toHaveLength(1);
    expect(result[0].forecastP50Wh).toBe(5500);
  });

  it('trims to 90 records, keeping newest', () => {
    let records: AccuracyRecord[] = [];
    for (let i = 0; i < 95; i++) {
      const date = new Date(2025, 0, i + 1).toISOString().slice(0, 10);
      records = recordForecast(records, date, 1000);
    }
    expect(records).toHaveLength(90);
    // Newest 90 should be kept (last 5 of 95 dropped from the front)
    expect(records[0].date > '2025-01-01').toBe(true);
  });
});

describe('recordActual', () => {
  it('fills actualWh and computes absErrorPct', () => {
    let records = recordForecast([], '2026-03-01', 5000);
    records = recordActual(records, '2026-03-01', 4000);
    expect(records[0].actualWh).toBe(4000);
    // |4000 - 5000| / 4000 * 100 = 25%
    expect(records[0].absErrorPct).toBe(25);
  });

  it('sets absErrorPct to null when actual is zero (avoids division by zero)', () => {
    let records = recordForecast([], '2026-03-01', 500);
    records = recordActual(records, '2026-03-01', 0);
    expect(records[0].absErrorPct).toBeNull();
  });

  it('no-ops when no forecast record exists for the date', () => {
    const records = recordActual([], '2026-03-01', 5000);
    expect(records).toHaveLength(0);
  });
});

describe('getAccuracyStats', () => {
  it('returns null for both windows when fewer than 2 complete records', () => {
    const records = [makeRecord('2026-03-01', 5000, 4000)];
    const stats = getAccuracyStats(records, new Date('2026-03-04'));
    expect(stats.mape7d).toBeNull();
    expect(stats.mape30d).toBeNull();
  });

  it('computes mape7d from records within 7 days', () => {
    const now = new Date('2026-03-04');
    const records = [
      makeRecord('2026-03-01', 5000, 4000),  // 25% error
      makeRecord('2026-03-02', 4000, 5000),  // 20% error
      makeRecord('2026-01-01', 1000, 2000),  // old — outside 7d window
    ];
    const stats = getAccuracyStats(records, now);
    expect(stats.mape7d).toBe(22.5);  // (25 + 20) / 2
  });

  it('includes more records in mape30d than mape7d', () => {
    const now = new Date('2026-03-04');
    const records = [
      makeRecord('2026-02-10', 5000, 4000), // 25% — within 30d, outside 7d
      makeRecord('2026-03-01', 4000, 5000), // 20% — within both
      makeRecord('2026-03-02', 3000, 4000), // 25% — within both
    ];
    const stats = getAccuracyStats(records, now);
    expect(stats.mape7d).toBe(22.5);   // (20+25)/2
    expect(stats.mape30d).toBe(23.3);  // (25+20+25)/3
  });
});

describe('suggestConfidenceFactor', () => {
  it('maps 0% MAPE to factor 0', () => expect(suggestConfidenceFactor(0)).toBe(0));
  it('maps 50% MAPE to factor 0.5', () => expect(suggestConfidenceFactor(50)).toBe(0.5));
  it('maps 100% MAPE to factor 1', () => expect(suggestConfidenceFactor(100)).toBe(1));
  it('clamps above 100% to 1', () => expect(suggestConfidenceFactor(150)).toBe(1));
  it('clamps below 0 to 0', () => expect(suggestConfidenceFactor(-10)).toBe(0));
});
