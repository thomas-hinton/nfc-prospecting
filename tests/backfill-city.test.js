import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from './fake-supabase.js';
import { runBackfill } from '../scripts/backfill-city.mjs';

const account = { email: 'prospecteur@example.com', password: 'correct-horse', id: 'user-1' };

function placeRow(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: `row-${Math.random()}`,
    user_id: account.id,
    place_id: `place-${Math.random()}`,
    name: 'Boulangerie du Port',
    address: '12 quai du Port, 83270 Saint-Cyr-sur-Mer',
    lat: null,
    lng: null,
    types: [],
    city: null,
    status: 'to_visit',
    sale_amount: null,
    created_at: now,
    status_changed_at: now,
    updated_at: now,
    ...overrides,
  };
}

async function setup(places) {
  const client = createFakeSupabase({ account, tables: { places } });
  await client.auth.signInWithPassword({ email: account.email, password: account.password });
  client.auth.admin = {
    async listUsers() {
      return { data: { users: [{ id: account.id, email: account.email }] }, error: null };
    },
  };
  return client;
}

const run = (client) => runBackfill({ client, userEmail: account.email });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runBackfill', () => {
  it('fills the commune of every already-tracked établissement whose stored address yields one', async () => {
    const places = [
      placeRow({ address: '12 quai du Port, 83270 Saint-Cyr-sur-Mer' }),
      placeRow({ address: '1 rue de Rivoli, 75001 Paris, France' }),
    ];
    const client = await setup(places);

    const result = await run(client);

    expect(client.state.tables.places.map((row) => row.city)).toEqual(['Saint-Cyr-sur-Mer', 'Paris']);
    expect(result.filled).toBe(2);
    expect(result.withoutCity).toBe(0);
  });

  it('leaves the commune unset when the stored address yields none, and reports how many are left', async () => {
    const places = [
      placeRow({ address: '12 quai du Port, 83270 Saint-Cyr-sur-Mer' }),
      placeRow({ address: 'Somewhere off the map' }),
      placeRow({ address: '' }),
    ];
    const client = await setup(places);

    const result = await run(client);

    expect(client.state.tables.places.map((row) => row.city)).toEqual(['Saint-Cyr-sur-Mer', null, null]);
    expect(result.filled).toBe(1);
    expect(result.withoutCity).toBe(2);
  });

  it('never overwrites a commune already set, so a hand-made correction survives the backfill', async () => {
    const places = [placeRow({ address: '12 quai du Port, 83270 Saint-Cyr-sur-Mer', city: 'Saint-Cyr' })];
    const client = await setup(places);

    const result = await run(client);

    expect(client.state.tables.places[0].city).toBe('Saint-Cyr');
    expect(result.filled).toBe(0);
    expect(result.alreadySet).toBe(1);
  });

  it('changes nothing further when it is run a second time', async () => {
    const places = [
      placeRow({ address: '12 quai du Port, 83270 Saint-Cyr-sur-Mer' }),
      placeRow({ address: 'Somewhere off the map' }),
    ];
    const client = await setup(places);

    await run(client);
    const snapshot = JSON.parse(JSON.stringify(client.state.tables.places));
    const second = await run(client);

    expect(client.state.tables.places).toEqual(snapshot);
    expect(second.filled).toBe(0);
    expect(second.alreadySet).toBe(1);
    expect(second.withoutCity).toBe(1);
  });

  it('never touches an établissement belonging to another account', async () => {
    const mine = placeRow();
    const theirs = placeRow({ user_id: 'someone-else' });
    const client = await setup([mine, theirs]);

    await run(client);

    expect(client.state.tables.places.find((row) => row.user_id === 'someone-else').city).toBeNull();
  });

  it('issues no Google request — it re-derives from the address already stored on each row', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('the backfill must not reach the network');
    });
    vi.stubGlobal('fetch', fetchSpy);
    const client = await setup([placeRow(), placeRow({ address: 'Somewhere off the map' })]);

    await run(client);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports the account it ran against', async () => {
    const client = await setup([placeRow()]);

    expect((await run(client)).userId).toBe(account.id);
  });
});
