import { describe, expect, it } from 'vitest';
import { dashboardPage, dashboardRow } from '../src/dashboard.js';

function place(overrides = {}) {
  return {
    id: 'row-1',
    placeId: 'place-1',
    name: 'Boulangerie du Port',
    address: '12 quai du Port, 83270 Saint-Cyr-sur-Mer',
    city: 'Saint-Cyr-sur-Mer',
    types: ['bakery', 'food'],
    status: 'to_visit',
    saleAmount: null,
    ...overrides,
  };
}

describe('dashboardRow', () => {
  it('shows the name, address, commune, type and statut of an établissement', () => {
    expect(dashboardRow(place())).toEqual({
      placeId: 'place-1',
      name: 'Boulangerie du Port',
      address: '12 quai du Port, 83270 Saint-Cyr-sur-Mer',
      city: 'Saint-Cyr-sur-Mer',
      type: 'bakery',
      status: 'to_visit',
      statusLabel: 'À visiter',
      saleAmount: '',
    });
  });

  it('shows the sale amount of a vendu établissement, in euros', () => {
    const row = dashboardRow(place({ status: 'sold', saleAmount: 1250 }));
    expect(row.statusLabel).toBe('Vendu');
    expect(row.saleAmount.replace(/\s/g, ' ')).toBe('1 250,00 €');
  });

  it('shows a vendu établissement sold for nothing as 0 €, not as blank', () => {
    expect(dashboardRow(place({ status: 'sold', saleAmount: 0 })).saleAmount.replace(/\s/g, ' ')).toBe('0,00 €');
  });

  it('shows no sale amount for an établissement that is not vendu, even one that once was', () => {
    expect(dashboardRow(place({ status: 'refused', saleAmount: 50 })).saleAmount).toBe('');
  });

  it('leaves the commune empty when the address yielded none', () => {
    expect(dashboardRow(place({ city: null })).city).toBe('');
  });

  it('reads the type as words, falling back to Autre when Google gave nothing distinctive', () => {
    expect(dashboardRow(place({ types: ['point_of_interest', 'real_estate_agency'] })).type).toBe('real estate agency');
    expect(dashboardRow(place({ types: ['establishment'] })).type).toBe('Autre');
  });
});

function tracked(count) {
  return Array.from({ length: count }, (_, index) => place({ id: `row-${index + 1}`, placeId: `place-${index + 1}`, name: `Établissement ${index + 1}` }));
}

const names = (view) => view.rows.map((row) => row.name);

describe('dashboardPage', () => {
  it('shows the requested page of the tracked list, in the order it was given', () => {
    const view = dashboardPage(tracked(60), { page: 2, pageSize: 25 });
    expect(names(view)).toEqual(Array.from({ length: 25 }, (_, index) => `Établissement ${26 + index}`));
    expect(view).toMatchObject({ page: 2, totalPages: 3, total: 60, first: 26, last: 50 });
  });

  it('falls back to the last page when the requested one no longer exists, e.g. after showing more rows per page', () => {
    const view = dashboardPage(tracked(60), { page: 3, pageSize: 50 });
    expect(names(view)).toEqual(Array.from({ length: 10 }, (_, index) => `Établissement ${51 + index}`));
    expect(view).toMatchObject({ page: 2, totalPages: 2, first: 51, last: 60 });
  });

  it('shows an empty first page when nothing is tracked yet', () => {
    expect(dashboardPage([], { page: 4, pageSize: 25 })).toEqual({ rows: [], page: 1, totalPages: 1, total: 0, first: 0, last: 0 });
  });

  it('lists every tracked établissement across its pages, each exactly once', () => {
    const list = tracked(401);
    const seen = [];
    for (let page = 1; page <= 5; page++) seen.push(...names(dashboardPage(list, { page, pageSize: 100 })));
    expect(seen).toEqual(list.map((item) => item.name));
  });
});
