import SunsyncClient from '../index';
import { loadConfig } from './config';
import { getMergedForecast, loadForecastCache, ForecastSlot } from './solcast';
import { getAgileRates, getFixedExportRate, getOutgoingAgileRate } from './octopus';
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
  if (isNaN(config.expensiveThresholdPence) || config.expensiveThresholdPence <= 0)
    throw new Error(`Invalid config: expensiveThresholdPence must be a positive number (got ${config.expensiveThresholdPence})`);

  console.log('[optimizer] Starting Sunsynk Battery Optimizer');
  console.log(`[optimizer] Expensive threshold: ${config.expensiveThresholdPence}p/kWh`);
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

  // Daily savings accumulators — reset when the calendar date changes
  let savingDate = new Date().toISOString().slice(0, 10);
  let dailySavingVsPeakPence = 0;
  let dailySavingVsStandardPence = 0;
  let dailyPvSavingPence = 0;
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

    // Resolve effective export rate: Outgoing Agile > fixed schedule > 0
    let exportRatePence = 0;
    if (config.octopusExportProduct && config.octopusExportTariff) {
      const agileExport = await getOutgoingAgileRate(config.octopusExportProduct, config.octopusExportTariff);
      if (agileExport !== null) {
        exportRatePence = agileExport;
        console.log(`[optimizer] Outgoing Agile export rate: ${exportRatePence.toFixed(2)}p/kWh`);
      } else {
        console.warn('[optimizer] Failed to get Outgoing Agile rate, falling back to fixed schedule');
      }
    }
    if (exportRatePence === 0 && config.exportTariffSchedule) {
      exportRatePence = getFixedExportRate(config.exportTariffSchedule);
      if (exportRatePence > 0) {
        console.log(`[optimizer] Fixed export rate: ${exportRatePence}p/kWh`);
      }
    }

    // Compute heat pump adjustment based on weather forecast temperature
    // Horizon = end of available Agile data (naturally bounded by Octopus API)
    let hpAdjustment: number[] | undefined;
    if (hpModel && hpSlotProfile) {
      try {
        const now = new Date();
        const horizonTime = rates.length > 0
          ? new Date(rates.reduce((latest, r) =>
              new Date(r.valid_to) > new Date(latest.valid_to) ? r : latest
            ).valid_to)
          : new Date(now.getTime() + 24 * 3600000);

        const { lat, lon } = await getHaLocation(config.haUrl, config.haToken);
        const forecast = await getHourlyForecast(lat, lon);
        const forecastAvgTemp = avgForecastTemp(forecast, now, horizonTime);

        if (!isNaN(forecastAvgTemp)) {
          hpAdjustment = heatPumpSlotAdjustment(hpModel, forecastAvgTemp, hpSlotProfile);
        }
      } catch (err) {
        console.error('[optimizer] Failed to compute HP forecast adjustment:', err);
      }
    }

    // Estimate EV load to first expensive slot (or 4h fallback) if charger is drawing power
    let evLoadWh = 0;
    if (config.haEvChargerEntity) {
      try {
        const chargePowerKw = await getEntityState(config.haUrl, config.haToken, config.haEvChargerEntity);
        if (chargePowerKw > 0.1) {
          const now = new Date();
          const firstExpensive = rates
            .filter(r => new Date(r.valid_to) > now && r.value_inc_vat >= config.expensiveThresholdPence)
            .sort((a, b) => new Date(a.valid_from).getTime() - new Date(b.valid_from).getTime())[0];
          const horizonMs = firstExpensive
            ? new Date(firstExpensive.valid_from).getTime() - now.getTime()
            : 4 * 3600000;
          const hoursToHorizon = Math.max(0, horizonMs / 3600000);
          evLoadWh = Math.round(chargePowerKw * hoursToHorizon * 1000);
          console.log(`[optimizer] EV charging at ${chargePowerKw} kW, estimated ${evLoadWh} Wh to first expensive slot`);
        }
      } catch (err) {
        console.warn('[optimizer] Failed to read EV charger entity, assuming not charging:', err);
      }
    }

    const result = calculate({ ...config, batteryFillRateWh, batteryCapacityWh }, batteryPct, pvForecasts, rates, slotProfile, hpAdjustment, evLoadWh, exportRatePence);

    // Accumulate daily savings; reset at midnight
    const today = new Date().toISOString().slice(0, 10);
    if (today !== savingDate) {
      dailySavingVsPeakPence = 0;
      dailySavingVsStandardPence = 0;
      dailyPvSavingPence = 0;
      savingDate = today;
    }
    dailySavingVsPeakPence     += result.savingVsPeakPence;
    dailySavingVsStandardPence += result.savingVsStandardPence;
    dailyPvSavingPence         += result.pvSavingPence;

    try {
      await client.setMinCharge(plantId, result.threshold, result.sellThreshold);
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
        ha('sensor.sunsynk_optimizer_expensive_slots',    result.expensiveSlots,    { friendly_name: `Upcoming expensive slots (≥${config.expensiveThresholdPence}p)` }),
        ha('sensor.sunsynk_optimizer_expensive_demand_wh', result.totalExpensiveDemandWh, { unit_of_measurement: 'Wh', friendly_name: 'Battery demand during expensive slots' }),
        ha('sensor.sunsynk_optimizer_lowest_price',       result.lowestPrice,        { unit_of_measurement: '£/kWh',  friendly_name: 'Agile lowest price in window' }),
        ha('sensor.sunsynk_optimizer_pv_total',            result.pvTotal,            { unit_of_measurement: 'Wh', friendly_name: 'PV forecast over Agile horizon (confidence-adjusted)' }),
        ha('sensor.sunsynk_optimizer_pv_total_p50',       result.pvTotalP50,         { unit_of_measurement: 'Wh', friendly_name: 'PV forecast over Agile horizon (p50)' }),
        ha('sensor.sunsynk_optimizer_house_usage',        result.houseUsage,         { unit_of_measurement: 'Wh',     friendly_name: 'Estimated house usage over Agile horizon' }),
        ha('sensor.sunsynk_optimizer_battery_watts',      result.batteryWatts,       { unit_of_measurement: 'Wh',     friendly_name: 'Battery current charge' }),
        ha('sensor.sunsynk_optimizer_battery_to_fill',    result.batteryToFill,      { unit_of_measurement: 'Wh',     friendly_name: 'Battery grid import needed' }),
        ha('sensor.sunsynk_optimizer_battery_to_fill_no_pv', result.batteryToFillNoPV, { unit_of_measurement: 'Wh',  friendly_name: 'Battery grid import needed (no PV)' }),
        ha('sensor.sunsynk_optimizer_surplus',            result.surplus,            { unit_of_measurement: 'Wh',     friendly_name: 'Solar surplus to peak' }),
        ha('sensor.sunsynk_optimizer_blocks',             result.blocks,             { friendly_name: 'Charging slots to buy' }),
        ha('sensor.sunsynk_optimizer_results',            result.results.length,     { friendly_name: 'Agile slots in window', slots: result.results }),
        ha('sensor.sunsynk_optimizer_actual_cost',        result.actualCostPence,    { unit_of_measurement: 'p', friendly_name: 'Planned charge cost (Agile)' }),
        ha('sensor.sunsynk_optimizer_peak_slot_price',    result.peakSlotPricePence, { unit_of_measurement: 'p/kWh', friendly_name: 'Agile price at peak hour' }),
        ha('sensor.sunsynk_optimizer_daily_saving_vs_peak',     Math.round(dailySavingVsPeakPence),     { unit_of_measurement: 'p', friendly_name: 'Daily saving vs peak-hour Agile (today)' }),
        ha('sensor.sunsynk_optimizer_daily_saving_vs_standard', Math.round(dailySavingVsStandardPence), { unit_of_measurement: 'p', friendly_name: `Daily saving vs ${config.standardTariffPence}p standard tariff (today)` }),
        ha('sensor.sunsynk_optimizer_daily_pv_saving',          Math.round(dailyPvSavingPence),         { unit_of_measurement: 'p', friendly_name: 'Daily saving from solar (today)' }),
        ...(evLoadWh > 0 ? [ha('sensor.sunsynk_optimizer_ev_load', evLoadWh, { unit_of_measurement: 'Wh', friendly_name: 'Estimated EV charge load to peak' })] : []),
        ...(exportRatePence > 0 ? [ha('sensor.sunsynk_optimizer_export_rate', exportRatePence, { unit_of_measurement: 'p/kWh', friendly_name: 'Effective export rate' })] : []),
        ...(result.exportableWh > 0 ? [ha('sensor.sunsynk_optimizer_exportable_wh', result.exportableWh, { unit_of_measurement: 'Wh', friendly_name: 'Energy available to sell to grid' })] : []),
        ...(result.sellThreshold > 0 ? [ha('sensor.sunsynk_optimizer_sell_threshold', result.sellThreshold, { unit_of_measurement: 'p/kWh', friendly_name: 'Sell-to-grid threshold' })] : []),
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
