# Sunsynk Battery Optimizer

A Home Assistant add-on (and standalone Node.js app) that automatically optimises Sunsynk battery charging using **Octopus Agile** electricity prices and **Solcast** solar forecasts.

Every 30 minutes (aligned to Agile half-hour boundaries) it:

1. Reads the current battery state-of-charge and live battery parameters from Home Assistant
2. Fetches the latest Octopus Agile half-hourly import prices
3. Resolves the current export rate (fixed schedule or live Outgoing Agile)
4. Uses the Solcast solar forecast to estimate PV generation before the peak period
5. Estimates house load from historical consumption profiles (heat-pump-adjusted if configured)
6. Estimates EV charge load if a charger entity is configured
7. Calculates the cheapest grid import slots needed, accounting for battery efficiency and export rate
8. Sets the Sunsynk minimum charge threshold via the Sunsynk API
9. Publishes all intermediate values back to Home Assistant as sensors

Solar forecasts are fetched from Solcast at scheduled times (default 06:00 and 12:00) to stay within the hobbyist API quota of 10 calls per day. Forecasts are cached to disk so the optimizer continues working across restarts and Solcast rate-limit errors.

---

## Requirements

- A Sunsynk (or Deye) inverter with a portal account at [sunsynk.net](https://www.sunsynk.net)
- [Octopus Energy](https://octopus.energy) Agile import tariff
- [Solcast](https://solcast.com) hobbyist account with rooftop site(s) configured
- Home Assistant with the [SolarSynk v3](https://github.com/erikarenhill/solarsynk-homeassistant) integration installed (provides battery SOC and other sensors)
- Node.js 20+ (for local/dev use) or Home Assistant with the add-on supervisor (for production)

---

## Configuration

All options can be set either via the Home Assistant add-on UI (stored in `/data/options.json`) or via a `.env` file for local development.

### Credentials & connectivity

| Option | Env var | Default | Description |
|---|---|---|---|
| `sunsynk_username` | `SUNSYNK_USER` | — | Sunsynk portal email |
| `sunsynk_password` | `SUNSYNK_PASS` | — | Sunsynk portal password |
| `ha_url` | `HA_URL` | `http://homeassistant.local:8123` | Home Assistant base URL |
| `ha_token` | `HA_TOKEN` | — | HA long-lived access token |

### Battery sensors (from HA / SolarSynk integration)

| Option | Env var | Default | Description |
|---|---|---|---|
| `ha_battery_soc_entity` | `HA_BATTERY_SOC_ENTITY` | `sensor.solarsynkv3_…_battery_bms_soc` | Battery state-of-charge (%) |
| `ha_battery_voltage_entity` | `HA_BATTERY_VOLTAGE_ENTITY` | `sensor.solarsynkv3_…_battery_voltage` | Battery voltage (V) |
| `ha_battery_max_current_entity` | `HA_BATTERY_MAX_CURRENT_ENTITY` | `sensor.solarsynkv3_…_batterymaxcurrentcharge` | Max charge current (A) |
| `ha_battery_capacity_ah_entity` | `HA_BATTERY_CAPACITY_AH_ENTITY` | `sensor.solarsynkv3_…_battery_capacity` | Battery capacity (Ah) |

> Battery capacity and charge rate are calculated live as `voltage × Ah` and `voltage × maxCurrent ÷ 2`. The `battery_capacity_wh` and `battery_fill_rate_wh` values below are used as fallbacks only if the HA sensors are unavailable.

### Battery parameters

| Option | Env var | Default | Description |
|---|---|---|---|
| `battery_capacity_wh` | `BATTERY_CAPACITY_WH` | `10000` | Battery capacity fallback (Wh) |
| `battery_fill_rate_wh` | `BATTERY_FILL_RATE_WH` | `2000` | Charge added per 30-min slot fallback (Wh) |
| `battery_round_trip_efficiency` | `BATTERY_ROUND_TRIP_EFFICIENCY` | `0.9` | Round-trip efficiency (0–1). 0.9 = 90% — accounts for losses when charging and discharging. Affects how many slots are needed and the export rate break-even calculation. |

### Octopus import tariff

| Option | Env var | Default | Description |
|---|---|---|---|
| `octopus_product` | `OCTOPUS_PRODUCT` | `AGILE-24-04-03` | Octopus import product code |
| `octopus_tariff` | `OCTOPUS_TARIFF` | `E-1R-AGILE-24-04-03-G` | Octopus import tariff code (suffix is region: G = South West) |
| `standard_tariff_pence` | `STANDARD_TARIFF_PENCE` | `24` | Your non-Agile standard unit rate (p/kWh), used to calculate savings vs a flat tariff |

### Export tariff

Configure either a fixed rate schedule or Outgoing Agile (or both — Outgoing Agile takes precedence).

| Option | Env var | Default | Description |
|---|---|---|---|
| `export_tariff_schedule` | `EXPORT_TARIFF_SCHEDULE` | `""` | Fixed export rate schedule. Format: `"RATE:YYYY-MM-DD,RATE:YYYY-MM-DD,…"`. The active rate is the one whose date is the latest on or before today. Example: `"15:2024-01-01,10:2026-04-01"` means 15p until April 2026, then 10p. |
| `octopus_export_product` | `OCTOPUS_EXPORT_PRODUCT` | `""` | Outgoing Agile product code (leave blank if not on Outgoing Agile) |
| `octopus_export_tariff` | `OCTOPUS_EXPORT_TARIFF` | `""` | Outgoing Agile tariff code |

When an export rate is configured, the optimizer only imports grid energy cheaper than the break-even point: `importPrice < exportRate × efficiency`. Paying more than the break-even means the effective stored cost exceeds what you'd earn by exporting instead.

### Solar forecast (Solcast)

| Option | Env var | Default | Description |
|---|---|---|---|
| `solcast_api_key` | `SOLCAST_API_KEY` | — | Solcast API key |
| `solcast_sites` | `SOLCAST_SITES` | — | Comma-separated Solcast site IDs (one per array, e.g. `"abc-123,def-456"`) |
| `forecast_fetch_times` | `FORECAST_FETCH_TIMES` | `06:00,12:00` | Daily times to refresh Solcast forecasts (keeps within 10 calls/day quota) |
| `forecast_confidence_factor` | `FORECAST_CONFIDENCE_FACTOR` | `0.3` | How much to lean towards the pessimistic (p10) forecast on uncertain days. `0` = always use p50, `1` = fully weight by p10/p90 spread. |

### House consumption

| Option | Env var | Default | Description |
|---|---|---|---|
| `ha_load_daily_entity` | `HA_LOAD_DAILY_ENTITY` | `sensor.solarsynkv3_…_load_daily_used` | Daily load entity used to build a per-slot consumption profile from history |
| `consumption_average_days` | `CONSUMPTION_AVERAGE_DAYS` | `7` | Number of days of history to average for the consumption profile |
| `avg_consumption_wh` | `AVG_CONSUMPTION_WH` | `500` | Fallback house consumption per 30-min slot (Wh) if HA history is unavailable |

### Heat pump (optional)

If configured, the optimizer builds a model of heat pump power vs outdoor temperature and adjusts expected consumption up or down based on today's weather forecast.

| Option | Env var | Default | Description |
|---|---|---|---|
| `ha_heat_pump_entity` | `HA_HEAT_PUMP_ENTITY` | `""` | Heat pump energy entity (kWh daily, e.g. from Homely/Vaillant integration) |
| `ha_outdoor_temp_entity` | `HA_OUTDOOR_TEMP_ENTITY` | `""` | Outdoor temperature entity (°C) — used to correlate heat pump load with temperature |

### EV charging (optional)

| Option | Env var | Default | Description |
|---|---|---|---|
| `ha_ev_charger_entity` | `HA_EV_CHARGER_ENTITY` | `""` | EV charger power entity (kW). If the charger is actively drawing power, the optimizer projects the charge load from now to peak and adds it to house usage. |

### Timing

| Option | Env var | Default | Description |
|---|---|---|---|
| `peak_hour` | `PEAK_HOUR` | `16` | Hour battery should be full by (local time, 24h). Typically the start of the Agile evening peak. |
| `min_charge_floor_pence` | `MIN_CHARGE_FLOOR_PENCE` | `10` | Minimum price threshold (p/kWh). Set to `0` to allow the threshold to drop to zero. Set negative to capture negative-price slots even when the battery is full. |

> **Note:** Passwords or API keys containing special characters (`#`, `&`, `!`) must be quoted in `.env`: `SUNSYNK_PASS="my#password"`

---

## Local / Development Setup

### 1. Clone and install

```bash
git clone https://github.com/programminggiantpanda/sunsynk-optimizer.git
cd sunsynk-optimizer
npm install
```

### 2. Create your `.env` file

```bash
cp .env.example .env
```

Edit `.env` with your credentials and site IDs.

### 3. Run

```bash
# Run with ts-node (no build step required)
npm run dev

# Or build first and run compiled output
npm run build
npm start
```

You should see output like:

```
[optimizer] Starting Sunsynk Battery Optimizer
[optimizer] Peak hour: 16:00
[optimizer] Authenticated with Sunsynk
[optimizer] Using plant: My Home (id=414684)
[optimizer] Fetching solar forecasts from Solcast (2 site(s))…
[optimizer] Forecasts updated: 48 merged slots
[optimizer] Fixed export rate: 15p/kWh
[optimizer] Battery: 52.1V × 200Ah = 10420 Wh capacity, fill rate 2605 Wh/slot
[calculator] Battery 65%, batteryToFill=3647 Wh, pvTotal=8200 Wh (p50=9100, adj=-9.9%), houseUsage=3500 Wh, surplus=4700 Wh, blocks=0, threshold=10p, eff=90%, exportRate=15p (break-even=13.5p, 6 import candidates)
[2026-03-04T08:00:00.000Z] Set min charge threshold to 10p (battery 65%)
[optimizer] HA sensors updated
```

### 4. Run tests

```bash
npm test
```

---

## Home Assistant Add-on Installation

### 1. Add the repository

In Home Assistant, go to **Settings → Add-ons → Add-on Store → ⋮ → Repositories** and add:

```
https://github.com/programminggiantpanda/sunsynk-optimizer
```

### 2. Install the add-on

Find **Sunsynk Optimizer** in the add-on store and click **Install**.

### 3. Configure

Go to the add-on **Configuration** tab and fill in your credentials and site IDs.

### 4. Start

Click **Start**. Check the **Log** tab to confirm it is running correctly.

---

## HA Sensors

After each price update the following sensors are written to Home Assistant:

| Entity | Unit | Description |
|---|---|---|
| `sensor.sunsynk_optimizer_threshold` | p/kWh | Charge threshold set on Sunsynk |
| `sensor.sunsynk_optimizer_lowest_price` | £/kWh | Cheapest Agile slot in window |
| `sensor.sunsynk_optimizer_pv_total` | Wh | PV forecast to peak (confidence-adjusted) |
| `sensor.sunsynk_optimizer_pv_total_p50` | Wh | PV forecast to peak (raw p50, for comparison) |
| `sensor.sunsynk_optimizer_house_usage` | Wh | Estimated house consumption to peak |
| `sensor.sunsynk_optimizer_battery_watts` | Wh | Current battery charge |
| `sensor.sunsynk_optimizer_battery_to_fill` | Wh | Grid import needed (accounting for solar) |
| `sensor.sunsynk_optimizer_battery_to_fill_no_pv` | Wh | Grid import needed (ignoring solar) |
| `sensor.sunsynk_optimizer_surplus` | Wh | Solar surplus to peak |
| `sensor.sunsynk_optimizer_blocks` | — | Number of 30-min charging slots to buy |
| `sensor.sunsynk_optimizer_results` | — | Agile slots in window (full slot data in attributes) |
| `sensor.sunsynk_optimizer_actual_cost` | p | Planned grid charge cost at Agile prices |
| `sensor.sunsynk_optimizer_peak_slot_price` | p/kWh | Agile price at peak hour (reference price) |
| `sensor.sunsynk_optimizer_daily_saving_vs_peak` | p | Saving today vs buying all energy at peak-hour Agile price |
| `sensor.sunsynk_optimizer_daily_saving_vs_standard` | p | Saving today vs buying at the configured standard tariff rate |
| `sensor.sunsynk_optimizer_daily_pv_saving` | p | Saving today from solar reducing grid imports |
| `sensor.sunsynk_optimizer_ev_load` | Wh | Estimated EV charge load to peak (only present when charging) |
| `sensor.sunsynk_optimizer_export_rate` | p/kWh | Effective export rate in use (only present when configured) |
| `sensor.sunsynk_optimizer_hp_adjustment` | Wh | Heat pump load adjustment vs historical (only present when configured) |
| `sensor.sunsynk_optimizer_slot_profile` | Wh | Total daily consumption profile (only present when HA history available) |

---

## How the Algorithm Works

### 1. Window

All calculations run from now until `peak_hour` (e.g. 16:00), the period before the expensive evening peak. If peak hour has already passed today, the window extends to tomorrow's peak.

### 2. PV forecast

Solcast p50 (median) estimates are summed across all 30-min slots in the window. On uncertain days (wide p10–p90 band), the estimate is adjusted down towards p10 according to `forecast_confidence_factor`. This prevents over-relying on solar on cloudy days.

### 3. House usage

A per-slot consumption profile is built from `consumption_average_days` of HA history. If a heat pump entity is configured, expected consumption is adjusted up or down based on how today's forecast temperature differs from the historical average for each slot. If no history is available, `avg_consumption_wh` is used as a flat fallback.

### 4. EV load

If an EV charger entity is configured and the charger is actively drawing power, the optimizer projects `chargePower × hoursTopeak` Wh as additional house load. This conservatively assumes charging continues at the current rate until peak.

### 5. Surplus and battery to fill

```
surplus          = pvTotal − houseUsage
batteryToFill    = capacity − currentCharge − max(surplus, 0)
```

If solar will more than cover house usage, the surplus reduces how much grid import is needed. A negative surplus (more house usage than solar) increases the amount needed.

### 6. Charging blocks

```
blocks = ceil(batteryToFill / (fillRatePerSlot × roundTripEfficiency))
```

Because not all imported energy is recoverable from the battery (conversion losses), more grid slots are needed than a naive calculation would suggest. At 90% efficiency, storing 5 kWh requires importing 5 ÷ 0.9 = 5.56 kWh.

### 7. Export rate filtering

If an export rate is configured, only grid slots cheaper than the break-even price are considered:

```
break-even = exportRate × roundTripEfficiency
```

Importing above the break-even means the effective cost per stored kWh exceeds the export income you'd forgo, making it uneconomic. For example at 15p export and 90% efficiency, break-even = 13.5p — importing at 14p would cost 14 ÷ 0.9 = 15.6p effective, worse than exporting.

### 8. Threshold

The Agile slots are sorted cheapest-first and the `blocks`-th cheapest qualifying slot sets the threshold. The Sunsynk inverter charges from the grid whenever the live Agile price is below this threshold.

### 9. Negative prices

If any slot in the window has a negative price (you are paid to use electricity), the optimizer always includes at least one charging slot regardless of battery level.

---

## Project Structure

```
src/
  index.ts                  SunsynkClient — auth, getPlants, setMinCharge
  optimizer/
    index.ts                Main entry point — wires everything together
    config.ts               Loads /data/options.json (HA) or .env (dev)
    solcast.ts              Fetches and caches Solcast rooftop forecasts
    octopus.ts              Fetches Octopus Agile rates; fixed export rate parser
    calculator.ts           Core optimisation algorithm
    scheduler.ts            Daily time scheduler + Agile-aligned interval runner
    homeassistant.ts        HA REST API client (sensors, notifications, slot profiles)
    heatpump.ts             Heat pump model: consumption vs temperature regression
    openmeteo.ts            Weather forecast fetcher (Open-Meteo, no API key needed)
    __tests__/
      calculator.test.ts    Unit tests for the core algorithm
      octopus.test.ts       Unit tests for export rate parsing
      solcast.test.ts       Unit tests for forecast cache logic
      homeassistant.test.ts Unit tests for HA notification helpers
addon/
  config.yaml               HA add-on manifest and schema
  Dockerfile                Builds and runs the optimizer on node:20-alpine
```
