import { describe, it, expect } from 'vitest';
import { selfSufficiencyPct, updateSelfSufficiency, SavingsHistory } from '../savings';

function makeHistory(overrides: Partial<SavingsHistory> = {}): SavingsHistory {
  return {
    week: '2026-W10',
    month: '2026-03',
    weeklySavingVsStandardPence: 0,
    weeklyExportIncomePence: 0,
    weeklyCo2SavedGrams: 0,
    monthlySavingVsStandardPence: 0,
    monthlyExportIncomePence: 0,
    monthlyCo2SavedGrams: 0,
    weeklyGridImportWh: 0,
    weeklyConsumptionWh: 0,
    monthlyGridImportWh: 0,
    monthlyConsumptionWh: 0,
    ...overrides,
  };
}

describe('selfSufficiencyPct', () => {
  it('returns null when consumption is zero', () => {
    expect(selfSufficiencyPct(0, 0)).toBeNull();
    expect(selfSufficiencyPct(500, 0)).toBeNull();
  });

  it('returns 100% when grid import is zero', () => {
    expect(selfSufficiencyPct(0, 10000)).toBe(100);
  });

  it('returns 0% when grid import equals consumption', () => {
    expect(selfSufficiencyPct(5000, 5000)).toBe(0);
  });

  it('returns 50% when grid covers half consumption', () => {
    expect(selfSufficiencyPct(5000, 10000)).toBe(50);
  });

  it('clamps to 0% when grid import exceeds consumption', () => {
    // Grid > consumption means negative generation reported — clamp to 0
    expect(selfSufficiencyPct(12000, 10000)).toBe(0);
  });

  it('rounds to one decimal place', () => {
    // 1 - 3000/7000 = ~57.142...%
    expect(selfSufficiencyPct(3000, 7000)).toBe(57.1);
  });
});

describe('updateSelfSufficiency', () => {
  // Use a fixed date in week 2026-W10, month 2026-03
  const now = new Date('2026-03-04T12:00:00Z');

  it('accumulates grid import and consumption into the same week/month', () => {
    const history = makeHistory();
    const result = updateSelfSufficiency(history, 2000, 8000, now);
    expect(result.weeklyGridImportWh).toBe(2000);
    expect(result.weeklyConsumptionWh).toBe(8000);
    expect(result.monthlyGridImportWh).toBe(2000);
    expect(result.monthlyConsumptionWh).toBe(8000);
  });

  it('adds to existing accumulators when week/month match', () => {
    const history = makeHistory({ weeklyGridImportWh: 1000, weeklyConsumptionWh: 4000, monthlyGridImportWh: 3000, monthlyConsumptionWh: 12000 });
    const result = updateSelfSufficiency(history, 500, 2000, now);
    expect(result.weeklyGridImportWh).toBe(1500);
    expect(result.weeklyConsumptionWh).toBe(6000);
    expect(result.monthlyGridImportWh).toBe(3500);
    expect(result.monthlyConsumptionWh).toBe(14000);
  });

  it('resets weekly accumulators when week changes', () => {
    // 2026-03-09 is in week W11
    const nextWeek = new Date('2026-03-09T12:00:00Z');
    const history = makeHistory({ week: '2026-W10', weeklyGridImportWh: 5000, weeklyConsumptionWh: 20000 });
    const result = updateSelfSufficiency(history, 800, 3000, nextWeek);
    expect(result.weeklyGridImportWh).toBe(800);
    expect(result.weeklyConsumptionWh).toBe(3000);
    // Month is still the same (March), so monthly should accumulate
    expect(result.monthlyGridImportWh).toBe(800);
    expect(result.monthlyConsumptionWh).toBe(3000);
  });

  it('resets monthly accumulators when month changes', () => {
    // 2026-04-01 is in April (new month) and a new week
    const nextMonth = new Date('2026-04-01T12:00:00Z');
    const history = makeHistory({ month: '2026-03', monthlyGridImportWh: 10000, monthlyConsumptionWh: 40000 });
    const result = updateSelfSufficiency(history, 200, 1000, nextMonth);
    expect(result.monthlyGridImportWh).toBe(200);
    expect(result.monthlyConsumptionWh).toBe(1000);
  });

  it('preserves savings accumulators unchanged', () => {
    const history = makeHistory({ weeklySavingVsStandardPence: 500, monthlySavingVsStandardPence: 2000, weeklyCo2SavedGrams: 300 });
    const result = updateSelfSufficiency(history, 1000, 5000, now);
    expect(result.weeklySavingVsStandardPence).toBe(500);
    expect(result.monthlySavingVsStandardPence).toBe(2000);
    expect(result.weeklyCo2SavedGrams).toBe(300);
  });
});
