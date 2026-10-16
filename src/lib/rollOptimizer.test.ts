import { describe, expect, it } from 'vitest';

import { optimizeRollLayout } from './rollOptimizer.ts';

const ROLLS = [1100, 1600, 2200, 2500, 3200, 4200, 5000] as const;

describe('roll media optimizer — single-piece layouts', () => {
  it('uses the 1600mm roll for a 1500 × 3000 job and charges half the waste', () => {
    const result = optimizeRollLayout({
      widthMm: 1500,
      heightMm: 3000,
      quantity: 1,
      rollWidthsMm: ROLLS,
      wasteFactor: 0.5,
    });

    expect(result.valid).toBe(true);
    if (!result.valid) return;

    expect(result.split).toBe(false);
    expect(result.panels[0]!.rollWidthMm).toBe(1600);
    expect(result.panels[0]!.rotated).toBe(false);
    expect(result.printedAreaSqm).toBeCloseTo(4.5);
    expect(result.consumedAreaSqm).toBeCloseTo(4.8);
    expect(result.wasteAreaSqm).toBeCloseTo(0.3);
    expect(result.billableAreaSqm).toBeCloseTo(4.65);
  });

  it('rotates when that wins the roll consumption', () => {
    const result = optimizeRollLayout({
      widthMm: 2000,
      heightMm: 1000,
      quantity: 1,
      rollWidthsMm: [1100, 1600, 2200],
    });

    expect(result.valid).toBe(true);
    if (!result.valid) return;

    expect(result.panels[0]!.rollWidthMm).toBe(1100);
    expect(result.panels[0]!.rotated).toBe(true);
    expect(result.consumedAreaSqm).toBeCloseTo(2.2);
    expect(result.billableAreaSqm).toBeCloseTo(2.1);
  });

  it('packs three identical pieces across a 3200mm roll when that reduces waste', () => {
    const result = optimizeRollLayout({
      widthMm: 1000,
      heightMm: 2000,
      quantity: 3,
      rollWidthsMm: [1100, 1600, 2200, 3200],
    });

    expect(result.valid).toBe(true);
    if (!result.valid) return;

    const panel = result.panels[0]!;
    expect(panel.rollWidthMm).toBe(3200);
    expect(panel.across).toBe(3);
    expect(panel.rows).toBe(1);
    expect(result.printedAreaSqm).toBeCloseTo(6);
    expect(result.consumedAreaSqm).toBeCloseTo(6.4);
    expect(result.wasteAreaSqm).toBeCloseTo(0.4);
    expect(result.billableAreaSqm).toBeCloseTo(6.2);
  });

  it('charges the unused part of a partial final row as waste', () => {
    const result = optimizeRollLayout({
      widthMm: 1000,
      heightMm: 1000,
      quantity: 5,
      rollWidthsMm: [3200],
    });

    expect(result.valid).toBe(true);
    if (!result.valid) return;

    const panel = result.panels[0]!;
    expect(panel.across).toBe(3);
    expect(panel.rows).toBe(2);
    expect(result.printedAreaSqm).toBeCloseTo(5);
    expect(result.consumedAreaSqm).toBeCloseTo(6.4);
    expect(result.wasteAreaSqm).toBeCloseTo(1.4);
    expect(result.billableAreaSqm).toBeCloseTo(5.7);
  });

  it('uses exact-fit material with zero waste', () => {
    const result = optimizeRollLayout({
      widthMm: 1600,
      heightMm: 2000,
      quantity: 1,
      rollWidthsMm: [1600, 2200],
    });

    expect(result.valid).toBe(true);
    if (!result.valid) return;

    expect(result.panels[0]!.rollWidthMm).toBe(1600);
    expect(result.wasteAreaSqm).toBe(0);
    expect(result.billableAreaSqm).toBeCloseTo(result.printedAreaSqm);
  });

  it('sanitises unsorted and duplicate roll widths without changing the result', () => {
    const clean = optimizeRollLayout({
      widthMm: 1500,
      heightMm: 3000,
      quantity: 1,
      rollWidthsMm: [1600, 2200, 3200],
    });
    const dirty = optimizeRollLayout({
      widthMm: 1500,
      heightMm: 3000,
      quantity: 1,
      rollWidthsMm: [3200, 1600, 2200, 1600, -10, Number.NaN],
    });

    expect(dirty).toEqual(clean);
  });

  it('changes charge when the waste factor changes without changing the physical layout', () => {
    const half = optimizeRollLayout({
      widthMm: 1500,
      heightMm: 3000,
      quantity: 1,
      rollWidthsMm: ROLLS,
      wasteFactor: 0.5,
    });
    const quarter = optimizeRollLayout({
      widthMm: 1500,
      heightMm: 3000,
      quantity: 1,
      rollWidthsMm: ROLLS,
      wasteFactor: 0.25,
    });

    expect(half.valid).toBe(true);
    expect(quarter.valid).toBe(true);
    if (!half.valid || !quarter.valid) return;

    expect(quarter.panels).toEqual(half.panels);
    expect(half.billableAreaSqm).toBeCloseTo(4.65);
    expect(quarter.billableAreaSqm).toBeCloseTo(4.575);
  });

  it('returns the same result for repeated identical input', () => {
    const input = {
      widthMm: 1000,
      heightMm: 2000,
      quantity: 7,
      rollWidthsMm: ROLLS,
      wasteFactor: 0.5,
    } as const;

    expect(optimizeRollLayout(input)).toEqual(optimizeRollLayout(input));
  });
});

describe('roll media optimizer — two-piece fallback', () => {
  it('returns a two-panel production plan when no single orientation fits', () => {
    const result = optimizeRollLayout({
      widthMm: 5500,
      heightMm: 6000,
      quantity: 1,
      rollWidthsMm: ROLLS,
    });

    expect(result.valid).toBe(true);
    if (!result.valid) return;

    expect(result.split).toBe(true);
    expect(result.parts).toBe(2);
    expect(result.panels).toHaveLength(2);
    expect(result.warnings).toContain('roll.twoPieceJoin');
    expect(result.splitAxis).toBeDefined();
    expect(result.splitAtMm).toBeGreaterThan(0);

    for (const panel of result.panels) {
      const acrossDimension = panel.rotated ? panel.heightMm : panel.widthMm;
      expect(acrossDimension).toBeLessThanOrEqual(panel.rollWidthMm);
    }
  });

  it('does not split a job merely because a split could be priced differently', () => {
    const result = optimizeRollLayout({
      widthMm: 1500,
      heightMm: 3000,
      quantity: 1,
      rollWidthsMm: ROLLS,
      maxParts: 2,
    });

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.split).toBe(false);
  });

  it('returns blocked when neither dimension can be made with two panels', () => {
    const result = optimizeRollLayout({
      widthMm: 11_000,
      heightMm: 11_000,
      quantity: 1,
      rollWidthsMm: ROLLS,
    });

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.blocked.reason).toBe('roll.noValidLayout');
  });

  it('adds configured seam overlap to the produced/charged panel area', () => {
    const noOverlap = optimizeRollLayout({
      widthMm: 5500,
      heightMm: 6000,
      quantity: 1,
      rollWidthsMm: ROLLS,
      seamOverlapMm: 0,
    });
    const withOverlap = optimizeRollLayout({
      widthMm: 5500,
      heightMm: 6000,
      quantity: 1,
      rollWidthsMm: ROLLS,
      seamOverlapMm: 50,
    });

    expect(noOverlap.valid).toBe(true);
    expect(withOverlap.valid).toBe(true);
    if (!noOverlap.valid || !withOverlap.valid) return;

    expect(noOverlap.split).toBe(true);
    expect(withOverlap.split).toBe(true);
    expect(withOverlap.printedAreaSqm).toBeGreaterThan(noOverlap.printedAreaSqm);
    expect(withOverlap.seamOverlapMm).toBe(50);
  });
});

describe('roll media optimizer — validation and invariants', () => {
  it('rejects invalid dimensions', () => {
    const result = optimizeRollLayout({
      widthMm: 0,
      heightMm: 1000,
      quantity: 1,
      rollWidthsMm: ROLLS,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.blocked.reason).toBe('roll.invalidDimensions');
  });

  it('rejects invalid quantity', () => {
    const result = optimizeRollLayout({
      widthMm: 1000,
      heightMm: 1000,
      quantity: 1.5,
      rollWidthsMm: ROLLS,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.blocked.reason).toBe('roll.invalidQuantity');
  });

  it('rejects an empty/invalid roll set', () => {
    const result = optimizeRollLayout({
      widthMm: 1000,
      heightMm: 1000,
      quantity: 1,
      rollWidthsMm: [0, -10, Number.NaN],
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.blocked.reason).toBe('roll.noRollWidths');
  });

  it('rejects a waste factor outside 0..1', () => {
    const result = optimizeRollLayout({
      widthMm: 1000,
      heightMm: 1000,
      quantity: 1,
      rollWidthsMm: ROLLS,
      wasteFactor: 1.1,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.blocked.reason).toBe('roll.invalidWasteFactor');
  });

  it('keeps billable area between printed and consumed area for a 0..1 waste factor', () => {
    const result = optimizeRollLayout({
      widthMm: 1234,
      heightMm: 2345,
      quantity: 9,
      rollWidthsMm: ROLLS,
      wasteFactor: 0.5,
    });

    expect(result.valid).toBe(true);
    if (!result.valid) return;

    expect(result.consumedAreaSqm).toBeGreaterThanOrEqual(result.printedAreaSqm);
    expect(result.wasteAreaSqm).toBeGreaterThanOrEqual(0);
    expect(result.billableAreaSqm).toBeGreaterThanOrEqual(result.printedAreaSqm);
    expect(result.billableAreaSqm).toBeLessThanOrEqual(result.consumedAreaSqm);
  });
});
