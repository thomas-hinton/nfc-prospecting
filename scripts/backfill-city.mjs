#!/usr/bin/env node
/**
 * One-off commune backfill (issue #7): fills `places.city` for établissements that were
 * already tracked before the column existed.
 *
 * It re-derives from the address **already stored on each row**, using the same shared
 * rule the app uses when it first tracks an établissement (src/place-fields.js), and so
 * issues **no Google request at all** — gaining a commune filter costs none of the
 * account's monthly Places quota.
 *
 * Local-only: authenticates with the service-role key (SUPABASE_SERVICE_ROLE_KEY), which
 * is never shipped to the browser bundle. Run it with the account's environment loaded:
 *
 *   set -a && . ./.env && set +a && npm run backfill:city
 *
 * Safe to re-run: an établissement whose commune is already set is left alone, so a
 * commune corrected by hand in the Supabase table editor is never overwritten, and a
 * second run changes nothing further.
 *
 * The count of établissements left without a commune is the point of the summary it
 * prints: it is the evidence that decides whether deriving the commune from Google's
 * structured address components — which would raise the Places billing tier — is ever
 * worth its own issue.
 */
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { placeCity } from '../src/place-fields.js';
import { fetchAll, resolveUserId } from './migrate-to-supabase.mjs';

/**
 * Fills the commune of every établissement that has none and whose stored address yields
 * one. Returns what happened, per établissement: `filled`, `alreadySet`, and `withoutCity`
 * — those whose address yields no recognisable commune and which stay unset.
 */
export async function runBackfill({ client, userEmail }) {
  const userId = await resolveUserId(client.auth, userEmail);
  const places = await fetchAll(client, 'places', { user_id: userId });

  let filled = 0;
  let alreadySet = 0;
  let withoutCity = 0;

  for (const row of places) {
    if (row.city) {
      alreadySet += 1;
      continue;
    }

    const city = placeCity(row.address);
    if (!city) {
      withoutCity += 1;
      continue;
    }

    const { error } = await client.from('places').update({ city }).eq('user_id', userId).eq('id', row.id);
    if (error) throw new Error(`Mise à jour de la commune (${row.place_id}) échouée : ${error.message}`);
    filled += 1;
  }

  return { userId, processed: places.length, filled, alreadySet, withoutCity };
}

async function main() {
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_TEST_EMAIL } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_TEST_EMAIL) {
    console.error(
      '[backfill-city] SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY et SUPABASE_TEST_EMAIL sont requis ' +
        '(le compte unique provisionné — voir ADR-0002). Lance : set -a && . ./.env && set +a && npm run backfill:city'
    );
    process.exit(1);
  }

  const client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const result = await runBackfill({ client, userEmail: SUPABASE_TEST_EMAIL });

  console.log(`[backfill-city] compte : ${SUPABASE_TEST_EMAIL} (${result.userId})`);
  console.log(`[backfill-city] ${result.processed} établissements examinés, aucune requête Google émise`);
  console.log(`[backfill-city] commune renseignée : ${result.filled}`);
  console.log(`[backfill-city] commune déjà présente, laissée intacte : ${result.alreadySet}`);
  console.log(`[backfill-city] sans commune exploitable, laissés vides : ${result.withoutCity}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[backfill-city] échec : ${error.message}`);
    process.exit(1);
  });
}
