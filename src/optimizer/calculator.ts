import { Config } from './config';
import { ForecastSlot } from './solcast';
import { PriceSlot } from './octopus';

export interface CalculationResult {
  threshold: number;               // pence — import threshold set on Sunsynk
  lowestPrice: number;             // £/kWh — cheapest Agile slot in horizon
  pvTotal: number;                 // Wh — confidence-adjusted PV forecast over horizon
  pvTotalP50: number;              // Wh — unadjusted p50 PV forecast (for comparison)
  houseUsage: number;              // Wh — estimated house consumption over horizon
  batteryWatts: number;            // Wh — current battery charge
  batteryToFill: number;           // Wh — grid import needed to cover expensive periods (0 when battery sufficient)
  batteryToFillNoPV: number;       // Wh — grid import needed ignoring solar
  surplus: number;                 // Wh — pvTotal minus houseUsage over horizon
  blocks: number;                  // number of 30-min charging slots to buy (fills battery to capacity)
  results: PriceSlot[];            // all Agile slots in horizon, sorted ascending by price
  energyPurchasedWh: number;       // Wh of grid import planned
  actualCostPence: number;         // cost at the purchased Agile slot prices
  peakSlotPricePence: number;      // highest upcoming expensive slot price (reference for saving calc)
  savingVsPeakPence: number;       // saving vs buying all energy at the highest expensive slot price
  savingVsStandardPence: number;   // saving vs buying all energy at the standard tariff rate
  pvSavingPence: number;           // saving from not needing to buy slots that solar covers
  evLoadWh: number;                // estimated EV charge load in the window (Wh)
  exportRatePence: number;         // effective export rate used (pence/kWh)
  exportableWh: number;            // Wh the battery has above what expensive periods need (can sell)
  sellThreshold: number;           // price above which Sunsynk should sell (0 = disabled)
  expensiveSlots: number;          // count of upcoming expensive slots (≥ expensiveThresholdPence)
  totalExpensiveDemandWh: number;  // Wh the battery needs to cover during expensive slots
  exportSlotCount: number;         // number of upcoming slots planned for battery export
  exportIncomePence: number;       // expected income from planned battery-to-grid sales
}

// ── Module-scope constants and pure helpers ──────────────────────────────────

const WH_PER_KW_HALF_HOUR = 500;

function adjustedEstimate(slot: ForecastSlot, confidenceFactor: number): number {
  if (confidenceFactor === 0) return slot.pv_estimate;
  const p50 = slot.pv_estimate;
  const p10 = slot.pv_estimate10;
  const p90 = slot.pv_estimate90;
  const spread = p50 > 0 ? (p90 - p10) / p50 : 0;
  const alpha = Math.min(confidenceFactor * spread, 1);
  return Math.max(0, p50 - alpha * (p50 - p10));
}

function slotConsumption(
  slotEnd: Date,
  avgConsumptionWh: number,
  slotProfile?: number[],
  hpAdjustment?: number[]
): number {
  const idx = slotEnd.getUTCHours() * 2 + Math.floor(slotEnd.getUTCMinutes() / 30);
  const base = slotProfile ? (slotProfile[idx] ?? avgConsumptionWh) : avgConsumptionWh;
  const hpDelta = hpAdjustment ? (hpAdjustment[idx] ?? 0) : 0;
  return Math.max(0, base + hpDelta);
}

/** Confidence-adjusted PV generation (Wh) for the 30-min slot ending at slotEnd. */
function pvForSlot(
  pvForecasts: ForecastSlot[],
  slotEnd: Date,
  confidenceFactor: number
): number {
  const slot = pvForecasts.find(
    s => Math.abs(new Date(s.period_end).getTime() - slotEnd.getTime()) < 60000
  );
  return slot ? adjustedEstimate(slot, confidenceFactor) * WH_PER_KW_HALF_HOUR : 0;
}

/** P50 PV generation (Wh) for the 30-min slot ending at slotEnd. */
function pvP50ForSlot(pvForecasts: ForecastSlot[], slotEnd: Date): number {
  const slot = pvForecasts.find(
    s => Math.abs(new Date(s.period_end).getTime() - slotEnd.getTime()) < 60000
  );
  return slot ? slot.pv_estimate * WH_PER_KW_HALF_HOUR : 0;
}

// ── Main calculation ─────────────────────────────────────────────────────────

/**
 * Calculate the minimum grid import price threshold (pence) to set on the Sunsynk inverter.
 *
 * Uses Octopus Agile tariff data directly to identify expensive slots:
 *   - Expensive slots (≥ expensiveThresholdPence): the battery should cover house load;
 *     we avoid importing from the grid during these periods.
 *   - Cheap slots (< expensiveThresholdPence): grid import is acceptable.
 *
 * The algorithm:
 *   1. Sums net battery draw during all upcoming expensive slots (house load − PV generation).
 *   2. Accounts for PV surplus during cheap slots (free battery charging, reduced grid import).
 *   3. Buys the cheapest cheap slots to cover any remaining deficit.
 *   4. Sets threshold = price of the Nth cheapest cheap slot needed.
 *
 * No peak hour configuration needed — the expensive periods are inferred from the Agile prices.
 */
export function calculate(
  config: Config,
  batteryPct: number,
  pvForecasts: ForecastSlot[],
  agileRates: PriceSlot[],
  slotProfile?: number[],      // 48-element Wh per slot (index 0 = 00:00–00:30 UTC); falls back to config.avgConsumptionWh
  hpAdjustment?: number[],     // 48-element Wh adjustment for heat pump temperature deviation
  evLoadWh = 0,                // estimated EV charge energy to add to house load (Wh)
  exportRatePence = 0,         // effective export rate (pence/kWh); used for import break-even filter
  exportRates?: PriceSlot[]    // full future export rate schedule; used to plan export slots
): CalculationResult {
  const now = new Date();
  const eff = Math.max(0.5, Math.min(1, config.batteryRoundTripEfficiency ?? 0.9));
  const batteryWatts = (config.batteryCapacityWh * batteryPct) / 100;

  // ── 1. All upcoming Agile slots ───────────────────────────────────────────
  // Use every available rate — the horizon is naturally bounded by Agile data availability
  const allRates = agileRates.filter(r => new Date(r.valid_to) > now);

  // Split: expensive = battery should cover; cheap = OK to import from grid
  const expensiveRates = allRates.filter(r => r.value_inc_vat >= config.expensiveThresholdPence);
  const cheapRates     = allRates.filter(r => r.value_inc_vat <  config.expensiveThresholdPence);

  // ── 2. Energy the battery must cover during expensive slots ───────────────
  let totalExpensiveDemandWh   = 0; // net battery draw (with PV offsetting some load)
  let totalExpensiveDemandNoPV = 0; // without PV (for batteryToFillNoPV)

  for (const rate of expensiveRates) {
    const slotEnd = new Date(rate.valid_to);
    const consumption = slotConsumption(slotEnd, config.avgConsumptionWh, slotProfile, hpAdjustment);
    const pv = pvForSlot(pvForecasts, slotEnd, config.forecastConfidenceFactor);
    totalExpensiveDemandWh   += Math.max(0, consumption - pv);
    totalExpensiveDemandNoPV += consumption;
  }

  // ── 3. PV surplus during cheap slots (pre-charges battery for free) ───────
  let pvSurplusCheapWh = 0;
  for (const rate of cheapRates) {
    const slotEnd = new Date(rate.valid_to);
    const consumption = slotConsumption(slotEnd, config.avgConsumptionWh, slotProfile, hpAdjustment);
    const pv = pvForSlot(pvForecasts, slotEnd, config.forecastConfidenceFactor);
    pvSurplusCheapWh += Math.max(0, pv - consumption);
  }

  // ── 4. Summary totals over the full horizon (for HA sensors / logging) ────
  let pvTotal = 0, pvTotalP50 = 0, houseUsage = 0;
  for (const rate of allRates) {
    const slotEnd = new Date(rate.valid_to);
    houseUsage  += slotConsumption(slotEnd, config.avgConsumptionWh, slotProfile, hpAdjustment);
    pvTotal     += pvForSlot(pvForecasts, slotEnd, config.forecastConfidenceFactor);
    pvTotalP50  += pvP50ForSlot(pvForecasts, slotEnd);
  }
  houseUsage += evLoadWh;
  const surplus = pvTotal - houseUsage;

  // ── 5. Grid import needed ─────────────────────────────────────────────────
  // Battery covers expensive demand; PV surplus during cheap slots reduces what we need to buy.
  // Round-trip efficiency applies to energy that goes grid → battery → load.
  const batteryToFill   = Math.max(0,
    totalExpensiveDemandWh - batteryWatts - pvSurplusCheapWh * eff
  );
  const batteryToFillNoPV = Math.max(0, totalExpensiveDemandNoPV - batteryWatts);

  // ── 6. Pick cheapest cheap slots to fill the battery ─────────────────────
  const importCandidates = [...cheapRates].sort((a, b) => a.value_inc_vat - b.value_inc_vat);

  const windowRates = [...allRates].sort((a, b) => a.value_inc_vat - b.value_inc_vat);
  const lowestPrice = windowRates.length > 0 ? windowRates[0].value_inc_vat / 100 : 0;

  // Opportunistic fill: use cheap slots to fill battery to capacity (not just the deficit).
  // More cheap storage = more expensive slots covered = maximum savings.
  const maxAbsorbWh = Math.max(0, config.batteryCapacityWh - batteryWatts);
  const opportunisticFillWh = Math.max(0, maxAbsorbWh - pvSurplusCheapWh * eff);
  const blocks = importCandidates.length === 0
    ? 0
    : Math.ceil(opportunisticFillWh / (config.batteryFillRateWh * eff));

  // Negative slot handling: always charge at negative slots the battery can absorb,
  // preferring the cheapest (most negative) first so we don't waste capacity on -1p
  // when -10p is available. When the battery is already full, include all negative slots
  // anyway — the BMS prevents over-charge and any remaining headroom will be used.
  const negativeSlots = importCandidates.filter(r => r.value_inc_vat < 0);
  const maxAbsorbBlocks = Math.ceil(maxAbsorbWh / (config.batteryFillRateWh * eff));
  const negativeBlocksToCharge = maxAbsorbBlocks > 0
    ? Math.min(negativeSlots.length, maxAbsorbBlocks)
    : negativeSlots.length;
  const blocksToUse = Math.max(blocks, negativeBlocksToCharge);

  let threshold: number;
  if (blocksToUse < 1 || !importCandidates.length) {
    threshold = config.minChargeFloorPence;
  } else {
    const idx = Math.min(blocksToUse - 1, importCandidates.length - 1);
    const rawValue = importCandidates[idx].value_inc_vat;
    const rawThreshold = Math.ceil(rawValue) || 0; // normalise -0 → 0
    // Don't apply the positive floor when the target slot is itself negative — that would
    // widen the threshold to include cheap positive slots we deliberately excluded.
    threshold = rawValue < 0
      ? rawThreshold
      : Math.max(rawThreshold, config.minChargeFloorPence);
  }

  // ── 7. Cost savings ───────────────────────────────────────────────────────
  const purchasedSlots    = blocksToUse > 0 ? importCandidates.slice(0, blocksToUse) : [];
  const energyPurchasedWh = blocksToUse > 0 ? Math.min(blocksToUse, importCandidates.length) * config.batteryFillRateWh : 0;
  const energyPurchasedKwh = energyPurchasedWh / 1000;

  const actualCostPence = purchasedSlots.reduce(
    (sum, s) => sum + s.value_inc_vat * (config.batteryFillRateWh / 1000), 0
  );

  // Reference: highest upcoming expensive slot (the price we avoid paying if we use stored energy)
  const peakSlotPricePence = expensiveRates.length > 0
    ? Math.max(...expensiveRates.map(r => r.value_inc_vat))
    : 0;

  const savingVsPeakPence     = peakSlotPricePence * energyPurchasedKwh - actualCostPence;
  const savingVsStandardPence = config.standardTariffPence * energyPurchasedKwh - actualCostPence;

  // PV saving: cheap slots freed by PV surplus charging the battery (capacity-based)
  const blocksWithoutPV = importCandidates.length === 0
    ? 0
    : Math.ceil(maxAbsorbWh / (config.batteryFillRateWh * eff));
  const pvSavedSlots = blocksWithoutPV > blocks ? importCandidates.slice(blocks, blocksWithoutPV) : [];
  const pvSavingPence = pvSavedSlots.reduce(
    (sum, s) => sum + s.value_inc_vat * (config.batteryFillRateWh / 1000), 0
  );

  // ── 8. Sell-to-grid planning ──────────────────────────────────────────────
  // Exportable = battery charge above what expensive periods need
  const exportableWh = Math.max(0, Math.floor(batteryWatts - totalExpensiveDemandWh));
  const breakEvenSell = windowRates.length > 0
    ? windowRates[0].value_inc_vat / eff
    : Infinity;

  // Use the full export rate schedule to identify the best slots to sell during.
  // Sort descending — pick the most profitable slots first, up to exportableWh capacity.
  const futureExportRates = (exportRates ?? [])
    .filter(r => new Date(r.valid_to) > now && r.value_inc_vat > breakEvenSell)
    .sort((a, b) => b.value_inc_vat - a.value_inc_vat);

  const exportSlotsNeeded = exportableWh > 0
    ? Math.ceil(exportableWh / (config.batteryFillRateWh * eff))
    : 0;
  const plannedExportSlots = futureExportRates.slice(0, exportSlotsNeeded);
  const exportIncomePence = plannedExportSlots.reduce(
    (sum, s) => sum + s.value_inc_vat * (config.batteryFillRateWh / 1000), 0
  );
  const exportSlotCount = plannedExportSlots.length;

  // Sell threshold: minimum price of planned export slots → Sunsynk sells during those slots only.
  // Falls back to break-even approach when no future schedule is available.
  let sellThreshold: number;
  if (plannedExportSlots.length > 0) {
    sellThreshold = Math.ceil(plannedExportSlots[plannedExportSlots.length - 1].value_inc_vat);
  } else if (exportableWh > 0 && exportRatePence > 0 && exportRatePence > breakEvenSell) {
    sellThreshold = Math.ceil(breakEvenSell);
  } else {
    sellThreshold = 0;
  }

  // ── Logging ───────────────────────────────────────────────────────────────
  const confidenceAdj = pvTotalP50 > 0
    ? ((pvTotal - pvTotalP50) / pvTotalP50 * 100).toFixed(1)
    : '0.0';

  console.log(
    `[calculator] Battery ${batteryPct}%, ` +
    `expensiveDemand=${totalExpensiveDemandWh.toFixed(0)} Wh (${expensiveRates.length} slots ≥${config.expensiveThresholdPence}p), ` +
    `batteryToFill=${batteryToFill.toFixed(0)} Wh, ` +
    `pvTotal=${pvTotal.toFixed(0)} Wh (p50=${pvTotalP50.toFixed(0)}, adj=${confidenceAdj}%), ` +
    `houseUsage=${houseUsage.toFixed(0)} Wh, surplus=${surplus.toFixed(0)} Wh, ` +
    `blocks=${blocksToUse}, threshold=${threshold}p, eff=${(eff * 100).toFixed(0)}%` +
    (exportRatePence > 0 ? `, exportRate=${exportRatePence}p (break-even=${(exportRatePence * eff).toFixed(1)}p, ${importCandidates.length} import candidates)` : '') +
    (sellThreshold > 0 ? `, sell=${sellThreshold}p (exportable=${exportableWh} Wh, ${exportSlotCount} slot(s), income=${exportIncomePence.toFixed(1)}p)` : '')
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
    blocks: blocksToUse,
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
    expensiveSlots: expensiveRates.length,
    totalExpensiveDemandWh: Math.floor(totalExpensiveDemandWh),
    exportSlotCount,
    exportIncomePence: Math.round(exportIncomePence * 10) / 10,
  };
}
