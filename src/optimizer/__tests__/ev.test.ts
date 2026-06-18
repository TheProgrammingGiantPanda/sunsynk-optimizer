import { describe, it, expect } from 'vitest';
import { computeTargetSoc, computeEvDemandWh, computeEvDecision } from '../ev';

// ── computeTargetSoc ────────────────────────────────────────────────────────

describe('computeTargetSoc', () => {
  const now = new Date('2026-04-08T12:00:00Z');

  it('returns dailyMaxSoc when last full charge was recent', () => {
    const result = computeTargetSoc('2026-04-01', 14, 80, now);
    expect(result.targetSoc).toBe(80);
    expect(result.daysSinceFullCharge).toBe(7);
    expect(result.isDueFullCharge).toBe(false);
  });

  it('returns 100% when full charge interval has elapsed', () => {
    const result = computeTargetSoc('2026-03-20', 14, 80, now);
    expect(result.targetSoc).toBe(100);
    expect(result.daysSinceFullCharge).toBe(19);
    expect(result.isDueFullCharge).toBe(true);
  });

  it('returns 100% when exactly at the interval boundary', () => {
    const result = computeTargetSoc('2026-03-25', 14, 80, now);
    expect(result.targetSoc).toBe(100);
    expect(result.daysSinceFullCharge).toBe(14);
    expect(result.isDueFullCharge).toBe(true);
  });

  it('returns 100% when no full charge has ever been recorded', () => {
    const result = computeTargetSoc('', 14, 80, now);
    expect(result.targetSoc).toBe(100);
    expect(result.daysSinceFullCharge).toBe(Infinity);
    expect(result.isDueFullCharge).toBe(true);
  });

  it('respects a custom interval (7 days)', () => {
    const result = computeTargetSoc('2026-04-01', 7, 80, now);
    expect(result.targetSoc).toBe(100);
    expect(result.isDueFullCharge).toBe(true);
  });

  it('respects a custom dailyMaxSoc', () => {
    const result = computeTargetSoc('2026-04-07', 14, 90, now);
    expect(result.targetSoc).toBe(90);
    expect(result.isDueFullCharge).toBe(false);
  });

  it('returns dailyMaxSoc when charged yesterday', () => {
    const result = computeTargetSoc('2026-04-07', 14, 80, now);
    expect(result.targetSoc).toBe(80);
    expect(result.daysSinceFullCharge).toBe(1);
    expect(result.isDueFullCharge).toBe(false);
  });

  it('returns dailyMaxSoc when charged today', () => {
    const result = computeTargetSoc('2026-04-08', 14, 80, now);
    expect(result.targetSoc).toBe(80);
    expect(result.daysSinceFullCharge).toBe(0);
    expect(result.isDueFullCharge).toBe(false);
  });
});

// ── computeEvDemandWh ───────────────────────────────────────────────────────

describe('computeEvDemandWh', () => {
  const LEAF_40KWH = 40000;

  it('calculates demand for 50% → 80% on a 40 kWh battery', () => {
    expect(computeEvDemandWh(50, 80, LEAF_40KWH)).toBe(12000);
  });

  it('calculates demand for 0% → 100% (full charge)', () => {
    expect(computeEvDemandWh(0, 100, LEAF_40KWH)).toBe(40000);
  });

  it('returns 0 when SOC is at target', () => {
    expect(computeEvDemandWh(80, 80, LEAF_40KWH)).toBe(0);
  });

  it('returns 0 when SOC is above target', () => {
    expect(computeEvDemandWh(90, 80, LEAF_40KWH)).toBe(0);
  });

  it('handles the 62 kWh Leaf', () => {
    expect(computeEvDemandWh(50, 80, 62000)).toBe(18600);
  });

  it('handles low deficit (75% → 80%)', () => {
    expect(computeEvDemandWh(75, 80, LEAF_40KWH)).toBe(2000);
  });

  it('handles 100% target from 95%', () => {
    expect(computeEvDemandWh(95, 100, LEAF_40KWH)).toBe(2000);
  });
});

// ── computeEvDecision ───────────────────────────────────────────────────────

describe('computeEvDecision — plugged in', () => {
  it('charges on a cheap slot when SOC < target', () => {
    const result = computeEvDecision(50, 80, true, 5, true);
    expect(result.shouldCharge).toBe(true);
    expect(result.reason).toContain('cheap slot');
  });

  it('does not charge when SOC >= target', () => {
    const result = computeEvDecision(80, 80, true, 5, true);
    expect(result.shouldCharge).toBe(false);
    expect(result.reason).toContain('not charging');
  });

  it('does not charge when slot is expensive', () => {
    const result = computeEvDecision(50, 80, true, 30, false);
    expect(result.shouldCharge).toBe(false);
    expect(result.reason).toContain('not cheap enough');
  });

  it('always charges at negative price even if SOC > daily target', () => {
    const result = computeEvDecision(85, 80, true, -3, false);
    expect(result.shouldCharge).toBe(true);
    expect(result.reason).toContain('negative price');
    expect(result.reason).toContain('charging to 100%');
  });

  it('does not charge at negative price when already at 100%', () => {
    const result = computeEvDecision(100, 80, true, -3, false);
    expect(result.shouldCharge).toBe(false);
    expect(result.reason).toContain('not charging');
  });

  it('charges to 100% target on a cheap slot when full charge is due', () => {
    const result = computeEvDecision(85, 100, true, 5, true);
    expect(result.shouldCharge).toBe(true);
    expect(result.reason).toContain('cheap slot');
    expect(result.reason).toContain('target 100%');
  });

  it('does not charge on cheap slot when SOC at 100% target', () => {
    const result = computeEvDecision(100, 100, true, 5, true);
    expect(result.shouldCharge).toBe(false);
  });

  it('handles null current price with cheap slot', () => {
    const result = computeEvDecision(50, 80, true, null, true);
    expect(result.shouldCharge).toBe(true);
    expect(result.reason).toContain('cheap slot');
  });

  it('handles null current price with expensive slot', () => {
    const result = computeEvDecision(50, 80, true, null, false);
    expect(result.shouldCharge).toBe(false);
  });

  it('negative price with fractional value (-0.5p) still triggers charge', () => {
    const result = computeEvDecision(70, 80, true, -0.5, false);
    expect(result.shouldCharge).toBe(true);
    expect(result.reason).toContain('-0.5p');
  });
});

describe('computeEvDecision — not plugged in', () => {
  it('never charges when EV is not plugged in, even on cheap slot', () => {
    const result = computeEvDecision(50, 80, false, 5, true);
    expect(result.shouldCharge).toBe(false);
    expect(result.reason).toContain('not plugged in');
  });

  it('never charges when unplugged, even at negative price', () => {
    const result = computeEvDecision(50, 80, false, -10, true);
    expect(result.shouldCharge).toBe(false);
    expect(result.reason).toContain('not plugged in');
  });

  it('never charges when unplugged, even when full charge is due', () => {
    const result = computeEvDecision(50, 100, false, 5, true);
    expect(result.shouldCharge).toBe(false);
    expect(result.reason).toContain('not plugged in');
  });
});
