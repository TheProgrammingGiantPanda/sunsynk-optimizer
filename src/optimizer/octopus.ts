import axios from 'axios';
import { withRetry } from './retry';

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
  return withRetry(
    () => axios.get(url, { params: { page_size: 192 }, headers: { Accept: 'application/json' }, timeout: 15000 })
      .then(res => res.data?.results ?? []),
    { label: 'Octopus Agile rates' }
  );
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
  const url = `https://api.octopus.energy/v1/products/${product}/electricity-tariffs/${tariff}/standard-unit-rates/`;
  let slots: PriceSlot[];
  try {
    slots = await withRetry(
      () => axios.get(url, { params: { page_size: 48 }, headers: { Accept: 'application/json' }, timeout: 15000 })
        .then(res => res.data?.results ?? []),
      { label: 'Outgoing Agile export rates' }
    );
  } catch {
    return null;
  }
  const current = slots.find(s => {
    const from = new Date(s.valid_from);
    const to   = new Date(s.valid_to);
    return from <= date && to > date;
  });
  return current?.value_inc_vat ?? null;
}
