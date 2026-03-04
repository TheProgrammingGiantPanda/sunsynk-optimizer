import axios from 'axios';

function haClient(haUrl: string, haToken: string) {
  return axios.create({
    baseURL: `${haUrl}/api`,
    headers: { Authorization: `Bearer ${haToken}`, 'Content-Type': 'application/json' },
    timeout: 10000,
  });
}

/**
 * Returns the current state of a HA entity as a number.
 */
export async function getEntityState(
  haUrl: string,
  haToken: string,
  entityId: string
): Promise<number> {
  const res = await haClient(haUrl, haToken).get(`/states/${entityId}`);
  const val = parseFloat(res.data?.state);
  if (isNaN(val)) {
    throw new Error(
      `Entity ${entityId} has non-numeric state: "${res.data?.state}"`
    );
  }
  return val;
}

/**
 * Sets a HA sensor state with optional attributes.
 * Creates the entity if it doesn't already exist.
 */
export async function setState(
  haUrl: string,
  haToken: string,
  entityId: string,
  state: string | number,
  attributes: Record<string, unknown> = {}
): Promise<void> {
  await haClient(haUrl, haToken).post(`/states/${entityId}`, { state, attributes });
}

/**
 * Calculates average house consumption per 30-min slot (Wh) from HA history.
 *
 * Uses the load_daily_used sensor which accumulates kWh through the day and
 * resets at midnight. Takes the peak value per day as that day's total,
 * averages across complete days, then divides by 48.
 *
 * Returns null if there is insufficient history (< 2 complete days).
 */
export async function getAvgConsumptionWh(
  haUrl: string,
  haToken: string,
  entityId: string,
  days = 7
): Promise<number | null> {
  const start = new Date();
  start.setDate(start.getDate() - (days + 1)); // +1 to ensure we get enough complete days

  const res = await haClient(haUrl, haToken).get(
    `/history/period/${start.toISOString()}`,
    { params: { filter_entity_id: entityId, end_time: new Date().toISOString() }, timeout: 30000 }
  );

  const states: any[] = res.data?.[0] ?? [];

  // Find the maximum (end-of-day) value per calendar date
  const byDay = new Map<string, number>();
  for (const s of states) {
    const val = parseFloat(s.state);
    if (isNaN(val)) continue;
    const day = (s.last_updated as string).slice(0, 10);
    const current = byDay.get(day) ?? 0;
    if (val > current) byDay.set(day, val);
  }

  // Sort days and drop today (incomplete)
  const sorted = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b));
  const today = new Date().toISOString().slice(0, 10);
  const completeDays = sorted.filter(([day]) => day !== today);

  if (completeDays.length < 2) return null;

  const avgDailyKwh =
    completeDays.reduce((sum, [, kwh]) => sum + kwh, 0) / completeDays.length;

  const perSlotWh = Math.round((avgDailyKwh / 48) * 1000);

  console.log(
    `[homeassistant] Avg consumption over ${completeDays.length} days: ` +
    `${avgDailyKwh.toFixed(1)} kWh/day = ${perSlotWh} Wh/slot`
  );

  return perSlotWh;
}

/**
 * Builds a 48-element array of average Wh consumed per 30-min slot (index 0 = 00:00–00:30, UTC).
 *
 * Derives per-slot energy by differentiating the load_daily_used cumulative sensor across
 * multiple days of history, then averages each slot index.
 *
 * Returns null if there is insufficient history (< 2 complete days).
 */
export async function getSlotProfileWh(
  haUrl: string,
  haToken: string,
  entityId: string,
  days = 7
): Promise<number[] | null> {
  const start = new Date();
  start.setDate(start.getDate() - (days + 1));

  const res = await haClient(haUrl, haToken).get(
    `/history/period/${start.toISOString()}`,
    { params: { filter_entity_id: entityId, end_time: new Date().toISOString() }, timeout: 30000 }
  );

  const states: any[] = res.data?.[0] ?? [];

  // Group states by calendar date (UTC)
  const byDate = new Map<string, { t: number; v: number }[]>();
  for (const s of states) {
    const val = parseFloat(s.state);
    if (isNaN(val)) continue;
    const date = (s.last_updated as string).slice(0, 10);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date)!.push({ t: new Date(s.last_updated).getTime(), v: val });
  }

  // Drop today (incomplete day)
  const today = new Date().toISOString().slice(0, 10);
  byDate.delete(today);

  if (byDate.size < 2) return null;

  // Accumulate per-slot totals and counts across all complete days
  const slotTotals = new Array(48).fill(0);
  const slotCounts = new Array(48).fill(0);

  for (const readings of byDate.values()) {
    // Sort chronologically; first reading may be residual from previous midnight
    readings.sort((a, b) => a.t - b.t);

    for (let i = 1; i < readings.length; i++) {
      const prev = readings[i - 1];
      const curr = readings[i];

      // The sensor resets at midnight — skip negative diffs (the reset itself)
      const delta = curr.v - prev.v;
      if (delta < 0) continue;

      // Assign energy to the 30-min slot containing the midpoint
      const mid = (prev.t + curr.t) / 2;
      const midDate = new Date(mid);
      const slotIdx = midDate.getUTCHours() * 2 + Math.floor(midDate.getUTCMinutes() / 30);

      slotTotals[slotIdx] += delta * 1000; // kWh → Wh
      slotCounts[slotIdx]++;
    }
  }

  // Build average profile; fill any empty slots with the overall mean
  const filledSlots = slotCounts.filter(c => c > 0).length;
  if (filledSlots === 0) return null;

  // Divide by days (not by individual delta count) — each slot spans ~3 readings,
  // so dividing by slotCounts would give 1/3 of actual consumption.
  const overallMean =
    slotTotals.reduce((a, b) => a + b, 0) / byDate.size / 48;

  const profile = slotTotals.map((total, i) =>
    slotCounts[i] > 0 ? Math.round(total / byDate.size) : Math.round(overallMean)
  );

  const dailyTotal = (profile.reduce((a, b) => a + b, 0) / 1000).toFixed(1);
  console.log(
    `[homeassistant] Slot profile built from ${byDate.size} days ` +
    `(implied daily total: ${dailyTotal} kWh)`
  );

  return profile;
}

/**
 * Lists all entity IDs matching a search string — useful for discovering sensor names.
 */
export async function findEntities(
  haUrl: string,
  haToken: string,
  search: string
): Promise<{ entity_id: string; state: string; friendly_name: string }[]> {
  const res = await haClient(haUrl, haToken).get('/states');
  return (res.data as any[])
    .filter((e: any) => e.entity_id.includes(search))
    .map((e: any) => ({
      entity_id: e.entity_id,
      state: e.state,
      friendly_name: e.attributes?.friendly_name ?? '',
    }));
}
