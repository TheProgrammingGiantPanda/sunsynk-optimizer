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
