import { describe, expect, it } from 'vitest';
import { BULK_STATUSES, NO_CITY, SORT_COMPARATORS, bulkImpact, dashboardMetrics, dashboardPage, dashboardRow, filterMenus, filtersSet, matchesFilters, pruneSelection, resetFilters, sortPlaces } from '../src/dashboard.js';

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

  it('filters by type and by statut, and by both at once', () => {
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

  it('offers no "sans commune" entry when every établissement has a commune', () => {
    expect(values(filterMenus(tracked.filter((item) => item.city), {}).cities)).toEqual(['Bandol', 'Évenos', 'Saint-Cyr-sur-Mer']);
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

  it('resets a type that no longer yields any établissement in the chosen commune, keeping the commune', () => {
    expect(filterMenus(tracked, { city: 'Évenos', type: 'bakery' }).filters).toEqual({ city: 'Évenos', type: null, status: null });
  });

  it('resets a commune no établissement is in any more', () => {
    expect(filterMenus(tracked, { city: 'Toulon', type: 'bakery' }).filters).toEqual({ city: null, type: 'bakery', status: null });
  });

  it('keeps every statut on offer, in pipeline order, each counted under the commune and type filters — an empty stage at zero, greyed out', () => {
    expect(filterMenus(tracked, { city: 'Bandol' }).statuses).toEqual([
      { value: 'to_visit', label: 'À visiter', count: 0, disabled: true },
      { value: 'scheduled', label: 'Programmé pour visite', count: 0, disabled: true },
      { value: 'sold', label: 'Vendu', count: 1, disabled: false },
      { value: 'refused', label: 'Refusé', count: 1, disabled: false },
      { value: 'non_compliant', label: 'Non conforme', count: 0, disabled: true },
    ]);
  });

  it('never leaves an empty list: a statut with nothing left under the commune and type resets, the commune stays', () => {
    const menus = filterMenus(tracked, { city: 'Évenos', status: 'sold' });
    expect(menus.filters).toEqual({ city: 'Évenos', type: null, status: null });
    expect(tracked.filter((item) => matchesFilters(item, menus.filters)).map((item) => item.placeId)).toEqual(['d']);
  });

  it('keeps the commune over both the type and the statut when none of them fit together any more', () => {
    const menus = filterMenus(tracked, { city: 'Évenos', type: 'restaurant', status: 'sold' });
    expect(menus.filters).toEqual({ city: 'Évenos', type: null, status: null });
    expect(values(menus.cities)).toEqual(['Bandol', 'Évenos', 'Saint-Cyr-sur-Mer', NO_CITY]);
    expect(values(menus.types)).toEqual(['hair_care']);
  });

  it('leaves no combination of commune, type and statut that lists nothing, however stale the chosen values', () => {
    const cities = [null, 'Bandol', 'Évenos', 'Saint-Cyr-sur-Mer', 'Toulon', NO_CITY];
    const types = [null, 'bakery', 'restaurant', 'hair_care', 'florist'];
    const statuses = [null, 'to_visit', 'scheduled', 'sold', 'refused', 'non_compliant'];
    for (const city of cities) {
      for (const type of types) {
        for (const status of statuses) {
          const { filters } = filterMenus(tracked, { city, type, status });
          expect(tracked.some((item) => matchesFilters(item, filters)), JSON.stringify({ city, type, status })).toBe(true);
        }
      }
    }
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

  it('sorts by statut in pipeline order: à visiter, programmé, vendu, refusé, non conforme', () => {
    expect(order({ key: 'status', direction: 'asc' })).toEqual(['a', 'b', 'c', 'd']);
  });

  it('sorts by date added and by date of last statut change', () => {
    expect(order({ key: 'createdAt', direction: 'asc' })).toEqual(['b', 'a', 'd', 'c']);
    expect(order({ key: 'statusChangedAt', direction: 'asc' })).toEqual(['b', 'c', 'a', 'd']);
  });

  it('offers every sort descending too', () => {
    expect(order({ key: 'name', direction: 'desc' })).toEqual(['d', 'a', 'b', 'c']);
    expect(order({ key: 'type', direction: 'desc' })).toEqual(['b', 'c', 'd', 'a']);
    expect(order({ key: 'status', direction: 'desc' })).toEqual(['d', 'c', 'b', 'a']);
    expect(order({ key: 'createdAt', direction: 'desc' })).toEqual(['c', 'd', 'a', 'b']);
    expect(order({ key: 'statusChangedAt', direction: 'desc' })).toEqual(['d', 'a', 'c', 'b']);
  });

  it('lists the établissements with no commune after every commune, and first when sorting descending', () => {
    const list = [place({ placeId: 'x', city: null }), place({ placeId: 'y', city: 'Toulon' }), place({ placeId: 'z', city: 'Bandol' })];
    expect(sortPlaces(list, { key: 'city', direction: 'asc' }).map((item) => item.placeId)).toEqual(['z', 'y', 'x']);
    expect(sortPlaces(list, { key: 'city', direction: 'desc' }).map((item) => item.placeId)).toEqual(['x', 'y', 'z']);
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
  const sortedWith = (compare, list) => [...list].sort(compare).map((item) => item.placeId);

  it('puts an établissement with no commune after every commune', () => {
    const list = [place({ placeId: 'x', city: null }), place({ placeId: 'y', city: 'Toulon' }), place({ placeId: 'z', city: 'Bandol' })];
    expect(sortedWith(SORT_COMPARATORS.city, list)).toEqual(['z', 'y', 'x']);
  });

  it('orders statuts along the pipeline, not alphabetically', () => {
    const list = ['non_compliant', 'refused', 'sold', 'scheduled', 'to_visit'].map((status) => place({ placeId: status, status }));
    expect(sortedWith(SORT_COMPARATORS.status, list)).toEqual(['to_visit', 'scheduled', 'sold', 'refused', 'non_compliant']);
  });

  it('compares names the French way and dates chronologically', () => {
    const names = [place({ placeId: 'b', name: 'Épicerie' }), place({ placeId: 'a', name: 'boulangerie' })];
    expect(sortedWith(SORT_COMPARATORS.name, names)).toEqual(['a', 'b']);
    const dates = [place({ placeId: 'late', createdAt: '2026-09-10T00:00:00Z' }), place({ placeId: 'early', createdAt: '2026-09-01T00:00:00Z' })];
    expect(sortedWith(SORT_COMPARATORS.createdAt, dates)).toEqual(['early', 'late']);
  });
});

describe('dashboardMetrics', () => {
  const tracked = [
    place({ placeId: 'a', city: 'Bandol', types: ['bakery'], status: 'sold', saleAmount: 50 }),
    place({ placeId: 'b', city: 'Bandol', types: ['restaurant'], status: 'sold', saleAmount: 120.1 }),
    place({ placeId: 'c', city: 'Bandol', types: ['bakery'], status: 'refused', saleAmount: 50 }),
    place({ placeId: 'd', city: 'Bandol', types: ['bakery'], status: 'scheduled' }),
    place({ placeId: 'e', city: 'Bandol', types: ['bakery'], status: 'to_visit' }),
    place({ placeId: 'f', city: 'Toulon', types: ['bakery'], status: 'sold', saleAmount: 0.2 }),
    place({ placeId: 'g', city: 'Toulon', types: ['bakery'], status: 'to_visit' }),
    place({ placeId: 'h', city: 'Toulon', types: ['bakery'], status: 'to_visit' }),
    place({ placeId: 'i', city: null, types: ['hair_care'], status: 'non_compliant' }),
  ];

  it('reads the whole tracked list when no filter is chosen', () => {
    expect(dashboardMetrics(tracked, { filters: {}, salePrice: 50 })).toEqual({
      sold: 3,
      revenue: 170.3,
      scheduled: 1,
      toVisit: 3,
      refused: 1,
      potentiel: { scheduled: 50, toVisit: 150 },
    });
  });

  it('reads only the filtered set: what is sold there, and what is left to do there', () => {
    expect(dashboardMetrics(tracked, { filters: { city: 'Toulon' }, salePrice: 50 })).toEqual({
      sold: 1,
      revenue: 0.2,
      scheduled: 0,
      toVisit: 2,
      refused: 0,
      potentiel: { scheduled: 0, toVisit: 100 },
    });
    expect(dashboardMetrics(tracked, { filters: { city: 'Bandol', type: 'bakery' }, salePrice: 50 })).toEqual({
      sold: 1,
      revenue: 50,
      scheduled: 1,
      toVisit: 1,
      refused: 1,
      potentiel: { scheduled: 50, toVisit: 50 },
    });
  });

  it('prices each stage’s potentiel at the configured sale price, so it moves when that price changes — the revenue does not', () => {
    const at = (salePrice) => dashboardMetrics(tracked, { filters: {}, salePrice });
    expect(at(50)).toMatchObject({ revenue: 170.3, potentiel: { scheduled: 50, toVisit: 150 } });
    expect(at(79.9)).toMatchObject({ revenue: 170.3, potentiel: { scheduled: 79.9, toVisit: 239.7 } });
    expect(at(0)).toMatchObject({ revenue: 170.3, potentiel: { scheduled: 0, toVisit: 0 } });
  });

  it('counts revenue only from vendu établissements, ignoring an amount left on any other statut', () => {
    expect(dashboardMetrics(tracked, { filters: { status: 'refused' }, salePrice: 50 })).toMatchObject({ sold: 0, revenue: 0 });
  });

  it('has no potentiel when the sale price is unknown', () => {
    expect(dashboardMetrics(tracked, { filters: {}, salePrice: null }).potentiel).toEqual({ scheduled: null, toVisit: null });
  });

  it('reads all zeros when nothing is tracked', () => {
    expect(dashboardMetrics([], { filters: {}, salePrice: 50 })).toEqual({
      sold: 0,
      revenue: 0,
      scheduled: 0,
      toVisit: 0,
      refused: 0,
      potentiel: { scheduled: 0, toVisit: 0 },
    });
  });
});

describe('filtersSet', () => {
  it('is false while every filter reads « Toutes / Tous »', () => {
    expect(filtersSet({ city: null, type: null, status: null })).toBe(false);
    expect(filtersSet({})).toBe(false);
  });

  it('is true as soon as one of commune, type or statut is chosen', () => {
    expect(filtersSet({ city: 'Bandol', type: null, status: null })).toBe(true);
    expect(filtersSet({ city: null, type: 'bakery', status: null })).toBe(true);
    expect(filtersSet({ city: null, type: null, status: 'sold' })).toBe(true);
  });

  it('counts "sans commune" as a chosen commune', () => {
    expect(filtersSet({ city: NO_CITY })).toBe(true);
  });
});

describe('resetFilters', () => {
  const dashboard = {
    page: 3,
    pageSize: 50,
    filters: { city: 'Bandol', type: 'bakery', status: 'scheduled' },
    sort: { key: 'name', direction: 'asc' },
    selection: new Set(['a', 'b']),
  };

  it('puts commune, type and statut back to « Toutes / Tous », from the first page', () => {
    const reset = resetFilters(dashboard);
    expect(reset.filters).toEqual({ city: null, type: null, status: null });
    expect(filtersSet(reset.filters)).toBe(false);
    expect(reset.page).toBe(1);
  });

  it('leaves the sort, its direction, the page size and the ticked selection alone', () => {
    const reset = resetFilters(dashboard);
    expect(reset.sort).toEqual({ key: 'name', direction: 'asc' });
    expect(reset.pageSize).toBe(50);
    expect(reset.selection).toEqual(new Set(['a', 'b']));
  });

  it('leaves the state it was given untouched', () => {
    resetFilters(dashboard);
    expect(dashboard.filters).toEqual({ city: 'Bandol', type: 'bakery', status: 'scheduled' });
    expect(dashboard.page).toBe(3);
  });
});

describe('pruneSelection', () => {
  const tracked = [
    place({ placeId: 'a', city: 'Bandol' }),
    place({ placeId: 'b', city: 'Bandol', status: 'scheduled' }),
    place({ placeId: 'c', city: 'Sanary-sur-Mer' }),
  ];

  it('keeps only the ticked établissements the filters still return', () => {
    expect(pruneSelection(new Set(['a', 'b', 'c']), tracked, { city: 'Bandol' })).toEqual(new Set(['a', 'b']));
    expect(pruneSelection(new Set(['a', 'c']), tracked, { city: 'Bandol', status: 'scheduled' })).toEqual(new Set());
  });

  it('drops a ticked établissement that is no longer tracked', () => {
    expect(pruneSelection(new Set(['a', 'gone']), tracked, {})).toEqual(new Set(['a']));
  });
});

describe('BULK_STATUSES', () => {
  it('offers every pipeline move but vendu, whose amount is individual', () => {
    expect([...BULK_STATUSES].sort()).toEqual(['non_compliant', 'refused', 'scheduled', 'to_visit']);
    expect(BULK_STATUSES).not.toContain('sold');
  });
});

describe('bulkImpact', () => {
  const selection = [
    place({ id: 'row-1', placeId: 'a', status: 'to_visit' }),
    place({ id: 'row-2', placeId: 'b', status: 'sold', saleAmount: 50 }),
    place({ id: 'row-3', placeId: 'c', status: 'sold', saleAmount: 79.9 }),
    place({ id: 'row-4', placeId: 'd', status: 'refused', saleAmount: 30 }),
  ];

  it('counts the établissements that will move to the target statut, and names it', () => {
    expect(bulkImpact(selection, 'scheduled')).toMatchObject({ count: 4, unchanged: 0, status: 'scheduled', statusLabel: 'Programmé pour visite' });
  });

  it('does not count those already at the target statut as moving', () => {
    expect(bulkImpact(selection, 'refused')).toMatchObject({ count: 3, unchanged: 1 });
  });

  it('counts the vendus the change will clear and the total sale amount it destroys, to the cent', () => {
    expect(bulkImpact(selection, 'to_visit')).toMatchObject({ soldCount: 2, amountCleared: 129.9 });
  });

  it('ignores an amount left on an établissement that is not vendu', () => {
    expect(bulkImpact(selection.filter((item) => item.status !== 'sold'), 'scheduled')).toMatchObject({ soldCount: 0, amountCleared: 0 });
  });

  it('refuses vendu as a target, which a bulk change never offers', () => {
    expect(() => bulkImpact(selection, 'sold')).toThrow();
  });

  it('reads all zeros over an empty selection', () => {
    expect(bulkImpact([], 'refused')).toEqual({ status: 'refused', statusLabel: 'Refusé', count: 0, unchanged: 0, soldCount: 0, amountCleared: 0 });
  });
});
