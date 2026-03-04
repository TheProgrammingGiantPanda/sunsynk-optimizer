import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { withRetry } from './retry';

export interface ForecastSlot {
  period_end: string;   // ISO 8601 UTC datetime
  period: string;       // e.g. "PT30M"
  pv_estimate: number;  // kW (mean estimate)
  pv_estimate10: number;
  pv_estimate90: number;
}

interface ForecastCache {
  fetchedAt: string;    // ISO 8601
  forecasts: ForecastSlot[];
}

const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_PATH = fs.existsSync('/data')
  ? '/data/pv_forecast_cache.json'
  : path.join(process.cwd(), 'pv_forecast_cache.json');

function saveCache(forecasts: ForecastSlot[]): void {
  try {
    const cache: ForecastCache = { fetchedAt: new Date().toISOString(), forecasts };
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache), 'utf-8');
    console.log(`[solcast] Forecast cached to ${CACHE_PATH}`);
  } catch (err: any) {
    console.warn(`[solcast] Failed to write forecast cache: ${err?.message ?? err}`);
  }
}

export function loadForecastCache(): ForecastSlot[] | null {
  try {
    if (!fs.existsSync(CACHE_PATH)) return null;
    const cache: ForecastCache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
    const ageMs = Date.now() - new Date(cache.fetchedAt).getTime();
    if (ageMs > CACHE_MAX_AGE_MS) {
      console.warn(`[solcast] Forecast cache is ${Math.round(ageMs / 3600000)}h old — too stale to use`);
      return null;
    }
    console.log(`[solcast] Using cached forecast from ${cache.fetchedAt} (${Math.round(ageMs / 60000)} min ago)`);
    return cache.forecasts;
  } catch {
    return null;
  }
}

export async function getSolarForecast(siteId: string, apiKey: string): Promise<ForecastSlot[]> {
  const url = `https://api.solcast.com.au/rooftop_sites/${siteId}/forecasts`;
  const auth = `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;
  return withRetry(
    () => axios.get(url, {
      params: { format: 'json' },
      headers: { Accept: 'application/json', Authorization: auth },
      timeout: 15000,
    }).then(res => res.data?.forecasts ?? []),
    { label: `Solcast site ${siteId}` }
  );
}

/**
 * Fetches forecasts for all sites in parallel and merges them into a single
 * array by summing pv_estimate (and p10/p90) for each period_end timestamp.
 *
 * On a 429 rate-limit error, falls back to the last cached forecast (if < 24 h old).
 * Saves a fresh cache after every successful fetch.
 */
export async function getMergedForecast(siteIds: string[], apiKey: string): Promise<ForecastSlot[]> {
  let allForecasts: ForecastSlot[][];
  try {
    allForecasts = await Promise.all(siteIds.map(id => getSolarForecast(id, apiKey)));
  } catch (err: any) {
    if (err?.response?.status === 429) {
      console.warn('[solcast] Rate limit hit (429) — attempting to load cached forecast');
      const cached = loadForecastCache();
      if (cached) return cached;
    }
    throw err;
  }

  const merged = new Map<string, ForecastSlot>();
  for (const forecasts of allForecasts) {
    for (const slot of forecasts) {
      const existing = merged.get(slot.period_end);
      if (existing) {
        existing.pv_estimate   += slot.pv_estimate;
        existing.pv_estimate10 += slot.pv_estimate10;
        existing.pv_estimate90 += slot.pv_estimate90;
      } else {
        merged.set(slot.period_end, { ...slot });
      }
    }
  }

  const result = [...merged.values()].sort((a, b) => a.period_end.localeCompare(b.period_end));
  saveCache(result);
  return result;
}

/**
 * Returns the P50 PV generation forecast for tomorrow (UTC calendar date) in Wh.
 * Each slot's pv_estimate is in kW over a 30-min period, so energy = kW × 0.5 × 1000 Wh.
 * Returns 0 if no slots are available for tomorrow.
 */
export function tomorrowPvWh(forecasts: ForecastSlot[]): number {
  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const tomorrowDateStr = tomorrow.toISOString().slice(0, 10);
  return Math.round(
    forecasts
      .filter(s => s.period_end.startsWith(tomorrowDateStr))
      .reduce((sum, s) => sum + s.pv_estimate * 0.5 * 1000, 0)
  );
}
