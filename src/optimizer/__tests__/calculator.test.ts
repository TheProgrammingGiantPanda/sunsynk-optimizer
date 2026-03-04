import { describe, it, expect } from 'vitest';
import { calculate } from '../calculator';
import { Config } from '../config';
import { ForecastSlot } from '../solcast';
import { PriceSlot } from '../octopus';

// Fixed "now" = 08:00 UTC; peak = 16:00 UTC → 16 slots in window
const NOW = new Date('2026-03-04T08:00:00Z');

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
  avgConsumptionWh: 500,
  peakHour: 16,
  minChargeFloorPence: 0,
  forecastConfidenceFactor: 0,
  forecastFetchTimes: ['06:00', '12:00'],
  haHeatPumpEntity: '',
  haOutdoorTempEntity: '',
  standardTariffPence: 24,
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

// 16 slots from 08:00–16:00, prices 10p, 11p, 12p … 25p
const RATES = Array.from({ length: 16 }, (_, i) => priceSlot(i * 0.5, 10 + i));

// 8 forecast slots matching the first 4h of the window (2 kW each)
// pvTotal = 8 × 2 kW × 500 = 8000 Wh; at avgConsumption 500 Wh/slot → houseUsage = 4000 Wh → surplus = 4000 Wh
const PV_8_SLOTS = Array.from({ length: 8 }, (_, i) => forecastSlot(i * 0.5, 2));

describe('calculate', () => {
  it('returns floor threshold when battery is full and no negative slots', () => {
    const result = calculate(BASE_CONFIG, 100, [], RATES);
    expect(result.threshold).toBe(0);
    expect(result.blocks).toBe(0);
  });

  it('buys the correct number of slots when battery is empty', () => {
    // 10000 Wh / 2500 Wh per slot = 4 blocks
    // Sorted prices: 10, 11, 12, 13 → 4th cheapest = 13 → threshold = ceil(13) = 13
    const result = calculate(BASE_CONFIG, 0, [], RATES);
    expect(result.blocks).toBe(4);
    expect(result.threshold).toBe(13);
  });

  it('solar surplus reduces the number of blocks needed', () => {
    // 8 slots × 1 kW × 500 = 4000 Wh PV; 8 slots × 500 Wh house = 4000 Wh
    // surplus = 0; batteryToFill = 10000 → 4 blocks without PV
    // With PV: surplus covers some load → fewer blocks vs fully empty battery
    const withPV    = calculate(BASE_CONFIG, 50, PV_8_SLOTS, RATES);
    const withoutPV = calculate(BASE_CONFIG, 50, [],          RATES);
    expect(withPV.pvTotal).toBeGreaterThan(0);
    expect(withPV.blocks).toBeLessThanOrEqual(withoutPV.blocks);
  });

  it('always includes a negative-price slot even when battery is full', () => {
    // Use a negative floor so we can observe the negative threshold
    const config = { ...BASE_CONFIG, minChargeFloorPence: -20 };
    const ratesWithNegative = [priceSlot(0, -5), ...RATES.slice(1)];
    const result = calculate(config, 100, [], ratesWithNegative);
    // blocks=0 but hasNegativeSlots → blocksToUse=1 → threshold = max(ceil(-5), -20) = -5
    expect(result.threshold).toBe(-5);
  });

  it('returns floor threshold when there are no rates in the window', () => {
    const result = calculate(BASE_CONFIG, 50, [], []);
    expect(result.threshold).toBe(BASE_CONFIG.minChargeFloorPence);
  });

  it('respects minChargeFloorPence as a minimum threshold', () => {
    const config = { ...BASE_CONFIG, minChargeFloorPence: 10 };
    const result = calculate(config, 100, [], RATES);
    expect(result.threshold).toBe(10);
  });

  it('uses slotProfile Wh values for houseUsage instead of avgConsumptionWh', () => {
    // houseUsage accumulates only for slots with PV forecast data
    // profile at 1000 Wh/slot vs default 500 Wh/slot → houseUsage doubles
    const highProfile = new Array(48).fill(1000);
    const withProfile = calculate(BASE_CONFIG, 50, PV_8_SLOTS, RATES, highProfile);
    const withDefault = calculate(BASE_CONFIG, 50, PV_8_SLOTS, RATES);
    expect(withProfile.houseUsage).toBeGreaterThan(withDefault.houseUsage);
  });

  it('applies hpAdjustment on top of slotProfile', () => {
    const profile    = new Array(48).fill(500);
    const adjustment = new Array(48).fill(300);  // HP running harder
    const without = calculate(BASE_CONFIG, 50, PV_8_SLOTS, RATES, profile);
    const withAdj  = calculate(BASE_CONFIG, 50, PV_8_SLOTS, RATES, profile, adjustment);
    expect(withAdj.houseUsage).toBeGreaterThan(without.houseUsage);
  });

  it('confidence factor leans pvTotal toward p10 on uncertain days', () => {
    // p10 = 0.5 × kw, p90 = 1.5 × kw → spread is wide
    const cfgNo   = { ...BASE_CONFIG, forecastConfidenceFactor: 0 };
    const cfgHigh = { ...BASE_CONFIG, forecastConfidenceFactor: 1 };
    const r0 = calculate(cfgNo,   50, PV_8_SLOTS, RATES);
    const r1 = calculate(cfgHigh, 50, PV_8_SLOTS, RATES);
    expect(r1.pvTotal).toBeLessThan(r0.pvTotal);
    expect(r0.pvTotal).toBe(r0.pvTotalP50);
  });

  it('returns correct batteryWatts for a given SOC', () => {
    const result = calculate(BASE_CONFIG, 60, [], RATES);
    expect(result.batteryWatts).toBe(Math.floor(10000 * 0.6));
  });

  it('calculates pvSavingPence as the cost of slots solar made unnecessary', () => {
    // Without PV: batteryToFillNoPV = 10000 - 5000 = 5000 → 2 blocks
    // With PV (surplus=4000): batteryToFill = 1000 → 1 block
    // PV saved slot index 1 (price 11p) × 2.5 kWh = 27.5p
    const result = calculate(BASE_CONFIG, 50, PV_8_SLOTS, RATES);
    expect(result.pvSavingPence).toBeCloseTo(11 * (2500 / 1000), 1); // 27.5p
  });

  it('pvSavingPence is zero when solar creates no surplus', () => {
    // No PV → no surplus → pvSaving = 0
    const result = calculate(BASE_CONFIG, 50, [], RATES);
    expect(result.pvSavingPence).toBe(0);
  });

  it('pushes peak to tomorrow if peakHour has already passed today', () => {
    // peakHour=6, NOW=08:00 → peak is tomorrow 06:00; full RATES window falls inside
    const config = { ...BASE_CONFIG, peakHour: 6 };
    const result = calculate(config, 0, [], RATES);
    expect(result.blocks).toBeGreaterThan(0);
  });
});
