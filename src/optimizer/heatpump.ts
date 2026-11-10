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
 * Shared OLS regression: load_daily_kWh = intercept + slope × avg_outdoor_temp_°C
 *
 * Differentiates a lifetime-cumulative energy sensor to get daily kWh, then pairs
 * with daily average outdoor temperature to build a linear model.
 *
 * Returns null if insufficient history (< 3 complete days with both sensors).
 */
async function buildThermalLoadModel(
  haUrl: string,
  haToken: string,
  energyEntity: string,
  outdoorTempEntity: string,
  days: number,
  label: string
): Promise<HeatPumpModel | null> {
  const client = haClient(haUrl, haToken);
  const start = new Date();
  start.setDate(start.getDate() - (days + 1));
  const endTime = new Date().toISOString();

  const [energyRes, tempRes] = await Promise.all([
    client.get(`/history/period/${start.toISOString()}`, {
      params: { filter_entity_id: energyEntity, end_time: endTime },
    }),
    client.get(`/history/period/${start.toISOString()}`, {
      params: { filter_entity_id: outdoorTempEntity, end_time: endTime },
    }),
  ]);

  const energyStates: any[] = energyRes.data?.[0] ?? [];
  const tempStates: any[] = tempRes.data?.[0] ?? [];

  // Energy sensor: differentiate cumulative kWh to get daily delta
  const energyByDay = new Map<string, number>();
  for (let i = 1; i < energyStates.length; i++) {
    const delta = parseFloat(energyStates[i].state) - parseFloat(energyStates[i - 1].state);
    if (isNaN(delta) || delta < 0) continue;
    const day = (energyStates[i].last_updated as string).slice(0, 10);
    energyByDay.set(day, (energyByDay.get(day) ?? 0) + delta);
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

  // Build paired (x=avgTemp, y=dailyKwh) dataset — exclude today (incomplete)
  const today = new Date().toISOString().slice(0, 10);
  const pairs: { x: number; y: number }[] = [];

  for (const [day, dailyKwh] of energyByDay) {
    if (day === today) continue;
    const temps = tempByDay.get(day);
    if (!temps?.length) continue;
    const avgTemp = temps.reduce((a, b) => a + b, 0) / temps.length;
    pairs.push({ x: avgTemp, y: dailyKwh });
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
    `[${label}] Model from ${pairs.length} days: load = ${intercept.toFixed(2)} + ${slope.toFixed(3)} × temp°C ` +
    `(avg ${historicalAvgTemp.toFixed(1)}°C → ${historicalDailyKwh.toFixed(1)} kWh/day)`
  );

  return { slope, intercept, historicalDailyKwh, historicalAvgTemp, days: pairs.length };
}

export async function buildHeatPumpModel(
  haUrl: string,
  haToken: string,
  hpEnergyEntity: string,
  outdoorTempEntity: string,
  days = 10
): Promise<HeatPumpModel | null> {
  return buildThermalLoadModel(haUrl, haToken, hpEnergyEntity, outdoorTempEntity, days, 'heatpump');
}

export async function buildAcModel(
  haUrl: string,
  haToken: string,
  acEnergyEntity: string,
  outdoorTempEntity: string,
  days = 10
): Promise<HeatPumpModel | null> {
  return buildThermalLoadModel(haUrl, haToken, acEnergyEntity, outdoorTempEntity, days, 'ac');
}

/**
 * Given a thermal load model and a forecast average temperature, compute the per-slot
 * energy adjustment (Wh) relative to the historical average embedded in the house
 * load profile.
 *
 * house_load_daily_profile already includes the load at historical-average conditions.
 * Returns a 48-element delta array (positive = more load than historical average).
 *
 * For HP: negative slope → cold forecast → positive delta (more heating needed).
 * For AC: positive slope → hot forecast → positive delta (more cooling needed).
 */
export function thermalSlotAdjustment(
  model: HeatPumpModel,
  forecastAvgTemp: number,
  loadSlotProfile: number[],
  label: string
): number[] {
  const predictedDailyKwh = model.intercept + model.slope * forecastAvgTemp;

  // Clamp: load can't be negative
  const clampedPredicted = Math.max(0, predictedDailyKwh);
  const ratio = model.historicalDailyKwh > 0
    ? clampedPredicted / model.historicalDailyKwh
    : 1;

  console.log(
    `[${label}] Forecast avg ${forecastAvgTemp.toFixed(1)}°C → predicted ${clampedPredicted.toFixed(1)} kWh/day ` +
    `(historical ${model.historicalDailyKwh.toFixed(1)} kWh/day, ratio ${ratio.toFixed(2)})`
  );

  // Adjustment per slot = profile[i] × (ratio - 1)
  return loadSlotProfile.map(wh => Math.round(wh * (ratio - 1)));
}

/** @deprecated Use thermalSlotAdjustment with label='heatpump' */
export function heatPumpSlotAdjustment(
  model: HeatPumpModel,
  forecastAvgTemp: number,
  hpSlotProfile: number[]
): number[] {
  return thermalSlotAdjustment(model, forecastAvgTemp, hpSlotProfile, 'heatpump');
}

/**
 * Fetches the HA instance latitude and longitude from /api/config.
 */
export async function getHaLocation(haUrl: string, haToken: string): Promise<{ lat: number; lon: number }> {
  const res = await haClient(haUrl, haToken).get('/config');
  return { lat: res.data.latitude, lon: res.data.longitude };
}
