import { describe, expect, it } from 'vitest';
import { createStore } from '../src/store.js';
import { createFakeSupabase } from './fake-supabase.js';

const account = { email: 'prospecteur@example.com', password: 'correct-horse', id: 'user-1' };

function setup(options = {}) {
  const client = createFakeSupabase({ account, ...options });
  return { client, store: createStore({ client }) };
}

describe('session management', () => {
  it('reports no session before signing in', async () => {
    const { store } = setup();
    expect(await store.getSession()).toBeNull();
  });

  it('returns a session after signing in with the provisioned credentials', async () => {
    const { store } = setup();
    const session = await store.signIn(account.email, account.password);
    expect(session.user.email).toBe(account.email);
    expect(await store.getSession()).not.toBeNull();
  });

  it('rejects wrong credentials without opening a session', async () => {
    const { store } = setup();
    await expect(store.signIn(account.email, 'wrong')).rejects.toThrow(/invalid login credentials/i);
    expect(await store.getSession()).toBeNull();
  });

  it('drops the session on sign out', async () => {
    const { store } = setup();
    await store.signIn(account.email, account.password);
    await store.signOut();
    expect(await store.getSession()).toBeNull();
  });

  it('notifies subscribers when the session appears and disappears', async () => {
    const { store } = setup();
    const seen = [];
    const unsubscribe = store.onAuthStateChange((session) => seen.push(session?.user?.email ?? null));
    await store.signIn(account.email, account.password);
    await store.signOut();
    unsubscribe();
    await store.signIn(account.email, account.password);
    expect(seen).toEqual([account.email, null]);
  });
});

describe('checkAndConsumeQuota', () => {
  it('allows a request that fits under the monthly limit and counts it', async () => {
    const { store, client } = setup({ monthlyLimit: 10 });
    await store.signIn(account.email, account.password);

    const result = await store.checkAndConsumeQuota();

    expect(result).toEqual({ allowed: true, total: 1, monthlyLimit: 10, remaining: 9 });
    expect(client.state.quota).toEqual({ places: 1, maps: 0 });
  });

  it('counts Maps JavaScript API loads separately from Places requests', async () => {
    const { store, client } = setup({ monthlyLimit: 10 });
    await store.signIn(account.email, account.password);

    await store.checkAndConsumeQuota({ api: 'maps' });
    await store.checkAndConsumeQuota({ api: 'places', count: 2 });

    expect(client.state.quota).toEqual({ places: 2, maps: 1 });
  });

  it('reports the request as not allowed once the monthly limit is reached', async () => {
    const { store, client } = setup({ monthlyLimit: 3, quota: { places: 3 } });
    await store.signIn(account.email, account.password);

    const result = await store.checkAndConsumeQuota();

    expect(result).toEqual({ allowed: false, total: 3, monthlyLimit: 3, remaining: 0 });
    expect(client.state.quota).toEqual({ places: 3, maps: 0 });
  });

  it('refuses a batch that would step over the limit without partially counting it', async () => {
    const { store, client } = setup({ monthlyLimit: 5, quota: { places: 4 } });
    await store.signIn(account.email, account.password);

    const result = await store.checkAndConsumeQuota({ count: 3 });

    expect(result.allowed).toBe(false);
    expect(client.state.quota).toEqual({ places: 4, maps: 0 });
  });

  it('never lets a run of requests exceed the monthly limit', async () => {
    const { store, client } = setup({ monthlyLimit: 4 });
    await store.signIn(account.email, account.password);

    const results = [];
    for (let index = 0; index < 6; index += 1) results.push(await store.checkAndConsumeQuota());

    expect(results.filter((result) => result.allowed)).toHaveLength(4);
    expect(client.state.quota.places).toBe(4);
  });

  it('fails loudly when the caller is not authenticated', async () => {
    const { store } = setup();
    await expect(store.checkAndConsumeQuota()).rejects.toThrow(/not authenticated/i);
  });

  it('rejects an unknown API name', async () => {
    const { store } = setup();
    await store.signIn(account.email, account.password);
    await expect(store.checkAndConsumeQuota({ api: 'directions' })).rejects.toThrow(/unknown api/i);
  });
});

describe('établissements', () => {
  const boulangerie = {
    placeId: 'place-123',
    name: 'Boulangerie du Port',
    address: '12 quai du Port, 83270 Saint-Cyr-sur-Mer',
    lat: 43.1808,
    lng: 5.7115,
    types: ['bakery', 'food'],
  };

  it('lists no établissement before anything is added', async () => {
    const { store } = setup();
    await store.signIn(account.email, account.password);
    expect(await store.listPlaces()).toEqual([]);
  });

  it('adds a new établissement, tracked with an initial statut of à visiter', async () => {
    const { store } = setup();
    await store.signIn(account.email, account.password);

    const { place, created } = await store.upsertPlace(boulangerie);

    expect(created).toBe(true);
    expect(place).toMatchObject({
      placeId: boulangerie.placeId,
      name: boulangerie.name,
      address: boulangerie.address,
      status: 'to_visit',
    });
    expect(await store.listPlaces()).toEqual([place]);
  });

  it('never creates a duplicate row when the same placeId is added again', async () => {
    const { store } = setup();
    await store.signIn(account.email, account.password);

    const first = await store.upsertPlace(boulangerie);
    const second = await store.upsertPlace(boulangerie);

    expect(second.created).toBe(false);
    expect(second.place).toEqual(first.place);
    expect(await store.listPlaces()).toHaveLength(1);
  });

  it('appends exactly one activity_log entry recording the add, and none on a re-add', async () => {
    const { store, client } = setup();
    await store.signIn(account.email, account.password);

    await store.upsertPlace(boulangerie);
    await store.upsertPlace(boulangerie);

    expect(client.state.tables.activity_log).toHaveLength(1);
    expect(client.state.tables.activity_log[0]).toMatchObject({
      action: 'place_added',
      place_name: boulangerie.name,
      address: boulangerie.address,
      user_id: account.id,
    });
    expect(client.state.tables.activity_log[0].details).toMatch(/à visiter/i);
  });

  it('never lists établissements belonging to another account', async () => {
    const { store, client } = setup();
    client.state.tables.places.push({
      id: 'other-row',
      user_id: 'someone-else',
      place_id: 'place-999',
      name: 'Établissement voisin',
      address: '',
      lat: null,
      lng: null,
      types: [],
      status: 'to_visit',
      created_at: new Date().toISOString(),
      status_changed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    await store.signIn(account.email, account.password);

    expect(await store.listPlaces()).toEqual([]);
  });

  it('fails loudly when adding an établissement while signed out', async () => {
    const { store } = setup();
    await expect(store.upsertPlace(boulangerie)).rejects.toThrow(/authentification/i);
  });
});

describe('settings', () => {
  it('reports the default sale price before any settings row exists', async () => {
    const { store } = setup();
    await store.signIn(account.email, account.password);
    expect(await store.getSettings()).toEqual({ salePrice: 50 });
  });

  it('reads back a saved sale price', async () => {
    const { store } = setup();
    await store.signIn(account.email, account.password);

    await store.saveSettings({ salePrice: 120 });

    expect(await store.getSettings()).toEqual({ salePrice: 120 });
  });

  it('overwrites a previously saved sale price rather than creating a second row', async () => {
    const { store, client } = setup();
    await store.signIn(account.email, account.password);

    await store.saveSettings({ salePrice: 120 });
    await store.saveSettings({ salePrice: 80 });

    expect(client.state.tables.settings).toHaveLength(1);
    expect(await store.getSettings()).toEqual({ salePrice: 80 });
  });

  it('never reads another account’s settings', async () => {
    const { store, client } = setup();
    client.state.tables.settings.push({ user_id: 'someone-else', sale_price: 999 });
    await store.signIn(account.email, account.password);

    expect(await store.getSettings()).toEqual({ salePrice: 50 });
  });
});

describe('statut & montant de vente', () => {
  const boulangerie = {
    placeId: 'place-123',
    name: 'Boulangerie du Port',
    address: '12 quai du Port, 83270 Saint-Cyr-sur-Mer',
    lat: 43.1808,
    lng: 5.7115,
    types: ['bakery', 'food'],
  };

  async function addBoulangerie(store) {
    const { place } = await store.upsertPlace(boulangerie);
    return place;
  }

  it('changes an établissement’s statut and appends a matching activity_log entry', async () => {
    const { store, client } = setup();
    await store.signIn(account.email, account.password);
    const place = await addBoulangerie(store);

    const updated = await store.setStatus(place.id, 'scheduled');

    expect(updated.status).toBe('scheduled');
    const [placeRow] = client.state.tables.places;
    expect(placeRow.status).toBe('scheduled');

    const entries = client.state.tables.activity_log;
    expect(entries).toHaveLength(2); // place_added, then the statut change
    expect(entries[1]).toMatchObject({ action: 'status_changed', place_name: boulangerie.name, user_id: account.id });
    expect(entries[1].details).toMatch(/à visiter/i);
    expect(entries[1].details).toMatch(/programmé pour visite/i);
  });

  it('defaults the sale amount to the configured sale price when marking vendu without an explicit amount', async () => {
    const { store } = setup();
    await store.signIn(account.email, account.password);
    await store.saveSettings({ salePrice: 75 });
    const place = await addBoulangerie(store);

    const updated = await store.setStatus(place.id, 'sold');

    expect(updated.status).toBe('sold');
    expect(updated.saleAmount).toBe(75);
  });

  it('uses an explicit sale amount instead of the configured sale price when marking vendu', async () => {
    const { store } = setup();
    await store.signIn(account.email, account.password);
    await store.saveSettings({ salePrice: 75 });
    const place = await addBoulangerie(store);

    const updated = await store.setStatus(place.id, 'sold', { saleAmount: 250 });

    expect(updated.saleAmount).toBe(250);
  });

  it('records the sale amount in the activity_log entry when marking vendu', async () => {
    const { store, client } = setup();
    await store.signIn(account.email, account.password);
    const place = await addBoulangerie(store);

    await store.setStatus(place.id, 'sold', { saleAmount: 250 });

    const entries = client.state.tables.activity_log;
    expect(entries.at(-1).details).toMatch(/250/);
  });

  it('edits the sale amount on an already-vendu établissement without touching its statut', async () => {
    const { store, client } = setup();
    await store.signIn(account.email, account.password);
    const place = await addBoulangerie(store);
    await store.setStatus(place.id, 'sold', { saleAmount: 100 });

    const updated = await store.setSaleAmount(place.id, 180);

    expect(updated.status).toBe('sold');
    expect(updated.saleAmount).toBe(180);
    const [placeRow] = client.state.tables.places;
    expect(placeRow.status).toBe('sold');
  });

  it('appends a distinct "sale amount changed" entry, not a statut-change entry, when only the amount changes', async () => {
    const { store, client } = setup();
    await store.signIn(account.email, account.password);
    const place = await addBoulangerie(store);
    await store.setStatus(place.id, 'sold', { saleAmount: 100 });

    await store.setSaleAmount(place.id, 180);

    const entries = client.state.tables.activity_log;
    expect(entries).toHaveLength(3); // place_added, status_changed (sold), sale_amount_changed
    expect(entries.at(-1)).toMatchObject({ action: 'sale_amount_changed', place_name: boulangerie.name });
    expect(entries.at(-1).details).toMatch(/180/);
  });

  it('refuses to edit the sale amount on an établissement that isn’t vendu', async () => {
    const { store } = setup();
    await store.signIn(account.email, account.password);
    const place = await addBoulangerie(store);

    await expect(store.setSaleAmount(place.id, 180)).rejects.toThrow(/vendu/i);
  });

  it('reopens a terminal statut back to à visiter, clearing the sale amount', async () => {
    const { store, client } = setup();
    await store.signIn(account.email, account.password);
    const place = await addBoulangerie(store);
    await store.setStatus(place.id, 'sold', { saleAmount: 250 });

    const updated = await store.setStatus(place.id, 'to_visit');

    expect(updated.status).toBe('to_visit');
    expect(updated.saleAmount).toBeNull();
    const [placeRow] = client.state.tables.places;
    expect(placeRow.sale_amount).toBeNull();

    const entries = client.state.tables.activity_log;
    expect(entries.at(-1)).toMatchObject({ action: 'status_changed' });
    expect(entries.at(-1).details).toMatch(/vendu/i);
    expect(entries.at(-1).details).toMatch(/à visiter/i);
  });

  it('reopens refusé and non conforme back to à visiter the same way', async () => {
    const { store } = setup();
    await store.signIn(account.email, account.password);
    const place = await addBoulangerie(store);
    await store.setStatus(place.id, 'refused');

    const updated = await store.setStatus(place.id, 'to_visit');

    expect(updated.status).toBe('to_visit');
    expect(updated.saleAmount).toBeNull();
  });

  it('is a no-op that appends nothing when the statut is set to its current value', async () => {
    const { store, client } = setup();
    await store.signIn(account.email, account.password);
    const place = await addBoulangerie(store);

    await store.setStatus(place.id, 'to_visit');

    expect(client.state.tables.activity_log).toHaveLength(1); // just place_added
  });

  it('rejects an unknown statut', async () => {
    const { store } = setup();
    await store.signIn(account.email, account.password);
    const place = await addBoulangerie(store);

    await expect(store.setStatus(place.id, 'lost')).rejects.toThrow(/statut/i);
  });

  it('fails loudly when changing statut while signed out', async () => {
    const { store } = setup();
    await expect(store.setStatus('place-row-id', 'sold')).rejects.toThrow(/authentification/i);
  });
});

describe('listActivityLog', () => {
  function activityRow(overrides = {}) {
    return {
      id: `log-${Math.random()}`,
      user_id: account.id,
      action: 'place_added',
      place_name: 'Établissement',
      address: '',
      details: null,
      at: new Date().toISOString(),
      ...overrides,
    };
  }

  it('lists no entry before anything is recorded', async () => {
    const { store } = setup();
    await store.signIn(account.email, account.password);
    expect(await store.listActivityLog()).toEqual({ entries: [], total: 0, page: 1, pageSize: 50 });
  });

  it('returns entries most-recently-added first', async () => {
    const { store, client } = setup();
    await store.signIn(account.email, account.password);
    client.state.tables.activity_log.push(
      activityRow({ id: 'log-1', place_name: 'Premier', at: '2026-01-01T00:00:00.000Z' }),
      activityRow({ id: 'log-2', place_name: 'Second', at: '2026-01-02T00:00:00.000Z' }),
      activityRow({ id: 'log-3', place_name: 'Troisième', at: '2026-01-03T00:00:00.000Z' })
    );

    const { entries, total } = await store.listActivityLog();

    expect(total).toBe(3);
    expect(entries.map((entry) => entry.placeName)).toEqual(['Troisième', 'Second', 'Premier']);
  });

  it('paginates against the total row count, respecting the requested page size', async () => {
    const { store, client } = setup();
    await store.signIn(account.email, account.password);
    for (let index = 0; index < 5; index += 1) {
      client.state.tables.activity_log.push(
        activityRow({ id: `log-${index}`, place_name: `Entrée ${index}`, at: `2026-01-0${index + 1}T00:00:00.000Z` })
      );
    }

    const firstPage = await store.listActivityLog({ page: 1, pageSize: 2 });
    const secondPage = await store.listActivityLog({ page: 2, pageSize: 2 });
    const lastPage = await store.listActivityLog({ page: 3, pageSize: 2 });

    expect(firstPage).toMatchObject({ total: 5, page: 1, pageSize: 2 });
    expect(firstPage.entries.map((entry) => entry.placeName)).toEqual(['Entrée 4', 'Entrée 3']);
    expect(secondPage.entries.map((entry) => entry.placeName)).toEqual(['Entrée 2', 'Entrée 1']);
    expect(lastPage.entries.map((entry) => entry.placeName)).toEqual(['Entrée 0']);
  });

  it('never lists activity belonging to another account', async () => {
    const { store, client } = setup();
    client.state.tables.activity_log.push(activityRow({ id: 'other-log', user_id: 'someone-else' }));
    await store.signIn(account.email, account.password);

    expect(await store.listActivityLog()).toEqual({ entries: [], total: 0, page: 1, pageSize: 50 });
  });

  it('fails loudly when reading the log while signed out', async () => {
    const { store } = setup();
    await expect(store.listActivityLog()).rejects.toThrow(/authentification/i);
  });
});

describe('getQuotaUsage', () => {
  function currentMonth() {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  it('reports zero usage against the default limit when nothing has been recorded', async () => {
    const { store } = setup();
    await store.signIn(account.email, account.password);

    expect(await store.getQuotaUsage()).toEqual({ places: 0, maps: 0, total: 0, monthlyLimit: 1000 });
  });

  it('reads Places/Maps usage and the account monthly limit for the current month', async () => {
    const { store, client } = setup();
    client.state.tables.quota.push({ user_id: account.id, month: currentMonth(), places_count: 7, maps_count: 3 });
    client.state.tables.settings.push({ user_id: account.id, monthly_quota_limit: 250 });
    await store.signIn(account.email, account.password);

    expect(await store.getQuotaUsage()).toEqual({ places: 7, maps: 3, total: 10, monthlyLimit: 250 });
  });

  it('ignores a previous month’s usage row', async () => {
    const { store, client } = setup();
    client.state.tables.quota.push({ user_id: account.id, month: '2020-01', places_count: 99, maps_count: 99 });
    await store.signIn(account.email, account.password);

    expect(await store.getQuotaUsage()).toMatchObject({ places: 0, maps: 0, total: 0 });
  });

  it('never reads another account’s quota or settings', async () => {
    const { store, client } = setup();
    client.state.tables.quota.push({ user_id: 'someone-else', month: currentMonth(), places_count: 42, maps_count: 0 });
    client.state.tables.settings.push({ user_id: 'someone-else', monthly_quota_limit: 5 });
    await store.signIn(account.email, account.password);

    expect(await store.getQuotaUsage()).toEqual({ places: 0, maps: 0, total: 0, monthlyLimit: 1000 });
  });

  it('fails loudly when reading quota usage while signed out', async () => {
    const { store } = setup();
    await expect(store.getQuotaUsage()).rejects.toThrow(/authentification/i);
  });
});
