# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added
- Daily accumulators persisted to `daily_accumulators.json` — restored on startup so mid-day restarts no longer wipe HA daily saving sensors (closes #14)
- Weekly and monthly savings accumulators persisted to `savings_history.json`; exposed as `sensor.sunsynk_optimizer_weekly/monthly_saving_vs_standard` and `weekly/monthly_export_income` (closes #19)
- Configurable plant ID via `sunsynk_plant_id` / `SUNSYNK_PLANT_ID` — targets a specific Sunsynk plant by ID; falls back to `plants[0]` (closes #18)
- Optional `expensive_threshold_percentile` config — computes `expensiveThresholdPence` dynamically each price update as the Nth percentile of all available Agile rates (closes #21)
- Carbon intensity integration — optional `carbon_intensity_weight` and `carbon_intensity_region_id` config; fetches National Grid ESO forecasts and blends carbon intensity into import slot scoring (closes #22)
- CO₂ saving sensors: `sensor.sunsynk_optimizer_daily/weekly/monthly_co2_saved` (gCO₂) — estimated carbon saved by shifting energy from expensive high-carbon peak slots to cheap lower-carbon slots. Carbon intensity is always fetched (free API, no auth) regardless of whether weighting is enabled.

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

[Unreleased]: https://github.com/TheProgrammingGiantPanda/sunsynk-optimizer/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/TheProgrammingGiantPanda/sunsynk-optimizer/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/TheProgrammingGiantPanda/sunsynk-optimizer/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/TheProgrammingGiantPanda/sunsynk-optimizer/releases/tag/v1.0.0
