# Sunsynk Battery Optimizer

A Home Assistant add-on (and standalone Node.js app) that automatically optimises Sunsynk battery charging using **Octopus Agile** electricity prices and **Solcast** solar forecasts.

Every 30 minutes it:
1. Reads the current battery state-of-charge from Home Assistant
2. Fetches the latest Octopus Agile half-hourly prices
3. Uses the Solcast solar forecast to estimate how much PV generation is expected before the peak period
4. Calculates the cheapest grid import slots needed to fill the battery before peak
5. Sets the Sunsynk minimum charge threshold via the Sunsynk API
6. Publishes all intermediate values back to Home Assistant as sensors

Solar forecasts are fetched from Solcast at scheduled times (default 06:00 and 12:00) to stay within the hobbyist API quota of 10 calls per day.

---

## Requirements

- A Sunsynk (or Deye) inverter with a portal account at [sunsynk.net](https://www.sunsynk.net)
- [Octopus Energy](https://octopus.energy) Agile tariff
- [Solcast](https://solcast.com) hobbyist account with rooftop site(s) configured
- Home Assistant with the [SolarSynk v3](https://github.com/erikarenhill/solarsynk-homeassistant) integration installed (provides battery SOC and other sensors)
- Node.js 20+ (for local/dev use) or Home Assistant with the add-on supervisor (for production)

---

## Configuration

All options can be set either via the Home Assistant add-on UI (stored in `/data/options.json`) or via a `.env` file for local development.

| Option | Env var | Default | Description |
|---|---|---|---|
| `sunsynk_username` | `SUNSYNK_USER` | — | Sunsynk portal email |
| `sunsynk_password` | `SUNSYNK_PASS` | — | Sunsynk portal password |
| `ha_url` | `HA_URL` | `http://homeassistant.local:8123` | Home Assistant base URL |
| `ha_token` | `HA_TOKEN` | — | HA long-lived access token |
| `ha_battery_soc_entity` | `HA_BATTERY_SOC_ENTITY` | `sensor.solarsynkv3_2310140043_battery_bms_soc` | Battery state-of-charge entity |
| `ha_battery_voltage_entity` | `HA_BATTERY_VOLTAGE_ENTITY` | `sensor.solarsynkv3_2310140043_battery_voltage` | Battery voltage entity (V) |
| `ha_battery_max_current_entity` | `HA_BATTERY_MAX_CURRENT_ENTITY` | `sensor.solarsynkv3_2310140043_batterymaxcurrentcharge` | Max charge current entity (A) |
| `ha_battery_capacity_ah_entity` | `HA_BATTERY_CAPACITY_AH_ENTITY` | `sensor.solarsynkv3_2310140043_battery_capacity` | Battery capacity entity (Ah) |
| `solcast_api_key` | `SOLCAST_API_KEY` | — | Solcast API key |
| `solcast_site_pv1` | `SOLCAST_SITE_PV1` | — | Solcast site ID for PV array 1 |
| `solcast_site_pv2` | `SOLCAST_SITE_PV2` | — | Solcast site ID for PV array 2 |
| `octopus_product` | `OCTOPUS_PRODUCT` | `AGILE-24-04-03` | Octopus product code |
| `octopus_tariff` | `OCTOPUS_TARIFF` | `E-1R-AGILE-24-04-03-G` | Octopus tariff code (G = South West) |
| `battery_capacity_wh` | `BATTERY_CAPACITY_WH` | `10000` | Battery capacity fallback (Wh) |
| `battery_fill_rate_wh` | `BATTERY_FILL_RATE_WH` | `2000` | Charge added per 30-min slot fallback (Wh) |
| `avg_consumption_wh` | `AVG_CONSUMPTION_WH` | `500` | Average house consumption per 30-min slot (Wh) |
| `peak_hour` | `PEAK_HOUR` | `16` | Hour battery should be full by (local time, 24h) |
| `min_charge_floor_pence` | `MIN_CHARGE_FLOOR_PENCE` | `0` | Minimum price threshold — set to 0 to capture negative prices |
| `forecast_fetch_times` | `FORECAST_FETCH_TIMES` | `06:00,12:00` | Daily times to refresh Solcast forecasts |
| `price_interval_minutes` | `PRICE_INTERVAL_MINUTES` | `30` | How often to recalculate and update Sunsynk (minutes) |

> **Note:** Battery capacity and charge rate are calculated automatically from live HA sensor values (`voltage × Ah` and `voltage × maxCurrent ÷ 2`). The `BATTERY_CAPACITY_WH` and `BATTERY_FILL_RATE_WH` values are only used as fallbacks if the HA sensors are unavailable.

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

Edit `.env` with your credentials and site IDs. See the configuration table above for all options.

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
[optimizer] Fetching solar forecasts from Solcast…
[optimizer] Battery: 52.1V × 200Ah = 10420 Wh capacity, fill rate 2605 Wh/slot
[calculator] Battery 65%, batteryToFill=3647 Wh, pvTotal=8200 Wh, houseUsage=3500 Wh, surplus=4700 Wh, blocks=0, threshold=0p
[2026-03-04T08:00:00.000Z] Set min charge threshold to 0p (battery 65%)
[optimizer] HA sensors updated
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
| `sensor.sunsynk_optimizer_pv_total` | Wh | Combined PV forecast to peak |
| `sensor.sunsynk_optimizer_pv1_total` | Wh | PV array 1 forecast to peak |
| `sensor.sunsynk_optimizer_pv2_total` | Wh | PV array 2 forecast to peak |
| `sensor.sunsynk_optimizer_house_usage` | Wh | Estimated house consumption to peak |
| `sensor.sunsynk_optimizer_battery_watts` | Wh | Current battery charge |
| `sensor.sunsynk_optimizer_battery_to_fill` | Wh | Grid import needed (accounting for solar) |
| `sensor.sunsynk_optimizer_battery_to_fill_no_pv` | Wh | Grid import needed (ignoring solar) |
| `sensor.sunsynk_optimizer_surplus` | Wh | Solar surplus to peak |
| `sensor.sunsynk_optimizer_blocks` | — | Number of 30-min charging slots to buy |
| `sensor.sunsynk_optimizer_results` | — | Agile slots in window (full data in attributes) |

---

## How the Algorithm Works

1. **Window**: from now until `peak_hour` (e.g. 16:00), representing the period before the expensive evening peak.
2. **PV forecast**: Solcast estimates are summed across all 30-min slots in the window.
3. **House usage**: estimated as `avg_consumption_wh` × number of slots in window.
4. **Surplus**: `pvTotal − houseUsage`. If positive, solar will partially charge the battery for free.
5. **Battery to fill**: `capacity − currentCharge − surplus`. This is how much grid import is needed.
6. **Charging blocks**: `ceil(batteryToFill / fillRatePerSlot)` — number of cheap slots to buy.
7. **Threshold**: the price of the most expensive slot we are willing to buy, taken from the cheapest-first sorted Agile rates. The Sunsynk inverter will charge from the grid any time the live Agile price is below this threshold.
8. **Negative prices**: if any slot in the window has a negative price (you are paid to use electricity), the optimizer always includes it regardless of battery charge level.

---

## Project Structure

```
src/
  index.ts                  SunsynkClient — auth, getPlants, setMinCharge
  optimizer/
    index.ts                Main entry point — wires everything together
    config.ts               Loads /data/options.json (HA) or .env (dev)
    solcast.ts              Fetches Solcast rooftop forecasts
    octopus.ts              Fetches Octopus Agile half-hourly rates
    calculator.ts           Core optimisation algorithm
    scheduler.ts            Daily time scheduler and interval runner
    homeassistant.ts        HA REST API client (read sensors, write states)
addon/
  config.yaml               HA add-on manifest
  Dockerfile                Builds and runs the optimizer on node:20-alpine
```
