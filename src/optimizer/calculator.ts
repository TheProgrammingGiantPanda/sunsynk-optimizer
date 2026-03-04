import { Config } from './config';
import { ForecastSlot } from './solcast';
import { PriceSlot } from './octopus';

export interface CalculationResult {
  threshold: number;         // pence — value set on Sunsynk
  lowestPrice: number;       // £/kWh — cheapest Agile slot in window
  pvTotal: number;           // Wh — combined PV forecast to peak
  houseUsage: number;        // Wh — estimated house consumption to peak
  batteryWatts: number;      // Wh — current battery charge
  batteryToFill: number;     // Wh — grid import needed (accounting for solar)
  batteryToFillNoPV: number; // Wh — grid import needed (ignoring solar)
  surplus: number;           // Wh — pvTotal minus houseUsage
  blocks: number;            // number of 30-min charging slots to buy
  results: PriceSlot[];      // cheapest Agile slots in window, sorted ascending
}

/**
 * Calculate the minimum grid import price threshold (pence) to set on the Sunsynk inverter.
 *
 * Port of the Node-RED "Calculate how much power we need to import" function.
 *
 * The threshold tells Sunsynk: "only charge the battery from the grid if the
 * current Agile price is below this value (pence/kWh)."
 */
export function calculate(
  config: Config,
  batteryPct: number,
  pvForecasts: ForecastSlot[],
  agileRates: PriceSlot[],
  slotProfile?: number[],      // 48-element Wh per slot (index 0 = 00:00–00:30 UTC); falls back to config.avgConsumptionWh
  hpAdjustment?: number[]      // 48-element Wh adjustment for heat pump temperature deviation
): CalculationResult {
  const now = new Date();

  // Build peak time for today (local clock)
  const peakTime = new Date(now);
  peakTime.setHours(config.peakHour, 0, 0, 0);
  if (peakTime <= now) {
    peakTime.setDate(peakTime.getDate() + 1);
  }

  // ── 1. Sum PV estimates and house usage from now → peakTime ──────────────
  // Solcast pv_estimate is in kW for a 30-min period → convert to Wh: * 500
  const WH_PER_KW_HALF_HOUR = 500;

  let pvTotal = 0;
  let houseUsage = 0;

  function slotConsumption(slotEnd: Date): number {
    const idx = slotEnd.getUTCHours() * 2 + Math.floor(slotEnd.getUTCMinutes() / 30);
    const base = slotProfile ? (slotProfile[idx] ?? config.avgConsumptionWh) : config.avgConsumptionWh;
    const hpDelta = hpAdjustment ? (hpAdjustment[idx] ?? 0) : 0;
    return Math.max(0, base + hpDelta);
  }

  for (const slot of pvForecasts) {
    const slotEnd = new Date(slot.period_end);
    if (slotEnd <= now || slotEnd > peakTime) continue;
    pvTotal += slot.pv_estimate * WH_PER_KW_HALF_HOUR;
    houseUsage += slotConsumption(slotEnd);
  }

  // ── 2. How much battery capacity remains to be filled? ───────────────────
  const batteryWatts = (config.batteryCapacityWh * batteryPct) / 100;
  const surplus = pvTotal - houseUsage;
  const batteryToFillNoPV = config.batteryCapacityWh - batteryWatts;
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

  const lowestPrice = windowRates.length > 0
    ? windowRates[0].value_inc_vat / 100
    : 0;

  const blocks = Math.ceil(batteryToFill / config.batteryFillRateWh);
  const hasNegativeSlots = windowRates.some(r => r.value_inc_vat < 0);

  let threshold: number;

  if (blocks < 1 && !hasNegativeSlots) {
    threshold = config.minChargeFloorPence;
  } else if (!windowRates.length) {
    threshold = config.minChargeFloorPence;
  } else {
    const blocksToUse = hasNegativeSlots && blocks < 1 ? 1 : blocks;
    const idx = Math.min(blocksToUse - 1, windowRates.length - 1);
    threshold = Math.max(Math.ceil(windowRates[idx].value_inc_vat), config.minChargeFloorPence);
  }

  console.log(
    `[calculator] Battery ${batteryPct}%, batteryToFill=${batteryToFill.toFixed(0)} Wh, ` +
    `pvTotal=${pvTotal.toFixed(0)} Wh, houseUsage=${houseUsage.toFixed(0)} Wh, ` +
    `surplus=${surplus.toFixed(0)} Wh, blocks=${blocks}, threshold=${threshold}p`
  );

  return {
    threshold,
    lowestPrice,
    pvTotal: Math.floor(pvTotal),
    houseUsage: Math.floor(houseUsage),
    batteryWatts: Math.floor(batteryWatts),
    batteryToFill: Math.floor(batteryToFill),
    batteryToFillNoPV: Math.floor(batteryToFillNoPV),
    surplus: Math.floor(surplus),
    blocks,
    results: windowRates,
  };
}
