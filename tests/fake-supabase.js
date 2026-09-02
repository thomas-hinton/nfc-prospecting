/**
 * In-memory stand-in for the parts of `@supabase/supabase-js` the store uses.
 *
 * It mirrors the observable behaviour of the real client — `{ data, error }` envelopes,
 * the auth state callback, and the `increment_quota` RPC's check-then-increment semantics
 * (see supabase/migrations/20260902000000_foundation.sql) — so store tests never need a
 * real Supabase project.
 */
export function createFakeSupabase({ account = null, monthlyLimit = 1000, quota = {} } = {}) {
  const listeners = new Set();
  const state = {
    session: null,
    monthlyLimit,
    quota: { places: 0, maps: 0, ...quota },
  };

  function emit(event) {
    for (const listener of listeners) listener(event, state.session);
  }

  const auth = {
    async getSession() {
      return { data: { session: state.session }, error: null };
    },
    onAuthStateChange(callback) {
      listeners.add(callback);
      return { data: { subscription: { unsubscribe: () => listeners.delete(callback) } } };
    },
    async signInWithPassword({ email, password }) {
      if (!account || email !== account.email || password !== account.password) {
        return { data: { session: null }, error: { message: 'Invalid login credentials' } };
      }
      state.session = { user: { id: account.id ?? 'user-1', email }, access_token: 'fake-token' };
      emit('SIGNED_IN');
      return { data: { session: state.session }, error: null };
    },
    async signOut() {
      state.session = null;
      emit('SIGNED_OUT');
      return { error: null };
    },
  };

  async function rpc(name, args = {}) {
    if (name !== 'increment_quota') return { data: null, error: { message: `unknown function ${name}` } };
    if (!state.session) return { data: null, error: { message: 'not authenticated', code: '42501' } };

    const api = args.p_api ?? 'places';
    const count = args.p_count ?? 1;
    if (api !== 'places' && api !== 'maps') return { data: null, error: { message: `unknown api: ${api}` } };
    if (!Number.isInteger(count) || count < 1) return { data: null, error: { message: 'count must be at least 1' } };

    const total = state.quota.places + state.quota.maps;
    if (total + count > state.monthlyLimit) {
      return { data: [{ allowed: false, total, monthly_limit: state.monthlyLimit }], error: null };
    }
    state.quota[api] += count;
    const next = state.quota.places + state.quota.maps;
    return { data: [{ allowed: true, total: next, monthly_limit: state.monthlyLimit }], error: null };
  }

  return { auth, rpc, state };
}
