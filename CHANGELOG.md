# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [1.7.3] - 2026-03-06

### Added
- `sensor.sunsynk_optimizer_current_price` (p/kWh) — live Agile import price for the active 30-min slot, shown in the Overview glance card and thresholds history graph

### Fixed
- Restored accumulator files missing `actualGridCostPence` (written before v1.7.2) caused `NaN` to be sent to HA, failing the sensor write; field is now defaulted to `0` on restore

## [1.7.2] - 2026-03-06

### Added
- `sensor.sunsynk_optimizer_daily_actual_grid_cost` (p) — tracks actual grid import cost today by accumulating `Δ kWh × current Agile rate` each price update cycle; requires `ha_grid_import_daily_entity` to be configured

## [1.7.1] - 2026-03-05

### Added
- Startup banner printed to logs with version number

## [1.7.0] - 2026-03-05

### Added
- TOU (Time-of-Use) tariff support — configurable `tou_rates` array of `{ from, to, pence }` entries to model fixed time-of-use import tariffs as an alternative to Agile
- Lovelace dashboard template (`lovelace-dashboard.yaml`) with Overview, Savings, and System views using the sections layout (#30)

### Fixed
- Dashboard switched to sections layout for better horizontal space usage
- Clarified `friendly_name` for horizon-based sensors (`pv_total`, `house_usage`, etc.)

## [1.6.2] - 2026-03-05

### Fixed
- Widen Solcast slot matching tolerance to 5 minutes to handle minor timestamp drift between forecast and local time

## [1.6.1] - 2026-03-04

### Fixed
- Update Carbon Intensity API endpoints to current National Grid ESO URLs

## [1.6.0] - 2026-03-04

### Added
- Self-sufficiency ratio sensors: `sensor.sunsynk_optimizer_daily/weekly/monthly_self_sufficiency` (%) — grid import vs total consumption; requires `ha_grid_import_daily_entity` (#28)

## [1.5.0] - 2026-03-04

### Added
- Solcast forecast accuracy tracking — compares each day's P50 forecast against actual generation; stores rolling history in `solcast_accuracy.json`
- MAPE sensors: `sensor.sunsynk_optimizer_forecast_accuracy_7d` and `forecast_accuracy_30d`
- Auto-tune confidence factor — adjusts `forecastConfidenceFactor` based on recent MAPE to reduce systematic over/under-estimation (#26)

## [1.4.0] - 2026-03-04

### Added
- HA persistent notification when any Agile slot price goes negative, with slot details (#25)

## [1.3.0] - 2026-03-04

### Added
- Auto-calibrate average consumption from HA history — reads `haLoadDailyEntity` over a configurable rolling window and derives per-slot Wh; falls back to `avgConsumptionWh` config value if insufficient history (#24)
- `sensor.sunsynk_optimizer_avg_consumption_wh` exposes the effective value and its source (`history` or `config`)

## [1.2.0] - 2026-03-04

### Added
- Dynamic minimum SOC — raises `minDischargeSoc` to `backupMinSoc` when tomorrow's P50 solar forecast is below `lowSolarThresholdWh`, preserving overnight reserve on low-solar days (#23)

## [1.1.1] - 2026-03-04

### Added
- Daily accumulators persisted to `daily_accumulators.json` — restored on startup so mid-day restarts no longer wipe HA daily saving sensors (closes #14)
- Weekly and monthly savings accumulators persisted to `savings_history.json`; exposed as `sensor.sunsynk_optimizer_weekly/monthly_saving_vs_standard` and `weekly/monthly_export_income` (closes #19)
- Configurable plant ID via `sunsynk_plant_id` / `SUNSYNK_PLANT_ID` — targets a specific Sunsynk plant by ID; falls back to `plants[0]` (closes #18)
- Optional `expensive_threshold_percentile` config — computes `expensiveThresholdPence` dynamically each price update as the Nth percentile of all available Agile rates (closes #21)
- Carbon intensity integration — optional `carbon_intensity_weight` and `carbon_intensity_region_id` config; fetches National Grid ESO forecasts and blends carbon intensity into import slot scoring (closes #22)
- CO₂ saving sensors: `sensor.sunsynk_optimizer_daily/weekly/monthly_co2_saved` (gCO₂) — estimated carbon saved by shifting load to cheap lower-carbon slots. Carbon intensity is always fetched (free API, no auth) regardless of whether weighting is enabled.

### Changed
- HA sensor writes now use `Promise.allSettled` — individual failures are logged by sensor name and do not suppress other writes (closes #16)
- `sell_threshold`, `exportable_wh`, `export_slot_count`, and `export_income` sensors are now written unconditionally every price update (0 when export is inactive), preventing stale values in HA (closes #17)
- `setMinCharge` is skipped when both threshold and sell threshold are unchanged from the previous run, reducing unnecessary Sunsynk API calls (closes #15)

## [1.1.0] - 2026-03-04

### Added
- Aggressive charging during negative Agile price slots — always charge at negative slots the battery can absorb, even when the battery would otherwise be considered full (closes #13)
- Daily export income accumulator (`sensor.sunsynk_optimizer_daily_export_income`) — resets at midnight alongside existing daily saving sensors (closes #12)
- `limitSoc` written to direction=0 product on every update to protect battery health (closes #11)
- Octopus Agile rate disk cache — import rates are saved to `/data/agile_cache.json` and reused on API failure (closes #10)
- Automatic token re-authentication on 401 — axios interceptor re-calls `login()` and retries the original request without requiring a service restart (closes #9)

### Fixed
- Battery round-trip efficiency now applied correctly to PV surplus and opportunistic fill calculations

## [1.0.1] - 2026-02-28

### Fixed
- Use `FROM node:20-alpine` directly in Dockerfile — HA base images use s6-overlay which is incompatible with a direct `node` CMD
- Copy `src/` and `tsconfig.json` before `npm ci` so the `prepare` script (which compiles TypeScript) can run during install
- Install Node.js and npm via `apk` — HA base images do not include Node.js
- Move `config.yaml` and `Dockerfile` to repo root so the Docker build context includes the `src/` directory
- Install dev dependencies before build, then prune them after to keep image size small

## [1.0.0] - 2026-02-24

### Added
- Core battery optimiser: fetches Octopus Agile rates, Solcast solar forecasts, and battery SOC from Home Assistant; sets Sunsynk import threshold via the Sunsynk API
- Price-driven algorithm — splits Agile slots into expensive (≥ `expensiveThresholdPence`) and cheap; fills battery to capacity using cheapest available slots
- Outgoing Agile export tariff support — plans battery-to-grid sales, sets sell threshold on direction=0 product (closes #4)
- Fixed export tariff schedule support (e.g. SEG) with date-based rate switching
- EV charging load integration — estimates EV energy demand and adds it to battery fill requirement (closes #6)
- Cost savings sensors: daily saving vs peak Agile, vs standard tariff, and from solar generation (closes #5)
- HA persistent notifications on critical errors (failed SOC read, failed `setMinCharge`); auto-dismissed on recovery (closes #7)
- Solcast forecast disk cache — survives 429 rate-limit errors; uses cache on restart if <24 h old (closes #8)
- Solcast p10/p90 confidence-weighted PV estimate via `forecastConfidenceFactor` config (closes #1)
- Agile price updates aligned to half-hour slot boundaries (:02 and :32) (closes #2)
- Per-slot consumption profile built from HA history (`haLoadDailyEntity`) over configurable rolling window
- Heat pump temperature sensitivity model — adjusts per-slot consumption forecast based on outdoor temperature via linear regression
- Multiple Solcast PV string support via comma-separated `SOLCAST_SITES`
- Retry logic with exponential backoff on all external API calls (no retry on 4xx)
- Startup config validation with clear error messages for missing or invalid values
- Timestamp prefix on all log output
- `repository.json` for Home Assistant add-on store compatibility
- `sensor.sunsynk_optimizer_slot_profile` and `sensor.sunsynk_optimizer_hp_adjustment` HA sensors

[1.7.3]: https://github.com/TheProgrammingGiantPanda/sunsynk-optimizer/compare/v1.7.2...v1.7.3
[1.7.2]: https://github.com/TheProgrammingGiantPanda/sunsynk-optimizer/compare/v1.7.1...v1.7.2
[1.7.1]: https://github.com/TheProgrammingGiantPanda/sunsynk-optimizer/compare/v1.7.0...v1.7.1
[1.7.0]: https://github.com/TheProgrammingGiantPanda/sunsynk-optimizer/compare/v1.6.2...v1.7.0
[1.6.2]: https://github.com/TheProgrammingGiantPanda/sunsynk-optimizer/compare/v1.6.1...v1.6.2
[1.6.1]: https://github.com/TheProgrammingGiantPanda/sunsynk-optimizer/compare/v1.6.0...v1.6.1
[1.6.0]: https://github.com/TheProgrammingGiantPanda/sunsynk-optimizer/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/TheProgrammingGiantPanda/sunsynk-optimizer/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/TheProgrammingGiantPanda/sunsynk-optimizer/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/TheProgrammingGiantPanda/sunsynk-optimizer/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/TheProgrammingGiantPanda/sunsynk-optimizer/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/TheProgrammingGiantPanda/sunsynk-optimizer/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/TheProgrammingGiantPanda/sunsynk-optimizer/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/TheProgrammingGiantPanda/sunsynk-optimizer/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/TheProgrammingGiantPanda/sunsynk-optimizer/releases/tag/v1.0.0
