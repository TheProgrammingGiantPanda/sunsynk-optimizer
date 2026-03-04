import axios from 'axios';

export interface HourlyTemperature {
  time: Date;
  tempC: number;
}

/**
 * Fetches hourly 2m temperature forecast from Open-Meteo (free, no API key).
 * Returns the next 48 hours of hourly temperatures.
 */
export async function getHourlyForecast(lat: number, lon: number): Promise<HourlyTemperature[]> {
  const res = await axios.get('https://api.open-meteo.com/v1/forecast', {
    params: {
      latitude: lat,
      longitude: lon,
      hourly: 'temperature_2m',
      forecast_days: 2,
      timezone: 'UTC',
    },
    timeout: 10000,
  });

  const times: string[] = res.data.hourly.time;
  const temps: number[] = res.data.hourly.temperature_2m;

  return times.map((t, i) => ({ time: new Date(t + ':00Z'), tempC: temps[i] }));
}

/**
 * Returns the average forecast temperature over a time window.
 */
export function avgForecastTemp(forecast: HourlyTemperature[], from: Date, to: Date): number {
  const window = forecast.filter(f => f.time >= from && f.time < to);
  if (!window.length) return NaN;
  return window.reduce((sum, f) => sum + f.tempC, 0) / window.length;
}
