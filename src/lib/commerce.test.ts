import { describe, expect, it } from 'vitest';

import {
  BANNER_PRODUCT_DRAFT, CATALOGUE_LIMITS, DomainError, quoteCatalogue,
  validateCatalogueProductDraft, validateCatalogueSelection,
  type CatalogueProduct, type CatalogueQuote, type CatalogueSelection,
} from './commerce.ts';

function product(patch: Partial<CatalogueProduct> = {}): CatalogueProduct {
  return { ...BANNER_PRODUCT_DRAFT, id: 'banner', revision: 3, ...patch };
}
function selection(patch: Partial<CatalogueSelection> = {}): CatalogueSelection {
  return {
    productId: 'banner', productRevision: 3, widthMm: 1000, heightMm: 1000,
    quantity: 1, eyeletsPerItem: 0, weldEdges: false, hemEdges: false, ...patch,
  };
}
function reconciles(quote: CatalogueQuote): void {
  expect(quote.lines.reduce((sum, line) => sum + line.subtotalCents, quote.minimumTopUpSubtotalCents)).toBe(quote.subtotalCents);
  expect(quote.lines.reduce((sum, line) => sum + line.taxCents, quote.minimumTopUpTaxCents)).toBe(quote.taxCents);
  expect(quote.lines.reduce((sum, line) => sum + line.totalCents, quote.minimumTopUpTotalCents)).toBe(quote.totalCents);
  expect(quote.subtotalCents + quote.taxCents).toBe(quote.totalCents);
  for (const line of quote.lines) {
    expect(line.baseCents + line.eyeletsCents + line.weldCents + line.hemCents).toBe(line.priceCents);
    expect(line.subtotalCents + line.taxCents).toBe(line.totalCents);
  }
}

describe('catalogue pricing', () => {
  it('uses the confirmed net banner tariff and applies the 500 TL minimum before 20% VAT', () => {
    expect(BANNER_PRODUCT_DRAFT).toMatchObject({
      unitPriceCents: 15_000, minimumOrderCents: 50_000, eyeletPriceCents: 500,
      weldPricePerMetreCents: 2000, hemPricePerMetreCents: 2000,
      taxRateBps: 2000, taxIncluded: false,
    });
    const quote = quoteCatalogue([product()], [selection()]);
    expect(quote).toMatchObject({ currency: 'TRY', minimumTopUpCents: 35_000, subtotalCents: 50_000, taxCents: 10_000, totalCents: 60_000 });
    expect(quote.lines[0]).toMatchObject({ areaSqm: 1, perimeterMetres: 4, baseCents: 15_000, eyeletsCents: 0, weldCents: 0, hemCents: 0 });
    reconciles(quote);
  });

  it('charges eyelets per item and each selected perimeter treatment independently across quantity', () => {
    const quote = quoteCatalogue([product()], [selection({
      widthMm: 2000, heightMm: 1000, quantity: 2, eyeletsPerItem: 4, weldEdges: true, hemEdges: true,
    })]);
    expect(quote.lines[0]).toMatchObject({
      areaSqm: 4, perimeterMetres: 12, baseCents: 60_000,
      eyeletsCents: 4000, weldCents: 24_000, hemCents: 24_000,
    });
    expect(quote).toMatchObject({ minimumTopUpCents: 0, subtotalCents: 112_000, taxCents: 22_400, totalCents: 134_400 });
    reconciles(quote);
  });

  it('rounds each component once using the full tenths-of-a-millimetre dimensions', () => {
    const quote = quoteCatalogue([product({ minimumOrderCents: 0 })], [selection({
      widthMm: 333.3, heightMm: 1000, quantity: 3, weldEdges: true,
    })]);
    expect(quote.lines[0]).toMatchObject({ areaSqm: 0.9999, perimeterMetres: 7.9998, baseCents: 14_999, weldCents: 16_000 });
    expect(quote).toMatchObject({ subtotalCents: 30_999, taxCents: 6200, totalCents: 37_199 });
    reconciles(quote);
  });

  it('prices unit products by count while retaining physical dimensions for finishing', () => {
    const quote = quoteCatalogue([product({ calculationMode: 'unit', unitPriceCents: 1250, minimumOrderCents: 0 })], [selection({
      widthMm: 2000, heightMm: 1000, quantity: 3, hemEdges: true,
    })]);
    expect(quote.lines[0]).toMatchObject({ baseCents: 3750, hemCents: 36_000, areaSqm: 6, perimeterMetres: 18 });
    expect(quote.totalCents).toBe(47_700);
    reconciles(quote);
  });

  it('applies one maximum selected-product minimum after summing a mixed-product basket', () => {
    const first = product({ calculationMode: 'unit', unitPriceCents: 20_000, minimumOrderCents: 30_000 });
    const second = product({ id: 'second', calculationMode: 'unit', unitPriceCents: 20_000, minimumOrderCents: 50_000 });
    const unused = product({ id: 'unused', minimumOrderCents: 900_000, taxIncluded: true });
    const quote = quoteCatalogue([first, second, unused], [selection(), selection({ productId: 'second' })]);
    expect(quote).toMatchObject({ minimumOrderCents: 50_000, minimumTopUpCents: 10_000, subtotalCents: 50_000, taxCents: 10_000, totalCents: 60_000 });
    expect(quote.lines.map((line) => line.priceCents)).toEqual([20_000, 20_000]);
    reconciles(quote);
  });

  it('adds repeated lines before applying the order minimum', () => {
    const quote = quoteCatalogue([product()], [selection(), selection()]);
    expect(quote.minimumTopUpCents).toBe(20_000);
    expect(quote.totalCents).toBe(60_000);
    reconciles(quote);
  });

  it('extracts included VAT without adding it again or increasing an inclusive minimum', () => {
    const quote = quoteCatalogue([product({ taxIncluded: true })], [selection()]);
    expect(quote).toMatchObject({ minimumTopUpCents: 35_000, subtotalCents: 41_667, taxCents: 8333, totalCents: 50_000 });
    reconciles(quote);
  });

  it('allocates inclusive one-kuruş tax rounding so every line adds to the exact receipt', () => {
    const quote = quoteCatalogue([product({ calculationMode: 'unit', unitPriceCents: 100, minimumOrderCents: 0, taxIncluded: true })], [selection(), selection()]);
    expect(quote).toMatchObject({ subtotalCents: 167, taxCents: 33, totalCents: 200 });
    expect(quote.lines.map((line) => line.totalCents)).toEqual([100, 100]);
    reconciles(quote);
  });

  it('handles zero-price and zero-tax products without invalid arithmetic', () => {
    const quote = quoteCatalogue([product({ unitPriceCents: 0, minimumOrderCents: 0, taxRateBps: 0 })], [selection()]);
    expect(quote).toMatchObject({ minimumTopUpCents: 0, subtotalCents: 0, taxCents: 0, totalCents: 0 });
    reconciles(quote);
  });

  it('snapshots customer selections, names, materials and the complete tariff independently of later edits', () => {
    const current = product();
    const selected = selection({ eyeletsPerItem: 2 });
    const quote = quoteCatalogue([current], [selected]);
    const original = structuredClone(quote);
    current.name = 'Changed';
    current.materialName = 'Changed';
    current.unitPriceCents = 1;
    current.minimumOrderCents = 0;
    current.taxRateBps = 0;
    selected.widthMm = 999;
    selected.eyeletsPerItem = 10;
    expect(quote).toEqual(original);
    expect(quote.lines[0]).toMatchObject({
      productName: 'Branda', materialName: 'Branda', calculationMode: 'area',
      productRevision: 3, widthMm: 1000, eyeletsPerItem: 2,
      unitPriceCents: 15_000, minimumOrderCents: 50_000,
      eyeletPriceCents: 500, weldPricePerMetreCents: 2000, hemPricePerMetreCents: 2000,
      taxRateBps: 2000, taxIncluded: false, leadDays: 3,
    });
  });
});

describe('catalogue input and revision validation', () => {
  it('rejects stale, removed and inactive products with typed errors', () => {
    expect(() => quoteCatalogue([product()], [selection({ productRevision: 2 })])).toThrowError(DomainError);
    try { quoteCatalogue([product()], [selection({ productRevision: 2 })]); }
    catch (error) { expect(error).toMatchObject({ code: 'CONFLICT', status: 409 }); }
    expect(() => quoteCatalogue([], [selection()])).toThrowError('Product not found');
    expect(() => quoteCatalogue([product({ active: false })], [selection()])).toThrowError('not available');
  });

  it('treats prototype-like identifiers as ordinary product keys', () => {
    for (const id of ['__proto__', 'constructor', 'toString']) {
      const quote = quoteCatalogue([product({ id })], [selection({ productId: id })]);
      expect(quote.lines[0]!.productId).toBe(id);
      expect(quote.totalCents).toBe(60_000);
    }
    expect(() => quoteCatalogue([product()], [selection({ productId: '__proto__' })])).toThrowError('Product not found');
  });

  it('rejects inconsistent tax rates and inclusion policies within one order', () => {
    for (const patch of [{ taxRateBps: 1000 }, { taxIncluded: true }]) {
      expect(() => quoteCatalogue([product(), product({ id: 'second', ...patch })], [selection(), selection({ productId: 'second' })]))
        .toThrowError('same tax rate');
    }
  });

  it('validates strict drafts and refuses forged identifiers, revisions and fractional minor units', () => {
    expect(validateCatalogueProductDraft({ ...BANNER_PRODUCT_DRAFT, name: ' Branda ', description: ' ' }).name).toBe('Branda');
    const invalid = [
      { id: 'forged' }, { revision: 4 }, { name: ' ' }, { materialName: '' },
      { unitPriceCents: -1 }, { unitPriceCents: 1.2 }, { unitPriceCents: NaN },
      { minimumOrderCents: Infinity }, { eyeletPriceCents: Number.MAX_SAFE_INTEGER },
      { taxRateBps: 10_001 }, { taxIncluded: 'false' }, { active: 'true' },
      { leadDays: -1 }, { leadDays: 366 }, { calculationMode: 'unknown' },
    ];
    for (const patch of invalid) expect(() => validateCatalogueProductDraft({ ...BANNER_PRODUCT_DRAFT, ...patch })).toThrowError(DomainError);
  });

  it('bounds dimensions, precision, counts and finishing values and refuses client totals', () => {
    const invalid = [
      { widthMm: 0 }, { widthMm: NaN }, { heightMm: Infinity },
      { widthMm: 100_000.1 }, { widthMm: 1000.01 },
      { quantity: 0 }, { quantity: 1.5 }, { quantity: 10_001 },
      { eyeletsPerItem: -1 }, { eyeletsPerItem: 0.5 }, { eyeletsPerItem: 10_001 },
      { weldEdges: 'false' }, { hemEdges: 1 }, { productRevision: -1 },
      { totalCents: 1 },
    ];
    for (const patch of invalid) expect(() => validateCatalogueSelection({ ...selection(), ...patch })).toThrowError(DomainError);
    expect(validateCatalogueSelection(selection({ widthMm: 1.1, heightMm: 100_000, quantity: 10_000 }))).toMatchObject({ widthMm: 1.1, quantity: 10_000 });
  });

  it('rejects empty and oversized orders without relying on UI validation', () => {
    expect(() => quoteCatalogue([product()], [])).toThrowError('1–50');
    expect(() => quoteCatalogue([product()], Array.from({ length: CATALOGUE_LIMITS.maxLines + 1 }, () => selection()))).toThrowError('1–50');
  });

  it('bounds the aggregate area and perimeter across the whole order', () => {
    const free = product({ unitPriceCents: 0, minimumOrderCents: 0 });
    const areaLimit = selection({ widthMm: 100_000, heightMm: 100_000, quantity: 100 });
    expect(quoteCatalogue([free], [areaLimit]).lines[0]!.areaSqm).toBe(CATALOGUE_LIMITS.maxAreaSqm);
    expect(() => quoteCatalogue([free], [areaLimit, selection()])).toThrowError('total area or perimeter');
    const long = selection({ widthMm: 100_000, heightMm: 1, quantity: 10_000 });
    expect(() => quoteCatalogue([free], [long, long, long, long, long])).toThrowError('total area or perimeter');
  });

  it('refuses overflowing components, aggregate totals and VAT-inclusive database limits', () => {
    expect(() => quoteCatalogue([product({ calculationMode: 'unit', unitPriceCents: 1_000_000_000 })], [selection({ quantity: 10_000 })]))
      .toThrowError('amount exceeds');
    const large = product({ calculationMode: 'unit', unitPriceCents: 100_000_000, taxRateBps: 0 });
    expect(() => quoteCatalogue([large], [selection({ quantity: 5000 }), selection({ quantity: 5000 })])).toThrowError('amount exceeds');
    expect(() => quoteCatalogue([product({ unitPriceCents: 0, minimumOrderCents: CATALOGUE_LIMITS.maxAmountCents })], [selection()]))
      .toThrowError('amount exceeds');
  });
});
