import { describe, expect, it } from 'vitest';
import { createStore } from '../src/store.js';
import { createFakeSupabase } from './fake-supabase.js';
import { chooseVisibleMarkers, placesOnMap, runBulkStatusChange, runZoneScan, zoneCells } from '../src/prospection.js';

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

function place(overrides = {}) {
  return { placeId: `place-${Math.random()}`, status: 'to_visit', lat: 43.18, lng: 5.71, ...overrides };
}

/** `count` établissements packed into the default `fakeBounds()` frame, 20 to a column. */
function denseZone(count) {
  return Array.from({ length: count }, (_, index) => place({ placeId: `place-${index}`, lat: 43.17 + (index % 20) * 0.001, lng: 5.7 + Math.floor(index / 20) * 0.001 }));
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

  it('returns every place unchanged when under the visible-marker cap', () => {
    const places = Array.from({ length: 10 }, () => place());
    expect(chooseVisibleMarkers(places, fakeBounds())).toBe(places);
  });

  it('returns every place unchanged when there are no bounds to sample against, even over the cap', () => {
    const places = Array.from({ length: 300 }, () => place());
    expect(chooseVisibleMarkers(places, null)).toBe(places);
  });

  it('caps the result at MAX_VISIBLE_MARKERS (250) for a dense zone', () => {
    const places = denseZone(300);
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
    const places = denseZone(300);
    const targetId = places[150].placeId;
    const displayed = chooseVisibleMarkers(places, fakeBounds(), targetId);
    expect(displayed.some((p) => p.placeId === targetId)).toBe(true);
  });
});

describe('placesOnMap', () => {

  it('shows the établissements inside the map frame, leaving out those outside it', () => {
    const inside = place({ placeId: 'inside' });
    const north = place({ placeId: 'north', lat: 43.5 });
    const east = place({ placeId: 'east', lng: 6.2 });

    const { inFrame, shown } = placesOnMap([inside, north, east], fakeBounds());

    expect(inFrame.map((p) => p.placeId)).toEqual(['inside']);
    expect(shown.map((p) => p.placeId)).toEqual(['inside']);
  });

  it('leaves out an établissement with no coordinates, since it has no marker', () => {
    const { inFrame, shown } = placesOnMap([place({ placeId: 'no-coords', lat: null, lng: null })], fakeBounds());
    expect(inFrame).toEqual([]);
    expect(shown).toEqual([]);
  });

  it('counts an établissement on the frame edge as inside it', () => {
    const { shown } = placesOnMap([place({ lat: 43.19, lng: 5.7 })], fakeBounds());
    expect(shown).toHaveLength(1);
  });

  it('follows a frame that straddles the antimeridian', () => {
    const bounds = fakeBounds({ south: -10, north: 10, west: 170, east: -170 });
    const places = [place({ placeId: 'west-side', lat: 0, lng: 175 }), place({ placeId: 'east-side', lat: 0, lng: -175 }), place({ placeId: 'outside', lat: 0, lng: 0 })];
    expect(placesOnMap(places, bounds).shown.map((p) => p.placeId)).toEqual(['west-side', 'east-side']);
  });

  it('caps what is shown at 250 in a dense zone, while counting every établissement in the frame', () => {
    const { inFrame, shown } = placesOnMap(denseZone(300), fakeBounds());
    expect(inFrame).toHaveLength(300);
    expect(shown).toHaveLength(250);
  });

  it('keeps the selected établissement shown when the cap would otherwise sample it out', () => {
    const places = denseZone(300);
    const { shown } = placesOnMap(places, fakeBounds(), places[150].placeId);
    expect(shown.some((p) => p.placeId === places[150].placeId)).toBe(true);
  });

  it('keeps the open établissement shown after its statut changes in a zone where the cap is reached', () => {
    const places = denseZone(300);
    const openId = places[150].placeId;
    places[150] = { ...places[150], status: 'sold' };

    const { shown } = placesOnMap(places, fakeBounds(), openId);

    expect(shown).toHaveLength(250);
    expect(shown.some((p) => p.placeId === openId)).toBe(true);
  });

  it('keeps the statut priority of the cap while the open établissement holds its slot', () => {
    const places = denseZone(300);
    places[150] = { ...places[150], status: 'sold' };

    const { shown } = placesOnMap(places, fakeBounds(), places[150].placeId);

    expect(shown.filter((p) => p.status === 'to_visit')).toHaveLength(249);
  });

  it('applies the usual rule again once no établissement is open', () => {
    const places = denseZone(300);
    places[150] = { ...places[150], status: 'sold' };

    const { shown } = placesOnMap(places, fakeBounds(), null);

    expect(shown.every((p) => p.status === 'to_visit')).toBe(true);
  });

  it('lists the open établissement first, whether or not the cap is reached', () => {
    const few = [place({ placeId: 'a' }), place({ placeId: 'b' }), place({ placeId: 'c' })];
    expect(placesOnMap(few, fakeBounds(), 'c').shown.map((p) => p.placeId)).toEqual(['c', 'a', 'b']);

    const many = denseZone(300);
    expect(placesOnMap(many, fakeBounds(), many[150].placeId).shown[0].placeId).toBe(many[150].placeId);
  });

  it('shows nothing before the map has a frame, as no marker is drawn yet', () => {
    expect(placesOnMap([place()], null)).toEqual({ inFrame: [], shown: [] });
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

describe('runBulkStatusChange', () => {
  /** Établissements in the order they were added (Établissement 1, 2, …). */
  const inAddedOrder = (places) => [...places].sort((a, b) => a.name.localeCompare(b.name, 'fr', { numeric: true }));
  /** A signed-in store tracking `count` établissements, and those établissements in the order added. */
  async function tracking(count, options) {
    const { store, client } = setup(options);
    await store.signIn(account.email, account.password);
    for (let index = 1; index <= count; index++) {
      await store.upsertPlace({ placeId: `place-${index}`, name: `Établissement ${index}`, address: `${index} rue du Port` });
    }
    return { store, client, places: inAddedOrder(await store.listPlaces()) };
  }
  /** The Backlog trail as a prospector reads it, without ids or timestamps. */
  const trail = (client) => client.state.tables.activity_log.map(({ action, place_name, address, details }) => ({ action, place_name, address, details }));

  it('moves every selected établissement to the statut and reports how many changed', async () => {
    const { store, places } = await tracking(3);

    const report = await runBulkStatusChange({ places, status: 'scheduled', store });

    expect(report).toMatchObject({ changed: 3, total: 3, failed: null, error: null });
    expect(report.updated.map((place) => place.status)).toEqual(['scheduled', 'scheduled', 'scheduled']);
    expect((await store.listPlaces()).every((place) => place.status === 'scheduled')).toBe(true);
  });

  it('leaves the same Backlog trail as making the same changes one at a time', async () => {
    const bulk = await tracking(3);
    await bulk.store.setStatus(bulk.places[1].id, 'sold', { saleAmount: 80 });
    const single = await tracking(3);
    await single.store.setStatus(single.places[1].id, 'sold', { saleAmount: 80 });

    await runBulkStatusChange({ places: inAddedOrder(await bulk.store.listPlaces()), status: 'refused', store: bulk.store });
    for (const place of inAddedOrder(await single.store.listPlaces())) await single.store.setStatus(place.id, 'refused');

    expect(trail(bulk.client)).toEqual(trail(single.client));
  });

  it('writes through the store’s single-établissement statut path, one call per établissement, in order', async () => {
    const { store, places } = await tracking(3);
    const calls = [];
    const spy = { ...store, setStatus: (id, status) => (calls.push([id, status]), store.setStatus(id, status)) };

    await runBulkStatusChange({ places, status: 'non_compliant', store: spy });

    expect(calls).toEqual(places.map((place) => [place.id, 'non_compliant']));
  });

  it('skips an établissement already at the statut', async () => {
    const { store, client, places } = await tracking(2);
    await store.setStatus(places[0].id, 'refused');
    const before = client.state.tables.activity_log.length;

    const report = await runBulkStatusChange({ places: await store.listPlaces(), status: 'refused', store });

    expect(report).toMatchObject({ changed: 1, total: 1 });
    expect(client.state.tables.activity_log).toHaveLength(before + 1);
  });

  it('stops at the first failure and reports how many changed before it', async () => {
    const { store, places } = await tracking(4);
    const failure = new Error('réseau coupé');
    const flaky = { ...store, setStatus: (id, status) => (id === places[2].id ? Promise.reject(failure) : store.setStatus(id, status)) };

    const report = await runBulkStatusChange({ places, status: 'scheduled', store: flaky });

    expect(report).toMatchObject({ changed: 2, total: 4, error: failure });
    expect(report.failed.id).toBe(places[2].id);
    expect(report.updated.map((place) => place.id)).toEqual([places[0].id, places[1].id]);
    const statuses = inAddedOrder(await store.listPlaces()).map((place) => place.status);
    expect(statuses).toEqual(['scheduled', 'scheduled', 'to_visit', 'to_visit']);
  });

  it('can be retried after a failure without applying a statut twice', async () => {
    const { store, client, places } = await tracking(3);
    let failOnce = true;
    const flaky = {
      ...store,
      setStatus: (id, status) => {
        if (id === places[1].id && failOnce) {
          failOnce = false;
          return Promise.reject(new Error('réseau coupé'));
        }
        return store.setStatus(id, status);
      },
    };
    await runBulkStatusChange({ places, status: 'refused', store: flaky });

    // A retry over the same, now stale, selection.
    const report = await runBulkStatusChange({ places, status: 'refused', store: flaky });

    expect(report.error).toBeNull();
    const changes = client.state.tables.activity_log.filter((entry) => entry.action === 'status_changed');
    expect(changes.map((entry) => entry.place_name)).toEqual(['Établissement 1', 'Établissement 2', 'Établissement 3']);
  });

  it('refuses to bulk-mark vendu', async () => {
    const { store, client, places } = await tracking(1);
    const before = client.state.tables.activity_log.length;

    await expect(runBulkStatusChange({ places, status: 'sold', store })).rejects.toThrow();
    expect(client.state.tables.activity_log).toHaveLength(before);
  });
});
