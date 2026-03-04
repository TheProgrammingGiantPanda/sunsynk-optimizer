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
  peakHour: number;
  minChargeFloorPence: number;
  forecastFetchTimes: string[];
  priceIntervalMinutes: number;
  haHeatPumpEntity: string;
  haOutdoorTempEntity: string;
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
    peakHour: Number(o['peak_hour'] ?? 16),
    minChargeFloorPence: Number(o['min_charge_floor_pence'] ?? 10),
    forecastFetchTimes: String(o['forecast_fetch_times'] ?? '06:00,12:00')
      .split(',')
      .map(t => t.trim()),
    priceIntervalMinutes: Number(o['price_interval_minutes'] ?? 30),
    haHeatPumpEntity: String(o['ha_heat_pump_entity'] ?? ''),
    haOutdoorTempEntity: String(o['ha_outdoor_temp_entity'] ?? 'sensor.main_heat_pump_outdoor_temperature'),
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
    peak_hour: process.env.PEAK_HOUR,
    min_charge_floor_pence: process.env.MIN_CHARGE_FLOOR_PENCE,
    forecast_fetch_times: process.env.FORECAST_FETCH_TIMES,
    price_interval_minutes: process.env.PRICE_INTERVAL_MINUTES,
    ha_heat_pump_entity: process.env.HA_HEAT_PUMP_ENTITY,
    ha_outdoor_temp_entity: process.env.HA_OUTDOOR_TEMP_ENTITY,
  });
}
