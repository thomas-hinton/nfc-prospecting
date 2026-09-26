import { describe, expect, it } from 'vitest';
import { NO_CITY, SORT_COMPARATORS, dashboardPage, dashboardRow, filterMenus, matchesFilters, sortPlaces } from '../src/dashboard.js';

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

describe('matchesFilters', () => {
  const inPort = place({ placeId: 'a', city: 'Saint-Cyr-sur-Mer', types: ['bakery'], status: 'to_visit' });
  const inBandol = place({ placeId: 'b', city: 'Bandol', types: ['restaurant'], status: 'sold' });
  const nowhere = place({ placeId: 'c', city: null, types: ['bakery'], status: 'sold' });
  const all = [inPort, inBandol, nowhere];
  const kept = (filters) => all.filter((item) => matchesFilters(item, filters)).map((item) => item.placeId);

  it('keeps every établissement when no filter is chosen', () => {
    expect(kept({})).toEqual(['a', 'b', 'c']);
  });

  it('filtering to a commune leaves only that commune’s établissements', () => {
    expect(kept({ city: 'Bandol' })).toEqual(['b']);
  });

  it('filtering to "sans commune" leaves only the établissements whose commune is unset', () => {
    expect(kept({ city: NO_CITY })).toEqual(['c']);
  });

  it('filters by type and by statut, each narrowing the other', () => {
    expect(kept({ type: 'bakery' })).toEqual(['a', 'c']);
    expect(kept({ status: 'sold' })).toEqual(['b', 'c']);
    expect(kept({ type: 'bakery', status: 'sold' })).toEqual(['c']);
  });
});

describe('filterMenus', () => {
  const tracked = [
    place({ placeId: 'a', city: 'Saint-Cyr-sur-Mer', types: ['bakery'], status: 'to_visit' }),
    place({ placeId: 'b', city: 'Bandol', types: ['restaurant'], status: 'sold' }),
    place({ placeId: 'c', city: null, types: ['bakery'], status: 'sold' }),
    place({ placeId: 'd', city: 'Évenos', types: ['hair_care'], status: 'to_visit' }),
    place({ placeId: 'e', city: 'Bandol', types: ['bakery'], status: 'refused' }),
  ];
  const values = (options) => options.map((option) => option.value);

  it('offers every commune, French-collated, with "sans commune" last, when nothing is chosen', () => {
    const { cities } = filterMenus(tracked, {});
    expect(cities).toEqual([
      { value: 'Bandol', label: 'Bandol' },
      { value: 'Évenos', label: 'Évenos' },
      { value: 'Saint-Cyr-sur-Mer', label: 'Saint-Cyr-sur-Mer' },
      { value: NO_CITY, label: 'Sans commune' },
    ]);
  });

  it('offers every type as words, French-collated, when nothing is chosen', () => {
    expect(filterMenus(tracked, {}).types).toEqual([
      { value: 'bakery', label: 'bakery' },
      { value: 'hair_care', label: 'hair care' },
      { value: 'restaurant', label: 'restaurant' },
    ]);
  });

  it('offers only the communes that still have établissements of the chosen type and statut', () => {
    expect(values(filterMenus(tracked, { type: 'bakery' }).cities)).toEqual(['Bandol', 'Saint-Cyr-sur-Mer', NO_CITY]);
    expect(values(filterMenus(tracked, { type: 'bakery', status: 'sold' }).cities)).toEqual([NO_CITY]);
  });

  it('offers only the types that still have établissements in the chosen commune and statut', () => {
    expect(values(filterMenus(tracked, { city: 'Bandol' }).types)).toEqual(['bakery', 'restaurant']);
    expect(values(filterMenus(tracked, { city: 'Bandol', status: 'sold' }).types)).toEqual(['restaurant']);
  });

  it('keeps a commune and a type that still yield results', () => {
    expect(filterMenus(tracked, { city: 'Bandol', type: 'bakery', status: null }).filters).toEqual({ city: 'Bandol', type: 'bakery', status: null });
  });

  it('resets a commune that no longer yields any établissement once the statut changes', () => {
    expect(filterMenus(tracked, { city: 'Évenos', status: 'sold' }).filters).toEqual({ city: null, type: null, status: 'sold' });
  });

  it('resets a type that no longer yields any établissement in the chosen commune', () => {
    expect(filterMenus(tracked, { city: 'Évenos', type: 'bakery' }).filters).toEqual({ city: 'Évenos', type: null, status: null });
  });

  it('narrows the menus under the filters as they stand after a reset', () => {
    const menus = filterMenus(tracked, { city: 'Évenos', type: 'restaurant', status: 'sold' });
    expect(menus.filters).toEqual({ city: null, type: 'restaurant', status: 'sold' });
    expect(values(menus.cities)).toEqual(['Bandol']);
    expect(values(menus.types)).toEqual(['bakery', 'restaurant']);
  });

  it('keeps every statut on offer, in pipeline order, each counted under the commune and type filters — an empty stage at zero', () => {
    expect(filterMenus(tracked, { city: 'Bandol' }).statuses).toEqual([
      { value: 'to_visit', label: 'À visiter', count: 0 },
      { value: 'scheduled', label: 'Programmé pour visite', count: 0 },
      { value: 'sold', label: 'Vendu', count: 1 },
      { value: 'refused', label: 'Refusé', count: 1 },
      { value: 'non_compliant', label: 'Non conforme', count: 0 },
    ]);
  });

  it('keeps a statut chosen even when it has no établissement', () => {
    const menus = filterMenus(tracked, { status: 'scheduled' });
    expect(menus.filters.status).toBe('scheduled');
    expect(menus.statuses.find((option) => option.value === 'scheduled').count).toBe(0);
  });

  it('counts each statut whatever statut is chosen', () => {
    expect(filterMenus(tracked, { city: 'Bandol', status: 'sold' }).statuses.map((option) => option.count)).toEqual([0, 0, 1, 1, 0]);
  });
});

describe('sortPlaces', () => {
  const tracked = [
    place({ placeId: 'a', name: 'éclair gourmand', city: 'Saint-Cyr-sur-Mer', types: ['bakery'], status: 'to_visit', createdAt: '2026-09-02T09:00:00Z', statusChangedAt: '2026-09-20T09:00:00Z' }),
    place({ placeId: 'b', name: 'Atelier 10', city: 'Bandol', types: ['restaurant'], status: 'sold', createdAt: '2026-09-01T09:00:00Z', statusChangedAt: '2026-09-03T09:00:00Z' }),
    place({ placeId: 'c', name: 'Atelier 9', city: 'Évenos', types: ['hair_care'], status: 'refused', createdAt: '2026-09-10T09:00:00Z', statusChangedAt: '2026-09-11T09:00:00Z' }),
    place({ placeId: 'd', name: 'Zinc', city: 'Bandol', types: ['bar'], status: 'non_compliant', createdAt: '2026-09-05T09:00:00Z', statusChangedAt: '2026-09-25T09:00:00Z' }),
  ];
  const order = (sort) => sortPlaces(tracked, sort).map((item) => item.placeId);

  it('sorts by name the French way: accents and case ignored, numbers read as numbers', () => {
    expect(order({ key: 'name', direction: 'asc' })).toEqual(['c', 'b', 'a', 'd']);
  });

  it('sorts by commune the French way, É among the E', () => {
    expect(order({ key: 'city', direction: 'asc' })).toEqual(['b', 'd', 'c', 'a']);
  });

  it('sorts by type, read as words', () => {
    expect(order({ key: 'type', direction: 'asc' })).toEqual(['a', 'd', 'c', 'b']);
  });

  it('sorts by statut, French-collated', () => {
    expect(order({ key: 'status', direction: 'asc' })).toEqual(['a', 'd', 'c', 'b']);
  });

  it('sorts by date added and by date of last statut change', () => {
    expect(order({ key: 'createdAt', direction: 'asc' })).toEqual(['b', 'a', 'd', 'c']);
    expect(order({ key: 'statusChangedAt', direction: 'asc' })).toEqual(['b', 'c', 'a', 'd']);
  });

  it('offers every sort descending too', () => {
    expect(order({ key: 'name', direction: 'desc' })).toEqual(['d', 'a', 'b', 'c']);
    expect(order({ key: 'createdAt', direction: 'desc' })).toEqual(['c', 'd', 'a', 'b']);
  });

  it('keeps établissements that tie in the order they were given', () => {
    expect(order({ key: 'city', direction: 'desc' })).toEqual(['a', 'c', 'b', 'd']);
  });

  it('leaves the list it was given untouched', () => {
    sortPlaces(tracked, { key: 'name', direction: 'desc' });
    expect(tracked.map((item) => item.placeId)).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('SORT_COMPARATORS', () => {
  it('puts an établissement with no commune after every commune', () => {
    const list = [place({ placeId: 'x', city: null }), place({ placeId: 'y', city: 'Toulon' }), place({ placeId: 'z', city: 'Bandol' })];
    expect([...list].sort(SORT_COMPARATORS.city).map((item) => item.placeId)).toEqual(['z', 'y', 'x']);
  });
});
