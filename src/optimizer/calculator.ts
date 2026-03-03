import { Config } from './config';
import { ForecastSlot } from './solcast';
import { PriceSlot } from './octopus';

/**
 * Calculate the minimum grid import price threshold (pence) to set on the Sunsynk inverter.
 *
 * Port of the Node-RED "Calculate how much power we need to import" function.
 *
 * The threshold tells Sunsynk: "only charge the battery from the grid if the
 * current Agile price is below this value (pence/kWh)."
 *
 * @returns Price threshold in whole pence, or the floor if no charging needed.
 */
export function calculate(
  config: Config,
  batteryPct: number,
  pv1Forecasts: ForecastSlot[],
  pv2Forecasts: ForecastSlot[],
  agileRates: PriceSlot[]
): number {
  const now = new Date();

  // Build peak time for today (local clock)
  const peakTime = new Date(now);
  peakTime.setHours(config.peakHour, 0, 0, 0);
  if (peakTime <= now) {
    // Past today's peak — aim for tomorrow's peak
    peakTime.setDate(peakTime.getDate() + 1);
  }

  // ── 1. Sum PV estimates and house usage from now → peakTime ──────────────
  // Solcast pv_estimate is in kW for a 30-min period → convert to Wh: * 500
  const WH_PER_KW_HALF_HOUR = 500;

  let pvTotal = 0;
  let houseUsage = 0;

  // Build a map of ISO-string → pv2 estimate for fast lookup
  const pv2Map = new Map<string, number>();
  for (const slot of pv2Forecasts) {
    pv2Map.set(slot.period_end, slot.pv_estimate);
  }

  for (const slot of pv1Forecasts) {
    const slotEnd = new Date(slot.period_end);
    if (slotEnd <= now || slotEnd > peakTime) continue;

    const pv1Wh = slot.pv_estimate * WH_PER_KW_HALF_HOUR;
    const pv2Wh = (pv2Map.get(slot.period_end) ?? 0) * WH_PER_KW_HALF_HOUR;
    pvTotal += pv1Wh + pv2Wh;
    houseUsage += config.avgConsumptionWh;
  }

  // If no forecast slots found (e.g. forecasts not yet fetched), add in
  // any pv2 slots that cover the window in case pv1 is empty
  if (pvTotal === 0 && pv2Forecasts.length > 0) {
    for (const slot of pv2Forecasts) {
      const slotEnd = new Date(slot.period_end);
      if (slotEnd <= now || slotEnd > peakTime) continue;
      pvTotal += slot.pv_estimate * WH_PER_KW_HALF_HOUR;
      houseUsage += config.avgConsumptionWh;
    }
  }

  // ── 2. How much battery capacity remains to be filled? ───────────────────
  const batteryWatts = (config.batteryCapacityWh * batteryPct) / 100;
  const surplus = pvTotal - houseUsage;

  // If we have surplus solar → it will charge the battery, so we need less grid.
  // If solar < house load → we need grid for both battery AND the net deficit.
  const batteryToFill =
    config.batteryCapacityWh -
    batteryWatts -
    (surplus > 0 ? surplus : -houseUsage);

  // ── 3. Pick cheapest Agile slots from now → peak ─────────────────────────
  const windowRates = agileRates.filter(r => {
    const from = new Date(r.valid_from);
    const to = new Date(r.valid_to);
    return to > now && from < peakTime;
  });

  windowRates.sort((a, b) => a.value_inc_vat - b.value_inc_vat);

  // Number of 30-min charging blocks required
  const blocks = Math.ceil(batteryToFill / config.batteryFillRateWh);

  // ── 4. Special case: buy negative-price slots regardless ─────────────────
  const hasNegativeSlots = windowRates.some(r => r.value_inc_vat < 0);

  if (blocks < 1 && !hasNegativeSlots) {
    // Battery is already full (or will be filled by solar) — use floor
    console.log(
      `[calculator] Battery ${batteryPct}% — no charging needed. ` +
      `batteryToFill=${batteryToFill.toFixed(0)} Wh, surplus=${surplus.toFixed(0)} Wh. ` +
      `Using floor ${config.minChargeFloorPence}p`
    );
    return config.minChargeFloorPence;
  }

  if (!windowRates.length) {
    console.warn('[calculator] No Agile rates in window — using floor');
    return config.minChargeFloorPence;
  }

  // The threshold = the price of the most expensive slot we're willing to buy
  const blocksToUse = hasNegativeSlots && blocks < 1 ? 1 : blocks;
  const idx = Math.min(blocksToUse - 1, windowRates.length - 1);
  const threshold = Math.ceil(windowRates[idx].value_inc_vat);

  console.log(
    `[calculator] Battery ${batteryPct}%, batteryToFill=${batteryToFill.toFixed(0)} Wh, ` +
    `pvTotal=${pvTotal.toFixed(0)} Wh, houseUsage=${houseUsage.toFixed(0)} Wh, ` +
    `surplus=${surplus.toFixed(0)} Wh, blocks=${blocks}, threshold=${threshold}p`
  );

  return Math.max(threshold, config.minChargeFloorPence);
}
