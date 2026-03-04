import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs');
vi.mock('axios');
// Bypass withRetry's exponential back-off — we're testing cache logic, not retry logic.
vi.mock('../retry', () => ({ withRetry: (fn: () => Promise<any>) => fn() }));

import fs from 'fs';
import axios from 'axios';
import { getAgileRates, getOutgoingAgileRates } from '../octopus';

// A slot valid 1 hour from now
function futureSlot(offsetHours = 1) {
  const from = new Date(Date.now() + offsetHours * 3600000);
  const to   = new Date(from.getTime() + 1800000);
  return { value_exc_vat: 10, value_inc_vat: 10.5, valid_from: from.toISOString(), valid_to: to.toISOString(), payment_method: null };
}

// A slot that is already expired
function expiredSlot() {
  const from = new Date(Date.now() - 3600000);
  const to   = new Date(Date.now() - 1800000);
  return { value_exc_vat: 5, value_inc_vat: 5.25, valid_from: from.toISOString(), valid_to: to.toISOString(), payment_method: null };
}

const mockFs     = vi.mocked(fs);
const LIVE_RATES   = [futureSlot(1), futureSlot(2)];
const CACHED_RATES = [futureSlot(3), futureSlot(4)];

beforeEach(() => {
  vi.clearAllMocks();
  // Default: /data does not exist (dev), cache file does not exist
  mockFs.existsSync = vi.fn((p: fs.PathLike) => String(p) !== '/data');
  vi.mocked(axios.get).mockResolvedValue({ data: { results: LIVE_RATES } });
});

// ── getAgileRates ────────────────────────────────────────────────────────────

describe('getAgileRates — caching', () => {
  it('saves cache after a successful fetch', async () => {
    mockFs.writeFileSync = vi.fn();
    await getAgileRates('PRODUCT', 'TARIFF');

    expect(mockFs.writeFileSync).toHaveBeenCalledOnce();
    const written = JSON.parse((mockFs.writeFileSync as any).mock.calls[0][1]);
    expect(written.rates).toEqual(LIVE_RATES);
    expect(written.fetchedAt).toBeDefined();
  });

  it('returns cached rates when live fetch fails and cache has future slots', async () => {
    vi.mocked(axios.get).mockRejectedValue(new Error('network error'));
    mockFs.existsSync = vi.fn(() => true);
    mockFs.readFileSync = vi.fn(() =>
      JSON.stringify({ fetchedAt: new Date().toISOString(), rates: CACHED_RATES })
    ) as any;

    const result = await getAgileRates('PRODUCT', 'TARIFF');
    expect(result).toEqual(CACHED_RATES);
  });

  it('throws when live fetch fails and cache is missing', async () => {
    vi.mocked(axios.get).mockRejectedValue(new Error('network error'));
    mockFs.existsSync = vi.fn(() => false);

    await expect(getAgileRates('PRODUCT', 'TARIFF')).rejects.toThrow('network error');
  });

  it('throws when live fetch fails and all cached slots are expired', async () => {
    vi.mocked(axios.get).mockRejectedValue(new Error('network error'));
    mockFs.existsSync = vi.fn(() => true);
    mockFs.readFileSync = vi.fn(() =>
      JSON.stringify({ fetchedAt: new Date().toISOString(), rates: [expiredSlot()] })
    ) as any;

    await expect(getAgileRates('PRODUCT', 'TARIFF')).rejects.toThrow('network error');
  });
});

// ── getOutgoingAgileRates ────────────────────────────────────────────────────

describe('getOutgoingAgileRates — caching', () => {
  it('saves cache after a successful fetch', async () => {
    mockFs.writeFileSync = vi.fn();
    await getOutgoingAgileRates('PRODUCT', 'TARIFF');

    expect(mockFs.writeFileSync).toHaveBeenCalledOnce();
    const written = JSON.parse((mockFs.writeFileSync as any).mock.calls[0][1]);
    expect(written.rates).toEqual(LIVE_RATES);
  });

  it('returns cached rates when live fetch fails and cache has future slots', async () => {
    vi.mocked(axios.get).mockRejectedValue(new Error('timeout'));
    mockFs.existsSync = vi.fn(() => true);
    mockFs.readFileSync = vi.fn(() =>
      JSON.stringify({ fetchedAt: new Date().toISOString(), rates: CACHED_RATES })
    ) as any;

    const result = await getOutgoingAgileRates('PRODUCT', 'TARIFF');
    expect(result).toEqual(CACHED_RATES);
  });

  it('returns [] when live fetch fails and no cache exists', async () => {
    vi.mocked(axios.get).mockRejectedValue(new Error('timeout'));
    mockFs.existsSync = vi.fn(() => false);

    const result = await getOutgoingAgileRates('PRODUCT', 'TARIFF');
    expect(result).toEqual([]);
  });

  it('returns [] when live fetch fails and all cached slots are expired', async () => {
    vi.mocked(axios.get).mockRejectedValue(new Error('timeout'));
    mockFs.existsSync = vi.fn(() => true);
    mockFs.readFileSync = vi.fn(() =>
      JSON.stringify({ fetchedAt: new Date().toISOString(), rates: [expiredSlot()] })
    ) as any;

    const result = await getOutgoingAgileRates('PRODUCT', 'TARIFF');
    expect(result).toEqual([]);
  });
});
