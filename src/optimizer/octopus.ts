import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { withRetry } from './retry';

// ── Disk cache ────────────────────────────────────────────────────────────────

const DATA_DIR = fs.existsSync('/data') ? '/data' : process.cwd();
const IMPORT_CACHE_PATH = path.join(DATA_DIR, 'agile_rates_cache.json');
const EXPORT_CACHE_PATH = path.join(DATA_DIR, 'agile_export_cache.json');

interface RatesCache {
  fetchedAt: string;
  rates: PriceSlot[];
}

function saveRatesCache(rates: PriceSlot[], cachePath: string): void {
  try {
    fs.writeFileSync(cachePath, JSON.stringify({ fetchedAt: new Date().toISOString(), rates }), 'utf-8');
  } catch (err: any) {
    console.warn(`[octopus] Failed to write rates cache: ${err?.message ?? err}`);
  }
}

function loadRatesCache(cachePath: string, label: string): PriceSlot[] | null {
  try {
    if (!fs.existsSync(cachePath)) return null;
    const cache: RatesCache = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    const now = new Date();
    const futureSlots = cache.rates.filter(r => new Date(r.valid_to) > now);
    if (futureSlots.length === 0) {
      console.warn(`[octopus] Cached ${label} are fully expired — no future slots`);
      return null;
    }
    const ageMin = Math.round((Date.now() - new Date(cache.fetchedAt).getTime()) / 60000);
    console.warn(`[octopus] Live ${label} fetch failed — using cache from ${cache.fetchedAt} (${ageMin} min ago, ${futureSlots.length} future slots)`);
    return cache.rates;
  } catch {
    return null;
  }
}

export interface PriceSlot {
  value_exc_vat: number;
  value_inc_vat: number;  // pence per kWh
  valid_from: string;     // ISO 8601
  valid_to: string;       // ISO 8601
  payment_method: string | null;
}

/**
 * Parse a fixed export tariff schedule and return the rate active on `date`.
 *
 * Schedule format: comma-separated "RATE:YYYY-MM-DD" pairs, where the date is
 * the start of that rate's validity.  Example: "15:2024-01-01,10:2026-04-01"
 * Returns the rate whose start date is the latest one that does not exceed `date`.
 * Returns 0 if the schedule is empty or unparseable.
 */
export function getFixedExportRate(schedule: string, date: Date = new Date()): number {
  if (!schedule?.trim()) return 0;
  const dateStr = date.toISOString().slice(0, 10); // "YYYY-MM-DD"
  const entries = schedule.split(',').map(s => s.trim()).filter(Boolean);
  let active = 0;
  let activeDate = '';
  for (const entry of entries) {
    const colon = entry.indexOf(':');
    if (colon === -1) continue;
    const rate = parseFloat(entry.slice(0, colon));
    const startDate = entry.slice(colon + 1).trim();
    if (isNaN(rate) || !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) continue;
    if (startDate <= dateStr && startDate >= activeDate) {
      active = rate;
      activeDate = startDate;
    }
  }
  return active;
}

export async function getAgileRates(
  product: string,
  tariff: string
): Promise<PriceSlot[]> {
  const url = `https://api.octopus.energy/v1/products/${product}/electricity-tariffs/${tariff}/standard-unit-rates/`;
  try {
    const rates = await withRetry(
      () => axios.get(url, { params: { page_size: 192 }, headers: { Accept: 'application/json' }, timeout: 15000 })
        .then(res => res.data?.results ?? []),
      { label: 'Octopus Agile rates' }
    );
    saveRatesCache(rates, IMPORT_CACHE_PATH);
    return rates;
  } catch (err) {
    const cached = loadRatesCache(IMPORT_CACHE_PATH, 'import rates');
    if (cached) return cached;
    throw err;
  }
}

/**
 * Fetch the full Outgoing Agile export rate schedule (pence/kWh half-hourly slots).
 * Returns an empty array if the fetch fails — callers should handle gracefully.
 */
export async function getOutgoingAgileRates(
  product: string,
  tariff: string
): Promise<PriceSlot[]> {
  const url = `https://api.octopus.energy/v1/products/${product}/electricity-tariffs/${tariff}/standard-unit-rates/`;
  try {
    const rates = await withRetry(
      () => axios.get(url, { params: { page_size: 192 }, headers: { Accept: 'application/json' }, timeout: 15000 })
        .then(res => res.data?.results ?? []),
      { label: 'Outgoing Agile export rates' }
    );
    saveRatesCache(rates, EXPORT_CACHE_PATH);
    return rates;
  } catch {
    return loadRatesCache(EXPORT_CACHE_PATH, 'export rates') ?? [];
  }
}

// ── TOU (Time-of-Use) rate synthesis ─────────────────────────────────────────

function parseHHMM(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function getLocalMinutes(date: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const h = parseInt(parts.find(p => p.type === 'hour')!.value, 10);
  const m = parseInt(parts.find(p => p.type === 'minute')!.value, 10);
  return h * 60 + m;
}

interface TouPeriod { startMin: number; endMin: number; pence: number; }

function touFindRate(periods: TouPeriod[], slotMin: number): number {
  for (const p of periods) {
    if (p.startMin < p.endMin) {
      if (slotMin >= p.startMin && slotMin < p.endMin) return p.pence;
    } else {
      // Midnight-crossing period (e.g. 23:00–07:00)
      if (slotMin >= p.startMin || slotMin < p.endMin) return p.pence;
    }
  }
  // Fallback: use the period that ended most recently before slotMin
  let bestPence = periods[periods.length - 1].pence;
  let bestDiff = Infinity;
  for (const p of periods) {
    const diff = (slotMin - p.endMin + 1440) % 1440;
    if (diff < bestDiff) { bestDiff = diff; bestPence = p.pence; }
  }
  return bestPence;
}

/**
 * Synthesise PriceSlot[] from a TOU schedule string.
 *
 * Format: comma-separated "HH:MM-HH:MM:PRICE" periods in local UK time (Europe/London).
 * Example: "00:30-07:30:7.5,07:30-00:30:28"
 *
 * Generates 30-min slots from `from` to `from + horizonHours`.
 * Gaps in coverage fall back to the most recently ended period.
 * Throws a descriptive error if the schedule is malformed.
 */
export function getTouRates(schedule: string, horizonHours = 36, from = new Date()): PriceSlot[] {
  if (!schedule?.trim()) {
    throw new Error('[tou] tou_rates is empty — provide a comma-separated HH:MM-HH:MM:PRICE schedule');
  }

  const periods: TouPeriod[] = [];
  for (const segment of schedule.split(',').map(s => s.trim()).filter(Boolean)) {
    const match = segment.match(/^(\d{2}:\d{2})-(\d{2}:\d{2}):(\d+(?:\.\d+)?)$/);
    if (!match) {
      throw new Error(
        `[tou] Malformed period: "${segment}". ` +
        `Expected format HH:MM-HH:MM:PRICE, e.g. "00:30-07:30:7.5,07:30-00:30:28"`
      );
    }
    const pence = parseFloat(match[3]);
    if (isNaN(pence)) throw new Error(`[tou] Invalid price in "${segment}"`);
    periods.push({ startMin: parseHHMM(match[1]), endMin: parseHHMM(match[2]), pence });
  }

  if (periods.length === 0) throw new Error('[tou] No valid periods found in tou_rates');

  // Snap start to current half-hour boundary (floor)
  const slotStart = new Date(from);
  slotStart.setSeconds(0, 0);
  slotStart.setMinutes(slotStart.getMinutes() < 30 ? 0 : 30);

  const slots: PriceSlot[] = [];
  const endMs = slotStart.getTime() + horizonHours * 3600000;
  for (let t = slotStart.getTime(); t < endMs; t += 30 * 60000) {
    const slotDate = new Date(t);
    const pence = touFindRate(periods, getLocalMinutes(slotDate));
    slots.push({
      value_exc_vat: pence / 1.05,
      value_inc_vat: pence,
      valid_from: slotDate.toISOString(),
      valid_to: new Date(t + 30 * 60000).toISOString(),
      payment_method: null,
    });
  }
  return slots;
}

/**
 * Fetch Outgoing Agile export rates and return the current slot's rate (pence/kWh).
 * Returns null if the fetch fails or no current slot is found.
 */
export async function getOutgoingAgileRate(
  product: string,
  tariff: string,
  date: Date = new Date()
): Promise<number | null> {
  const slots = await getOutgoingAgileRates(product, tariff);
  const current = slots.find(s => {
    const from = new Date(s.valid_from);
    const to   = new Date(s.valid_to);
    return from <= date && to > date;
  });
  return current?.value_inc_vat ?? null;
}
