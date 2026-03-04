import { Config } from './config';

/**
 * Schedule a callback to run at specific HH:MM times each day.
 * Fires once immediately if `runOnStart` is true (useful for initial fetch).
 */
export function scheduleDailyTimes(
  times: string[],   // e.g. ["06:00", "12:00"]
  callback: () => Promise<void>,
  runOnStart = false
): void {
  if (runOnStart) {
    callback().catch(err => console.error('[scheduler] Initial run error:', err));
  }

  const scheduleNext = () => {
    const now = new Date();
    const upcoming = times
      .map(t => {
        const [hh, mm] = t.split(':').map(Number);
        const d = new Date(now);
        d.setHours(hh, mm, 0, 0);
        if (d <= now) d.setDate(d.getDate() + 1);
        return d;
      })
      .sort((a, b) => a.getTime() - b.getTime());

    const next = upcoming[0];
    const msUntilNext = next.getTime() - now.getTime();

    console.log(
      `[scheduler] Next forecast fetch at ${next.toLocaleTimeString()} ` +
      `(in ${Math.round(msUntilNext / 60000)} min)`
    );

    setTimeout(async () => {
      try {
        await callback();
      } catch (err) {
        console.error('[scheduler] Forecast fetch error:', err);
      }
      scheduleNext(); // schedule the one after
    }, msUntilNext);
  };

  scheduleNext();
}

/**
 * Schedule a callback aligned to Agile half-hour slot boundaries.
 *
 * Octopus publishes new prices at :00 and :30 each hour. We fire
 * `offsetMinutes` after each boundary (default 2) so fresh prices are
 * always available. After the first aligned fire, repeats every 30 min
 * using recursive setTimeout to prevent drift.
 */
export function scheduleAgileAligned(
  callback: () => Promise<void>,
  offsetMinutes = 2
): void {
  const SLOT_MS = 30 * 60 * 1000;

  const run = async () => {
    try {
      await callback();
    } catch (err) {
      console.error('[scheduler] Price update error:', err);
    }
    setTimeout(run, SLOT_MS);
  };

  // Find ms until the next :0X or :3X fire time
  const now = new Date();
  const secsIntoHour =
    now.getMinutes() * 60 + now.getSeconds() + now.getMilliseconds() / 1000;

  const t1 = offsetMinutes * 60;            // e.g. 2:00 into hour
  const t2 = (30 + offsetMinutes) * 60;     // e.g. 32:00 into hour

  let secsUntil: number;
  if (secsIntoHour < t1)       secsUntil = t1 - secsIntoHour;
  else if (secsIntoHour < t2)  secsUntil = t2 - secsIntoHour;
  else                          secsUntil = 3600 - secsIntoHour + t1;

  const next = new Date(now.getTime() + secsUntil * 1000);
  console.log(
    `[scheduler] First price update at ${next.toLocaleTimeString()} ` +
    `(in ${Math.round(secsUntil / 60)} min), then every 30 min`
  );

  setTimeout(run, secsUntil * 1000);
}
