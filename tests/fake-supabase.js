let nextRowId = 1;
const uid = (prefix) => `${prefix}-${nextRowId++}`;

/** Column defaults per table, mirroring supabase/migrations/20260902000000_foundation.sql. */
function rowDefaults(table) {
  const now = new Date().toISOString();
  if (table === 'places') {
    return { status: 'to_visit', sale_amount: null, created_at: now, status_changed_at: now, updated_at: now };
  }
  if (table === 'activity_log') {
    return { place_name: '', address: '', details: null, at: now };
  }
  return {};
}

/**
 * A tiny stand-in for the PostgREST query builder the store chains off `client.from()`.
 * Only the operations `src/store.js` actually uses are implemented: `select`/`eq`/`order`/
 * `range` (with `maybeSingle` as a terminal, and `select(*, { count: 'exact' })` reporting
 * the filtered-but-unpaginated row count), and `insert`/`upsert`/`update` optionally
 * followed by `select()` to return the affected rows.
 */
function createTableQuery(table, state) {
  let op = { type: 'select' };
  const filters = [];
  let orderSpec = null;
  let rangeSpec = null;
  let wantsSelectBack = false;
  let wantsCount = false;

  function requireAuth() {
    if (!state.session) return { message: 'not authenticated', code: '42501' };
    return null;
  }

  function rows() {
    return state.tables[table].filter((row) => row.user_id === state.session.user.id);
  }

  function applyFilters(list) {
    return list.filter((row) => filters.every((f) => row[f.column] === f.value));
  }

  function applyOrder(list) {
    if (!orderSpec) return list;
    const { column, ascending } = orderSpec;
    return [...list].sort((a, b) => (a[column] > b[column] ? 1 : a[column] < b[column] ? -1 : 0) * (ascending ? 1 : -1));
  }

  async function execute() {
    const authError = requireAuth();
    if (authError) return { data: null, error: authError };

    if (op.type === 'select') {
      const filtered = applyFilters(rows());
      const ordered = applyOrder(filtered);
      const data = rangeSpec ? ordered.slice(rangeSpec.from, rangeSpec.to + 1) : ordered;
      return { data, error: null, count: wantsCount ? filtered.length : null };
    }

    if (op.type === 'insert') {
      const inserted = op.rows.map((row) => ({ id: uid(table), ...rowDefaults(table), ...row }));
      state.tables[table].push(...inserted);
      return { data: wantsSelectBack ? inserted : null, error: null };
    }

    if (op.type === 'upsert') {
      const conflictColumns = (op.options.onConflict || '').split(',').filter(Boolean);
      const existing = conflictColumns.length
        ? state.tables[table].find((row) => conflictColumns.every((column) => row[column] === op.row[column]))
        : undefined;

      if (existing) {
        if (op.options.ignoreDuplicates) return { data: wantsSelectBack ? [] : null, error: null };
        Object.assign(existing, op.row, { updated_at: new Date().toISOString() });
        return { data: wantsSelectBack ? [existing] : null, error: null };
      }

      const created = { id: uid(table), ...rowDefaults(table), ...op.row };
      state.tables[table].push(created);
      return { data: wantsSelectBack ? [created] : null, error: null };
    }

    if (op.type === 'update') {
      const targets = applyFilters(rows());
      targets.forEach((row) => Object.assign(row, op.patch));
      return { data: wantsSelectBack ? targets : null, error: null };
    }

    return { data: null, error: { message: `unsupported operation: ${op.type}` } };
  }

  const query = {
    select(_columns = '*', { count } = {}) {
      wantsSelectBack = true;
      wantsCount = count === 'exact';
      return query;
    },
    eq(column, value) {
      filters.push({ column, value });
      return query;
    },
    order(column, { ascending = true } = {}) {
      orderSpec = { column, ascending };
      return query;
    },
    range(from, to) {
      rangeSpec = { from, to };
      return query;
    },
    insert(rows) {
      op = { type: 'insert', rows: Array.isArray(rows) ? rows : [rows] };
      return query;
    },
    upsert(row, options = {}) {
      op = { type: 'upsert', row, options };
      return query;
    },
    update(patch) {
      op = { type: 'update', patch };
      return query;
    },
    async maybeSingle() {
      const { data, error } = await execute();
      if (error) return { data: null, error };
      if (!data || data.length === 0) return { data: null, error: null };
      if (data.length > 1) return { data: null, error: { message: 'multiple rows returned' } };
      return { data: data[0], error: null };
    },
    then(onFulfilled, onRejected) {
      return execute().then(onFulfilled, onRejected);
    },
  };

  return query;
}

/**
 * In-memory stand-in for the parts of `@supabase/supabase-js` the store uses.
 *
 * It mirrors the observable behaviour of the real client — `{ data, error }` envelopes,
 * the auth state callback, the `increment_quota` RPC's check-then-increment semantics
 * (see supabase/migrations/20260902000000_foundation.sql), and a minimal `.from()` table
 * query builder — so store tests never need a real Supabase project.
 */
export function createFakeSupabase({ account = null, monthlyLimit = 1000, quota = {}, tables = {} } = {}) {
  const listeners = new Set();
  const state = {
    session: null,
    monthlyLimit,
    quota: { places: 0, maps: 0, ...quota },
    tables: { places: [], activity_log: [], quota: [], settings: [], ...tables },
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

  function from(table) {
    return createTableQuery(table, state);
  }

  return { auth, rpc, from, state };
}
