import axios from 'axios';
import { withRetry } from './retry';
import { PriceSlot } from './octopus';

// National Grid ESO Carbon Intensity API — free, no auth required.
// https://api.carbonintensity.org.uk

export interface CarbonSlot {
  from: string;   // ISO 8601
  to: string;     // ISO 8601
  intensity: number; // gCO2/kWh forecast
}

interface ApiPeriod {
  from: string;
  to: string;
  intensity: { forecast: number };
}

/**
 * Fetch the 48h carbon intensity forecast for the given region.
 * regionId: National Grid ESO region (1=North Scotland, 12=South East England, etc.)
 * Falls back to the national average if regionId is 0 or omitted.
 */
export async function getCarbonIntensityForecast(regionId = 0): Promise<CarbonSlot[]> {
  const url = regionId > 0
    ? `https://api.carbonintensity.org.uk/regional/regionid/${regionId}/intensity/pt24h/fw48h`
    : 'https://api.carbonintensity.org.uk/v2/intensity/pt24h/fw48h';

  const res = await withRetry(
    () => axios.get(url, { timeout: 10000, headers: { Accept: 'application/json' } }),
    { label: 'carbon intensity forecast' }
  );

  const periods: ApiPeriod[] = regionId > 0
    ? (res.data?.data?.[0]?.data ?? [])
    : (res.data?.data ?? []);

  return periods.map((p: ApiPeriod) => ({
    from: p.from,
    to: p.to,
    intensity: p.intensity?.forecast ?? 0,
  }));
}

/**
 * Given carbon intensity forecasts and a list of Agile rate slots, blend each
 * slot's price with a carbon penalty to produce carbon-adjusted rates for scoring.
 *
 * The carbon penalty is normalised so that an average-carbon slot adds 0p and a
 * high-carbon slot adds a penalty proportional to `weight` × the slot's price.
 * Low-carbon slots get a corresponding discount. The blending uses:
 *
 *   adjustedPrice = price × (1 - weight) + price × weight × (intensity / avgIntensity)
 *
 * which simplifies to: price × (1 - weight + weight × relativeIntensity).
 * This keeps the units in pence and preserves the ordering for pure-price cases (weight=0).
 */
/**
 * Estimate gCO2 saved this price update by shifting energy from expensive high-carbon
 * slots to cheap lower-carbon slots.
 *
 * Method:
 *  - avgExpensiveIntensity = mean carbon intensity of upcoming expensive slots
 *  - avgCheapIntensity     = mean carbon intensity of the N cheapest cheap slots we charge at
 *  - co2Saved = energyPurchasedKwh × max(0, avgExpensiveIntensity − avgCheapIntensity) gCO2
 *
 * Returns 0 when carbon data is unavailable or cheap slots are actually higher-carbon than peak.
 */
export function estimateCo2SavedGrams(
  rates: PriceSlot[],
  carbonSlots: CarbonSlot[],
  expensiveThresholdPence: number,
  blocksCharged: number,
  fillRateWh: number
): number {
  if (carbonSlots.length === 0 || blocksCharged === 0) return 0;

  const carbonMap = new Map<string, number>();
  for (const s of carbonSlots) carbonMap.set(s.from, s.intensity);

  const now = new Date();
  const future = rates.filter(r => new Date(r.valid_to) > now);

  const expensiveIntensities = future
    .filter(r => r.value_inc_vat >= expensiveThresholdPence)
    .map(r => carbonMap.get(r.valid_from))
    .filter((v): v is number => v != null);

  const cheapSorted = future
    .filter(r => r.value_inc_vat < expensiveThresholdPence)
    .sort((a, b) => a.value_inc_vat - b.value_inc_vat)
    .slice(0, blocksCharged);

  const cheapIntensities = cheapSorted
    .map(r => carbonMap.get(r.valid_from))
    .filter((v): v is number => v != null);

  if (expensiveIntensities.length === 0 || cheapIntensities.length === 0) return 0;

  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const delta = avg(expensiveIntensities) - avg(cheapIntensities);
  if (delta <= 0) return 0;

  const energyPurchasedKwh = (blocksCharged * fillRateWh) / 1000;
  return Math.round(delta * energyPurchasedKwh);
}

export function applyCarbonWeighting<T extends { value_inc_vat: number; value_exc_vat: number; valid_from: string; valid_to: string }>(
  rates: T[],
  carbonSlots: CarbonSlot[],
  weight: number
): T[] {
  if (weight <= 0 || carbonSlots.length === 0) return rates;

  const w = Math.max(0, Math.min(1, weight));

  // Map carbon slots by start time for fast lookup
  const carbonMap = new Map<string, number>();
  for (const s of carbonSlots) carbonMap.set(s.from, s.intensity);

  // Compute mean intensity across matched slots for normalisation
  const matched = rates.map(r => carbonMap.get(r.valid_from) ?? null).filter((v): v is number => v !== null);
  if (matched.length === 0) return rates;
  const avgIntensity = matched.reduce((a, b) => a + b, 0) / matched.length;
  if (avgIntensity === 0) return rates;

  return rates.map(r => {
    const intensity = carbonMap.get(r.valid_from);
    if (intensity == null) return r;
    const relativeIntensity = intensity / avgIntensity;
    const factor = 1 - w + w * relativeIntensity;
    return {
      ...r,
      value_inc_vat: r.value_inc_vat * factor,
      value_exc_vat: r.value_exc_vat * factor,
    };
  });
}
