import { createClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStore } from '../src/store.js';

/**
 * Exercises the real `increment_quota` function against a Supabase project — the local
 * CLI stack or the production project. Skipped unless the environment is configured:
 *
 *   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
 *   SUPABASE_TEST_EMAIL, SUPABASE_TEST_PASSWORD
 *
 * The service-role key is used only here, to reset the month's counters and the limit
 * between assertions; it never reaches the browser bundle.
 */
const env = process.env;
const configured = Boolean(
  env.SUPABASE_URL &&
    env.SUPABASE_ANON_KEY &&
    env.SUPABASE_SERVICE_ROLE_KEY &&
    env.SUPABASE_TEST_EMAIL &&
    env.SUPABASE_TEST_PASSWORD
);

if (!configured) {
  console.warn(
    '[tests] increment_quota integration tests skipped: no Supabase project configured. ' +
      'Run them with `set -a && . ./.env && set +a && npm test`.'
  );
}

const month = new Date().toISOString().slice(0, 7);

describe.skipIf(!configured)('increment_quota against a real project', () => {
  let admin;
  let store;
  let userId;

  async function resetQuota({ monthlyLimit, places = 0, maps = 0 }) {
    await admin.from('settings').upsert({ user_id: userId, monthly_quota_limit: monthlyLimit });
    await admin.from('quota').upsert({ user_id: userId, month, places_count: places, maps_count: maps });
  }

  beforeAll(async () => {
    admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const client = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    store = createStore({ client });
    const session = await store.signIn(env.SUPABASE_TEST_EMAIL, env.SUPABASE_TEST_PASSWORD);
    userId = session.user.id;
  });

  afterAll(async () => {
    if (userId) await resetQuota({ monthlyLimit: 1000 });
  });

  it('counts a request that fits and refuses the one that would step over the limit', async () => {
    await resetQuota({ monthlyLimit: 2 });

    expect(await store.checkAndConsumeQuota()).toMatchObject({ allowed: true, total: 1 });
    expect(await store.checkAndConsumeQuota({ api: 'maps' })).toMatchObject({ allowed: true, total: 2 });

    const refused = await store.checkAndConsumeQuota();
    expect(refused).toMatchObject({ allowed: false, total: 2, monthlyLimit: 2, remaining: 0 });
  });

  it('never counts more than the limit when devices call concurrently', async () => {
    const monthlyLimit = 5;
    await resetQuota({ monthlyLimit });

    const results = await Promise.all(Array.from({ length: 20 }, () => store.checkAndConsumeQuota()));

    expect(results.filter((result) => result.allowed)).toHaveLength(monthlyLimit);
    const { data } = await admin.from('quota').select('places_count, maps_count').eq('user_id', userId).eq('month', month).single();
    expect(data.places_count + data.maps_count).toBe(monthlyLimit);
  });
});
