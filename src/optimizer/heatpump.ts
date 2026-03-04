import axios from 'axios';

function haClient(haUrl: string, haToken: string) {
  return axios.create({
    baseURL: `${haUrl}/api`,
    headers: { Authorization: `Bearer ${haToken}`, 'Content-Type': 'application/json' },
    timeout: 30000,
  });
}

export interface HeatPumpModel {
  slope: number;         // kWh per °C
  intercept: number;     // kWh at 0°C
  historicalDailyKwh: number; // average daily kWh from training data
  historicalAvgTemp: number;  // average outdoor temp from training data
  days: number;
}

/**
 * Builds a linear regression model: HP_daily_kWh = intercept + slope × avg_outdoor_temp_°C
 *
 * Uses history of the HP energy sensor (lifetime cumulative kWh, differentiated per day)
 * and the outdoor temperature sensor (averaged per day).
 *
 * Returns null if insufficient history (< 3 days with both sensors).
 */
export async function buildHeatPumpModel(
  haUrl: string,
  haToken: string,
  hpEnergyEntity: string,
  outdoorTempEntity: string,
  days = 10
): Promise<HeatPumpModel | null> {
  const client = haClient(haUrl, haToken);
  const start = new Date();
  start.setDate(start.getDate() - (days + 1));
  const endTime = new Date().toISOString();

  const [hpRes, tempRes] = await Promise.all([
    client.get(`/history/period/${start.toISOString()}`, {
      params: { filter_entity_id: hpEnergyEntity, end_time: endTime },
    }),
    client.get(`/history/period/${start.toISOString()}`, {
      params: { filter_entity_id: outdoorTempEntity, end_time: endTime },
    }),
  ]);

  const hpStates: any[] = hpRes.data?.[0] ?? [];
  const tempStates: any[] = tempRes.data?.[0] ?? [];

  // HP energy: differentiate to get daily kWh (sensor is lifetime cumulative, never resets)
  const hpByDay = new Map<string, number>();
  for (let i = 1; i < hpStates.length; i++) {
    const delta = parseFloat(hpStates[i].state) - parseFloat(hpStates[i - 1].state);
    if (isNaN(delta) || delta < 0) continue;
    const day = (hpStates[i].last_updated as string).slice(0, 10);
    hpByDay.set(day, (hpByDay.get(day) ?? 0) + delta);
  }

  // Outdoor temp: average per day
  const tempByDay = new Map<string, number[]>();
  for (const s of tempStates) {
    const val = parseFloat(s.state);
    if (isNaN(val)) continue;
    const day = (s.last_updated as string).slice(0, 10);
    if (!tempByDay.has(day)) tempByDay.set(day, []);
    tempByDay.get(day)!.push(val);
  }

  // Build paired (x=avgTemp, y=hpKwh) dataset — exclude today
  const today = new Date().toISOString().slice(0, 10);
  const pairs: { x: number; y: number }[] = [];

  for (const [day, hpKwh] of hpByDay) {
    if (day === today) continue;
    const temps = tempByDay.get(day);
    if (!temps?.length) continue;
    const avgTemp = temps.reduce((a, b) => a + b, 0) / temps.length;
    pairs.push({ x: avgTemp, y: hpKwh });
  }

  if (pairs.length < 3) return null;

  // Ordinary least squares: y = intercept + slope * x
  const n = pairs.length;
  const sumX = pairs.reduce((s, p) => s + p.x, 0);
  const sumY = pairs.reduce((s, p) => s + p.y, 0);
  const sumXY = pairs.reduce((s, p) => s + p.x * p.y, 0);
  const sumX2 = pairs.reduce((s, p) => s + p.x * p.x, 0);

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;

  const historicalDailyKwh = sumY / n;
  const historicalAvgTemp = sumX / n;

  console.log(
    `[heatpump] Model from ${pairs.length} days: HP = ${intercept.toFixed(2)} + ${slope.toFixed(3)} × temp°C ` +
    `(avg ${historicalAvgTemp.toFixed(1)}°C → ${historicalDailyKwh.toFixed(1)} kWh/day)`
  );

  return { slope, intercept, historicalDailyKwh, historicalAvgTemp, days: pairs.length };
}

/**
 * Given a heat pump model and a forecast average temperature, compute the per-slot
 * HP energy adjustment (Wh) relative to the historical average embedded in the house
 * load profile.
 *
 * house_load_daily_profile already includes HP at historical-average conditions.
 * This returns the delta to add/subtract per slot based on temperature deviation.
 *
 * Returns a 48-element array of Wh adjustments (positive = more HP than historical).
 */
export function heatPumpSlotAdjustment(
  model: HeatPumpModel,
  forecastAvgTemp: number,
  hpSlotProfile: number[]   // historical HP Wh per slot
): number[] {
  const predictedDailyKwh = model.intercept + model.slope * forecastAvgTemp;

  // Clamp: HP can't consume negative energy
  const clampedPredicted = Math.max(0, predictedDailyKwh);
  const ratio = model.historicalDailyKwh > 0
    ? clampedPredicted / model.historicalDailyKwh
    : 1;

  console.log(
    `[heatpump] Forecast avg ${forecastAvgTemp.toFixed(1)}°C → predicted ${clampedPredicted.toFixed(1)} kWh/day ` +
    `(historical ${model.historicalDailyKwh.toFixed(1)} kWh/day, ratio ${ratio.toFixed(2)})`
  );

  // Adjustment per slot = hp_profile[i] × (ratio - 1)
  return hpSlotProfile.map(wh => Math.round(wh * (ratio - 1)));
}

/**
 * Fetches the HA instance latitude and longitude from /api/config.
 */
export async function getHaLocation(haUrl: string, haToken: string): Promise<{ lat: number; lon: number }> {
  const res = await haClient(haUrl, haToken).get('/config');
  return { lat: res.data.latitude, lon: res.data.longitude };
}
