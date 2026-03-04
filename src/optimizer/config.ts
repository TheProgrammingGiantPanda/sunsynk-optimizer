import fs from 'fs';
import path from 'path';

export interface Config {
  sunsynkUsername: string;
  sunsynkPassword: string;
  haUrl: string;
  haToken: string;
  haBatterySocEntity: string;
  haBatteryVoltageEntity: string;
  haBatteryMaxCurrentEntity: string;
  haBatteryCapacityAhEntity: string;
  haLoadDailyEntity: string;
  consumptionAverageDays: number;
  solcastApiKey: string;
  solcastSites: string[];
  octopusProduct: string;
  octopusTariff: string;
  batteryCapacityWh: number;
  batteryFillRateWh: number;
  avgConsumptionWh: number;
  expensiveThresholdPence: number;  // slots at or above this price are "expensive" — battery covers them
  minChargeFloorPence: number;
  forecastConfidenceFactor: number;
  forecastFetchTimes: string[];
  haHeatPumpEntity: string;
  haOutdoorTempEntity: string;
  standardTariffPence: number;
  haEvChargerEntity: string;
  exportTariffSchedule: string;       // "RATE:YYYY-MM-DD,..." fixed schedule
  octopusExportProduct: string;       // e.g. "OUTGOING-AGILE-BB-23-02-28" (optional)
  octopusExportTariff: string;        // e.g. "E-1R-OUTGOING-AGILE-BB-23-02-28-G" (optional)
  batteryRoundTripEfficiency: number; // 0–1; fraction of imported Wh recoverable on discharge (default 0.9)
  minDischargeSoc: number;            // % — minimum battery SoC before selling stops (limitSoc on direction=0)
  sunsynkPlantId: string;             // optional — target a specific plant ID; falls back to plants[0]
  expensiveThresholdPercentile: number; // 0 = use fixed expensiveThresholdPence; 1–99 = compute dynamically
  carbonIntensityWeight: number;        // 0 = disabled; 0.1–1 blends carbon intensity into slot scoring
  carbonIntensityRegionId: number;      // National Grid ESO region ID (0 = national average)
  lowSolarThresholdWh: number;          // 0 = disabled; if tomorrow P50 PV < this Wh, use backupMinSoc
  backupMinSoc: number;                 // min SOC % when tomorrow solar is poor (default 40)
}

function fromOptions(o: Record<string, unknown>): Config {
  return {
    sunsynkUsername: String(o['sunsynk_username'] ?? ''),
    sunsynkPassword: String(o['sunsynk_password'] ?? ''),
    haUrl: String(o['ha_url'] ?? 'http://homeassistant.local:8123'),
    haToken: String(o['ha_token'] ?? ''),
    haBatterySocEntity: String(o['ha_battery_soc_entity'] ?? 'sensor.solarsynkv3_2310140043_battery_bms_soc'),
    haBatteryVoltageEntity: String(o['ha_battery_voltage_entity'] ?? 'sensor.solarsynkv3_2310140043_battery_voltage'),
    haBatteryMaxCurrentEntity: String(o['ha_battery_max_current_entity'] ?? 'sensor.solarsynkv3_2310140043_batterymaxcurrentcharge'),
    haBatteryCapacityAhEntity: String(o['ha_battery_capacity_ah_entity'] ?? 'sensor.solarsynkv3_2310140043_battery_capacity'),
    haLoadDailyEntity: String(o['ha_load_daily_entity'] ?? 'sensor.solarsynkv3_2310140043_load_daily_used'),
    consumptionAverageDays: Number(o['consumption_average_days'] ?? 7),
    solcastApiKey: String(o['solcast_api_key'] ?? ''),
    solcastSites: String(o['solcast_sites'] ?? '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    octopusProduct: String(o['octopus_product'] ?? 'AGILE-24-04-03'),
    octopusTariff: String(o['octopus_tariff'] ?? 'E-1R-AGILE-24-04-03-G'),
    batteryCapacityWh: Number(o['battery_capacity_wh'] ?? 10000),
    batteryFillRateWh: Number(o['battery_fill_rate_wh'] ?? 2000),
    avgConsumptionWh: Number(o['avg_consumption_wh'] ?? 500),
    expensiveThresholdPence: Number(o['expensive_threshold_pence'] ?? 25),
    minChargeFloorPence: Number(o['min_charge_floor_pence'] ?? 10),
    forecastConfidenceFactor: Number(o['forecast_confidence_factor'] ?? 0.3),
    forecastFetchTimes: String(o['forecast_fetch_times'] ?? '06:00,12:00')
      .split(',')
      .map(t => t.trim()),
    haHeatPumpEntity: String(o['ha_heat_pump_entity'] ?? ''),
    haOutdoorTempEntity: String(o['ha_outdoor_temp_entity'] ?? 'sensor.main_heat_pump_outdoor_temperature'),
    standardTariffPence: Number(o['standard_tariff_pence'] ?? 24),
    haEvChargerEntity: String(o['ha_ev_charger_entity'] ?? ''),
    exportTariffSchedule: String(o['export_tariff_schedule'] ?? ''),
    octopusExportProduct: String(o['octopus_export_product'] ?? ''),
    octopusExportTariff: String(o['octopus_export_tariff'] ?? ''),
    batteryRoundTripEfficiency: Number(o['battery_round_trip_efficiency'] ?? 0.9),
    minDischargeSoc: Number(o['min_discharge_soc'] ?? 20),
    sunsynkPlantId: String(o['sunsynk_plant_id'] ?? ''),
    expensiveThresholdPercentile: Number(o['expensive_threshold_percentile'] ?? 0),
    carbonIntensityWeight: Number(o['carbon_intensity_weight'] ?? 0),
    carbonIntensityRegionId: Number(o['carbon_intensity_region_id'] ?? 0),
    lowSolarThresholdWh: Number(o['low_solar_threshold_wh'] ?? 0),
    backupMinSoc: Number(o['backup_min_soc'] ?? 40),
  };
}

export function loadConfig(): Config {
  // In HA add-on: /data/options.json is written by Supervisor from add-on options
  const optionsPath = '/data/options.json';
  if (fs.existsSync(optionsPath)) {
    const raw = fs.readFileSync(optionsPath, 'utf-8');
    return fromOptions(JSON.parse(raw));
  }

  // Dev fallback: use environment variables (load .env before running)
  return fromOptions({
    sunsynk_username: process.env.SUNSYNK_USER,
    sunsynk_password: process.env.SUNSYNK_PASS,
    ha_url: process.env.HA_URL,
    ha_token: process.env.HA_TOKEN,
    ha_battery_soc_entity: process.env.HA_BATTERY_SOC_ENTITY,
    ha_battery_voltage_entity: process.env.HA_BATTERY_VOLTAGE_ENTITY,
    ha_battery_max_current_entity: process.env.HA_BATTERY_MAX_CURRENT_ENTITY,
    ha_battery_capacity_ah_entity: process.env.HA_BATTERY_CAPACITY_AH_ENTITY,
    ha_load_daily_entity: process.env.HA_LOAD_DAILY_ENTITY,
    consumption_average_days: process.env.CONSUMPTION_AVERAGE_DAYS,
    solcast_api_key: process.env.SOLCAST_API_KEY,
    solcast_sites: process.env.SOLCAST_SITES,
    octopus_product: process.env.OCTOPUS_PRODUCT,
    octopus_tariff: process.env.OCTOPUS_TARIFF,
    battery_capacity_wh: process.env.BATTERY_CAPACITY_WH,
    battery_fill_rate_wh: process.env.BATTERY_FILL_RATE_WH,
    avg_consumption_wh: process.env.AVG_CONSUMPTION_WH,
    expensive_threshold_pence: process.env.EXPENSIVE_THRESHOLD_PENCE,
    min_charge_floor_pence: process.env.MIN_CHARGE_FLOOR_PENCE,
    forecast_confidence_factor: process.env.FORECAST_CONFIDENCE_FACTOR,
    forecast_fetch_times: process.env.FORECAST_FETCH_TIMES,
    ha_heat_pump_entity: process.env.HA_HEAT_PUMP_ENTITY,
    ha_outdoor_temp_entity: process.env.HA_OUTDOOR_TEMP_ENTITY,
    standard_tariff_pence: process.env.STANDARD_TARIFF_PENCE,
    ha_ev_charger_entity: process.env.HA_EV_CHARGER_ENTITY,
    export_tariff_schedule: process.env.EXPORT_TARIFF_SCHEDULE,
    octopus_export_product: process.env.OCTOPUS_EXPORT_PRODUCT,
    octopus_export_tariff: process.env.OCTOPUS_EXPORT_TARIFF,
    battery_round_trip_efficiency: process.env.BATTERY_ROUND_TRIP_EFFICIENCY,
    min_discharge_soc: process.env.MIN_DISCHARGE_SOC,
    sunsynk_plant_id: process.env.SUNSYNK_PLANT_ID,
    expensive_threshold_percentile: process.env.EXPENSIVE_THRESHOLD_PERCENTILE,
    carbon_intensity_weight: process.env.CARBON_INTENSITY_WEIGHT,
    carbon_intensity_region_id: process.env.CARBON_INTENSITY_REGION_ID,
    low_solar_threshold_wh: process.env.LOW_SOLAR_THRESHOLD_WH,
    backup_min_soc: process.env.BACKUP_MIN_SOC,
  });
}
