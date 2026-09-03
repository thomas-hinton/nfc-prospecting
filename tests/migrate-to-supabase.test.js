import { describe, expect, it } from 'vitest';
import { createFakeSupabase } from './fake-supabase.js';
import {
  activityLogInsertPayload,
  activitySignature,
  migrateActivityLog,
  migratePlaces,
  migrateVisitHistory,
  normalizeAmount,
  placeUpsertPayload,
  resolveUserId,
  runMigration,
  toIsoTimestamp,
  visitHistoryInsertPayload,
  visitSignature,
} from '../scripts/migrate-to-supabase.mjs';

const account = { email: 'prospecteur@example.com', password: 'correct-horse', id: 'user-1' };

/** The fake's table map lacks visit_history by default; the store never wrote to it. */
async function setup() {
  const client = createFakeSupabase({ account, tables: { visit_history: [] } });
  await client.auth.signInWithPassword({ email: account.email, password: account.password });
  return client;
}

describe('toIsoTimestamp', () => {
  it('converts a legacy epoch-ms number to an ISO string', () => {
    expect(toIsoTimestamp(1700000000000)).toBe(new Date(1700000000000).toISOString());
  });

  it('passes an already-ISO string through unchanged in value', () => {
    const iso = '2024-01-01T00:00:00.000Z';
    expect(toIsoTimestamp(iso)).toBe(iso);
  });

  it('returns null for missing or invalid values', () => {
    expect(toIsoTimestamp(null)).toBeNull();
    expect(toIsoTimestamp(undefined)).toBeNull();
    expect(toIsoTimestamp('')).toBeNull();
    expect(toIsoTimestamp('not-a-date')).toBeNull();
  });
});

describe('normalizeAmount', () => {
  it('normalizes numbers and numeric strings (as Postgres numeric round-trips) to the same form', () => {
    expect(normalizeAmount(50)).toBe(normalizeAmount('50.00'));
    expect(normalizeAmount(50.5)).toBe('50.50');
  });

  it('treats missing amounts as null, distinct from zero', () => {
    expect(normalizeAmount(null)).toBeNull();
    expect(normalizeAmount(undefined)).toBeNull();
    expect(normalizeAmount(0)).toBe('0.00');
  });
});

describe('payload builders', () => {
  it('maps a legacy place to the places row shape, preserving placeId and converting epoch-ms timestamps', () => {
    const place = {
      placeId: 'abc123',
      name: 'Le Bistrot',
      address: '1 rue de Paris',
      lat: 48.85,
      lng: 2.35,
      types: ['restaurant'],
      status: 'sold',
      saleAmount: 75,
      createdAt: 1700000000000,
      statusChangedAt: 1700000100000,
      updatedAt: 1700000200000,
    };
    expect(placeUpsertPayload(place, 'user-1')).toEqual({
      user_id: 'user-1',
      place_id: 'abc123',
      name: 'Le Bistrot',
      address: '1 rue de Paris',
      lat: 48.85,
      lng: 2.35,
      types: ['restaurant'],
      status: 'sold',
      sale_amount: 75,
      created_at: new Date(1700000000000).toISOString(),
      status_changed_at: new Date(1700000100000).toISOString(),
      updated_at: new Date(1700000200000).toISOString(),
    });
  });

  it('maps a visitHistory entry, linking it to the given établissement row id', () => {
    const entry = { status: 'refused', changedAt: 1700000300000, comment: 'Pas intéressé', saleAmount: null };
    expect(visitHistoryInsertPayload(entry, 'user-1', 'place-row-1')).toEqual({
      user_id: 'user-1',
      place_id: 'place-row-1',
      status: 'refused',
      comment: 'Pas intéressé',
      sale_amount: null,
      changed_at: new Date(1700000300000).toISOString(),
    });
  });

  it('maps a backlog event, preserving its original `at` timestamp', () => {
    const event = {
      at: '2024-03-01T10:00:00+01:00',
      action: 'Fiche ajoutée',
      placeName: 'Le Bistrot',
      address: '1 rue de Paris',
      details: 'Statut initial : à visiter.',
    };
    expect(activityLogInsertPayload(event, 'user-1')).toEqual({
      user_id: 'user-1',
      action: 'Fiche ajoutée',
      place_name: 'Le Bistrot',
      address: '1 rue de Paris',
      details: 'Statut initial : à visiter.',
      at: new Date('2024-03-01T10:00:00+01:00').toISOString(),
    });
  });
});

describe('resolveUserId', () => {
  it('finds the provisioned account by email', async () => {
    const adminAuth = {
      admin: {
        async listUsers({ page }) {
          if (page > 1) return { data: { users: [] }, error: null };
          return { data: { users: [{ id: 'user-1', email: account.email }] }, error: null };
        },
      },
    };
    await expect(resolveUserId(adminAuth, account.email)).resolves.toBe('user-1');
  });

  it('pages through listUsers until the account is found', async () => {
    const pages = [
      Array.from({ length: 200 }, (_, i) => ({ id: `other-${i}`, email: `other-${i}@example.com` })),
      [{ id: 'user-1', email: account.email }],
    ];
    const adminAuth = {
      admin: {
        async listUsers({ page }) {
          return { data: { users: pages[page - 1] ?? [] }, error: null };
        },
      },
    };
    await expect(resolveUserId(adminAuth, account.email)).resolves.toBe('user-1');
  });

  it('throws when no account matches the email', async () => {
    const adminAuth = { admin: { async listUsers() { return { data: { users: [] }, error: null }; } } };
    await expect(resolveUserId(adminAuth, 'missing@example.com')).rejects.toThrow(/aucun compte/i);
  });
});

describe('migratePlaces', () => {
  it('inserts every établissement, keyed by its original placeId, and returns the row id map', async () => {
    const client = await setup();
    const places = [
      { placeId: 'p1', name: 'Le Bistrot', address: '1 rue de Paris', status: 'to_visit' },
      { placeId: 'p2', name: 'Le Café', address: '2 rue de Lyon', status: 'sold', saleAmount: 60 },
    ];
    const { idByPlaceId, processed } = await migratePlaces(client, 'user-1', places);

    expect(processed).toBe(2);
    expect(idByPlaceId.size).toBe(2);
    const rows = client.state.tables.places;
    expect(rows.map((row) => row.place_id).sort()).toEqual(['p1', 'p2']);
    expect(rows.find((row) => row.place_id === 'p2').sale_amount).toBe(60);
  });

  it('skips établissements without a placeId', async () => {
    const client = await setup();
    const { processed } = await migratePlaces(client, 'user-1', [{ name: 'Sans place id' }]);
    expect(processed).toBe(0);
    expect(client.state.tables.places).toHaveLength(0);
  });

  it('is idempotent: re-running does not duplicate rows on the same placeId', async () => {
    const client = await setup();
    const places = [{ placeId: 'p1', name: 'Le Bistrot', address: '1 rue de Paris', status: 'to_visit' }];
    await migratePlaces(client, 'user-1', places);
    await migratePlaces(client, 'user-1', places);
    expect(client.state.tables.places).toHaveLength(1);
  });

  it('re-running with changed source data updates the existing row rather than inserting a duplicate', async () => {
    const client = await setup();
    await migratePlaces(client, 'user-1', [{ placeId: 'p1', name: 'Ancien nom', address: 'A', status: 'to_visit' }]);
    await migratePlaces(client, 'user-1', [{ placeId: 'p1', name: 'Nouveau nom', address: 'A', status: 'sold', saleAmount: 40 }]);

    expect(client.state.tables.places).toHaveLength(1);
    expect(client.state.tables.places[0].name).toBe('Nouveau nom');
    expect(client.state.tables.places[0].sale_amount).toBe(40);
  });
});

describe('migrateVisitHistory', () => {
  it('inserts every visitHistory entry, linked to its établissement row', async () => {
    const client = await setup();
    const places = [
      {
        placeId: 'p1',
        name: 'Le Bistrot',
        visitHistory: [
          { status: 'to_visit', changedAt: 1700000000000, comment: 'fermé', saleAmount: null },
          { status: 'sold', changedAt: 1700000100000, comment: '', saleAmount: 60 },
        ],
      },
    ];
    const { idByPlaceId } = await migratePlaces(client, 'user-1', places);
    const { inserted, skipped } = await migrateVisitHistory(client, 'user-1', places, idByPlaceId);

    expect(inserted).toBe(2);
    expect(skipped).toBe(0);
    const rows = client.state.tables.visit_history;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.place_id === idByPlaceId.get('p1'))).toBe(true);
    expect(rows.map((row) => row.status).sort()).toEqual(['sold', 'to_visit']);
  });

  it('is idempotent: re-running does not duplicate identical visit entries', async () => {
    const client = await setup();
    const places = [
      { placeId: 'p1', name: 'Le Bistrot', visitHistory: [{ status: 'refused', changedAt: 1700000000000, comment: 'non', saleAmount: null }] },
    ];
    const { idByPlaceId } = await migratePlaces(client, 'user-1', places);
    const first = await migrateVisitHistory(client, 'user-1', places, idByPlaceId);
    const second = await migrateVisitHistory(client, 'user-1', places, idByPlaceId);

    expect(first).toEqual({ inserted: 1, skipped: 0 });
    expect(second).toEqual({ inserted: 0, skipped: 1 });
    expect(client.state.tables.visit_history).toHaveLength(1);
  });

  it('treats two entries with different comments on the same établissement as distinct', async () => {
    const client = await setup();
    const places = [
      {
        placeId: 'p1',
        name: 'Le Bistrot',
        visitHistory: [
          { status: 'to_visit', changedAt: 1700000000000, comment: 'fermé', saleAmount: null },
          { status: 'to_visit', changedAt: 1700000000000, comment: 'absent', saleAmount: null },
        ],
      },
    ];
    const { idByPlaceId } = await migratePlaces(client, 'user-1', places);
    const { inserted } = await migrateVisitHistory(client, 'user-1', places, idByPlaceId);
    expect(inserted).toBe(2);
  });

  it('inserts two genuinely-duplicate visit entries once each, and skips both only once both exist', async () => {
    const client = await setup();
    const duplicateEntry = { status: 'to_visit', changedAt: 1700000000000, comment: 'fermé', saleAmount: null };
    const places = [{ placeId: 'p1', name: 'Le Bistrot', visitHistory: [duplicateEntry, { ...duplicateEntry }] }];
    const { idByPlaceId } = await migratePlaces(client, 'user-1', places);

    const first = await migrateVisitHistory(client, 'user-1', places, idByPlaceId);
    expect(first).toEqual({ inserted: 2, skipped: 0 });
    expect(client.state.tables.visit_history).toHaveLength(2);

    const second = await migrateVisitHistory(client, 'user-1', places, idByPlaceId);
    expect(second).toEqual({ inserted: 0, skipped: 2 });
    expect(client.state.tables.visit_history).toHaveLength(2);
  });
});

describe('migrateActivityLog', () => {
  it('inserts every backlog event, preserving its original `at` timestamp', async () => {
    const client = await setup();
    const events = [
      { at: '2024-01-01T10:00:00Z', action: 'Fiche ajoutée', placeName: 'Le Bistrot', address: 'A', details: 'Statut initial.' },
      { at: '2024-01-02T10:00:00Z', action: 'Statut modifié', placeName: 'Le Bistrot', address: 'A', details: 'Vendu.' },
    ];
    const { inserted, skipped } = await migrateActivityLog(client, 'user-1', events);

    expect(inserted).toBe(2);
    expect(skipped).toBe(0);
    const rows = client.state.tables.activity_log;
    expect(rows.map((row) => row.at)).toEqual(events.map((event) => new Date(event.at).toISOString()));
  });

  it('is idempotent: re-running does not duplicate identical events', async () => {
    const client = await setup();
    const events = [{ at: '2024-01-01T10:00:00Z', action: 'Fiche ajoutée', placeName: 'Le Bistrot', address: 'A', details: '' }];
    const first = await migrateActivityLog(client, 'user-1', events);
    const second = await migrateActivityLog(client, 'user-1', events);

    expect(first).toEqual({ inserted: 1, skipped: 0 });
    expect(second).toEqual({ inserted: 0, skipped: 1 });
    expect(client.state.tables.activity_log).toHaveLength(1);
  });

  it('inserts two backlog events that share a signature (e.g. two same-second entries) once each, not as duplicates of each other', async () => {
    const client = await setup();
    const duplicateEvent = { at: '2024-01-01T10:00:00Z', action: 'Commentaire ajouté', placeName: 'Le Bistrot', address: 'A', details: 'x' };
    const events = [duplicateEvent, { ...duplicateEvent }];

    const first = await migrateActivityLog(client, 'user-1', events);
    expect(first).toEqual({ inserted: 2, skipped: 0 });
    expect(client.state.tables.activity_log).toHaveLength(2);

    const second = await migrateActivityLog(client, 'user-1', events);
    expect(second).toEqual({ inserted: 0, skipped: 2 });
    expect(client.state.tables.activity_log).toHaveLength(2);
  });
});

describe('activitySignature', () => {
  it('is stable across an insert/read round trip through the fake store', async () => {
    const client = await setup();
    const event = { at: '2024-01-01T10:00:00Z', action: 'Fiche ajoutée', placeName: 'Le Bistrot', address: 'A', details: 'x' };
    await migrateActivityLog(client, 'user-1', [event]);
    const stored = client.state.tables.activity_log[0];
    const sourceSignature = activitySignature({
      action: event.action,
      place_name: event.placeName,
      address: event.address,
      details: event.details,
      at: event.at,
    });
    expect(activitySignature(stored)).toBe(sourceSignature);
  });
});

describe('visitSignature', () => {
  it('normalizes sale_amount the same way whether it comes from a JS number or a Postgres numeric string', () => {
    const fromSource = visitSignature({ status: 'sold', changed_at: '2024-01-01T00:00:00Z', comment: '', sale_amount: 50 });
    const fromDb = visitSignature({ status: 'sold', changed_at: '2024-01-01T00:00:00Z', comment: '', sale_amount: '50.00' });
    expect(fromSource).toBe(fromDb);
  });
});

describe('runMigration (end to end against the fake store)', () => {
  it('migrates places, visit history and activity log for the resolved account', async () => {
    const client = await setup();
    client.auth.admin = {
      async listUsers() {
        return { data: { users: [{ id: account.id, email: account.email }] }, error: null };
      },
    };

    const places = [
      {
        placeId: 'p1',
        name: 'Le Bistrot',
        address: '1 rue de Paris',
        status: 'sold',
        saleAmount: 60,
        createdAt: 1700000000000,
        visitHistory: [{ status: 'sold', changedAt: 1700000100000, comment: '', saleAmount: 60 }],
      },
    ];
    const events = [{ at: '2024-01-01T10:00:00Z', action: 'Fiche ajoutée', placeName: 'Le Bistrot', address: '1 rue de Paris', details: '' }];

    const result = await runMigration({ client, userEmail: account.email, places, events });

    expect(result.userId).toBe(account.id);
    expect(result.places).toEqual({ processed: 1 });
    expect(result.visitHistory).toEqual({ inserted: 1, skipped: 0 });
    expect(result.activityLog).toEqual({ inserted: 1, skipped: 0 });

    const rerun = await runMigration({ client, userEmail: account.email, places, events });
    expect(rerun.places).toEqual({ processed: 1 });
    expect(rerun.visitHistory).toEqual({ inserted: 0, skipped: 1 });
    expect(rerun.activityLog).toEqual({ inserted: 0, skipped: 1 });
    expect(client.state.tables.places).toHaveLength(1);
    expect(client.state.tables.visit_history).toHaveLength(1);
    expect(client.state.tables.activity_log).toHaveLength(1);
  });
});
