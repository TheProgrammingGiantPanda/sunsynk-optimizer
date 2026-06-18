import fs from 'fs';
import path from 'path';
import { getEntityState, setState } from './homeassistant';

const DATA_DIR = fs.existsSync('/data') ? '/data' : process.cwd();
const EV_STATE_PATH = path.join(DATA_DIR, 'ev_state.json');

interface EvState {
  lastFullChargeDate: string; // YYYY-MM-DD
}

export function loadEvState(): EvState {
  try {
    return JSON.parse(fs.readFileSync(EV_STATE_PATH, 'utf-8'));
  } catch {
    return { lastFullChargeDate: '' };
  }
}

export function saveEvState(state: EvState): void {
  try {
    fs.writeFileSync(EV_STATE_PATH, JSON.stringify(state), 'utf-8');
  } catch (err) {
    console.warn('[ev] Failed to persist EV state:', err);
  }
}

export interface EvConfig {
  haUrl: string;
  haToken: string;
  haEvBatterySocEntity: string;    // sensor for Leaf battery %
  haEvChargerSwitchEntity: string; // switch to turn charger on/off
  haEvPluggedInEntity: string;     // binary_sensor or sensor indicating EV is plugged in
  evBatteryCapacityWh: number;     // e.g. 40000 (40 kWh Leaf)
  evChargeRateW: number;           // e.g. 7000 (7 kW Go2Pro)
  evDailyMaxSoc: number;           // e.g. 80 (%)
  evFullChargeIntervalDays: number; // e.g. 14
}

export interface EvDemand {
  evSocPct: number;
  targetSoc: number;
  evDemandWh: number;   // energy needed to reach target SOC
  chargeRateW: number;
  pluggedIn: boolean;
}

export interface EvDecision {
  shouldCharge: boolean;
  evSocPct: number;
  targetSoc: number;
  evDemandWh: number;
  chargeRateW: number;
  pluggedIn: boolean;
  reason: string;
}

/**
 * Pure function: compute the target SOC based on last full charge date and interval.
 */
export function computeTargetSoc(
  lastFullChargeDate: string,
  fullChargeIntervalDays: number,
  dailyMaxSoc: number,
  now: Date = new Date()
): { targetSoc: number; daysSinceFullCharge: number; isDueFullCharge: boolean } {
  const daysSinceFullCharge = lastFullChargeDate
    ? Math.floor((now.getTime() - new Date(lastFullChargeDate + 'T00:00:00Z').getTime()) / 86400000)
    : Infinity;

  const isDueFullCharge = daysSinceFullCharge >= fullChargeIntervalDays;
  const targetSoc = isDueFullCharge ? 100 : dailyMaxSoc;

  return { targetSoc, daysSinceFullCharge, isDueFullCharge };
}

/**
 * Pure function: compute EV energy demand in Wh.
 */
export function computeEvDemandWh(
  evSocPct: number,
  targetSoc: number,
  batteryCapacityWh: number
): number {
  const deficit = Math.max(0, targetSoc - evSocPct);
  return Math.round((deficit / 100) * batteryCapacityWh);
}

/**
 * Pure function: decide whether the EV charger should be on or off.
 */
export function computeEvDecision(
  evSocPct: number,
  targetSoc: number,
  pluggedIn: boolean,
  currentPricePence: number | null,
  isChargeSlot: boolean,
): { shouldCharge: boolean; reason: string } {
  if (!pluggedIn) {
    return { shouldCharge: false, reason: 'EV not plugged in' };
  }

  const isNegativePrice = currentPricePence !== null && currentPricePence < 0;
  const evNeedsCharge = evSocPct < targetSoc;

  if (isNegativePrice && evSocPct < 100) {
    return {
      shouldCharge: true,
      reason: `negative price (${currentPricePence!.toFixed(1)}p) — charging to 100%`,
    };
  }

  if (isChargeSlot && evNeedsCharge) {
    return {
      shouldCharge: true,
      reason: `cheap slot, SOC ${evSocPct}% < target ${targetSoc}%`,
    };
  }

  if (!evNeedsCharge) {
    return {
      shouldCharge: false,
      reason: `SOC ${evSocPct}% >= target ${targetSoc}% — not charging`,
    };
  }

  return { shouldCharge: false, reason: 'slot not cheap enough — skipping EV charge' };
}

/**
 * Read the plugged-in state from HA. Handles both binary_sensor (on/off)
 * and numeric sensor (0/1) styles. Returns true if plugged in.
 */
async function isEvPluggedIn(haUrl: string, haToken: string, entityId: string): Promise<boolean> {
  if (!entityId) return true; // no entity configured — assume plugged in
  try {
    const val = await getEntityState(haUrl, haToken, entityId);
    // numeric: 1 = plugged in, 0 = not
    return val >= 1;
  } catch {
    // binary_sensor returns "on"/"off" which getEntityState (parseFloat) can't handle.
    // Fall back to raw state string check.
    try {
      const axios = (await import('axios')).default;
      const res = await axios.get(`${haUrl}/api/states/${entityId}`, {
        headers: { Authorization: `Bearer ${haToken}` },
        timeout: 10000,
      });
      const state = String(res.data?.state).toLowerCase();
      return state === 'on' || state === 'true' || state === 'connected' || state === 'plugged_in';
    } catch (err) {
      console.warn(`[ev] Failed to read plugged-in entity ${entityId}, assuming not plugged in:`, err);
      return false;
    }
  }
}

/**
 * Compute how much energy the EV needs to reach its target SOC.
 * Called BEFORE the calculator so the demand is factored into slot planning.
 */
export async function getEvDemand(evConfig: EvConfig): Promise<EvDemand> {
  const evSocPct = await getEntityState(evConfig.haUrl, evConfig.haToken, evConfig.haEvBatterySocEntity);
  const pluggedIn = await isEvPluggedIn(evConfig.haUrl, evConfig.haToken, evConfig.haEvPluggedInEntity);

  const evState = loadEvState();
  const { targetSoc } = computeTargetSoc(
    evState.lastFullChargeDate,
    evConfig.evFullChargeIntervalDays,
    evConfig.evDailyMaxSoc
  );

  const evDemandWh = pluggedIn ? computeEvDemandWh(evSocPct, targetSoc, evConfig.evBatteryCapacityWh) : 0;

  console.log(`[ev] SOC ${evSocPct}%, target ${targetSoc}%, plugged in: ${pluggedIn}, demand ${evDemandWh} Wh`);

  return { evSocPct, targetSoc, evDemandWh, chargeRateW: evConfig.evChargeRateW, pluggedIn };
}

/**
 * Decide whether the EV charger should be on or off for the current slot,
 * then call HA to flip the switch and publish sensor states.
 * Called AFTER the calculator, using the pre-computed demand.
 */
export async function updateEvCharger(
  evConfig: EvConfig,
  evDemand: EvDemand,
  currentPricePence: number | null,
  isChargeSlot: boolean,
): Promise<EvDecision> {
  const { haUrl, haToken } = evConfig;
  const { evSocPct, targetSoc, pluggedIn } = evDemand;

  const { shouldCharge, reason } = computeEvDecision(
    evSocPct, targetSoc, pluggedIn, currentPricePence, isChargeSlot
  );

  // Track when we reach 100% for the full-charge interval
  const evState = loadEvState();
  const { isDueFullCharge } = computeTargetSoc(
    evState.lastFullChargeDate,
    evConfig.evFullChargeIntervalDays,
    evConfig.evDailyMaxSoc
  );
  if (evSocPct >= 100 && isDueFullCharge) {
    evState.lastFullChargeDate = new Date().toISOString().slice(0, 10);
    saveEvState(evState);
    console.log(`[ev] Full charge completed — next full charge due in ${evConfig.evFullChargeIntervalDays} days`);
  }

  // Control the charger switch
  const service = shouldCharge ? 'turn_on' : 'turn_off';
  await callSwitch(haUrl, haToken, evConfig.haEvChargerSwitchEntity, service);

  // Publish EV sensors to HA
  const { daysSinceFullCharge } = computeTargetSoc(
    evState.lastFullChargeDate,
    evConfig.evFullChargeIntervalDays,
    evConfig.evDailyMaxSoc
  );
  await Promise.allSettled([
    setState(haUrl, haToken, 'sensor.sunsynk_optimizer_ev_battery_soc', evSocPct, {
      unit_of_measurement: '%',
      friendly_name: 'EV battery SOC',
      device_class: 'battery',
    }),
    setState(haUrl, haToken, 'sensor.sunsynk_optimizer_ev_charge_rate', shouldCharge ? evConfig.evChargeRateW : 0, {
      unit_of_measurement: 'W',
      friendly_name: 'EV charge rate',
    }),
    setState(haUrl, haToken, 'sensor.sunsynk_optimizer_ev_charging', shouldCharge ? 'on' : 'off', {
      friendly_name: 'EV charging',
      target_soc: targetSoc,
      plugged_in: pluggedIn,
      reason,
      days_since_full_charge: daysSinceFullCharge === Infinity ? 'never' : daysSinceFullCharge,
    }),
  ]);

  console.log(`[ev] ${shouldCharge ? 'ON' : 'OFF'} — ${reason}`);

  return { shouldCharge, evSocPct, targetSoc, evDemandWh: evDemand.evDemandWh, chargeRateW: evConfig.evChargeRateW, pluggedIn, reason };
}

async function callSwitch(
  haUrl: string,
  haToken: string,
  entityId: string,
  service: 'turn_on' | 'turn_off'
): Promise<void> {
  const axios = (await import('axios')).default;
  await axios.post(
    `${haUrl}/api/services/switch/${service}`,
    { entity_id: entityId },
    { headers: { Authorization: `Bearer ${haToken}`, 'Content-Type': 'application/json' }, timeout: 10000 }
  );
}
