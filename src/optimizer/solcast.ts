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
