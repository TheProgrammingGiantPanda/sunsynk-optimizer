import axios from 'axios';

export interface ForecastSlot {
  period_end: string;   // ISO 8601 UTC datetime
  period: string;       // e.g. "PT30M"
  pv_estimate: number;  // kW (mean estimate)
  pv_estimate10: number;
  pv_estimate90: number;
}

export async function getSolarForecast(siteId: string, apiKey: string): Promise<ForecastSlot[]> {
  const url = `https://api.solcast.com.au/rooftop_sites/${siteId}/forecasts`;
  const res = await axios.get(url, {
    params: { format: 'json' },
    headers: {
      Accept: 'application/json',
      // Solcast Basic auth: API key as username, empty password
      Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`,
    },
    timeout: 15000,
  });
  return res.data?.forecasts ?? [];
}

/**
 * Fetches forecasts for all sites in parallel and merges them into a single
 * array by summing pv_estimate (and p10/p90) for each period_end timestamp.
 */
export async function getMergedForecast(siteIds: string[], apiKey: string): Promise<ForecastSlot[]> {
  const allForecasts = await Promise.all(siteIds.map(id => getSolarForecast(id, apiKey)));

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

  return [...merged.values()].sort((a, b) => a.period_end.localeCompare(b.period_end));
}
