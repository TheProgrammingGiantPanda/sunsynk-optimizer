import { Config } from './config';
import { ForecastSlot } from './solcast';
import { PriceSlot } from './octopus';

export interface CalculationResult {
  threshold: number;         // pence — value set on Sunsynk
  lowestPrice: number;       // £/kWh — cheapest Agile slot in window
  pvTotal: number;           // Wh — confidence-adjusted PV forecast to peak
  pvTotalP50: number;        // Wh — unadjusted p50 PV forecast (for comparison)
  houseUsage: number;        // Wh — estimated house consumption to peak
  batteryWatts: number;      // Wh — current battery charge
  batteryToFill: number;     // Wh — grid import needed (accounting for solar)
  batteryToFillNoPV: number; // Wh — grid import needed (ignoring solar)
  surplus: number;           // Wh — pvTotal minus houseUsage
  blocks: number;                  // number of 30-min charging slots to buy
  results: PriceSlot[];            // cheapest Agile slots in window, sorted ascending
  energyPurchasedWh: number;       // Wh of grid import planned
  actualCostPence: number;         // cost at the purchased Agile slot prices
  peakSlotPricePence: number;      // Agile price at peakHour (reference for saving calc)
  savingVsPeakPence: number;       // saving vs buying all energy at peak-hour Agile price
  savingVsStandardPence: number;   // saving vs buying all energy at the standard tariff rate
  pvSavingPence: number;           // saving from not needing to buy slots that solar covers
  evLoadWh: number;                // estimated EV charge load in the window (Wh)
  exportRatePence: number;         // effective export rate used (pence/kWh)
  exportableWh: number;            // Wh of genuine surplus (max(0, floor(−batteryToFill)))
  sellThreshold: number;           // price above which Sunsynk should sell (0 = disabled, otherwise ceil(breakEven))
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
  hpAdjustment?: number[],     // 48-element Wh adjustment for heat pump temperature deviation
  evLoadWh = 0,                // estimated EV charge energy to add to house load (Wh)
  exportRatePence = 0          // effective export rate (pence/kWh); slots above this are skipped
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

  // Confidence-weighted estimate: on uncertain days (wide p10–p90 band) lean
  // towards p10 proportionally; on clear days (tight band) stay near p50.
  // factor=0 → always p50, factor=1 → p10 on maximally uncertain days.
  function adjustedEstimate(slot: ForecastSlot): number {
    const f = config.forecastConfidenceFactor;
    if (f === 0) return slot.pv_estimate;
    const p50 = slot.pv_estimate;
    const p10 = slot.pv_estimate10;
    const p90 = slot.pv_estimate90;
    const spread = p50 > 0 ? (p90 - p10) / p50 : 0;
    const alpha = Math.min(f * spread, 1);
    return Math.max(0, p50 - alpha * (p50 - p10));
  }

  let pvTotal = 0;
  let pvTotalP50 = 0;
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
    pvTotal     += adjustedEstimate(slot) * WH_PER_KW_HALF_HOUR;
    pvTotalP50  += slot.pv_estimate       * WH_PER_KW_HALF_HOUR;
    houseUsage  += slotConsumption(slotEnd);
  }

  // Add EV load to house usage — treated identically to any other load in the window
  houseUsage += evLoadWh;

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

  // Account for battery round-trip losses.
  // Each imported Wh yields only `eff` Wh of usable discharge energy.
  // So to store `batteryToFill` Wh we must import `batteryToFill / eff` Wh.
  // For the export rate filter: importing at price P beats exporting at rate X
  // only when P/eff < X  →  P < X * eff.
  const eff = Math.max(0.5, Math.min(1, config.batteryRoundTripEfficiency ?? 0.9));

  // When we can export, only buy grid energy cheaper than the break-even point —
  // buying above exportRate*eff means the effective stored cost exceeds what we'd earn exporting.
  const importCandidates = exportRatePence > 0
    ? windowRates.filter(r => r.value_inc_vat < exportRatePence * eff)
    : windowRates;

  const lowestPrice = windowRates.length > 0
    ? windowRates[0].value_inc_vat / 100
    : 0;

  // Divide by efficiency: more grid import needed to achieve the same stored Wh
  const blocks = Math.ceil(batteryToFill / (config.batteryFillRateWh * eff));
  const hasNegativeSlots = importCandidates.some(r => r.value_inc_vat < 0);

  let threshold: number;

  if (blocks < 1 && !hasNegativeSlots) {
    threshold = config.minChargeFloorPence;
  } else if (!importCandidates.length) {
    threshold = config.minChargeFloorPence;
  } else {
    const blocksToUse = hasNegativeSlots && blocks < 1 ? 1 : blocks;
    const idx = Math.min(blocksToUse - 1, importCandidates.length - 1);
    threshold = Math.max(Math.ceil(importCandidates[idx].value_inc_vat), config.minChargeFloorPence);
  }

  // ── 4. Cost savings vs peak-hour Agile and standard tariff ──────────────
  const purchasedSlots = blocks > 0 ? importCandidates.slice(0, blocks) : [];
  const energyPurchasedWh = blocks > 0 ? Math.min(blocks, importCandidates.length) * config.batteryFillRateWh : 0;
  const energyPurchasedKwh = energyPurchasedWh / 1000;

  const actualCostPence = purchasedSlots.reduce(
    (sum, s) => sum + s.value_inc_vat * (config.batteryFillRateWh / 1000), 0
  );

  // Find the Agile slot that covers peakTime (the reference "what you'd pay at peak")
  const peakSlot = agileRates.find(r => {
    const from = new Date(r.valid_from);
    const to   = new Date(r.valid_to);
    return from <= peakTime && to > peakTime;
  });
  const peakSlotPricePence = peakSlot?.value_inc_vat ?? 0;

  const savingVsPeakPence     = peakSlotPricePence * energyPurchasedKwh - actualCostPence;
  const savingVsStandardPence = config.standardTariffPence * energyPurchasedKwh - actualCostPence;

  // PV saving: cost of the slots solar made unnecessary
  // blocksWithoutPV uses batteryToFillNoPV (ignores solar); if PV created surplus,
  // blocksWithoutPV > blocks and the difference is what solar saved us buying.
  const blocksWithoutPV = Math.max(0, Math.ceil(batteryToFillNoPV / config.batteryFillRateWh));
  const pvSavedSlots = blocksWithoutPV > blocks ? importCandidates.slice(blocks, blocksWithoutPV) : [];
  const pvSavingPence = pvSavedSlots.reduce(
    (sum, s) => sum + s.value_inc_vat * (config.batteryFillRateWh / 1000), 0
  );

  // ── 5. Sell-to-grid threshold ─────────────────────────────────────────────
  // Genuine surplus: energy that would overflow the battery regardless.
  // breakEvenSell: min export price at which selling beats reimporting later.
  const exportableWh = Math.max(0, Math.floor(-batteryToFill));
  const breakEvenSell = windowRates.length > 0
    ? windowRates[0].value_inc_vat / eff   // cheapest future import / efficiency
    : Infinity;
  const sellThreshold = (exportableWh > 0 && exportRatePence > 0 && exportRatePence > breakEvenSell)
    ? Math.ceil(breakEvenSell)
    : 0;

  const confidenceAdj = pvTotalP50 > 0
    ? ((pvTotal - pvTotalP50) / pvTotalP50 * 100).toFixed(1)
    : '0.0';

  console.log(
    `[calculator] Battery ${batteryPct}%, batteryToFill=${batteryToFill.toFixed(0)} Wh, ` +
    `pvTotal=${pvTotal.toFixed(0)} Wh (p50=${pvTotalP50.toFixed(0)}, adj=${confidenceAdj}%), ` +
    `houseUsage=${houseUsage.toFixed(0)} Wh, surplus=${surplus.toFixed(0)} Wh, ` +
    `blocks=${blocks}, threshold=${threshold}p, eff=${(eff * 100).toFixed(0)}%` +
    (exportRatePence > 0 ? `, exportRate=${exportRatePence}p (break-even=${(exportRatePence * eff).toFixed(1)}p, ${importCandidates.length} import candidates)` : '') +
    (sellThreshold > 0 ? `, sell=${sellThreshold}p (exportable=${exportableWh} Wh)` : '')
  );

  return {
    threshold,
    lowestPrice,
    pvTotal: Math.floor(pvTotal),
    pvTotalP50: Math.floor(pvTotalP50),
    houseUsage: Math.floor(houseUsage),
    batteryWatts: Math.floor(batteryWatts),
    batteryToFill: Math.floor(batteryToFill),
    batteryToFillNoPV: Math.floor(batteryToFillNoPV),
    surplus: Math.floor(surplus),
    blocks,
    results: windowRates,
    energyPurchasedWh,
    actualCostPence: Math.round(actualCostPence * 10) / 10,
    peakSlotPricePence,
    savingVsPeakPence:     Math.round(savingVsPeakPence * 10) / 10,
    savingVsStandardPence: Math.round(savingVsStandardPence * 10) / 10,
    pvSavingPence:         Math.round(pvSavingPence * 10) / 10,
    evLoadWh:              Math.round(evLoadWh),
    exportRatePence,
    exportableWh,
    sellThreshold,
  };
}
