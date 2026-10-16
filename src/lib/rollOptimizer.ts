/**
 * Roll-media layout optimizer for large-format work.
 *
 * Pure and deterministic: no React, store, database, clock or currency here.
 * It answers one question: how should a finished rectangle (and quantity) be
 * laid onto the available roll widths with the lowest billable material area?
 */

export interface RollOptimizerInput {
  widthMm: number;
  heightMm: number;
  quantity: number;
  rollWidthsMm: readonly number[];
  /** Fraction of physical waste charged to the customer. V1 default: 0.50. */
  wasteFactor?: number;
  /** V1 supports at most a two-panel fallback when no single-piece layout fits. */
  maxParts?: 1 | 2;
  /** Extra printed width added to the second panel at a join. */
  seamOverlapMm?: number;
}

export interface RollPanelPlan {
  widthMm: number;
  heightMm: number;
  quantity: number;
  rollWidthMm: number;
  rotated: boolean;
  /** Maximum identical panels placed across this roll in the winning layout. */
  across: number;
  rows: number;
  consumedLengthMm: number;
  printedAreaSqm: number;
  consumedAreaSqm: number;
  wasteAreaSqm: number;
}

export interface ValidRollLayoutResult {
  valid: true;
  split: boolean;
  parts: 1 | 2;
  warnings: string[];
  wasteFactor: number;
  printedAreaSqm: number;
  consumedAreaSqm: number;
  wasteAreaSqm: number;
  billableAreaSqm: number;
  panels: RollPanelPlan[];
  splitAxis?: 'width' | 'height';
  /** Finished-size split position, before optional overlap is added. */
  splitAtMm?: number;
  seamOverlapMm: number;
}

export interface BlockedRollLayoutResult {
  valid: false;
  split: false;
  warnings: string[];
  blocked: {
    reason:
      | 'roll.invalidDimensions'
      | 'roll.invalidQuantity'
      | 'roll.noRollWidths'
      | 'roll.invalidWasteFactor'
      | 'roll.invalidSeamOverlap'
      | 'roll.noValidLayout';
  };
}

export type RollLayoutResult = ValidRollLayoutResult | BlockedRollLayoutResult;

interface PanelCandidate {
  plan: RollPanelPlan;
  printedAreaMm2: number;
  consumedAreaMm2: number;
  wasteAreaMm2: number;
  billableAreaMm2: number;
}

interface SplitCandidate {
  axis: 'width' | 'height';
  splitAtMm: number;
  finishedPartA: number;
  finishedPartB: number;
  panels: [PanelCandidate, PanelCandidate];
  printedAreaMm2: number;
  consumedAreaMm2: number;
  wasteAreaMm2: number;
  billableAreaMm2: number;
}

const MM2_PER_SQM = 1_000_000;
const EPSILON = 1e-9;

const sqm = (mm2: number): number => mm2 / MM2_PER_SQM;

function blocked(reason: BlockedRollLayoutResult['blocked']['reason']): BlockedRollLayoutResult {
  return { valid: false, split: false, warnings: [], blocked: { reason } };
}

function positiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function sanitiseRollWidths(widths: readonly number[]): number[] {
  return [...new Set(widths.filter(positiveFinite))].sort((a, b) => a - b);
}

function compareNumber(a: number, b: number): number {
  if (Math.abs(a - b) <= EPSILON) return 0;
  return a < b ? -1 : 1;
}

/**
 * Pick a layout for ONE panel shape repeated `quantity` times.
 *
 * Both orientations and every roll width are evaluated. The `printedAreaMm2`
 * is invariant for a given panel shape; only consumption/waste changes.
 */
function bestPanel(
  widthMm: number,
  heightMm: number,
  quantity: number,
  rollWidthsMm: readonly number[],
  wasteFactor: number,
): PanelCandidate | null {
  const candidates: PanelCandidate[] = [];
  const printedAreaMm2 = widthMm * heightMm * quantity;

  for (const rotated of [false, true] as const) {
    const acrossDimension = rotated ? heightMm : widthMm;
    const alongDimension = rotated ? widthMm : heightMm;

    for (const rollWidthMm of rollWidthsMm) {
      if (acrossDimension > rollWidthMm + EPSILON) continue;

      const capacityAcross = Math.floor(rollWidthMm / acrossDimension);
      if (capacityAcross < 1) continue;

      const rows = Math.ceil(quantity / capacityAcross);
      const consumedLengthMm = rows * alongDimension;
      const consumedAreaMm2 = rollWidthMm * consumedLengthMm;
      const wasteAreaMm2 = Math.max(0, consumedAreaMm2 - printedAreaMm2);
      const billableAreaMm2 = printedAreaMm2 + wasteAreaMm2 * wasteFactor;

      candidates.push({
        plan: {
          widthMm,
          heightMm,
          quantity,
          rollWidthMm,
          rotated,
          across: capacityAcross,
          rows,
          consumedLengthMm,
          printedAreaSqm: sqm(printedAreaMm2),
          consumedAreaSqm: sqm(consumedAreaMm2),
          wasteAreaSqm: sqm(wasteAreaMm2),
        },
        printedAreaMm2,
        consumedAreaMm2,
        wasteAreaMm2,
        billableAreaMm2,
      });
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    // Business priority: lowest charged material first.
    const billable = compareNumber(a.billableAreaMm2, b.billableAreaMm2);
    if (billable !== 0) return billable;

    const consumed = compareNumber(a.consumedAreaMm2, b.consumedAreaMm2);
    if (consumed !== 0) return consumed;

    // Stable production tie-breaks from the spec.
    const roll = compareNumber(a.plan.rollWidthMm, b.plan.rollWidthMm);
    if (roll !== 0) return roll;

    if (a.plan.rotated !== b.plan.rotated) return a.plan.rotated ? 1 : -1;
    return 0;
  });

  return candidates[0]!;
}

/**
 * Candidate finished split positions in 1mm increments.
 *
 * With V1 roll widths in the low thousands of millimetres this is deliberately
 * exhaustive rather than heuristic: across-count changes occur at hard width
 * boundaries, so checking the complete feasible interval avoids guessing which
 * "nice" split is cheapest. Fractional interval edges and the exact midpoint
 * are included too for deterministic support of decimal finished sizes.
 */
function splitPositions(totalMm: number, maxRollMm: number): number[] {
  const lower = Math.max(EPSILON, totalMm - maxRollMm);
  const upper = Math.min(maxRollMm, totalMm - EPSILON);
  if (lower > upper) return [];

  const values = new Set<number>();
  values.add(lower);
  values.add(upper);
  values.add(totalMm / 2);

  const firstWhole = Math.ceil(lower);
  const lastWhole = Math.floor(upper);
  for (let mm = firstWhole; mm <= lastWhole; mm += 1) values.add(mm);

  return [...values]
    .filter((value) => value > 0 && value < totalMm && value >= lower - EPSILON && value <= upper + EPSILON)
    .sort((a, b) => a - b);
}

function bestSplit(
  widthMm: number,
  heightMm: number,
  quantity: number,
  rollWidthsMm: readonly number[],
  wasteFactor: number,
  seamOverlapMm: number,
): SplitCandidate | null {
  const maxRollMm = Math.max(...rollWidthsMm);
  const candidates: SplitCandidate[] = [];

  const tryAxis = (axis: 'width' | 'height'): void => {
    const total = axis === 'width' ? widthMm : heightMm;
    const other = axis === 'width' ? heightMm : widthMm;

    for (const splitAtMm of splitPositions(total, maxRollMm)) {
      const finishedPartA = splitAtMm;
      const finishedPartB = total - splitAtMm;

      // The second panel carries the configured join overlap. With the V1
      // default of 0 this is exactly the customer's finished rectangle split in
      // two. Keeping it explicit lets production set a real overlap later.
      const printPartA = finishedPartA;
      const printPartB = finishedPartB + seamOverlapMm;

      const dimsA: readonly [number, number] =
        axis === 'width' ? [printPartA, other] : [other, printPartA];
      const dimsB: readonly [number, number] =
        axis === 'width' ? [printPartB, other] : [other, printPartB];

      const panelA = bestPanel(dimsA[0], dimsA[1], quantity, rollWidthsMm, wasteFactor);
      if (panelA === null) continue;
      const panelB = bestPanel(dimsB[0], dimsB[1], quantity, rollWidthsMm, wasteFactor);
      if (panelB === null) continue;

      const printedAreaMm2 = panelA.printedAreaMm2 + panelB.printedAreaMm2;
      const consumedAreaMm2 = panelA.consumedAreaMm2 + panelB.consumedAreaMm2;
      const wasteAreaMm2 = Math.max(0, consumedAreaMm2 - printedAreaMm2);
      const billableAreaMm2 = printedAreaMm2 + wasteAreaMm2 * wasteFactor;

      candidates.push({
        axis,
        splitAtMm,
        finishedPartA,
        finishedPartB,
        panels: [panelA, panelB],
        printedAreaMm2,
        consumedAreaMm2,
        wasteAreaMm2,
        billableAreaMm2,
      });
    }
  };

  tryAxis('width');
  tryAxis('height');

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const billable = compareNumber(a.billableAreaMm2, b.billableAreaMm2);
    if (billable !== 0) return billable;

    const consumed = compareNumber(a.consumedAreaMm2, b.consumedAreaMm2);
    if (consumed !== 0) return consumed;

    const rollSumA = a.panels[0].plan.rollWidthMm + a.panels[1].plan.rollWidthMm;
    const rollSumB = b.panels[0].plan.rollWidthMm + b.panels[1].plan.rollWidthMm;
    const rollSum = compareNumber(rollSumA, rollSumB);
    if (rollSum !== 0) return rollSum;

    // When cost is identical, favour the more balanced join for production.
    const balanceA = Math.abs(a.finishedPartA - a.finishedPartB);
    const balanceB = Math.abs(b.finishedPartA - b.finishedPartB);
    const balance = compareNumber(balanceA, balanceB);
    if (balance !== 0) return balance;

    if (a.axis !== b.axis) return a.axis === 'width' ? -1 : 1;
    return compareNumber(a.splitAtMm, b.splitAtMm);
  });

  return candidates[0]!;
}

export function optimizeRollLayout(input: RollOptimizerInput): RollLayoutResult {
  const { widthMm, heightMm } = input;
  if (!positiveFinite(widthMm) || !positiveFinite(heightMm)) {
    return blocked('roll.invalidDimensions');
  }

  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    return blocked('roll.invalidQuantity');
  }

  const rollWidthsMm = sanitiseRollWidths(input.rollWidthsMm);
  if (rollWidthsMm.length === 0) return blocked('roll.noRollWidths');

  const wasteFactor = input.wasteFactor ?? 0.5;
  if (!Number.isFinite(wasteFactor) || wasteFactor < 0 || wasteFactor > 1) {
    return blocked('roll.invalidWasteFactor');
  }

  const seamOverlapMm = input.seamOverlapMm ?? 0;
  if (!Number.isFinite(seamOverlapMm) || seamOverlapMm < 0) {
    return blocked('roll.invalidSeamOverlap');
  }

  const maxParts = input.maxParts ?? 2;

  const single = bestPanel(widthMm, heightMm, input.quantity, rollWidthsMm, wasteFactor);
  if (single !== null) {
    return {
      valid: true,
      split: false,
      parts: 1,
      warnings: [],
      wasteFactor,
      printedAreaSqm: sqm(single.printedAreaMm2),
      consumedAreaSqm: sqm(single.consumedAreaMm2),
      wasteAreaSqm: sqm(single.wasteAreaMm2),
      billableAreaSqm: sqm(single.billableAreaMm2),
      panels: [single.plan],
      seamOverlapMm,
    };
  }

  if (maxParts < 2) return blocked('roll.noValidLayout');

  const split = bestSplit(
    widthMm,
    heightMm,
    input.quantity,
    rollWidthsMm,
    wasteFactor,
    seamOverlapMm,
  );
  if (split === null) return blocked('roll.noValidLayout');

  return {
    valid: true,
    split: true,
    parts: 2,
    warnings: ['roll.twoPieceJoin'],
    wasteFactor,
    printedAreaSqm: sqm(split.printedAreaMm2),
    consumedAreaSqm: sqm(split.consumedAreaMm2),
    wasteAreaSqm: sqm(split.wasteAreaMm2),
    billableAreaSqm: sqm(split.billableAreaMm2),
    panels: split.panels.map((panel) => panel.plan),
    splitAxis: split.axis,
    splitAtMm: split.splitAtMm,
    seamOverlapMm,
  };
}
