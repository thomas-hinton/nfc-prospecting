import { describe, expect, it } from 'vitest';
import { createStore } from '../src/store.js';
import { createFakeSupabase } from './fake-supabase.js';
import { chooseVisibleMarkers, runZoneScan, zoneCells } from '../src/prospection.js';

const account = { email: 'prospecteur@example.com', password: 'correct-horse', id: 'user-1' };

function setup(options = {}) {
  const client = createFakeSupabase({ account, ...options });
  return { client, store: createStore({ client }) };
}

function candidate(overrides = {}) {
  return {
    id: 'place-1',
    displayName: 'Boulangerie du Port',
    formattedAddress: '12 quai du Port, 83270 Saint-Cyr-sur-Mer',
    location: { lat: () => 43.1808, lng: () => 5.7115 },
    types: ['bakery', 'food'],
    ...overrides,
  };
}

function fakeBounds({ south = 43.17, west = 5.7, north = 43.19, east = 5.73 } = {}) {
  return {
    getNorthEast: () => ({ lat: () => north, lng: () => east }),
    getSouthWest: () => ({ lat: () => south, lng: () => west }),
  };
}

describe('zoneCells', () => {
  it('splits the visible bounds into a grid of at least 3x3 cells', () => {
    const cells = zoneCells(fakeBounds());
    expect(cells.length).toBeGreaterThanOrEqual(9);
    cells.forEach((cell) => {
      expect(cell.center.lat).toBeTypeOf('number');
      expect(cell.center.lng).toBeTypeOf('number');
      expect(cell.radius).toBeGreaterThan(0);
    });
  });

  it('caps the grid at 100 cells for a very large visible area', () => {
    const cells = zoneCells(fakeBounds({ south: 40, west: 0, north: 45, east: 8 }));
    expect(cells.length).toBeLessThanOrEqual(100);
  });
});

describe('chooseVisibleMarkers', () => {
  function place(overrides = {}) {
    return { placeId: `place-${Math.random()}`, status: 'to_visit', lat: 43.18, lng: 5.71, ...overrides };
  }

  it('returns every place unchanged when under the visible-marker cap', () => {
    const places = Array.from({ length: 10 }, () => place());
    expect(chooseVisibleMarkers(places, fakeBounds())).toBe(places);
  });

  it('returns every place unchanged when there are no bounds to sample against, even over the cap', () => {
    const places = Array.from({ length: 300 }, () => place());
    expect(chooseVisibleMarkers(places, null)).toBe(places);
  });

  it('caps the result at MAX_VISIBLE_MARKERS (250) for a dense zone', () => {
    const places = Array.from({ length: 300 }, (_, index) => place({ placeId: `place-${index}`, lat: 43.17 + (index % 20) * 0.001, lng: 5.7 + Math.floor(index / 20) * 0.001 }));
    const displayed = chooseVisibleMarkers(places, fakeBounds());
    expect(displayed.length).toBe(250);
    expect(new Set(displayed.map((p) => p.placeId)).size).toBe(250);
  });

  it('samples every statut bucket rather than letting one bucket crowd out the others', () => {
    const toVisit = Array.from({ length: 200 }, (_, index) => place({ placeId: `visit-${index}`, status: 'to_visit', lat: 43.17 + (index % 20) * 0.001, lng: 5.7 + Math.floor(index / 20) * 0.001 }));
    const sold = Array.from({ length: 100 }, (_, index) => place({ placeId: `sold-${index}`, status: 'sold', lat: 43.17 + (index % 10) * 0.001, lng: 5.7 + Math.floor(index / 10) * 0.001 }));
    const displayed = chooseVisibleMarkers([...toVisit, ...sold], fakeBounds());
    const statuses = new Set(displayed.map((p) => p.status));
    expect(statuses.has('to_visit')).toBe(true);
    expect(statuses.has('sold')).toBe(true);
  });

  it('always keeps the selected marker visible even when it would otherwise be sampled out', () => {
    const places = Array.from({ length: 300 }, (_, index) => place({ placeId: `place-${index}`, lat: 43.17 + (index % 20) * 0.001, lng: 5.7 + Math.floor(index / 20) * 0.001 }));
    const targetId = places[150].placeId;
    const displayed = chooseVisibleMarkers(places, fakeBounds(), targetId);
    expect(displayed.some((p) => p.placeId === targetId)).toBe(true);
  });
});

describe('runZoneScan', () => {
  it('adds every newly discovered établissement via upsertPlace, one activity_log entry each', async () => {
    const { store, client } = setup();
    await store.signIn(account.email, account.password);
    const cells = [{ center: { lat: 43.18, lng: 5.71 }, radius: 100 }];

    const result = await runZoneScan({
      cells,
      store,
      searchCell: async () => [candidate({ id: 'place-1' }), candidate({ id: 'place-2', displayName: 'Fleuriste' })],
    });

    expect(result).toMatchObject({ added: 2, cellsProcessed: 1, cellsTotal: 1, quotaExhausted: false });
    expect(await store.listPlaces()).toHaveLength(2);
    expect(client.state.tables.activity_log).toHaveLength(2);
  });

  it('does not duplicate an établissement the scan rediscovers that is already tracked', async () => {
    const { store } = setup();
    await store.signIn(account.email, account.password);
    await store.upsertPlace({ placeId: 'place-1', name: 'Boulangerie du Port', address: '12 quai du Port' });
    const cells = [{ center: { lat: 43.18, lng: 5.71 }, radius: 100 }];

    const result = await runZoneScan({
      cells,
      store,
      searchCell: async () => [candidate({ id: 'place-1' })],
    });

    expect(result.added).toBe(0);
    expect(await store.listPlaces()).toHaveLength(1);
  });

  it('ignores candidates without a place id', async () => {
    const { store } = setup();
    await store.signIn(account.email, account.password);
    const cells = [{ center: { lat: 43.18, lng: 5.71 }, radius: 100 }];

    const result = await runZoneScan({ cells, store, searchCell: async () => [candidate({ id: undefined })] });

    expect(result.added).toBe(0);
    expect(await store.listPlaces()).toEqual([]);
  });

  it('halts further requests once the monthly quota is exhausted, without erroring', async () => {
    const { store } = setup({ monthlyLimit: 2 });
    await store.signIn(account.email, account.password);
    const cells = [
      { center: { lat: 43.18, lng: 5.71 }, radius: 100 },
      { center: { lat: 43.19, lng: 5.72 }, radius: 100 },
      { center: { lat: 43.2, lng: 5.73 }, radius: 100 },
    ];
    let searchCalls = 0;

    const result = await runZoneScan({
      cells,
      store,
      searchCell: async (cell) => {
        searchCalls += 1;
        return [candidate({ id: `place-${cell.center.lat}` })];
      },
    });

    expect(result).toMatchObject({ cellsProcessed: 2, cellsTotal: 3, quotaExhausted: true, added: 2 });
    expect(searchCalls).toBe(2);
    expect(await store.listPlaces()).toHaveLength(2);
  });

  it('reports progress per cell via onCellStart and each addition via onPlaceAdded', async () => {
    const { store } = setup();
    await store.signIn(account.email, account.password);
    const cells = [
      { center: { lat: 43.18, lng: 5.71 }, radius: 100 },
      { center: { lat: 43.19, lng: 5.72 }, radius: 100 },
    ];
    const progress = [];
    const added = [];

    await runZoneScan({
      cells,
      store,
      searchCell: async (cell) => [candidate({ id: `place-${cell.center.lat}` })],
      onCellStart: (update) => progress.push(update),
      onPlaceAdded: (place) => added.push(place.placeId),
    });

    expect(progress).toEqual([
      { cellsProcessed: 1, cellsTotal: 2, added: 0 },
      { cellsProcessed: 2, cellsTotal: 2, added: 1 },
    ]);
    expect(added).toEqual(['place-43.18', 'place-43.19']);
  });
});
