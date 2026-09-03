#!/usr/bin/env node
/**
 * One-time data migration (issue #11): imports the legacy prospection.json (établissements
 * + visit history) and backlog.json (activity log) — written by the local desktop app,
 * server.py — into the Supabase schema from issue #3.
 *
 * Local-only: authenticates with the service-role key (SUPABASE_SERVICE_ROLE_KEY), which
 * is never shipped to the browser bundle. Run it with the account's environment loaded:
 *
 *   set -a && . ./.env && set +a && node scripts/migrate-to-supabase.mjs [prospection.json] [backlog.json]
 *
 * Safe to re-run: établissements are upserted on (user_id, place_id) — the same unique
 * constraint the app relies on — and visit_history / activity_log rows, which carry no
 * natural unique key in the schema, are skipped when an equivalent row already exists.
 *
 * Out of scope, per issue #11: quota and settings are not migrated — the account starts
 * fresh on those. Verification is via direct database queries (row counts, spot-checks),
 * not through src/store.js or the app UI — see issue #2.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const PAGE_SIZE = 1000;
const INSERT_BATCH_SIZE = 500;

/** Epoch-ms number (as written by the legacy app) or an ISO string, to an ISO string. */
export function toIsoTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/** Postgres `numeric` round-trips as a string; normalize both sides before comparing. */
export function normalizeAmount(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : null;
}

export function placeUpsertPayload(place, userId) {
  return {
    user_id: userId,
    place_id: place.placeId,
    name: place.name ?? '',
    address: place.address ?? '',
    lat: place.lat ?? null,
    lng: place.lng ?? null,
    types: place.types ?? [],
    status: place.status || 'to_visit',
    sale_amount: place.saleAmount ?? null,
    created_at: toIsoTimestamp(place.createdAt) ?? undefined,
    status_changed_at: toIsoTimestamp(place.statusChangedAt) ?? undefined,
    updated_at: toIsoTimestamp(place.updatedAt) ?? undefined,
  };
}

export function visitHistoryInsertPayload(entry, userId, placeRowId) {
  return {
    user_id: userId,
    place_id: placeRowId,
    status: entry.status,
    comment: entry.comment ?? '',
    sale_amount: entry.saleAmount ?? null,
    changed_at: toIsoTimestamp(entry.changedAt) ?? undefined,
  };
}

export function activityLogInsertPayload(event, userId) {
  return {
    user_id: userId,
    action: event.action ?? '',
    place_name: event.placeName ?? '',
    address: event.address ?? '',
    details: event.details ?? null,
    at: toIsoTimestamp(event.at) ?? undefined,
  };
}

/** Identity used to recognize a visit_history row already migrated from this entry. */
export function visitSignature(row) {
  return [row.status, toIsoTimestamp(row.changed_at), row.comment ?? '', normalizeAmount(row.sale_amount)].join('|');
}

/** Identity used to recognize an activity_log row already migrated from this event. */
export function activitySignature(row) {
  return [row.action ?? '', row.place_name ?? '', row.address ?? '', row.details ?? '', toIsoTimestamp(row.at)].join('|');
}

/** Throws with `context` prefixed onto a Supabase `{ message }` error. */
function raise(context, error) {
  throw new Error(`${context} : ${error.message}`);
}

/** Every row matching `filters`, paged past PostgREST's default row cap. */
async function fetchAll(client, table, filters) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    let query = client.from(table).select('*');
    for (const [column, value] of Object.entries(filters)) query = query.eq(column, value);
    const { data, error } = await query.range(offset, offset + PAGE_SIZE - 1);
    if (error) raise(`Lecture de ${table} échouée`, error);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

/** Inserts `rows` into `table` in chunks, returning how many were inserted. */
async function insertInBatches(client, table, rows, errorContext) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + INSERT_BATCH_SIZE);
    const { error } = await client.from(table).insert(batch);
    if (error) raise(errorContext, error);
    inserted += batch.length;
  }
  return inserted;
}

/**
 * Inserts every `sourceRow` in `table` not already covered by `existingRows`, matching by
 * `signatureOf` as a **multiset**: neither visit_history nor activity_log has a natural
 * unique key, so two source rows that legitimately share a signature (e.g. two backlog
 * events landing in the same second) must both be inserted the first time, and only
 * skipped on a later re-run once that many matching rows already exist. A plain
 * existence check (a `Set`) would wrongly collapse the two together on the very first run.
 */
async function insertMissing(client, table, existingRows, sourceRows, signatureOf, errorContext) {
  const existingCounts = new Map();
  for (const row of existingRows) {
    const signature = signatureOf(row);
    existingCounts.set(signature, (existingCounts.get(signature) ?? 0) + 1);
  }

  const claimed = new Map();
  const toInsert = [];
  let skipped = 0;
  for (const row of sourceRows) {
    const signature = signatureOf(row);
    const alreadyClaimed = claimed.get(signature) ?? 0;
    claimed.set(signature, alreadyClaimed + 1);
    if (alreadyClaimed < (existingCounts.get(signature) ?? 0)) {
      skipped += 1;
      continue;
    }
    toInsert.push(row);
  }

  const inserted = await insertInBatches(client, table, toInsert, errorContext);
  return { inserted, skipped };
}

/** The provisioned account's user id (ADR-0002: exactly one account), looked up by email. */
export async function resolveUserId(adminAuth, email) {
  for (let page = 1; ; page += 1) {
    const { data, error } = await adminAuth.admin.listUsers({ page, perPage: 200 });
    if (error) raise('Impossible de lister les comptes', error);
    const found = data.users.find((user) => user.email === email);
    if (found) return found.id;
    if (data.users.length < 200) break;
  }
  throw new Error(`Aucun compte Supabase trouvé pour ${email}.`);
}

/** Upserts every établissement, keyed by (user_id, place_id). Returns the place_id → row id map. */
export async function migratePlaces(client, userId, places) {
  const idByPlaceId = new Map();
  let processed = 0;
  for (const place of places) {
    if (!place.placeId) {
      console.warn(`[migrate] établissement sans placeId ignoré : ${place.name ?? '(sans nom)'}`);
      continue;
    }
    const { data, error } = await client
      .from('places')
      .upsert(placeUpsertPayload(place, userId), { onConflict: 'user_id,place_id' })
      .select();
    if (error) raise(`Insertion de l'établissement ${place.placeId} échouée`, error);
    idByPlaceId.set(place.placeId, data[0].id);
    processed += 1;
  }
  return { idByPlaceId, processed };
}

/** Inserts every visitHistory entry not already present for its établissement. */
export async function migrateVisitHistory(client, userId, places, idByPlaceId) {
  let inserted = 0;
  let skipped = 0;
  for (const place of places) {
    const placeRowId = idByPlaceId.get(place.placeId);
    const history = place.visitHistory ?? [];
    if (!placeRowId || history.length === 0) continue;

    const existing = await fetchAll(client, 'visit_history', { user_id: userId, place_id: placeRowId });
    const sourceRows = history.map((entry) => visitHistoryInsertPayload(entry, userId, placeRowId));
    const result = await insertMissing(
      client,
      'visit_history',
      existing,
      sourceRows,
      visitSignature,
      `Insertion de l'historique de visite (${place.placeId}) échouée`
    );
    inserted += result.inserted;
    skipped += result.skipped;
  }
  return { inserted, skipped };
}

/** Inserts every backlog.json event not already present, preserving its original `at`. */
export async function migrateActivityLog(client, userId, events) {
  const existing = await fetchAll(client, 'activity_log', { user_id: userId });
  const sourceRows = events.map((event) => activityLogInsertPayload(event, userId));
  return insertMissing(client, 'activity_log', existing, sourceRows, activitySignature, "Insertion du journal d'activité échouée");
}

export async function runMigration({ client, userEmail, places, events }) {
  const userId = await resolveUserId(client.auth, userEmail);

  const placesResult = await migratePlaces(client, userId, places);
  const visitHistoryResult = await migrateVisitHistory(client, userId, places, placesResult.idByPlaceId);
  const activityLogResult = await migrateActivityLog(client, userId, events);

  return {
    userId,
    places: { processed: placesResult.processed },
    visitHistory: visitHistoryResult,
    activityLog: activityLogResult,
  };
}

function readJsonFile(path, description) {
  if (!existsSync(path)) {
    console.error(`[migrate] ${description} introuvable : ${path}`);
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    console.error(`[migrate] ${description} illisible (${path}) : ${error.message}`);
    process.exit(1);
  }
}

async function main() {
  const [, , prospectionPath = 'prospection.json', backlogPath = 'backlog.json'] = process.argv;

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_TEST_EMAIL } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_TEST_EMAIL) {
    console.error(
      '[migrate] SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY et SUPABASE_TEST_EMAIL sont requis ' +
        '(le compte unique provisionné — voir ADR-0002). Lance : set -a && . ./.env && set +a && npm run migrate'
    );
    process.exit(1);
  }

  const prospection = readJsonFile(prospectionPath, 'prospection.json');
  const backlog = readJsonFile(backlogPath, 'backlog.json');
  const places = Array.isArray(prospection.places) ? prospection.places : [];
  const events = Array.isArray(backlog) ? backlog : [];

  const client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const result = await runMigration({ client, userEmail: SUPABASE_TEST_EMAIL, places, events });

  console.log(`[migrate] compte : ${SUPABASE_TEST_EMAIL} (${result.userId})`);
  console.log(`[migrate] places : ${result.places.processed} traitées (insertion ou mise à jour)`);
  console.log(`[migrate] visit_history : ${result.visitHistory.inserted} insérées, ${result.visitHistory.skipped} déjà présentes`);
  console.log(`[migrate] activity_log : ${result.activityLog.inserted} insérées, ${result.activityLog.skipped} déjà présentes`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[migrate] échec : ${error.message}`);
    process.exit(1);
  });
}
