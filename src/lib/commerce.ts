import type { Job } from './jobs.ts';

export type CataloguePricingMode = 'area' | 'unit';
export interface CatalogueProduct {
  id: string;
  revision: number;
  name: string;
  description: string;
  materialName: string;
  calculationMode: CataloguePricingMode;
  active: boolean;
  unitPriceCents: number;
  minimumOrderCents: number;
  eyeletPriceCents: number;
  weldPricePerMetreCents: number;
  hemPricePerMetreCents: number;
  taxRateBps: number;
  taxIncluded: boolean;
  leadDays: number;
}
export type CatalogueProductDraft = Omit<CatalogueProduct, 'id' | 'revision'>;
export interface CatalogueSelection {
  productId: string;
  productRevision: number;
  widthMm: number;
  heightMm: number;
  quantity: number;
  eyeletsPerItem: number;
  weldEdges: boolean;
  hemEdges: boolean;
}
/** Component prices use the product's tariff basis (inclusive or exclusive). */
export interface CatalogueQuoteLine extends CatalogueSelection {
  productName: string;
  materialName: string;
  calculationMode: CataloguePricingMode;
  unitPriceCents: number;
  minimumOrderCents: number;
  eyeletPriceCents: number;
  weldPricePerMetreCents: number;
  hemPricePerMetreCents: number;
  taxRateBps: number;
  taxIncluded: boolean;
  leadDays: number;
  /** Across the entire quantity. */
  areaSqm: number;
  perimeterMetres: number;
  baseCents: number;
  eyeletsCents: number;
  weldCents: number;
  hemCents: number;
  /** Sum of the four components, before an order-level minimum adjustment. */
  priceCents: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}
export interface CatalogueQuote {
  currency: 'TRY';
  lines: CatalogueQuoteLine[];
  taxRateBps: number;
  taxIncluded: boolean;
  /** Maximum selected product minimum, in the same tariff basis as prices. */
  minimumOrderCents: number;
  /** Order-level minimum adjustment, in the same tariff basis as prices. */
  minimumTopUpCents: number;
  minimumTopUpSubtotalCents: number;
  minimumTopUpTaxCents: number;
  minimumTopUpTotalCents: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}
export interface CatalogueOrderSubmission {
  requestKey: string;
  customer: { name: string; email: string };
  lines: CatalogueSelection[];
}
export interface CatalogueOrderLine extends CatalogueQuoteLine {
  jobRef: string;
  readyBy: string;
}
export interface CatalogueOrder {
  kind: 'catalogue';
  ref: string;
  customer: { name: string; email: string };
  placedOn: string;
  readyBy: string;
  currency: 'TRY';
  lines: CatalogueOrderLine[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  minimumTopUpCents: number;
}
export interface CatalogueReceipt { order: CatalogueOrder; jobs: Job[] }

export class DomainError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message = code) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.status = status;
  }
}

export const BANNER_PRODUCT_DRAFT: CatalogueProductDraft = {
  name: 'Branda', description: 'Özel ölçü branda baskı.', materialName: 'Branda',
  calculationMode: 'area', active: true, unitPriceCents: 15_000,
  minimumOrderCents: 50_000, eyeletPriceCents: 500,
  weldPricePerMetreCents: 2_000, hemPricePerMetreCents: 2_000,
  taxRateBps: 2_000, taxIncluded: false, leadDays: 3,
};

export const CATALOGUE_LIMITS = {
  maxLines: 50,
  maxQuantity: 10_000,
  maxDimensionMm: 100_000,
  maxEyeletsPerItem: 10_000,
  maxAreaSqm: 1_000_000,
  maxPerimeterMetres: 10_000_000,
  maxPriceCents: 1_000_000_000,
  // Fits PostgreSQL numeric(12, 2), including every job's price.
  maxAmountCents: 999_999_999_999,
} as const;

const DRAFT_FIELDS = [
  'name', 'description', 'materialName', 'calculationMode', 'active', 'unitPriceCents',
  'minimumOrderCents', 'eyeletPriceCents', 'weldPricePerMetreCents',
  'hemPricePerMetreCents', 'taxRateBps', 'taxIncluded', 'leadDays',
] as const;
const SELECTION_FIELDS = [
  'productId', 'productRevision', 'widthMm', 'heightMm', 'quantity',
  'eyeletsPerItem', 'weldEdges', 'hemEdges',
] as const;

function invalid(code: string, message: string): never {
  throw new DomainError(code, 400, message);
}

function record(value: unknown, fields: readonly string[], code: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !fields.includes(key))) {
    return invalid(code, 'Unexpected or invalid fields.');
  }
  return value as Record<string, unknown>;
}

function cleanText(value: unknown, maximum: number, code: string, required = true): string {
  if (typeof value !== 'string' || value.length > maximum
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    return invalid(code, 'Invalid text.');
  }
  const clean = value.trim();
  if (required && clean === '') return invalid(code, 'Required text is missing.');
  return clean;
}

function integer(value: unknown, minimum: number, maximum: number, code: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    return invalid(code, 'A whole number within the supported range is required.');
  }
  return value;
}

function boolean(value: unknown, code: string): boolean {
  if (typeof value !== 'boolean') return invalid(code, 'A boolean is required.');
  return value;
}

/** Price inputs are integer kuruş; no strings, floats or client totals are accepted. */
export function validateCatalogueProductDraft(value: unknown): CatalogueProductDraft {
  const code = 'INVALID_PRODUCT';
  const draft = record(value, DRAFT_FIELDS, code);
  if (draft.calculationMode !== 'area' && draft.calculationMode !== 'unit') {
    return invalid(code, 'Unknown calculation mode.');
  }
  return {
    name: cleanText(draft.name, 160, code),
    description: cleanText(draft.description, 4000, code, false),
    materialName: cleanText(draft.materialName, 160, code),
    calculationMode: draft.calculationMode,
    active: boolean(draft.active, code),
    unitPriceCents: integer(draft.unitPriceCents, 0, CATALOGUE_LIMITS.maxPriceCents, code),
    minimumOrderCents: integer(draft.minimumOrderCents, 0, CATALOGUE_LIMITS.maxAmountCents, code),
    eyeletPriceCents: integer(draft.eyeletPriceCents, 0, CATALOGUE_LIMITS.maxPriceCents, code),
    weldPricePerMetreCents: integer(draft.weldPricePerMetreCents, 0, CATALOGUE_LIMITS.maxPriceCents, code),
    hemPricePerMetreCents: integer(draft.hemPricePerMetreCents, 0, CATALOGUE_LIMITS.maxPriceCents, code),
    taxRateBps: integer(draft.taxRateBps, 0, 10_000, code),
    taxIncluded: boolean(draft.taxIncluded, code),
    leadDays: integer(draft.leadDays, 0, 365, code),
  };
}

function dimension(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1
    || value > CATALOGUE_LIMITS.maxDimensionMm
    || Math.abs(Math.round(value * 10) - value * 10) > 1e-7) {
    return invalid('INVALID_SELECTION', 'Dimensions must be 1–100000 mm with at most one decimal place.');
  }
  return Math.round(value * 10) / 10;
}

/** Dimensions also apply to unit-priced products because finishing uses the perimeter. */
export function validateCatalogueSelection(value: unknown): CatalogueSelection {
  const code = 'INVALID_SELECTION';
  const selection = record(value, SELECTION_FIELDS, code);
  return {
    productId: cleanText(selection.productId, 128, code),
    productRevision: integer(selection.productRevision, 0, 2_147_483_647, code),
    widthMm: dimension(selection.widthMm), heightMm: dimension(selection.heightMm),
    quantity: integer(selection.quantity, 1, CATALOGUE_LIMITS.maxQuantity, code),
    eyeletsPerItem: integer(selection.eyeletsPerItem, 0, CATALOGUE_LIMITS.maxEyeletsPerItem, code),
    weldEdges: boolean(selection.weldEdges, code), hemEdges: boolean(selection.hemEdges, code),
  };
}

export function validateCatalogueProduct(value: unknown): CatalogueProduct {
  const product = record(value, ['id', 'revision', ...DRAFT_FIELDS], 'INVALID_PRODUCT');
  const { id, revision, ...draft } = product;
  return {
    id: cleanText(id, 128, 'INVALID_PRODUCT'),
    revision: integer(revision, 0, 2_147_483_647, 'INVALID_PRODUCT'),
    ...validateCatalogueProductDraft(draft),
  };
}

/** Round a nonnegative rational to the nearest kuruş, halves upward. */
function rounded(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator / 2n) / denominator;
}

function amount(value: bigint): number {
  if (value < 0n || value > BigInt(CATALOGUE_LIMITS.maxAmountCents)) {
    return invalid('AMOUNT_LIMIT', 'The calculated amount exceeds the supported range.');
  }
  return Number(value);
}

/**
 * Quote a whole order against current, authoritative product revisions.
 * Each component rounds once. The maximum product minimum is applied once to
 * the sum, in the tariff's own tax basis; tax is then added or extracted.
 */
export function quoteCatalogue(
  products: readonly CatalogueProduct[],
  selections: readonly CatalogueSelection[],
): CatalogueQuote {
  if (!Array.isArray(products) || !Array.isArray(selections) || selections.length === 0
    || selections.length > CATALOGUE_LIMITS.maxLines) {
    return invalid('INVALID_SELECTION', 'An order must contain 1–50 lines.');
  }
  const byId = new Map<string, CatalogueProduct>();
  for (const value of products) {
    const product = validateCatalogueProduct(value);
    if (byId.has(product.id)) return invalid('INVALID_PRODUCT', 'Duplicate product identifiers.');
    byId.set(product.id, product);
  }
  let totalArea = 0n;
  let totalPerimeter = 0n;
  const lines = selections.map((value): CatalogueQuoteLine => {
    const selection = validateCatalogueSelection(value);
    const product = byId.get(selection.productId);
    if (product === undefined) throw new DomainError('PRODUCT_NOT_FOUND', 404, 'Product not found.');
    if (selection.productRevision !== product.revision) throw new DomainError('CONFLICT', 409, 'The product has changed. Request a new quote.');
    if (!product.active) throw new DomainError('PRODUCT_UNAVAILABLE', 409, 'The product is not available for new orders.');
    const width = BigInt(Math.round(selection.widthMm * 10));
    const height = BigInt(Math.round(selection.heightMm * 10));
    const quantity = BigInt(selection.quantity);
    const area = width * height * quantity; // 1/100 square millimetres.
    const perimeter = 2n * (width + height) * quantity; // 1/10 millimetres.
    totalArea += area;
    totalPerimeter += perimeter;
    if (totalArea > BigInt(CATALOGUE_LIMITS.maxAreaSqm) * 100_000_000n
      || totalPerimeter > BigInt(CATALOGUE_LIMITS.maxPerimeterMetres) * 10_000n) {
      return invalid('GEOMETRY_LIMIT', 'The total area or perimeter exceeds the supported range.');
    }
    const baseCents = amount(product.calculationMode === 'area'
      ? rounded(area * BigInt(product.unitPriceCents), 100_000_000n)
      : quantity * BigInt(product.unitPriceCents));
    const eyeletsCents = amount(quantity * BigInt(selection.eyeletsPerItem) * BigInt(product.eyeletPriceCents));
    const weldCents = amount(selection.weldEdges
      ? rounded(perimeter * BigInt(product.weldPricePerMetreCents), 10_000n) : 0n);
    const hemCents = amount(selection.hemEdges
      ? rounded(perimeter * BigInt(product.hemPricePerMetreCents), 10_000n) : 0n);
    const priceCents = amount(BigInt(baseCents) + BigInt(eyeletsCents) + BigInt(weldCents) + BigInt(hemCents));
    return {
      ...selection, productName: product.name, materialName: product.materialName,
      calculationMode: product.calculationMode, unitPriceCents: product.unitPriceCents,
      minimumOrderCents: product.minimumOrderCents,
      eyeletPriceCents: product.eyeletPriceCents,
      weldPricePerMetreCents: product.weldPricePerMetreCents,
      hemPricePerMetreCents: product.hemPricePerMetreCents,
      taxRateBps: product.taxRateBps, taxIncluded: product.taxIncluded, leadDays: product.leadDays,
      areaSqm: Number(area) / 100_000_000, perimeterMetres: Number(perimeter) / 10_000,
      baseCents, eyeletsCents, weldCents, hemCents, priceCents,
      subtotalCents: 0, taxCents: 0, totalCents: 0,
    };
  });
  const { taxRateBps, taxIncluded } = lines[0]!;
  if (lines.some((line) => line.taxRateBps !== taxRateBps || line.taxIncluded !== taxIncluded)) {
    return invalid('MIXED_TAX_POLICY', 'All lines in an order must use the same tax rate and inclusion policy.');
  }
  const minimumOrderCents = Math.max(...lines.map((line) => line.minimumOrderCents));
  const goods = lines.reduce((sum, line) => sum + BigInt(line.priceCents), 0n);
  const minimumTopUpCents = amount(goods < BigInt(minimumOrderCents) ? BigInt(minimumOrderCents) - goods : 0n);
  const priced = goods + BigInt(minimumTopUpCents);
  const subtotalCents = amount(taxIncluded ? rounded(priced * 10_000n, 10_000n + BigInt(taxRateBps)) : priced);
  const taxCents = amount(taxIncluded ? priced - BigInt(subtotalCents) : rounded(priced * BigInt(taxRateBps), 10_000n));
  const totalCents = amount(BigInt(subtotalCents) + BigInt(taxCents));

  // Allocate order tax deterministically so line amounts plus the minimum
  // adjustment add back to the receipt exactly, including one-kuruş rounding.
  let cumulative = 0n;
  let allocated = 0n;
  const parts = [...lines.map((line) => line.priceCents), minimumTopUpCents].map((price) => {
    cumulative += BigInt(price);
    const through = priced === 0n ? 0n : rounded(cumulative * BigInt(taxCents), priced);
    const tax = amount(through - allocated);
    allocated = through;
    return taxIncluded
      ? { subtotalCents: price - tax, taxCents: tax, totalCents: price }
      : { subtotalCents: price, taxCents: tax, totalCents: amount(BigInt(price) + BigInt(tax)) };
  });
  lines.forEach((line, index) => Object.assign(line, parts[index]));
  const topUp = parts.at(-1)!;
  return {
    currency: 'TRY', lines, taxRateBps, taxIncluded, minimumOrderCents,
    minimumTopUpCents, minimumTopUpSubtotalCents: topUp.subtotalCents,
    minimumTopUpTaxCents: topUp.taxCents, minimumTopUpTotalCents: topUp.totalCents,
    subtotalCents, taxCents, totalCents,
  };
}
