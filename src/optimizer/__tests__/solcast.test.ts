import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs');
vi.mock('axios');

import fs from 'fs';
import axios from 'axios';
import { getMergedForecast, loadForecastCache, tomorrowPvWh, ForecastSlot } from '../solcast';

const FRESH_SLOT: ForecastSlot = {
  period_end: '2026-03-04T09:00:00Z',
  period: 'PT30M',
  pv_estimate: 2.5,
  pv_estimate10: 1.0,
  pv_estimate90: 3.5,
};

const FRESH_CACHE = JSON.stringify({
  fetchedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(), // 30 min ago
  forecasts: [FRESH_SLOT],
});

const STALE_CACHE = JSON.stringify({
  fetchedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(), // 25h ago
  forecasts: [FRESH_SLOT],
});

const mockFs = vi.mocked(fs);

beforeEach(() => {
  vi.clearAllMocks();
  // Default: /data does NOT exist (dev environment)
  mockFs.existsSync = vi.fn((p: fs.PathLike) => String(p) !== '/data');
});

describe('loadForecastCache', () => {
  it('returns null when cache file does not exist', () => {
    mockFs.existsSync = vi.fn(() => false);
    expect(loadForecastCache()).toBeNull();
  });

  it('returns forecasts from a fresh cache', () => {
    mockFs.existsSync = vi.fn(() => true);
    mockFs.readFileSync = vi.fn(() => FRESH_CACHE) as any;
    expect(loadForecastCache()).toEqual([FRESH_SLOT]);
  });

  it('returns null for a stale cache (>24h)', () => {
    mockFs.existsSync = vi.fn(() => true);
    mockFs.readFileSync = vi.fn(() => STALE_CACHE) as any;
    expect(loadForecastCache()).toBeNull();
  });

  it('returns null when cache file is corrupt JSON', () => {
    mockFs.existsSync = vi.fn(() => true);
    mockFs.readFileSync = vi.fn(() => 'not-json') as any;
    expect(loadForecastCache()).toBeNull();
  });
});

describe('tomorrowPvWh', () => {
  it('returns 0 for an empty forecast', () => {
    expect(tomorrowPvWh([])).toBe(0);
  });

  it('sums P50 Wh for slots whose period_end falls on tomorrow (UTC)', () => {
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const tomorrowDate = tomorrow.toISOString().slice(0, 10);

    const slots: ForecastSlot[] = [
      // today — should be excluded
      { period_end: new Date().toISOString().slice(0, 10) + 'T12:00:00Z', period: 'PT30M', pv_estimate: 2, pv_estimate10: 1, pv_estimate90: 3 },
      // tomorrow — 2 kW × 0.5h × 1000 = 1000 Wh each
      { period_end: tomorrowDate + 'T10:00:00Z', period: 'PT30M', pv_estimate: 2, pv_estimate10: 1, pv_estimate90: 3 },
      { period_end: tomorrowDate + 'T10:30:00Z', period: 'PT30M', pv_estimate: 2, pv_estimate10: 1, pv_estimate90: 3 },
    ];

    expect(tomorrowPvWh(slots)).toBe(2000);
  });

  it('returns 0 when no slots match tomorrow', () => {
    const slots: ForecastSlot[] = [
      { period_end: '2020-01-01T12:00:00Z', period: 'PT30M', pv_estimate: 5, pv_estimate10: 1, pv_estimate90: 8 },
    ];
    expect(tomorrowPvWh(slots)).toBe(0);
  });
});

describe('getMergedForecast', () => {
  it('saves cache and returns merged forecasts on success', async () => {
    mockFs.writeFileSync = vi.fn();
    vi.spyOn(axios, 'get').mockResolvedValue({ data: { forecasts: [FRESH_SLOT] } });

    const result = await getMergedForecast(['site1'], 'apikey');

    expect(result).toHaveLength(1);
    expect(result[0].pv_estimate).toBe(FRESH_SLOT.pv_estimate);
    expect(mockFs.writeFileSync).toHaveBeenCalledOnce();
  });

  it('merges two sites by summing estimates for the same period_end', async () => {
    mockFs.writeFileSync = vi.fn();
    const site1Slot = { ...FRESH_SLOT, pv_estimate: 2, pv_estimate10: 1, pv_estimate90: 3 };
    const site2Slot = { ...FRESH_SLOT, pv_estimate: 3, pv_estimate10: 1, pv_estimate90: 4 };

    vi.spyOn(axios, 'get')
      .mockResolvedValueOnce({ data: { forecasts: [site1Slot] } })
      .mockResolvedValueOnce({ data: { forecasts: [site2Slot] } });

    const result = await getMergedForecast(['site1', 'site2'], 'apikey');

    expect(result).toHaveLength(1);
    expect(result[0].pv_estimate).toBe(5);
    expect(result[0].pv_estimate10).toBe(2);
    expect(result[0].pv_estimate90).toBe(7);
  });

  it('falls back to cache on 429 rate-limit error', async () => {
    mockFs.existsSync = vi.fn(() => true);
    mockFs.readFileSync = vi.fn(() => FRESH_CACHE) as any;
    mockFs.writeFileSync = vi.fn();

    const err: any = new Error('Too Many Requests');
    err.response = { status: 429 };
    vi.spyOn(axios, 'get').mockRejectedValue(err);

    const result = await getMergedForecast(['site1'], 'apikey');
    expect(result).toEqual([FRESH_SLOT]);
    expect(mockFs.writeFileSync).not.toHaveBeenCalled();
  });

  it('throws on 429 when cache is unavailable', async () => {
    mockFs.existsSync = vi.fn(() => false);

    const err: any = new Error('Too Many Requests');
    err.response = { status: 429 };
    vi.spyOn(axios, 'get').mockRejectedValue(err);

    await expect(getMergedForecast(['site1'], 'apikey')).rejects.toThrow('Too Many Requests');
  });

  it('throws non-429 errors without checking cache', async () => {
    mockFs.existsSync = vi.fn(() => true);
    mockFs.readFileSync = vi.fn(() => FRESH_CACHE) as any;

    // Use 403 (Forbidden) — withRetry re-throws 4xx immediately, no retry delay
    const err: any = new Error('Forbidden');
    err.response = { status: 403 };
    vi.spyOn(axios, 'get').mockRejectedValue(err);

    await expect(getMergedForecast(['site1'], 'apikey')).rejects.toThrow('Forbidden');
  });
});
