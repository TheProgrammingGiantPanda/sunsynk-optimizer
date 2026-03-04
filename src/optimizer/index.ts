import SunsyncClient from '../index';
import { loadConfig } from './config';
import { getSolarForecast, ForecastSlot } from './solcast';
import { getAgileRates } from './octopus';
import { calculate } from './calculator';
import { scheduleDailyTimes, scheduleInterval } from './scheduler';
import { getEntityState, setState, getSlotProfileWh } from './homeassistant';

async function main() {
  const config = loadConfig();

  // Validate required config
  const required: (keyof typeof config)[] = [
    'sunsynkUsername', 'sunsynkPassword',
    'haUrl', 'haToken',
    'solcastSitePv1', 'solcastSitePv2',
  ];
  for (const key of required) {
    if (!config[key]) throw new Error(`Missing required config: ${key}`);
  }

  console.log('[optimizer] Starting Sunsynk Battery Optimizer');
  console.log(`[optimizer] Peak hour: ${config.peakHour}:00`);
  console.log(`[optimizer] Battery capacity: ${config.batteryCapacityWh} Wh`);
  console.log(`[optimizer] Forecast fetch times: ${config.forecastFetchTimes.join(', ')}`);
  console.log(`[optimizer] Price update interval: ${config.priceIntervalMinutes} min`);

  const client = new SunsyncClient();
  await client.login(config.sunsynkUsername, config.sunsynkPassword);
  console.log('[optimizer] Authenticated with Sunsynk');

  const plants = await client.getPlants();
  if (!plants.length) throw new Error('No plants found on Sunsynk account');
  const plantId = plants[0].id;
  console.log(`[optimizer] Using plant: ${plants[0].name ?? plantId} (id=${plantId})`);

  // Cached values — refreshed at scheduled times
  let pv1Forecasts: ForecastSlot[] = [];
  let pv2Forecasts: ForecastSlot[] = [];
  let slotProfile: number[] | undefined;

  // Forecast + consumption fetcher
  const fetchForecasts = async () => {
    console.log('[optimizer] Fetching solar forecasts from Solcast…');
    try {
      [pv1Forecasts, pv2Forecasts] = await Promise.all([
        getSolarForecast(config.solcastSitePv1, config.solcastApiKey),
        getSolarForecast(config.solcastSitePv2, config.solcastApiKey),
      ]);
      console.log(
        `[optimizer] Forecasts updated: pv1=${pv1Forecasts.length} slots, pv2=${pv2Forecasts.length} slots`
      );
    } catch (err) {
      console.error('[optimizer] Forecast fetch failed:', err);
    }

    try {
      const profile = await getSlotProfileWh(
        config.haUrl, config.haToken,
        config.haLoadDailyEntity,
        config.consumptionAverageDays
      );
      if (profile !== null) {
        slotProfile = profile;
      } else {
        console.warn(`[optimizer] Not enough consumption history — using config fallback: ${config.avgConsumptionWh} Wh/slot`);
      }
    } catch (err) {
      console.error('[optimizer] Failed to build consumption profile:', err);
    }
  };

  // Schedule forecast fetches at configured times, and fetch once on start
  scheduleDailyTimes(config.forecastFetchTimes, fetchForecasts, true);

  // Price update loop — runs every priceIntervalMinutes
  scheduleInterval(config.priceIntervalMinutes, async () => {
    let batteryPct: number;
    try {
      batteryPct = await getEntityState(config.haUrl, config.haToken, config.haBatterySocEntity);
    } catch (err) {
      console.error('[optimizer] Failed to get battery SOC from HA:', err);
      return;
    }

    // Fetch live battery parameters: voltage, max charge current, capacity (Ah)
    let batteryFillRateWh = config.batteryFillRateWh;
    let batteryCapacityWh = config.batteryCapacityWh;
    try {
      const [voltage, maxCurrent, capacityAh] = await Promise.all([
        getEntityState(config.haUrl, config.haToken, config.haBatteryVoltageEntity),
        getEntityState(config.haUrl, config.haToken, config.haBatteryMaxCurrentEntity),
        getEntityState(config.haUrl, config.haToken, config.haBatteryCapacityAhEntity),
      ]);
      batteryFillRateWh = Math.round((voltage * maxCurrent) / 2);
      batteryCapacityWh = Math.round(voltage * capacityAh);
      console.log(
        `[optimizer] Battery: ${voltage}V × ${capacityAh}Ah = ${batteryCapacityWh} Wh capacity, ` +
        `fill rate ${voltage}V × ${maxCurrent}A ÷ 2 = ${batteryFillRateWh} Wh/slot`
      );
    } catch (err) {
      console.warn(`[optimizer] Could not read battery params from HA, using config fallbacks: ` +
        `capacity=${batteryCapacityWh} Wh, fill rate=${batteryFillRateWh} Wh/slot`);
    }

    let rates;
    try {
      rates = await getAgileRates(config.octopusProduct, config.octopusTariff);
    } catch (err) {
      console.error('[optimizer] Failed to get Agile rates:', err);
      return;
    }

    const result = calculate({ ...config, batteryFillRateWh, batteryCapacityWh }, batteryPct, pv1Forecasts, pv2Forecasts, rates, slotProfile);

    try {
      await client.setMinCharge(plantId, result.threshold);
      console.log(
        `[${new Date().toISOString()}] Set min charge threshold to ${result.threshold}p ` +
        `(battery ${batteryPct}%)`
      );
    } catch (err) {
      console.error('[optimizer] Failed to set min charge:', err);
    }

    // Push results to HA sensors
    try {
      const ha = (id: string, state: string | number, attrs: Record<string, unknown> = {}) =>
        setState(config.haUrl, config.haToken, id, state, attrs);

      await Promise.all([
        ha('sensor.sunsynk_optimizer_threshold',          result.threshold,         { unit_of_measurement: 'p/kWh',  friendly_name: 'Sunsynk charge threshold' }),
        ha('sensor.sunsynk_optimizer_lowest_price',       result.lowestPrice,        { unit_of_measurement: '£/kWh',  friendly_name: 'Agile lowest price in window' }),
        ha('sensor.sunsynk_optimizer_pv1_total',          result.pv1Total,           { unit_of_measurement: 'Wh',     friendly_name: 'PV1 forecast to peak' }),
        ha('sensor.sunsynk_optimizer_pv2_total',          result.pv2Total,           { unit_of_measurement: 'Wh',     friendly_name: 'PV2 forecast to peak' }),
        ha('sensor.sunsynk_optimizer_pv_total',           result.pvTotal,            { unit_of_measurement: 'Wh',     friendly_name: 'PV total forecast to peak' }),
        ha('sensor.sunsynk_optimizer_house_usage',        result.houseUsage,         { unit_of_measurement: 'Wh',     friendly_name: 'Estimated house usage to peak' }),
        ha('sensor.sunsynk_optimizer_battery_watts',      result.batteryWatts,       { unit_of_measurement: 'Wh',     friendly_name: 'Battery current charge' }),
        ha('sensor.sunsynk_optimizer_battery_to_fill',    result.batteryToFill,      { unit_of_measurement: 'Wh',     friendly_name: 'Battery grid import needed' }),
        ha('sensor.sunsynk_optimizer_battery_to_fill_no_pv', result.batteryToFillNoPV, { unit_of_measurement: 'Wh',  friendly_name: 'Battery grid import needed (no PV)' }),
        ha('sensor.sunsynk_optimizer_surplus',            result.surplus,            { unit_of_measurement: 'Wh',     friendly_name: 'Solar surplus to peak' }),
        ha('sensor.sunsynk_optimizer_blocks',             result.blocks,             { friendly_name: 'Charging slots to buy' }),
        ha('sensor.sunsynk_optimizer_results',            result.results.length,     { friendly_name: 'Agile slots in window', slots: result.results }),
      ]);
      console.log('[optimizer] HA sensors updated');
    } catch (err) {
      console.error('[optimizer] Failed to update HA sensors:', err);
    }
  });
}

main().catch(err => {
  console.error('[optimizer] Fatal error:', err);
  process.exit(1);
});
