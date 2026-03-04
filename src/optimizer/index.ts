import SunsyncClient from '../index';
import { loadConfig } from './config';
import { getMergedForecast, loadForecastCache, ForecastSlot } from './solcast';
import { getAgileRates } from './octopus';
import { calculate } from './calculator';
import { scheduleDailyTimes, scheduleAgileAligned } from './scheduler';
import { getEntityState, setState, getSlotProfileWh, createNotification, dismissNotification } from './homeassistant';
import { buildHeatPumpModel, heatPumpSlotAdjustment, getHaLocation, HeatPumpModel } from './heatpump';
import { getHourlyForecast, avgForecastTemp } from './openmeteo';

async function main() {
  const config = loadConfig();

  // Validate required string config
  const requiredStrings: (keyof typeof config)[] = [
    'sunsynkUsername', 'sunsynkPassword',
    'haUrl', 'haToken',
    'solcastApiKey',
  ];
  for (const key of requiredStrings) {
    const val = config[key];
    if (typeof val !== 'string' || !val.trim()) {
      throw new Error(`Missing required config: ${key}`);
    }
  }
  if (!config.solcastSites.length) throw new Error('Missing required config: solcastSites (SOLCAST_SITES)');

  // Validate numeric config
  if (isNaN(config.batteryCapacityWh) || config.batteryCapacityWh <= 0)
    throw new Error(`Invalid config: batteryCapacityWh must be a positive number (got ${config.batteryCapacityWh})`);
  if (isNaN(config.batteryFillRateWh) || config.batteryFillRateWh <= 0)
    throw new Error(`Invalid config: batteryFillRateWh must be a positive number (got ${config.batteryFillRateWh})`);
  if (isNaN(config.peakHour) || config.peakHour < 0 || config.peakHour > 23)
    throw new Error(`Invalid config: peakHour must be 0–23 (got ${config.peakHour})`);

  console.log('[optimizer] Starting Sunsynk Battery Optimizer');
  console.log(`[optimizer] Peak hour: ${config.peakHour}:00`);
  console.log(`[optimizer] Battery capacity: ${config.batteryCapacityWh} Wh`);
  console.log(`[optimizer] Forecast fetch times: ${config.forecastFetchTimes.join(', ')}`);
  console.log(`[optimizer] Price updates: aligned to Agile half-hour boundaries (+2 min offset)`);

  const client = new SunsyncClient();
  await client.login(config.sunsynkUsername, config.sunsynkPassword);
  console.log('[optimizer] Authenticated with Sunsynk');

  const plants = await client.getPlants();
  if (!plants.length) throw new Error('No plants found on Sunsynk account');
  const plantId = plants[0].id;
  console.log(`[optimizer] Using plant: ${plants[0].name ?? plantId} (id=${plantId})`);

  // Cached values — refreshed at scheduled times
  // Pre-populate from disk cache so price updates work immediately on restart
  let pvForecasts: ForecastSlot[] = loadForecastCache() ?? [];
  let slotProfile: number[] | undefined;
  let hpSlotProfile: number[] | undefined;
  let hpModel: HeatPumpModel | null = null;

  // Forecast + consumption fetcher
  const fetchForecasts = async () => {
    console.log(`[optimizer] Fetching solar forecasts from Solcast (${config.solcastSites.length} site(s))…`);
    try {
      pvForecasts = await getMergedForecast(config.solcastSites, config.solcastApiKey);
      console.log(`[optimizer] Forecasts updated: ${pvForecasts.length} merged slots`);
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

    if (config.haHeatPumpEntity) {
      try {
        const [hpProfile, model] = await Promise.all([
          getSlotProfileWh(config.haUrl, config.haToken, config.haHeatPumpEntity, config.consumptionAverageDays),
          buildHeatPumpModel(config.haUrl, config.haToken, config.haHeatPumpEntity, config.haOutdoorTempEntity, config.consumptionAverageDays),
        ]);
        if (hpProfile) hpSlotProfile = hpProfile;
        hpModel = model;
      } catch (err) {
        console.error('[optimizer] Failed to build heat pump model:', err);
      }
    }
  };

  // Schedule forecast fetches at configured times, and fetch once on start
  scheduleDailyTimes(config.forecastFetchTimes, fetchForecasts, true);

  // Price update loop — aligned to Agile half-hour boundaries (:02 and :32)
  scheduleAgileAligned(async () => {
    let batteryPct: number;
    try {
      batteryPct = await getEntityState(config.haUrl, config.haToken, config.haBatterySocEntity);
    } catch (err) {
      console.error('[optimizer] Failed to get battery SOC from HA:', err);
      createNotification(config.haUrl, config.haToken,
        'Sunsynk Optimizer — battery SOC unavailable',
        `Failed to read battery state-of-charge from HA at ${new Date().toISOString()}.\n\n${err}`
      ).catch(() => {});
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
      const liveCapacity = Math.round(voltage * capacityAh);
      const liveFillRate = Math.round((voltage * maxCurrent) / 2);
      if (liveCapacity > 0) {
        batteryCapacityWh = liveCapacity;
      } else {
        console.warn(`[optimizer] Battery capacity from HA is zero or invalid (${voltage}V × ${capacityAh}Ah), using config fallback: ${batteryCapacityWh} Wh`);
      }
      if (liveFillRate > 0) {
        batteryFillRateWh = liveFillRate;
      } else {
        console.warn(`[optimizer] Battery fill rate from HA is zero or invalid (${voltage}V × ${maxCurrent}A), using config fallback: ${batteryFillRateWh} Wh/slot`);
      }
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

    // Compute heat pump adjustment based on weather forecast temperature
    let hpAdjustment: number[] | undefined;
    if (hpModel && hpSlotProfile) {
      try {
        const now = new Date();
        const peakTime = new Date(now);
        peakTime.setHours(config.peakHour, 0, 0, 0);
        if (peakTime <= now) peakTime.setDate(peakTime.getDate() + 1);

        const { lat, lon } = await getHaLocation(config.haUrl, config.haToken);
        const forecast = await getHourlyForecast(lat, lon);
        const forecastAvgTemp = avgForecastTemp(forecast, now, peakTime);

        if (!isNaN(forecastAvgTemp)) {
          hpAdjustment = heatPumpSlotAdjustment(hpModel, forecastAvgTemp, hpSlotProfile);
        }
      } catch (err) {
        console.error('[optimizer] Failed to compute HP forecast adjustment:', err);
      }
    }

    const result = calculate({ ...config, batteryFillRateWh, batteryCapacityWh }, batteryPct, pvForecasts, rates, slotProfile, hpAdjustment);

    try {
      await client.setMinCharge(plantId, result.threshold);
      console.log(
        `[${new Date().toISOString()}] Set min charge threshold to ${result.threshold}p ` +
        `(battery ${batteryPct}%)`
      );
      dismissNotification(config.haUrl, config.haToken).catch(() => {});
    } catch (err) {
      console.error('[optimizer] Failed to set min charge:', err);
      createNotification(config.haUrl, config.haToken,
        'Sunsynk Optimizer — failed to set charge threshold',
        `Failed to set min charge threshold at ${new Date().toISOString()}.\n\n${err}`
      ).catch(() => {});
    }

    // Push results to HA sensors
    try {
      const ha = (id: string, state: string | number, attrs: Record<string, unknown> = {}) =>
        setState(config.haUrl, config.haToken, id, state, attrs);

      await Promise.all([
        ha('sensor.sunsynk_optimizer_threshold',          result.threshold,         { unit_of_measurement: 'p/kWh',  friendly_name: 'Sunsynk charge threshold' }),
        ha('sensor.sunsynk_optimizer_lowest_price',       result.lowestPrice,        { unit_of_measurement: '£/kWh',  friendly_name: 'Agile lowest price in window' }),
        ha('sensor.sunsynk_optimizer_pv_total',            result.pvTotal,            { unit_of_measurement: 'Wh', friendly_name: 'PV forecast to peak (confidence-adjusted)' }),
        ha('sensor.sunsynk_optimizer_pv_total_p50',       result.pvTotalP50,         { unit_of_measurement: 'Wh', friendly_name: 'PV forecast to peak (p50)' }),
        ha('sensor.sunsynk_optimizer_house_usage',        result.houseUsage,         { unit_of_measurement: 'Wh',     friendly_name: 'Estimated house usage to peak' }),
        ha('sensor.sunsynk_optimizer_battery_watts',      result.batteryWatts,       { unit_of_measurement: 'Wh',     friendly_name: 'Battery current charge' }),
        ha('sensor.sunsynk_optimizer_battery_to_fill',    result.batteryToFill,      { unit_of_measurement: 'Wh',     friendly_name: 'Battery grid import needed' }),
        ha('sensor.sunsynk_optimizer_battery_to_fill_no_pv', result.batteryToFillNoPV, { unit_of_measurement: 'Wh',  friendly_name: 'Battery grid import needed (no PV)' }),
        ha('sensor.sunsynk_optimizer_surplus',            result.surplus,            { unit_of_measurement: 'Wh',     friendly_name: 'Solar surplus to peak' }),
        ha('sensor.sunsynk_optimizer_blocks',             result.blocks,             { friendly_name: 'Charging slots to buy' }),
        ha('sensor.sunsynk_optimizer_results',            result.results.length,     { friendly_name: 'Agile slots in window', slots: result.results }),
        ...(hpAdjustment ? [ha('sensor.sunsynk_optimizer_hp_adjustment',
          hpAdjustment.reduce((a, b) => a + b, 0),
          { unit_of_measurement: 'Wh', friendly_name: 'Heat pump adjustment vs historical', slots: hpAdjustment }
        )] : []),
        ...(slotProfile ? [ha('sensor.sunsynk_optimizer_slot_profile',
          slotProfile.reduce((a, b) => a + b, 0),
          { unit_of_measurement: 'Wh', friendly_name: 'Avg daily consumption profile', slots: slotProfile }
        )] : []),
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
