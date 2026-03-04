import fs from 'fs';
import path from 'path';

const DATA_DIR = fs.existsSync('/data') ? '/data' : process.cwd();
const ACCURACY_PATH = path.join(DATA_DIR, 'forecast_accuracy.json');
const MAX_RECORDS = 90;

export interface AccuracyRecord {
  date: string;              // YYYY-MM-DD
  forecastP50Wh: number;
  actualWh: number | null;
  absErrorPct: number | null; // |actual − forecast| / actual × 100; null until actual is known
}

export interface AccuracyStats {
  mape7d: number | null;   // mean absolute % error over last 7 days (null if < 2 complete records)
  mape30d: number | null;  // mean absolute % error over last 30 days
}

export function loadAccuracyHistory(): AccuracyRecord[] {
  try {
    if (!fs.existsSync(ACCURACY_PATH)) return [];
    return JSON.parse(fs.readFileSync(ACCURACY_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

export function saveAccuracyHistory(records: AccuracyRecord[]): void {
  try {
    fs.writeFileSync(ACCURACY_PATH, JSON.stringify(records), 'utf-8');
  } catch (err) {
    console.warn('[accuracy] Failed to persist forecast accuracy history:', err);
  }
}

/**
 * Upsert today's Solcast P50 forecast total (Wh) into the history.
 * Returns the updated (sorted, trimmed) records array.
 */
export function recordForecast(records: AccuracyRecord[], date: string, forecastP50Wh: number): AccuracyRecord[] {
  const existing = records.find(r => r.date === date);
  if (existing) {
    existing.forecastP50Wh = forecastP50Wh;
    return records;
  }
  const updated = [...records, { date, forecastP50Wh, actualWh: null, absErrorPct: null }];
  return updated.sort((a, b) => a.date.localeCompare(b.date)).slice(-MAX_RECORDS);
}

/**
 * Complete a record with the actual measured generation for a given date.
 * Computes absErrorPct if actual > 0 (avoids division by zero on zero-generation days).
 * No-ops silently if no forecast record exists for that date.
 */
export function recordActual(records: AccuracyRecord[], date: string, actualWh: number): AccuracyRecord[] {
  const existing = records.find(r => r.date === date);
  if (!existing) return records;
  existing.actualWh = actualWh;
  existing.absErrorPct = actualWh > 0
    ? Math.round(Math.abs(actualWh - existing.forecastP50Wh) / actualWh * 1000) / 10
    : null;
  return records;
}

/**
 * Compute MAPE stats over 7-day and 30-day windows.
 * Only includes records where absErrorPct is known (actual was recorded).
 */
export function getAccuracyStats(records: AccuracyRecord[], now = new Date()): AccuracyStats {
  const complete = records.filter(r => r.absErrorPct !== null);

  const cutoff = (days: number) => {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString().slice(0, 10);
  };

  const mape = (arr: AccuracyRecord[]) =>
    arr.length < 2 ? null
      : Math.round(arr.reduce((s, r) => s + r.absErrorPct!, 0) / arr.length * 10) / 10;

  return {
    mape7d:  mape(complete.filter(r => r.date >= cutoff(7))),
    mape30d: mape(complete.filter(r => r.date >= cutoff(30))),
  };
}

/**
 * Suggest a forecastConfidenceFactor based on observed MAPE.
 * Higher MAPE → lean more towards the conservative p10 forecast.
 * MAPE of 0% → 0.0, MAPE of 100% → 1.0, clamped to [0, 1].
 */
export function suggestConfidenceFactor(mape: number): number {
  return Math.round(Math.min(Math.max(mape / 100, 0), 1) * 100) / 100;
}
