/**
 * The store: the only module that talks to Supabase.
 *
 * It takes an already-built client so tests can drive the same public interface against
 * an in-memory fake (see tests/fake-supabase.js). This foundation slice covers session
 * management and the quota RPC; feature tickets extend it with établissement, visite,
 * activity-log and settings methods.
 */

const DEFAULT_MONTHLY_LIMIT = 1000;

function throwStoreError(error, fallback) {
  throw new Error(error?.message || fallback);
}

export function createStore({ client }) {
  if (!client) throw new Error('createStore requires a Supabase client');

  return {
    /** The current session, or null when nobody is signed in. */
    async getSession() {
      const { data, error } = await client.auth.getSession();
      if (error) throwStoreError(error, 'Impossible de lire la session.');
      return data?.session ?? null;
    },

    /** Subscribe to session changes. Returns an unsubscribe function. */
    onAuthStateChange(callback) {
      const { data } = client.auth.onAuthStateChange((_event, session) => callback(session ?? null));
      return () => data?.subscription?.unsubscribe();
    },

    async signIn(email, password) {
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error) throwStoreError(error, 'Connexion impossible.');
      return data.session;
    },

    async signOut() {
      const { error } = await client.auth.signOut();
      if (error) throwStoreError(error, 'Déconnexion impossible.');
    },

    /**
     * Ask the database whether a Google Maps Platform request fits under this month's
     * limit and, if it does, count it — in one atomic step, so two devices can't both
     * read a stale count and jointly overshoot.
     *
     * @param {{ api?: 'places' | 'maps', count?: number }} [request]
     * @returns {Promise<{ allowed: boolean, total: number, monthlyLimit: number, remaining: number }>}
     */
    async checkAndConsumeQuota({ api = 'places', count = 1 } = {}) {
      const { data, error } = await client.rpc('increment_quota', { p_api: api, p_count: count });
      if (error) throwStoreError(error, 'Vérification du quota impossible.');

      const row = Array.isArray(data) ? data[0] : data;
      if (!row) throwStoreError(null, 'Réponse inattendue du quota.');

      const monthlyLimit = Number(row.monthly_limit ?? DEFAULT_MONTHLY_LIMIT);
      const total = Number(row.total ?? 0);
      return {
        allowed: Boolean(row.allowed),
        total,
        monthlyLimit,
        remaining: Math.max(0, monthlyLimit - total),
      };
    },
  };
}
