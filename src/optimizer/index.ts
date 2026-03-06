import './logger';
import fs from 'fs';
import path from 'path';
import SunsyncClient from '../index';
import { loadConfig } from './config';
import { getMergedForecast, loadForecastCache, ForecastSlot, tomorrowPvWh, dailyPvWhByDate } from './solcast';
import { getAgileRates, getFixedExportRate, getOutgoingAgileRates, getTouRates } from './octopus';
import { PriceSlot } from './octopus';
import { calculate } from './calculator';
import { scheduleDailyTimes, scheduleAgileAligned } from './scheduler';
import { getEntityState, setState, getSlotProfileWh, getAvgConsumptionWh, getDayMaxKwh, createNotification, dismissNotification, NOTIFICATION_ID_NEGATIVE_PRICES } from './homeassistant';
import { loadAccuracyHistory, saveAccuracyHistory, recordForecast, recordActual, getAccuracyStats, suggestConfidenceFactor, AccuracyRecord } from './accuracy';
import { buildHeatPumpModel, heatPumpSlotAdjustment, getHaLocation, HeatPumpModel } from './heatpump';
import { getHourlyForecast, avgForecastTemp } from './openmeteo';
import { loadSavingsHistory, updateSavingsHistory, updateSelfSufficiency, selfSufficiencyPct, SavingsHistory } from './savings';
import { getCarbonIntensityForecast, applyCarbonWeighting, estimateCo2SavedGrams, CarbonSlot } from './carbonintensity';

// ── Daily accumulator persistence ────────────────────────────────────────────

const DATA_DIR = fs.existsSync('/data') ? '/data' : process.cwd();
const ACCUMULATORS_PATH = path.join(DATA_DIR, 'daily_accumulators.json');

interface DailyAccumulators {
  date: string;
  savingVsPeakPence: number;
  savingVsStandardPence: number;
  pvSavingPence: number;
  exportIncomePence: number;
  co2SavedGrams: number;
  actualGridCostPence: number;
}

function loadAccumulators(today: string): DailyAccumulators {
  try {
    const raw = fs.readFileSync(ACCUMULATORS_PATH, 'utf-8');
    const saved: DailyAccumulators = JSON.parse(raw);
    if (saved.date === today) {
      console.log(`[optimizer] Restored daily accumulators for ${today} from disk`);
      // Default any fields added after the file was first written
      saved.actualGridCostPence ??= 0;
      return saved;
    }
  } catch {
    // No file or parse error — start fresh
  }
  return { date: today, savingVsPeakPence: 0, savingVsStandardPence: 0, pvSavingPence: 0, exportIncomePence: 0, co2SavedGrams: 0, actualGridCostPence: 0 };
}

function saveAccumulators(acc: DailyAccumulators): void {
  try {
    fs.writeFileSync(ACCUMULATORS_PATH, JSON.stringify(acc), 'utf-8');
  } catch (err) {
    console.warn('[optimizer] Failed to persist daily accumulators:', err);
  }
}

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

  console.log('================================================');
  console.log('  Sunsynk Battery Optimizer  v1.7.2  starting  ');
  console.log('================================================');
  console.log(`[optimizer] Expensive threshold: ${config.expensiveThresholdPence}p/kWh`);
  console.log(`[optimizer] Battery capacity: ${config.batteryCapacityWh} Wh`);
  console.log(`[optimizer] Forecast fetch times: ${config.forecastFetchTimes.join(', ')}`);
  if (config.touRates) {
    console.log(`[optimizer] TOU schedule active — Agile rates will not be fetched`);
    if (config.octopusProduct) console.log(`[optimizer] WARNING: tou_rates is set; octopus_product/tariff will be ignored`);
  }
  if (config.exportTariffSchedule) console.log(`[optimizer] Fixed export tariff: ${config.exportTariffSchedule}`);
  if (config.octopusExportProduct) console.log(`[optimizer] Outgoing Agile export: ${config.octopusExportProduct} / ${config.octopusExportTariff}`);
  console.log(`[optimizer] Price updates: aligned to Agile half-hour boundaries (+2 min offset)`);

  const client = new SunsyncClient();
  await client.login(config.sunsynkUsername, config.sunsynkPassword);
  console.log('[optimizer] Authenticated with Sunsynk');

  const plants = await client.getPlants();
  if (!plants.length) throw new Error('No plants found on Sunsynk account');
  const plant = config.sunsynkPlantId
    ? plants.find(p => String(p.id) === config.sunsynkPlantId) ?? (() => { throw new Error(`Plant id=${config.sunsynkPlantId} not found on account (available: ${plants.map(p => p.id).join(', ')})`); })()
    : plants[0];
  const plantId = plant.id;
  console.log(`[optimizer] Using plant: ${plant.name ?? plantId} (id=${plantId})`);

  // Cached values — refreshed at scheduled times
  // Pre-populate from disk cache so price updates work immediately on restart
  let pvForecasts: ForecastSlot[] = loadForecastCache() ?? [];

  // Daily savings accumulators — restored from disk on startup, reset when calendar date changes
  let accumulators = loadAccumulators(new Date().toISOString().slice(0, 10));
  let slotProfile: number[] | undefined;
  let computedAvgConsumptionWh: number | null = null;
  let hpSlotProfile: number[] | undefined;
  let hpModel: HeatPumpModel | null = null;

  // Last values sent to Sunsynk — skip API call when unchanged
  let lastThreshold: number | null = null;
  let lastSellThreshold: number | null = null;

  // Last grid import reading — used to compute per-slot delta for actual cost tracking
  let lastGridImportKwh: number | null = null;

  // Weekly / monthly savings history — persisted across restarts
  let savingsHistory: SavingsHistory = loadSavingsHistory();

  // Solcast forecast accuracy history — persisted across restarts
  let accuracyHistory: AccuracyRecord[] = loadAccuracyHistory();
  let computedConfidenceFactor: number | null = null;

  // Forecast + consumption fetcher
  // useCache: skip Solcast API call if a fresh cache already exists (used on startup to avoid
  // burning the hobbyist quota every time the service restarts)
  const fetchForecasts = async (useCache = false, updateAccuracy = true) => {
    let solcastFetched = false;
    if (useCache) {
      const cached = loadForecastCache();
      if (cached) {
        pvForecasts = cached;
        console.log(`[optimizer] Solar forecast loaded from cache (${pvForecasts.length} slots) — skipping Solcast API call`);
        solcastFetched = true;
      }
    }
    if (!solcastFetched) {
      console.log(`[optimizer] Fetching solar forecasts from Solcast (${config.solcastSites.length} site(s))…`);
      try {
        pvForecasts = await getMergedForecast(config.solcastSites, config.solcastApiKey);
        console.log(`[optimizer] Forecasts updated: ${pvForecasts.length} merged slots`);
      } catch (err) {
        console.error('[optimizer] Forecast fetch failed:', err);
      }
    }

    try {
      const profile = await getSlotProfileWh(
        config.haUrl, config.haToken,
        config.haLoadDailyEntity,
        config.consumptionAverageDays
      );
      if (profile !== null) {
        slotProfile = profile;
        // Derive flat average from the profile for the sensor
        computedAvgConsumptionWh = Math.round(profile.reduce((a, b) => a + b, 0) / profile.length);
      } else {
        slotProfile = undefined;
        // Try a flat average from history as a better fallback than the static config value
        const historyAvg = await getAvgConsumptionWh(
          config.haUrl, config.haToken,
          config.haLoadDailyEntity,
          config.consumptionAverageDays
        );
        if (historyAvg !== null) {
          computedAvgConsumptionWh = historyAvg;
          console.log(`[optimizer] Using history-derived avg consumption: ${historyAvg} Wh/slot`);
        } else {
          computedAvgConsumptionWh = null;
          console.warn(`[optimizer] Not enough consumption history — using config fallback: ${config.avgConsumptionWh} Wh/slot`);
        }
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

    // Forecast accuracy tracking (only on scheduled fetches, not cache-only startup)
    if (updateAccuracy && pvForecasts.length > 0) {
      try {
        const today = new Date().toISOString().slice(0, 10);
        const todayForecastWh = dailyPvWhByDate(pvForecasts, today);
        if (todayForecastWh > 0) {
          accuracyHistory = recordForecast(accuracyHistory, today, todayForecastWh);
        }

        // Complete yesterday's record with actual generation if entity is configured
        if (config.haPvDailyEntity) {
          const yesterday = new Date();
          yesterday.setUTCDate(yesterday.getUTCDate() - 1);
          const yesterdayStr = yesterday.toISOString().slice(0, 10);
          const actualKwh = await getDayMaxKwh(config.haUrl, config.haToken, config.haPvDailyEntity, yesterdayStr);
          if (actualKwh !== null) {
            const actualWh = Math.round(actualKwh * 1000);
            accuracyHistory = recordActual(accuracyHistory, yesterdayStr, actualWh);
            const stats = getAccuracyStats(accuracyHistory);
            console.log(
              `[accuracy] Yesterday (${yesterdayStr}): forecast=${accuracyHistory.find(r => r.date === yesterdayStr)?.forecastP50Wh ?? '?'} Wh, ` +
              `actual=${actualWh} Wh` +
              (stats.mape7d !== null ? `, MAPE 7d=${stats.mape7d}%` : '') +
              (stats.mape30d !== null ? `, 30d=${stats.mape30d}%` : '')
            );

            if (config.autoTuneConfidence && stats.mape7d !== null) {
              computedConfidenceFactor = suggestConfidenceFactor(stats.mape7d);
              console.log(`[accuracy] Auto-tuned forecastConfidenceFactor → ${computedConfidenceFactor} (MAPE 7d=${stats.mape7d}%)`);
            }
          }
        }

        saveAccuracyHistory(accuracyHistory);
      } catch (err) {
        console.error('[optimizer] Forecast accuracy update failed:', err);
      }
    }
  };

  // Startup: use cache if fresh (avoids Solcast API call on every restart); skip accuracy update
  fetchForecasts(true, false).catch(err => console.error('[optimizer] Initial forecast error:', err));
  // Scheduled fetches (e.g. 06:00, 12:00): always pull fresh data from Solcast
  scheduleDailyTimes(config.forecastFetchTimes, fetchForecasts, false);

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

    let rates: PriceSlot[];
    try {
      if (config.touRates) {
        rates = getTouRates(config.touRates);
        console.log(`[optimizer] Using TOU schedule (${rates.length} synthesised slots)`);
      } else {
        rates = await getAgileRates(config.octopusProduct, config.octopusTariff);
      }
    } catch (err) {
      console.error('[optimizer] Failed to get rates:', err);
      return;
    }

    // Notify when upcoming Agile slots have negative prices (Agile only — TOU rates are never negative)
    if (!config.touRates) {
      const now = new Date();
      const negativeSlots = rates
        .filter(r => new Date(r.valid_from) >= now && r.value_inc_vat < 0)
        .sort((a, b) => new Date(a.valid_from).getTime() - new Date(b.valid_from).getTime());

      if (negativeSlots.length > 0) {
        const lines = negativeSlots.map(r => {
          const from = new Date(r.valid_from).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
          const to   = new Date(r.valid_to).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
          return `- ${from}–${to}: ${r.value_inc_vat.toFixed(2)}p/kWh`;
        });
        console.log(`[optimizer] ${negativeSlots.length} negative-price slot(s) upcoming — notifying HA`);
        createNotification(
          config.haUrl, config.haToken,
          `⚡ Negative Agile prices — ${negativeSlots.length} slot(s)`,
          `Upcoming negative-price slots (charge discretionary loads now):\n\n${lines.join('\n')}`,
          NOTIFICATION_ID_NEGATIVE_PRICES
        ).catch(() => {});
      } else {
        dismissNotification(config.haUrl, config.haToken, NOTIFICATION_ID_NEGATIVE_PRICES).catch(() => {});
      }
    }

    // Resolve effective export rate: Outgoing Agile schedule > fixed schedule > 0
    let exportRatePence = 0;
    let exportRates: PriceSlot[] = [];
    if (config.octopusExportProduct && config.octopusExportTariff) {
      const fetchedExportRates = await getOutgoingAgileRates(config.octopusExportProduct, config.octopusExportTariff);
      if (fetchedExportRates.length > 0) {
        exportRates = fetchedExportRates;
        const now = new Date();
        const currentSlot = fetchedExportRates.find(s =>
          new Date(s.valid_from) <= now && new Date(s.valid_to) > now
        );
        if (currentSlot) {
          exportRatePence = currentSlot.value_inc_vat;
          console.log(`[optimizer] Outgoing Agile export rate: ${exportRatePence.toFixed(2)}p/kWh (${fetchedExportRates.length} future slots)`);
        }
      } else {
        console.warn('[optimizer] Failed to get Outgoing Agile rates, falling back to fixed schedule');
      }
    }
    if (exportRatePence === 0 && config.exportTariffSchedule) {
      exportRatePence = getFixedExportRate(config.exportTariffSchedule);
      if (exportRatePence > 0) {
        console.log(`[optimizer] Fixed export rate: ${exportRatePence}p/kWh`);
      }
    }

    // For fixed export tariffs, synthesise a slot schedule at the fixed rate so the
    // export planning logic (slot selection, income, sell threshold) works the same way.
    if (exportRates.length === 0 && exportRatePence > 0) {
      exportRates = rates.map(r => ({ ...r, value_exc_vat: exportRatePence / 1.05, value_inc_vat: exportRatePence }));
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

    // Read daily grid import — used for self-sufficiency and actual cost tracking
    let dailySelfSuffPct: number | null = null;
    let currentGridImportKwh: number | null = null;
    if (config.haGridImportDailyEntity) {
      try {
        const [gridImportKwh, consumptionKwh] = await Promise.all([
          getEntityState(config.haUrl, config.haToken, config.haGridImportDailyEntity),
          getEntityState(config.haUrl, config.haToken, config.haLoadDailyEntity),
        ]);
        currentGridImportKwh = gridImportKwh;
        dailySelfSuffPct = selfSufficiencyPct(Math.round(gridImportKwh * 1000), Math.round(consumptionKwh * 1000));
      } catch (err) {
        console.warn('[optimizer] Failed to read self-sufficiency sensors:', err);
      }
    }

    // Fetch carbon intensity — used for CO2 saving estimates and (optionally) slot scoring
    let carbonSlots: CarbonSlot[] = [];
    let carbonRates = rates;
    try {
      carbonSlots = await getCarbonIntensityForecast(config.carbonIntensityRegionId);
      if (config.carbonIntensityWeight > 0) {
        carbonRates = applyCarbonWeighting(rates, carbonSlots, config.carbonIntensityWeight);
        console.log(`[optimizer] Carbon intensity weighting applied (weight=${config.carbonIntensityWeight}, regionId=${config.carbonIntensityRegionId}, ${carbonSlots.length} slots)`);
      }
    } catch (err) {
      console.warn('[optimizer] Carbon intensity fetch failed — CO2 estimates unavailable this cycle:', err);
    }

    // Optionally compute expensive threshold from a percentile of current rates
    let expensiveThresholdPence = config.expensiveThresholdPence;
    const pct = config.expensiveThresholdPercentile;
    if (pct > 0 && pct < 100 && rates.length > 0) {
      const sorted = [...rates].map(r => r.value_inc_vat).sort((a, b) => a - b);
      const idx = Math.floor((pct / 100) * sorted.length);
      expensiveThresholdPence = Math.round(sorted[Math.min(idx, sorted.length - 1)]);
      console.log(`[optimizer] Expensive threshold (p${pct}): ${expensiveThresholdPence}p/kWh`);
    }

    // Dynamic minimum SOC: if tomorrow's P50 solar is below threshold, raise the floor
    let effectiveMinSoc = config.minDischargeSoc;
    if (config.lowSolarThresholdWh > 0 && pvForecasts.length > 0) {
      const tomorrowWh = tomorrowPvWh(pvForecasts);
      if (tomorrowWh < config.lowSolarThresholdWh) {
        effectiveMinSoc = config.backupMinSoc;
        console.log(`[optimizer] Low solar forecast tomorrow (${tomorrowWh} Wh < ${config.lowSolarThresholdWh} Wh threshold) — raising min SOC to ${effectiveMinSoc}%`);
      } else {
        console.log(`[optimizer] Solar forecast tomorrow: ${tomorrowWh} Wh — min SOC unchanged at ${effectiveMinSoc}%`);
      }
    }

    // Use history-derived avg if available, falling back to static config
    const effectiveAvgConsumptionWh = computedAvgConsumptionWh ?? config.avgConsumptionWh;
    // Use auto-tuned confidence factor if available, otherwise static config
    const effectiveConfidenceFactor = computedConfidenceFactor ?? config.forecastConfidenceFactor;

    const result = calculate({ ...config, batteryFillRateWh, batteryCapacityWh, expensiveThresholdPence, avgConsumptionWh: effectiveAvgConsumptionWh, forecastConfidenceFactor: effectiveConfidenceFactor }, batteryPct, pvForecasts, carbonRates, slotProfile, hpAdjustment, evLoadWh, exportRatePence, exportRates);

    // Accumulate daily savings; reset at midnight
    const today = new Date().toISOString().slice(0, 10);
    if (today !== accumulators.date) {
      // Before resetting, roll yesterday's self-sufficiency into weekly/monthly accumulators
      if (config.haGridImportDailyEntity) {
        try {
          const yesterday = new Date();
          yesterday.setUTCDate(yesterday.getUTCDate() - 1);
          const yesterdayStr = yesterday.toISOString().slice(0, 10);
          const [gridImportKwh, consumptionKwh] = await Promise.all([
            getDayMaxKwh(config.haUrl, config.haToken, config.haGridImportDailyEntity, yesterdayStr),
            getDayMaxKwh(config.haUrl, config.haToken, config.haLoadDailyEntity, yesterdayStr),
          ]);
          if (gridImportKwh !== null && consumptionKwh !== null) {
            savingsHistory = updateSelfSufficiency(
              savingsHistory,
              Math.round(gridImportKwh * 1000),
              Math.round(consumptionKwh * 1000)
            );
            console.log(`[optimizer] Self-sufficiency updated for ${yesterdayStr}: grid=${Math.round(gridImportKwh * 1000)} Wh, load=${Math.round(consumptionKwh * 1000)} Wh`);
          }
        } catch (err) {
          console.error('[optimizer] Failed to update self-sufficiency accumulators:', err);
        }
      }
      accumulators = { date: today, savingVsPeakPence: 0, savingVsStandardPence: 0, pvSavingPence: 0, exportIncomePence: 0, co2SavedGrams: 0, actualGridCostPence: 0 };
      lastGridImportKwh = null; // reset on day rollover so delta is clean
    }
    accumulators.savingVsPeakPence     += result.savingVsPeakPence;
    accumulators.savingVsStandardPence += result.savingVsStandardPence;
    accumulators.pvSavingPence         += result.pvSavingPence;
    if (result.sellThreshold > 0) accumulators.exportIncomePence += result.exportIncomePence;
    const co2SavedGrams = estimateCo2SavedGrams(rates, carbonSlots, expensiveThresholdPence, result.blocks, config.batteryFillRateWh);
    accumulators.co2SavedGrams += co2SavedGrams;

    // Current import rate for this slot
    const now = new Date();
    const currentRatePence = rates.find(r => new Date(r.valid_from) <= now && new Date(r.valid_to) > now)?.value_inc_vat ?? null;

    // Actual grid cost: delta in grid import kWh this slot × current import rate
    if (currentGridImportKwh !== null) {
      if (lastGridImportKwh !== null && currentRatePence !== null) {
        const deltaKwh = Math.max(0, currentGridImportKwh - lastGridImportKwh);
        accumulators.actualGridCostPence += deltaKwh * currentRatePence;
      }
      lastGridImportKwh = currentGridImportKwh;
    }

    saveAccumulators(accumulators);

    // Update weekly / monthly accumulators
    savingsHistory = updateSavingsHistory(
      savingsHistory,
      result.savingVsStandardPence,
      result.sellThreshold > 0 ? result.exportIncomePence : 0,
      co2SavedGrams
    );

    const exportConfigured = exportRatePence > 0 || exportRates.length > 0;
    const effectiveSellThreshold = exportConfigured ? result.sellThreshold : undefined;
    if (result.threshold === lastThreshold && effectiveSellThreshold === lastSellThreshold) {
      console.log(`[optimizer] Threshold unchanged (${result.threshold}p / sell ${effectiveSellThreshold ?? 'n/a'}p) — skipping Sunsynk update`);
    } else {
      try {
        // Pass sellThreshold whenever export is configured so direction=0 is always kept in sync.
        // 0 = no surplus/not profitable → setMinCharge writes 999p to disable selling.
        await client.setMinCharge(plantId, result.threshold, effectiveSellThreshold, { limitSoc: effectiveMinSoc });
        console.log(`[optimizer] Set min charge threshold to ${result.threshold}p (battery ${batteryPct}%)`);
        lastThreshold = result.threshold;
        lastSellThreshold = effectiveSellThreshold ?? null;
        dismissNotification(config.haUrl, config.haToken).catch(() => {});
      } catch (err) {
        console.error('[optimizer] Failed to set min charge:', err);
        createNotification(config.haUrl, config.haToken,
          'Sunsynk Optimizer — failed to set charge threshold',
          `Failed to set min charge threshold at ${new Date().toISOString()}.\n\n${err}`
        ).catch(() => {});
      }
    }

    // Push results to HA sensors
    {
      const ha = (id: string, state: string | number, attrs: Record<string, unknown> = {}) =>
        setState(config.haUrl, config.haToken, id, state, attrs);

      const writes: [string, Promise<unknown>][] = [
        ['threshold',          ha('sensor.sunsynk_optimizer_threshold',          result.threshold,         { unit_of_measurement: 'p/kWh',  friendly_name: 'Sunsynk charge threshold' })],
        ['effective_min_soc',  ha('sensor.sunsynk_optimizer_effective_min_soc',  effectiveMinSoc,          { unit_of_measurement: '%', friendly_name: 'Effective minimum discharge SOC' })],
        ['avg_consumption_wh', ha('sensor.sunsynk_optimizer_avg_consumption_wh', effectiveAvgConsumptionWh, { unit_of_measurement: 'Wh', friendly_name: 'Avg house consumption per 30-min slot', source: computedAvgConsumptionWh !== null ? 'history' : 'config' })],
        ...(() => {
          const stats = getAccuracyStats(accuracyHistory);
          const entries: [string, Promise<unknown>][] = [];
          if (stats.mape7d !== null)  entries.push(['forecast_accuracy_7d',  ha('sensor.sunsynk_optimizer_forecast_accuracy_7d',  stats.mape7d,  { unit_of_measurement: '%', friendly_name: 'Solcast forecast accuracy — MAPE 7d' })]);
          if (stats.mape30d !== null) entries.push(['forecast_accuracy_30d', ha('sensor.sunsynk_optimizer_forecast_accuracy_30d', stats.mape30d, { unit_of_measurement: '%', friendly_name: 'Solcast forecast accuracy — MAPE 30d' })]);
          return entries;
        })(),
        ['expensive_slots',    ha('sensor.sunsynk_optimizer_expensive_slots',    result.expensiveSlots,    { friendly_name: `Upcoming expensive slots (≥${config.expensiveThresholdPence}p)` })],
        ['expensive_demand_wh', ha('sensor.sunsynk_optimizer_expensive_demand_wh', result.totalExpensiveDemandWh, { unit_of_measurement: 'Wh', friendly_name: 'Battery demand during expensive slots' })],
        ['lowest_price',       ha('sensor.sunsynk_optimizer_lowest_price',       result.lowestPrice,        { unit_of_measurement: '£/kWh',  friendly_name: 'Agile lowest price in window' })],
        ...(currentRatePence !== null ? [['current_price', ha('sensor.sunsynk_optimizer_current_price', currentRatePence, { unit_of_measurement: 'p/kWh', friendly_name: 'Current Agile import price' })] as [string, Promise<unknown>]] : []),
        ['pv_total',           ha('sensor.sunsynk_optimizer_pv_total',           result.pvTotal,            { unit_of_measurement: 'Wh', friendly_name: 'Total PV forecast over remaining Agile horizon (confidence-adjusted)' })],
        ['pv_total_p50',       ha('sensor.sunsynk_optimizer_pv_total_p50',       result.pvTotalP50,         { unit_of_measurement: 'Wh', friendly_name: 'Total PV forecast over remaining Agile horizon (p50)' })],
        ['house_usage',        ha('sensor.sunsynk_optimizer_house_usage',        result.houseUsage,         { unit_of_measurement: 'Wh',     friendly_name: 'Projected house consumption over remaining Agile horizon (resets when new rates published)' })],
        ['battery_watts',      ha('sensor.sunsynk_optimizer_battery_watts',      result.batteryWatts,       { unit_of_measurement: 'Wh',     friendly_name: 'Battery current charge' })],
        ['battery_to_fill',    ha('sensor.sunsynk_optimizer_battery_to_fill',    result.batteryToFill,      { unit_of_measurement: 'Wh',     friendly_name: 'Grid import needed to cover expensive slots over remaining horizon' })],
        ['battery_to_fill_no_pv', ha('sensor.sunsynk_optimizer_battery_to_fill_no_pv', result.batteryToFillNoPV, { unit_of_measurement: 'Wh', friendly_name: 'Battery grid import needed (no PV)' })],
        ['surplus',            ha('sensor.sunsynk_optimizer_surplus',            result.surplus,            { unit_of_measurement: 'Wh',     friendly_name: 'Total solar surplus over remaining Agile horizon (PV minus house usage)' })],
        ['blocks',             ha('sensor.sunsynk_optimizer_blocks',             result.blocks,             { friendly_name: 'Charging slots to buy' })],
        ['results',            ha('sensor.sunsynk_optimizer_results',            result.results.length,     { friendly_name: 'Agile slots in window', slots: result.results })],
        ['actual_cost',        ha('sensor.sunsynk_optimizer_actual_cost',        result.actualCostPence,    { unit_of_measurement: 'p', friendly_name: 'Planned charge cost (Agile)' })],
        ['peak_slot_price',    ha('sensor.sunsynk_optimizer_peak_slot_price',    result.peakSlotPricePence, { unit_of_measurement: 'p/kWh', friendly_name: 'Agile price at peak hour' })],
        ['daily_saving_vs_peak',     ha('sensor.sunsynk_optimizer_daily_saving_vs_peak',     Math.round(accumulators.savingVsPeakPence),     { unit_of_measurement: 'p', friendly_name: 'Daily saving vs peak-hour Agile (today)' })],
        ['daily_saving_vs_standard', ha('sensor.sunsynk_optimizer_daily_saving_vs_standard', Math.round(accumulators.savingVsStandardPence), { unit_of_measurement: 'p', friendly_name: `Daily saving vs ${config.standardTariffPence}p standard tariff (today)` })],
        ['daily_pv_saving',          ha('sensor.sunsynk_optimizer_daily_pv_saving',          Math.round(accumulators.pvSavingPence),         { unit_of_measurement: 'p', friendly_name: 'Daily saving from solar (today)' })],
        ['daily_export_income',      ha('sensor.sunsynk_optimizer_daily_export_income',      Math.round(accumulators.exportIncomePence),     { unit_of_measurement: 'p', friendly_name: 'Daily export income (today)' })],
        ...(config.haGridImportDailyEntity ? [['daily_actual_grid_cost', ha('sensor.sunsynk_optimizer_daily_actual_grid_cost', Math.round(accumulators.actualGridCostPence), { unit_of_measurement: 'p', friendly_name: 'Actual grid import cost today' })] as [string, Promise<unknown>]] : []),
        ['weekly_saving_vs_standard', ha('sensor.sunsynk_optimizer_weekly_saving_vs_standard', Math.round(savingsHistory.weeklySavingVsStandardPence), { unit_of_measurement: 'p', friendly_name: `Weekly saving vs ${config.standardTariffPence}p standard tariff (${savingsHistory.week})` })],
        ['weekly_export_income',      ha('sensor.sunsynk_optimizer_weekly_export_income',      Math.round(savingsHistory.weeklyExportIncomePence),      { unit_of_measurement: 'p', friendly_name: `Weekly export income (${savingsHistory.week})` })],
        ['monthly_saving_vs_standard', ha('sensor.sunsynk_optimizer_monthly_saving_vs_standard', Math.round(savingsHistory.monthlySavingVsStandardPence), { unit_of_measurement: 'p', friendly_name: `Monthly saving vs ${config.standardTariffPence}p standard tariff (${savingsHistory.month})` })],
        ['monthly_export_income',     ha('sensor.sunsynk_optimizer_monthly_export_income',     Math.round(savingsHistory.monthlyExportIncomePence),     { unit_of_measurement: 'p', friendly_name: `Monthly export income (${savingsHistory.month})` })],
        ['daily_co2_saved',           ha('sensor.sunsynk_optimizer_daily_co2_saved',           accumulators.co2SavedGrams,                              { unit_of_measurement: 'g', friendly_name: 'Estimated CO₂ saved today (gCO₂)' })],
        ['weekly_co2_saved',          ha('sensor.sunsynk_optimizer_weekly_co2_saved',          savingsHistory.weeklyCo2SavedGrams,                       { unit_of_measurement: 'g', friendly_name: `Estimated CO₂ saved this week (${savingsHistory.week}, gCO₂)` })],
        ['monthly_co2_saved',         ha('sensor.sunsynk_optimizer_monthly_co2_saved',         savingsHistory.monthlyCo2SavedGrams,                      { unit_of_measurement: 'g', friendly_name: `Estimated CO₂ saved this month (${savingsHistory.month}, gCO₂)` })],
        ...(config.haGridImportDailyEntity && dailySelfSuffPct !== null ? [['daily_self_sufficiency', ha('sensor.sunsynk_optimizer_daily_self_sufficiency', dailySelfSuffPct, { unit_of_measurement: '%', friendly_name: 'Self-sufficiency today' })] as [string, Promise<unknown>]] : []),
        ...(() => {
          const weeklySS = selfSufficiencyPct(savingsHistory.weeklyGridImportWh, savingsHistory.weeklyConsumptionWh);
          const monthlySS = selfSufficiencyPct(savingsHistory.monthlyGridImportWh, savingsHistory.monthlyConsumptionWh);
          const entries: [string, Promise<unknown>][] = [];
          if (config.haGridImportDailyEntity && weeklySS !== null) entries.push(['weekly_self_sufficiency', ha('sensor.sunsynk_optimizer_weekly_self_sufficiency', weeklySS, { unit_of_measurement: '%', friendly_name: `Self-sufficiency this week (${savingsHistory.week})` })]);
          if (config.haGridImportDailyEntity && monthlySS !== null) entries.push(['monthly_self_sufficiency', ha('sensor.sunsynk_optimizer_monthly_self_sufficiency', monthlySS, { unit_of_measurement: '%', friendly_name: `Self-sufficiency this month (${savingsHistory.month})` })]);
          return entries;
        })(),
        ...(evLoadWh > 0 ? [['ev_load',        ha('sensor.sunsynk_optimizer_ev_load',        evLoadWh,               { unit_of_measurement: 'Wh',     friendly_name: 'Estimated EV charge load to peak' })] as [string, Promise<unknown>]] : []),
        ...(exportRatePence > 0 ? [['export_rate',   ha('sensor.sunsynk_optimizer_export_rate',   exportRatePence,        { unit_of_measurement: 'p/kWh',  friendly_name: 'Effective export rate' })] as [string, Promise<unknown>]] : []),
        ['exportable_wh',    ha('sensor.sunsynk_optimizer_exportable_wh',    result.exportableWh,    { unit_of_measurement: 'Wh',     friendly_name: 'Energy available to sell to grid' })],
        ['sell_threshold',   ha('sensor.sunsynk_optimizer_sell_threshold',   result.sellThreshold,   { unit_of_measurement: 'p/kWh',  friendly_name: 'Sell-to-grid threshold' })],
        ['export_slot_count', ha('sensor.sunsynk_optimizer_export_slot_count', result.exportSlotCount, { friendly_name: 'Planned export slots' })],
        ['export_income',    ha('sensor.sunsynk_optimizer_export_income',    result.exportIncomePence, { unit_of_measurement: 'p',      friendly_name: 'Expected export income' })],
        ...(hpAdjustment ? [['hp_adjustment', ha('sensor.sunsynk_optimizer_hp_adjustment',
          hpAdjustment.reduce((a, b) => a + b, 0),
          { unit_of_measurement: 'Wh', friendly_name: 'Heat pump adjustment vs historical', slots: hpAdjustment }
        )] as [string, Promise<unknown>]] : []),
        ...(slotProfile ? [['slot_profile', ha('sensor.sunsynk_optimizer_slot_profile',
          slotProfile.reduce((a, b) => a + b, 0),
          { unit_of_measurement: 'Wh', friendly_name: 'Avg daily consumption profile', slots: slotProfile }
        )] as [string, Promise<unknown>]] : []),
      ];

      const results = await Promise.allSettled(writes.map(([, p]) => p));
      const failed = results
        .map((r, i) => r.status === 'rejected' ? writes[i][0] : null)
        .filter(Boolean);
      if (failed.length) {
        console.error(`[optimizer] Failed to write HA sensors: ${failed.join(', ')}`);
      } else {
        console.log('[optimizer] HA sensors updated');
      }
    }
  });
}

main().catch(err => {
  console.error('[optimizer] Fatal error:', err);
  process.exit(1);
});
