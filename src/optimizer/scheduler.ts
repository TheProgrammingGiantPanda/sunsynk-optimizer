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
 * Schedule a callback to run every `intervalMinutes` minutes.
 * Fires once immediately on start.
 */
export function scheduleInterval(
  intervalMinutes: number,
  callback: () => Promise<void>
): void {
  const run = async () => {
    try {
      await callback();
    } catch (err) {
      console.error('[scheduler] Interval callback error:', err);
    }
  };

  run(); // run immediately
  setInterval(run, intervalMinutes * 60 * 1000);
}
