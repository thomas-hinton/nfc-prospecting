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
