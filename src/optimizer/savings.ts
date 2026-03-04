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
    };
  } catch {
    return { week, month, weeklySavingVsStandardPence: 0, weeklyExportIncomePence: 0, weeklyCo2SavedGrams: 0, monthlySavingVsStandardPence: 0, monthlyExportIncomePence: 0, monthlyCo2SavedGrams: 0 };
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
  };
  try {
    fs.writeFileSync(SAVINGS_PATH, JSON.stringify(updated), 'utf-8');
  } catch (err) {
    console.warn('[optimizer] Failed to persist savings history:', err);
  }
  return updated;
}
