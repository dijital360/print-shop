# Roll Media Pricing Engine Specification

## Purpose
Choose the lowest-billable valid production layout for roll-fed outdoor print jobs and return both the price inputs and a production-readable plan.

The engine must be pure/deterministic: the same inputs always return the same result, with no network, database or UI dependency.

## Inputs
At minimum:
- finished width (mm)
- finished height (mm)
- quantity
- material key
- available roll widths for that material (mm)
- media price per m² for the active customer price list
- waste charge factor (V1 default 0.50)
- optional split policy
  - max parts (V1: 2)
  - seam/overlap allowance in mm (configurable; initial default 0 until production rule is finalized)
  - optional join finishing charge

## Core definitions
For one chosen layout:
- `printedArea` = finished printed area across all requested units, plus any explicitly configured overlap area if overlap is considered printable/consumed production.
- `consumedArea` = selected roll width × consumed linear length across all runs.
- `wasteArea` = max(0, consumedArea - printedArea).
- `billableArea` = printedArea + wasteArea × wasteChargeFactor.
- media charge = billableArea × customer/material m² rate.

All area arithmetic should use millimetres internally where practical and round only at the money boundary.

## Orientation
For every candidate roll width, evaluate:
- upright: piece width across roll, piece height along roll
- rotated: piece height across roll, piece width along roll

Rotation is allowed unless a future product explicitly disables it.

## Quantity packing
For an orientation that fits a roll:
- `across = floor(rollWidth / pieceAcross)`
- rows = ceil(quantity / across)
- consumedLength = rows × pieceAlong
- consumedArea = rollWidth × consumedLength

The final row may be partially filled; unused area is waste and charged at the waste factor.

The optimizer evaluates all roll widths and both orientations and chooses the lowest final media charge. Tie-breaking must be deterministic:
1. lower billable area
2. lower consumed area
3. narrower roll width
4. non-rotated before rotated (purely for stable output when all else is equal)

## Single-piece fit
A candidate is valid when the across dimension is <= roll width.

If at least one single-piece layout is valid, compare all valid single-piece candidates and return the best one. Do not split merely because a split might be marginally cheaper: V1 split exists to make otherwise-unprintable dimensions printable. A later policy may allow cost-driven splitting explicitly.

## Two-piece split
If neither orientation fits any available roll:
1. Evaluate splitting the finished dimension into exactly two production panels.
2. Evaluate vertical and horizontal split directions.
3. Evaluate practical split positions derived from available roll widths rather than only an equal 50/50 split.
4. Each panel must be printable on at least one available roll.
5. Price the two panel layouts together, including configured overlap and joining charge when present.
6. Select the lowest-billable valid split plan.

Customer-facing result must carry a warning that the finished product will be printed in two pieces and joined.

Production plan must include panel dimensions and roll choice for each panel.

## Important pricing rule
Waste is not free and is not charged at full price in V1.

Default:
`billableArea = printedArea + wasteArea * 0.50`

The factor is configuration data, not a constant hidden inside the optimizer.

## Example baseline cases
These are acceptance examples for the first implementation. Rates are omitted where only layout selection is being asserted.

### Case A — simple closest roll
Rolls: 1100, 1600, 2200, 2500, 3200, 4200, 5000
Job: 1500 × 3000 mm, qty 1
Expected winning layout:
- 1600 mm roll
- 1500 mm across, 3000 mm along
- non-rotated
- printed area = 4.50 m²
- consumed area = 4.80 m²
- waste = 0.30 m²
- billable area at 50% waste = 4.65 m²

### Case B — rotation wins
Rolls: 1100, 1600, 2200
Job: 2000 × 1000 mm, qty 1
Expected:
- 1100 mm roll via rotation
- 1000 mm across, 2000 mm along
- printed area = 2.00 m²
- consumed area = 2.20 m²
- waste = 0.20 m²
- billable area = 2.10 m²

### Case C — quantity packing across one roll
Rolls: 1100, 1600, 2200, 3200
Job: 1000 × 2000 mm, qty 3
Expected optimizer to evaluate:
- three separate runs on 1100 mm
- two-across layouts where possible
- three-across on 3200 mm
Winning plan at equal m² rate and 50% waste should be the plan with the lowest billable area, not necessarily the narrowest roll.

For 3200 mm, 3 across:
- printed area = 6.00 m²
- consumed area = 3.2 × 2.0 = 6.40 m²
- waste = 0.40 m²
- billable = 6.20 m²

For 1100 mm, one across, 3 rows:
- consumed area = 1.1 × 6.0 = 6.60 m²
- waste = 0.60 m²
- billable = 6.30 m²

Expected winner: 3200 mm / 3 across.

### Case D — partial final row
Rolls: 3200
Job: 1000 × 1000 mm, qty 5
3 fit across.
- rows = 2
- consumed length = 2000 mm
- consumed area = 6.40 m²
- printed area = 5.00 m²
- waste = 1.40 m²
- billable = 5.70 m²

### Case E — two-piece split required
Rolls maximum: 5000 mm
Job: 5500 × 6000 mm, qty 1
No single-piece orientation fits.
Expected:
- return a valid 2-panel plan if possible
- `split=true`, `parts=2`
- carry a customer warning and production panel dimensions
- optimizer compares both split directions / valid roll combinations
Exact winning panel dimensions depend on seam allowance policy and must be deterministic for a given configured allowance.

### Case F — impossible even in two pieces
If a finished dimension cannot be made printable using two panels under the configured maximum roll set and split policy, return a structured blocked result with a human-readable reason key. Never silently clamp the requested size.

### Case G — waste factor changes price, not physical plan
Run the same job with waste factor 0.50 and 0.25.
Expected:
- physical layout remains unchanged if all material m² rates are equal across roll widths
- billable area/charge changes accordingly

### Case H — customer price group
Same physical job and material, Retail rate != Dealer rate.
Expected:
- exact same production layout
- different media charge based on authenticated customer's price list
- no browser-provided customer-group override accepted as authoritative

## Result shape (directional)
The engine should return a structured result similar to:

```ts
interface RollLayoutResult {
  valid: boolean;
  split: boolean;
  warnings: string[];
  printedAreaSqm: number;
  consumedAreaSqm: number;
  wasteAreaSqm: number;
  wasteFactor: number;
  billableAreaSqm: number;
  panels: Array<{
    widthMm: number;
    heightMm: number;
    quantity: number;
    rollWidthMm: number;
    rotated: boolean;
    across: number;
    rows: number;
    consumedLengthMm: number;
  }>;
  blocked?: { reason: string };
}
```

This is a domain result, not a UI model. Customer/staff wording should use i18n reason/warning keys around it.

## Test strategy
Unit tests should cover:
- every baseline case above
- zero/negative/non-finite dimensions and quantity
- unsorted/duplicate roll-width inputs
- exact-fit boundaries
- rotation ties
- final-row waste
- very large quantity
- two-piece split boundaries
- configurable seam allowance
- configurable waste factor
- deterministic tie-breaking
- money rounding happens after physical layout calculation

Property-style invariants worth asserting:
- consumedArea >= printedArea
- wasteArea >= 0
- billableArea is between printedArea and consumedArea when waste factor is in [0,1]
- every selected panel's across dimension <= its roll width
- output is identical for repeated identical input
- changing only price group/rate does not alter the physical winning layout when all candidate roll widths share the same rate basis
