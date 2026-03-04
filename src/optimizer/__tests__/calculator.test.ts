import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { calculate } from '../calculator';
import { Config } from '../config';
import { ForecastSlot } from '../solcast';
import { PriceSlot } from '../octopus';

// Fixed "now" = 08:00 UTC; all slot offsets are relative to this time.
// Fake timers ensure calculate()'s internal new Date() matches.
const NOW = new Date('2026-03-04T08:00:00Z');
beforeAll(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterAll(() => vi.useRealTimers());

// With expensiveThresholdPence=20, RATES splits as:
//   cheap:     slots 0–9  → prices 10p–19p (from NOW+0h to NOW+4.5h)
//   expensive: slots 10–15 → prices 20p–25p (from NOW+5h  to NOW+7.5h)
const BASE_CONFIG: Config = {
  sunsynkUsername: 'u',
  sunsynkPassword: 'p',
  haUrl: 'http://ha',
  haToken: 'tok',
  haBatterySocEntity: 'sensor.soc',
  haBatteryVoltageEntity: 'sensor.v',
  haBatteryMaxCurrentEntity: 'sensor.a',
  haBatteryCapacityAhEntity: 'sensor.ah',
  haLoadDailyEntity: 'sensor.load',
  consumptionAverageDays: 7,
  solcastApiKey: 'key',
  solcastSites: ['site1'],
  octopusProduct: 'AGILE-24-04-03',
  octopusTariff: 'E-1R-AGILE-24-04-03-G',
  batteryCapacityWh: 10000,
  batteryFillRateWh: 2500,  // 1 slot = 2500 Wh
  avgConsumptionWh: 500,    // 500 Wh per 30-min slot
  expensiveThresholdPence: 20,
  minChargeFloorPence: 0,
  forecastConfidenceFactor: 0,
  forecastFetchTimes: ['06:00', '12:00'],
  haHeatPumpEntity: '',
  haOutdoorTempEntity: '',
  standardTariffPence: 24,
  haEvChargerEntity: '',
  exportTariffSchedule: '',
  octopusExportProduct: '',
  octopusExportTariff: '',
  batteryRoundTripEfficiency: 1.0,  // 100% efficiency for predictable arithmetic
};

/** Build a 30-min price slot starting offsetHours after NOW */
function priceSlot(offsetHours: number, pence: number): PriceSlot {
  const from = new Date(NOW.getTime() + offsetHours * 3600000);
  const to   = new Date(from.getTime() + 1800000);
  return { value_exc_vat: pence / 1.05, value_inc_vat: pence, valid_from: from.toISOString(), valid_to: to.toISOString(), payment_method: null };
}

/** Build a forecast slot whose period_end is offsetHours+0.5h after NOW */
function forecastSlot(offsetHours: number, kw: number): ForecastSlot {
  const end = new Date(NOW.getTime() + offsetHours * 3600000 + 1800000);
  return { period_end: end.toISOString(), period: 'PT30M', pv_estimate: kw, pv_estimate10: kw * 0.5, pv_estimate90: kw * 1.5 };
}

// 16 slots from 08:00–16:00 UTC, prices 10p, 11p, 12p … 25p
// cheap (10p–19p): slots 0–9; expensive (20p–25p): slots 10–15
const RATES = Array.from({ length: 16 }, (_, i) => priceSlot(i * 0.5, 10 + i));

// 6 forecast slots covering the expensive window (NOW+5h to NOW+7.5h = 13:00–15:30 UTC)
// Each slot 1 kW → 500 Wh; perfectly covers avgConsumptionWh=500 → net expensive draw = 0
const PV_COVERS_EXPENSIVE = Array.from({ length: 6 }, (_, i) => forecastSlot(5 + i * 0.5, 1));

// 6 forecast slots generating 2 kW each in the expensive window
// PV=1000 Wh, house=500 Wh → net surplus=500 Wh per slot
const PV_SURPLUS_IN_EXPENSIVE = Array.from({ length: 6 }, (_, i) => forecastSlot(5 + i * 0.5, 2));

// 6 forecast slots generating 2 kW in cheap window (NOW+0.5h to NOW+3h)
// PV=1000 Wh, house=500 Wh → surplus=500 Wh/slot during cheap slots
const PV_SURPLUS_IN_CHEAP = Array.from({ length: 6 }, (_, i) => forecastSlot(i * 0.5, 2));

describe('calculate — core behaviour', () => {

  it('battery covers expensive demand: fills remaining capacity with cheap slots', () => {
    // 6 expensive slots × 500 Wh = 3000 Wh demand; battery at 50% = 5000 Wh → deficit = 0.
    // Remaining capacity = 5000 Wh → opportunistic fill: ceil(5000/2500) = 2 blocks.
    const result = calculate(BASE_CONFIG, 50, [], RATES);
    expect(result.batteryToFill).toBe(0);         // no deficit
    expect(result.totalExpensiveDemandWh).toBe(3000);
    expect(result.blocks).toBe(2);                // fill remaining 5000 Wh with 2 cheap slots
    expect(result.threshold).toBe(11);            // 2nd cheapest cheap slot (11p)
  });

  it('fills battery to capacity when deficit exists', () => {
    // battery 0%, capacity 10000 Wh → opportunistic fill: ceil(10000/2500) = 4 blocks
    // batteryToFill (deficit) = 3000 Wh; threshold = 4th cheapest cheap slot (13p)
    const result = calculate(BASE_CONFIG, 0, [], RATES);
    expect(result.batteryToFill).toBe(3000);      // deficit to cover expensive demand
    expect(result.blocks).toBe(4);                // fill to capacity
    expect(result.threshold).toBe(13);            // 4th cheapest (10p,11p,12p,13p)
    expect(result.expensiveSlots).toBe(6);
  });

  it('expensiveSlots = 0 when all prices are below threshold', () => {
    // All slots at 5p–14p < 20p threshold; battery=0% → fill all 10000 Wh
    const cheapRates = Array.from({ length: 10 }, (_, i) => priceSlot(i * 0.5, 5 + i));
    const result = calculate(BASE_CONFIG, 0, [], cheapRates);
    expect(result.expensiveSlots).toBe(0);
    expect(result.totalExpensiveDemandWh).toBe(0);
    expect(result.blocks).toBe(4);             // ceil(10000/2500) = 4 to fill battery
    expect(result.threshold).toBe(8);          // 4th cheapest of 5p,6p,7p,8p... = 8p
  });

  it('PV during expensive slots reduces battery demand', () => {
    // PV_COVERS_EXPENSIVE: 1 kW × 6 slots → pvForSlot=500 Wh = exactly house 500 Wh → net draw=0
    // Battery=0%, capacity=10000 → still fills to capacity with cheap slots
    const result = calculate(BASE_CONFIG, 0, PV_COVERS_EXPENSIVE, RATES);
    expect(result.totalExpensiveDemandWh).toBe(0);
    expect(result.batteryToFill).toBe(0);
    // blocks > 0: opportunistically fills battery even though deficit = 0
    expect(result.blocks).toBe(4);  // ceil(10000/2500)
  });

  it('PV surplus during cheap slots reduces grid import needed', () => {
    // Battery=0%, demand=3000 Wh from expensive slots.
    // PV_SURPLUS_IN_CHEAP: 6 slots × 500 Wh surplus → pvSurplusCheapWh=3000 Wh
    // batteryToFill (deficit) = max(0, 3000 - 0 - 3000) = 0
    // opportunisticFill = max(0, 10000 - 3000) = 7000 → ceil(7000/2500) = 3 blocks
    const result = calculate(BASE_CONFIG, 0, PV_SURPLUS_IN_CHEAP, RATES);
    expect(result.batteryToFill).toBe(0);
    expect(result.blocks).toBe(3);    // PV fills 3000 Wh; grid covers remaining 7000 Wh
    expect(result.threshold).toBe(12); // 3rd cheapest cheap slot (10p,11p,12p)
  });

  it('all-expensive rates: threshold falls to floor when no cheap slots available', () => {
    const allExpensive = Array.from({ length: 8 }, (_, i) => priceSlot(i * 0.5, 20 + i));
    const result = calculate(BASE_CONFIG, 0, [], allExpensive);
    expect(result.expensiveSlots).toBe(8);
    expect(result.threshold).toBe(BASE_CONFIG.minChargeFloorPence);
    expect(result.blocks).toBe(0); // no cheap slots to buy
  });

  it('always includes a negative-price cheap slot when battery is full', () => {
    const config = { ...BASE_CONFIG, minChargeFloorPence: -20 };
    const ratesWithNegative = [priceSlot(0, -5), ...RATES.slice(1)];
    // battery=100% (full): maxAbsorb=0, blocks=0, but -5p slot → threshold=-5 (free money)
    const result = calculate(config, 100, [], ratesWithNegative);
    expect(result.threshold).toBe(-5);
  });

  it('respects minChargeFloorPence as a minimum threshold', () => {
    const config = { ...BASE_CONFIG, minChargeFloorPence: 10 };
    // battery=100% (full): blocks=0, threshold=minFloor=10
    const result = calculate(config, 100, [], RATES);
    expect(result.threshold).toBe(10);
  });

  it('returns correct batteryWatts for a given SOC', () => {
    const result = calculate(BASE_CONFIG, 60, [], RATES);
    expect(result.batteryWatts).toBe(Math.floor(10000 * 0.6));
  });

  it('lowestPrice is the cheapest slot in the full horizon', () => {
    const result = calculate(BASE_CONFIG, 50, [], RATES);
    expect(result.lowestPrice).toBeCloseTo(0.10, 2); // 10p in £/kWh
  });

  it('peakSlotPricePence is the highest upcoming expensive slot', () => {
    const result = calculate(BASE_CONFIG, 50, [], RATES);
    expect(result.peakSlotPricePence).toBe(25); // highest in 20p–25p band
  });

  it('peakSlotPricePence is 0 when no expensive slots exist', () => {
    const cheapRates = Array.from({ length: 8 }, (_, i) => priceSlot(i * 0.5, 5 + i));
    const result = calculate(BASE_CONFIG, 50, [], cheapRates);
    expect(result.peakSlotPricePence).toBe(0);
  });

  it('uses slotProfile Wh values for houseUsage', () => {
    const highProfile = new Array(48).fill(1000);
    const withProfile = calculate(BASE_CONFIG, 0, [], RATES, highProfile);
    const withDefault = calculate(BASE_CONFIG, 0, [], RATES);
    expect(withProfile.houseUsage).toBeGreaterThan(withDefault.houseUsage);
    // Higher house usage in expensive slots → more demand → more blocks
    expect(withProfile.blocks).toBeGreaterThanOrEqual(withDefault.blocks);
  });

  it('applies hpAdjustment on top of slotProfile', () => {
    const profile    = new Array(48).fill(500);
    const adjustment = new Array(48).fill(200);
    const without = calculate(BASE_CONFIG, 0, [], RATES, profile);
    const withAdj  = calculate(BASE_CONFIG, 0, [], RATES, profile, adjustment);
    expect(withAdj.houseUsage).toBeGreaterThan(without.houseUsage);
  });

  it('confidence factor leans pvTotal toward p10 on uncertain days', () => {
    const cfgNo   = { ...BASE_CONFIG, forecastConfidenceFactor: 0 };
    const cfgHigh = { ...BASE_CONFIG, forecastConfidenceFactor: 1 };
    const r0 = calculate(cfgNo,   0, PV_COVERS_EXPENSIVE, RATES);
    const r1 = calculate(cfgHigh, 0, PV_COVERS_EXPENSIVE, RATES);
    expect(r1.pvTotal).toBeLessThan(r0.pvTotal);
    expect(r0.pvTotal).toBe(r0.pvTotalP50);
  });

  it('adds evLoadWh to houseUsage', () => {
    const without = calculate(BASE_CONFIG, 50, [], RATES);
    const withEv  = calculate(BASE_CONFIG, 50, [], RATES, undefined, undefined, 2000);
    expect(withEv.evLoadWh).toBe(2000);
    expect(withEv.houseUsage).toBe(without.houseUsage + 2000);
  });

  it('evLoadWh defaults to zero', () => {
    const result = calculate(BASE_CONFIG, 50, [], RATES);
    expect(result.evLoadWh).toBe(0);
  });

  it('returns exportRatePence in the result', () => {
    const result = calculate(BASE_CONFIG, 50, [], RATES, undefined, undefined, 0, 12);
    expect(result.exportRatePence).toBe(12);
  });

  it('filters out cheap slots above the export break-even', () => {
    // exportRate=12p, eff=1.0 → break-even=12p; only slots <12p are import candidates
    // cheap slots (10p–19p) filtered to [10p, 11p]; battery=0% needs 3000 Wh → 2 blocks
    const result = calculate(BASE_CONFIG, 0, [], RATES, undefined, undefined, 0, 12);
    // threshold capped at 11p (below break-even of 12p)
    expect(result.threshold).toBeLessThan(12);
  });

  it('efficiency increases blocks needed', () => {
    // Lower efficiency means PV surplus is worth less AND each purchased slot charges less,
    // so more cheap slots are needed to fill battery to capacity.
    const config100 = { ...BASE_CONFIG };
    const config80  = { ...BASE_CONFIG, batteryRoundTripEfficiency: 0.8 };
    const r100 = calculate(config100, 0, PV_SURPLUS_IN_CHEAP, RATES);
    const r80  = calculate(config80,  0, PV_SURPLUS_IN_CHEAP, RATES);
    // r100: opportunistic = 10000 - 3000×1.0 = 7000; blocks = ceil(7000/(2500×1.0)) = 3
    // r80:  opportunistic = 10000 - 3000×0.8 = 7600; blocks = ceil(7600/(2500×0.8)) = 4
    expect(r80.blocks).toBeGreaterThan(r100.blocks);
    // batteryToFill (deficit-based) still reflects efficiency:
    expect(r100.batteryToFill).toBe(0);    // pvSurplus×1.0 = 3000 covers 3000 demand
    expect(r80.batteryToFill).toBe(600);   // pvSurplus×0.8 = 2400 < 3000 → deficit=600
  });

  it('pvSavingPence reflects cheap slots solar made unnecessary', () => {
    // No PV: battery=0%, demand=3000 → 2 blocks (slots at 10p, 11p)
    // With PV_SURPLUS_IN_CHEAP: pvSurplus=3000 → batteryToFill=0 → 0 blocks
    // pvSavingPence = cost of the 2 slots PV made unnecessary = (10+11)×2.5 = 52.5p
    const withPV    = calculate(BASE_CONFIG, 0, PV_SURPLUS_IN_CHEAP, RATES);
    const withoutPV = calculate(BASE_CONFIG, 0, [], RATES);
    expect(withPV.pvSavingPence).toBeGreaterThan(0);
    expect(withoutPV.pvSavingPence).toBe(0);
  });
});

// ── Sell-to-grid threshold ───────────────────────────────────────────────────

describe('calculate — sell threshold', () => {

  it('sellThreshold is 0 when battery cannot cover expensive demand (no surplus to sell)', () => {
    // battery=0%, demand=3000 → not enough to cover expensive periods, no surplus
    const result = calculate(BASE_CONFIG, 0, [], RATES, undefined, undefined, 0, 15);
    expect(result.exportableWh).toBe(0);
    expect(result.sellThreshold).toBe(0);
  });

  it('sellThreshold is 0 when export rate not configured', () => {
    // battery=100% (10000), demand=3000 → exportableWh=7000; but exportRatePence=0
    const result = calculate(BASE_CONFIG, 100, [], RATES);
    expect(result.exportableWh).toBe(7000);
    expect(result.sellThreshold).toBe(0);
  });

  it('sellThreshold is 0 when export rate <= break-even', () => {
    // cheapest cheap slot=10p, eff=1.0 → breakEvenSell=10p; exportRatePence=10 ≤ 10 → disabled
    const result = calculate(BASE_CONFIG, 100, [], RATES, undefined, undefined, 0, 10);
    expect(result.sellThreshold).toBe(0);
  });

  it('sellThreshold = ceil(breakEven) when surplus and export > break-even', () => {
    // eff=1.0, cheapest=10p → breakEven=10p; exportRate=12p > 10 → sellThreshold=10
    const result = calculate(BASE_CONFIG, 100, [], RATES, undefined, undefined, 0, 12);
    expect(result.exportableWh).toBe(7000);
    expect(result.sellThreshold).toBe(10);
  });

  it('sellThreshold rounds up with fractional efficiency', () => {
    // eff=0.8, cheapest=10p → breakEven=10/0.8=12.5p; exportRate=15 > 12.5 → sellThreshold=13
    const config = { ...BASE_CONFIG, batteryRoundTripEfficiency: 0.8 };
    const result = calculate(config, 100, [], RATES, undefined, undefined, 0, 15);
    expect(result.sellThreshold).toBe(13);
  });

  it('exportableWh = batteryWatts − totalExpensiveDemandWh when battery is above demand', () => {
    // battery=100% (10000), demand=3000 → exportable=7000
    const result = calculate(BASE_CONFIG, 100, [], RATES);
    expect(result.exportableWh).toBe(7000);
    expect(result.totalExpensiveDemandWh).toBe(3000);
  });

  it('exportSlotCount and exportIncomePence are 0 when no exportRates provided', () => {
    const result = calculate(BASE_CONFIG, 100, [], RATES, undefined, undefined, 0, 20);
    expect(result.exportSlotCount).toBe(0);
    expect(result.exportIncomePence).toBe(0);
    // Falls back to break-even threshold
    expect(result.sellThreshold).toBe(10); // ceil(10/1.0) = 10
  });

  it('sellThreshold targets the Nth most profitable export slot (not just break-even)', () => {
    // battery=100%, exportable=7000 Wh → 3 slots to export (ceil(7000/2500)=3)
    // Export rates above break-even (10p): [30p, 25p, 20p, 15p, 12p] sorted desc
    // Top 3 are 30p, 25p, 20p → threshold = ceil(20) = 20
    const exportRates = [
      priceSlot(1, 12), priceSlot(2, 25), priceSlot(3, 30), priceSlot(4, 20), priceSlot(5, 15),
    ];
    const result = calculate(BASE_CONFIG, 100, [], RATES, undefined, undefined, 0, 20, exportRates);
    expect(result.exportSlotCount).toBe(3);
    expect(result.sellThreshold).toBe(20); // lowest of the 3 planned slots (20p)
  });

  it('exportIncomePence = sum of planned slot prices × fillRate/1000', () => {
    // 3 slots planned: 30p, 25p, 20p each × (2500/1000) = 2.5 kWh
    // income = (30 + 25 + 20) × 2.5 = 187.5p
    const exportRates = [
      priceSlot(1, 12), priceSlot(2, 25), priceSlot(3, 30), priceSlot(4, 20), priceSlot(5, 15),
    ];
    const result = calculate(BASE_CONFIG, 100, [], RATES, undefined, undefined, 0, 20, exportRates);
    expect(result.exportIncomePence).toBeCloseTo(187.5, 1);
  });

  it('excludes export slots at or below break-even', () => {
    // break-even = cheapest import / eff = 10p / 1.0 = 10p
    // export slots at [10p, 9p, 8p] are all ≤ break-even → not profitable
    const exportRates = [priceSlot(1, 8), priceSlot(2, 9), priceSlot(3, 10)];
    const result = calculate(BASE_CONFIG, 100, [], RATES, undefined, undefined, 0, 20, exportRates);
    expect(result.exportSlotCount).toBe(0);
    expect(result.exportIncomePence).toBe(0);
    expect(result.sellThreshold).toBe(10); // fallback to break-even
  });

  it('caps export slots at exportableWh capacity', () => {
    // exportable=7000 Wh → 3 slots needed; 5 export slots available above break-even
    // Only the top 3 (most profitable) are selected
    const exportRates = [
      priceSlot(1, 50), priceSlot(2, 40), priceSlot(3, 35), priceSlot(4, 28), priceSlot(5, 22),
    ];
    const result = calculate(BASE_CONFIG, 100, [], RATES, undefined, undefined, 0, 20, exportRates);
    expect(result.exportSlotCount).toBe(3);     // capped at ceil(7000/2500)
    expect(result.sellThreshold).toBe(35);      // lowest of top-3: 50,40,35
  });
});

// ── Horizon extends to all available Agile data ───────────────────────────────

describe('calculate — horizon behaviour', () => {

  it('slots beyond old-style peak hour are included in the window', () => {
    // All 16 slots in RATES (08:00–16:00) are included; check results array length
    const result = calculate(BASE_CONFIG, 50, [], RATES);
    expect(result.results.length).toBe(RATES.length);
  });

  it('a cheaper slot added after the last expensive slot is visible and lowers threshold', () => {
    // Add a 2p slot at +9h (17:00 UTC) — after the standard expensive window
    const extendedRates = [...RATES, priceSlot(9, 2)];
    const standard = calculate(BASE_CONFIG, 0, [], RATES);
    const extended = calculate(BASE_CONFIG, 0, [], extendedRates);
    // The 2p slot is cheaper than anything in RATES → lower lowestPrice and potentially lower threshold
    expect(extended.lowestPrice).toBeLessThan(standard.lowestPrice);
  });

  it('battery exactly covers expensive demand: fills remaining capacity with cheap slots', () => {
    // demand=3000 Wh; battery=30% = 3000 Wh → batteryToFill=0, but 7000 Wh capacity remains
    // ceil(7000/2500) = 3 opportunistic blocks
    const result = calculate(BASE_CONFIG, 30, [], RATES);
    expect(result.batteryToFill).toBe(0);
    expect(result.blocks).toBe(3);   // fill remaining 7000 Wh with 3 cheap slots
  });

  it('expensiveThresholdPence is reflected in expensiveSlots count', () => {
    // Raise threshold to 30p → no slots ≥30p in RATES → expensiveSlots=0
    // All 16 slots become cheap → battery fills to capacity
    const config = { ...BASE_CONFIG, expensiveThresholdPence: 30 };
    const result = calculate(config, 0, [], RATES);
    expect(result.expensiveSlots).toBe(0);
    expect(result.totalExpensiveDemandWh).toBe(0);
    expect(result.blocks).toBe(4);   // fill 10000 Wh; all slots now cheap candidates
  });
});
