import fs from 'fs';
import path from 'path';

const DATA_DIR = fs.existsSync('/data') ? '/data' : process.cwd();
const SAVINGS_PATH = path.join(DATA_DIR, 'savings_history.json');

export interface SavingsHistory {
  week: string;          // ISO week key: "2026-W10"
  month: string;         // "2026-03"
  weeklySavingVsStandardPence: number;
  weeklyExportIncomePence: number;
  weeklyCo2SavedGrams: number;
  monthlySavingVsStandardPence: number;
  monthlyExportIncomePence: number;
  monthlyCo2SavedGrams: number;
  // Self-sufficiency: accumulated Wh totals for completed days this week/month
  weeklyGridImportWh: number;
  weeklyConsumptionWh: number;
  monthlyGridImportWh: number;
  monthlyConsumptionWh: number;
  // Actual grid import cost accumulated from completed days this week/month
  weeklyGridCostPence: number;
  monthlyGridCostPence: number;
}

/**
 * Compute self-sufficiency percentage from total grid import and total consumption Wh.
 * Returns null if consumption is zero (avoids division by zero).
 * Clamped to [0, 100].
 */
export function selfSufficiencyPct(gridImportWh: number, consumptionWh: number): number | null {
  if (consumptionWh <= 0) return null;
  return Math.round(Math.max(0, 1 - gridImportWh / consumptionWh) * 1000) / 10;
}

function isoWeek(d: Date): string {
  // ISO 8601 week: Monday-based, week containing first Thursday of year is week 1
  const tmp = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dow);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((tmp.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${tmp.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function isoMonth(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function loadSavingsHistory(now = new Date()): SavingsHistory {
  const week = isoWeek(now);
  const month = isoMonth(now);
  try {
    const saved: SavingsHistory = JSON.parse(fs.readFileSync(SAVINGS_PATH, 'utf-8'));
    return {
      week,
      month,
      weeklySavingVsStandardPence:  saved.week  === week  ? saved.weeklySavingVsStandardPence  : 0,
      weeklyExportIncomePence:       saved.week  === week  ? saved.weeklyExportIncomePence       : 0,
      weeklyCo2SavedGrams:           saved.week  === week  ? (saved.weeklyCo2SavedGrams ?? 0)    : 0,
      monthlySavingVsStandardPence:  saved.month === month ? saved.monthlySavingVsStandardPence  : 0,
      monthlyExportIncomePence:      saved.month === month ? saved.monthlyExportIncomePence       : 0,
      monthlyCo2SavedGrams:          saved.month === month ? (saved.monthlyCo2SavedGrams ?? 0)   : 0,
      weeklyGridImportWh:            saved.week  === week  ? (saved.weeklyGridImportWh  ?? 0)    : 0,
      weeklyConsumptionWh:           saved.week  === week  ? (saved.weeklyConsumptionWh ?? 0)    : 0,
      monthlyGridImportWh:           saved.month === month ? (saved.monthlyGridImportWh  ?? 0)   : 0,
      monthlyConsumptionWh:          saved.month === month ? (saved.monthlyConsumptionWh ?? 0)   : 0,
      weeklyGridCostPence:           saved.week  === week  ? (saved.weeklyGridCostPence  ?? 0)   : 0,
      monthlyGridCostPence:          saved.month === month ? (saved.monthlyGridCostPence ?? 0)   : 0,
    };
  } catch {
    return { week, month, weeklySavingVsStandardPence: 0, weeklyExportIncomePence: 0, weeklyCo2SavedGrams: 0, monthlySavingVsStandardPence: 0, monthlyExportIncomePence: 0, monthlyCo2SavedGrams: 0, weeklyGridImportWh: 0, weeklyConsumptionWh: 0, monthlyGridImportWh: 0, monthlyConsumptionWh: 0, weeklyGridCostPence: 0, monthlyGridCostPence: 0 };
  }
}

export function updateSavingsHistory(
  history: SavingsHistory,
  savingVsStandardPence: number,
  exportIncomePence: number,
  co2SavedGrams: number,
  now = new Date()
): SavingsHistory {
  const week = isoWeek(now);
  const month = isoMonth(now);
  const updated: SavingsHistory = {
    week,
    month,
    weeklySavingVsStandardPence:  (history.week  === week  ? history.weeklySavingVsStandardPence  : 0) + savingVsStandardPence,
    weeklyExportIncomePence:       (history.week  === week  ? history.weeklyExportIncomePence       : 0) + exportIncomePence,
    weeklyCo2SavedGrams:           (history.week  === week  ? history.weeklyCo2SavedGrams           : 0) + co2SavedGrams,
    monthlySavingVsStandardPence:  (history.month === month ? history.monthlySavingVsStandardPence  : 0) + savingVsStandardPence,
    monthlyExportIncomePence:      (history.month === month ? history.monthlyExportIncomePence       : 0) + exportIncomePence,
    monthlyCo2SavedGrams:          (history.month === month ? history.monthlyCo2SavedGrams           : 0) + co2SavedGrams,
    // Preserve day-rollover accumulators unchanged (updated separately at midnight)
    weeklyGridImportWh:   history.week  === week  ? (history.weeklyGridImportWh  ?? 0) : 0,
    weeklyConsumptionWh:  history.week  === week  ? (history.weeklyConsumptionWh ?? 0) : 0,
    monthlyGridImportWh:  history.month === month ? (history.monthlyGridImportWh  ?? 0) : 0,
    monthlyConsumptionWh: history.month === month ? (history.monthlyConsumptionWh ?? 0) : 0,
    weeklyGridCostPence:  history.week  === week  ? (history.weeklyGridCostPence  ?? 0) : 0,
    monthlyGridCostPence: history.month === month ? (history.monthlyGridCostPence ?? 0) : 0,
  };
  try {
    fs.writeFileSync(SAVINGS_PATH, JSON.stringify(updated), 'utf-8');
  } catch (err) {
    console.warn('[optimizer] Failed to persist savings history:', err);
  }
  return updated;
}

/**
 * Add a completed day's actual grid cost to the weekly/monthly accumulators.
 * Called at day rollover before resetting the daily accumulator.
 */
export function updateGridCost(
  history: SavingsHistory,
  gridCostPence: number,
  now = new Date()
): SavingsHistory {
  const week = isoWeek(now);
  const month = isoMonth(now);
  const updated: SavingsHistory = {
    ...history,
    week,
    month,
    weeklyGridCostPence:  (history.week  === week  ? (history.weeklyGridCostPence  ?? 0) : 0) + gridCostPence,
    monthlyGridCostPence: (history.month === month ? (history.monthlyGridCostPence ?? 0) : 0) + gridCostPence,
  };
  try {
    fs.writeFileSync(SAVINGS_PATH, JSON.stringify(updated), 'utf-8');
  } catch (err) {
    console.warn('[optimizer] Failed to persist savings history:', err);
  }
  return updated;
}

/**
 * Add a completed day's grid import and consumption to the weekly/monthly self-sufficiency
 * accumulators. Called at day rollover using the previous day's final sensor readings.
 */
export function updateSelfSufficiency(
  history: SavingsHistory,
  gridImportWh: number,
  consumptionWh: number,
  now = new Date()
): SavingsHistory {
  const week = isoWeek(now);
  const month = isoMonth(now);
  const updated: SavingsHistory = {
    ...history,
    week,
    month,
    weeklyGridImportWh:   (history.week  === week  ? (history.weeklyGridImportWh  ?? 0) : 0) + gridImportWh,
    weeklyConsumptionWh:  (history.week  === week  ? (history.weeklyConsumptionWh ?? 0) : 0) + consumptionWh,
    monthlyGridImportWh:  (history.month === month ? (history.monthlyGridImportWh  ?? 0) : 0) + gridImportWh,
    monthlyConsumptionWh: (history.month === month ? (history.monthlyConsumptionWh ?? 0) : 0) + consumptionWh,
  };
  try {
    fs.writeFileSync(SAVINGS_PATH, JSON.stringify(updated), 'utf-8');
  } catch (err) {
    console.warn('[optimizer] Failed to persist savings history:', err);
  }
  return updated;
}
