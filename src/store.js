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

/** Converts a `places` row (snake_case, as stored) to the établissement shape callers use. */
function mapPlaceRow(row) {
  return {
    id: row.id,
    placeId: row.place_id,
    name: row.name,
    address: row.address,
    lat: row.lat,
    lng: row.lng,
    types: row.types ?? [],
    status: row.status,
    saleAmount: row.sale_amount ?? null,
    createdAt: row.created_at,
    statusChangedAt: row.status_changed_at,
    updatedAt: row.updated_at,
  };
}

/** Converts an `activity_log` row (snake_case, as stored) to the shape callers use. */
function mapActivityLogRow(row) {
  return {
    id: row.id,
    action: row.action,
    placeName: row.place_name,
    address: row.address,
    details: row.details ?? null,
    at: row.at,
  };
}

/** The current calendar month in UTC, formatted as `increment_quota` formats it: `YYYY-MM`. */
function currentMonthUTC() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function createStore({ client }) {
  if (!client) throw new Error('createStore requires a Supabase client');

  async function currentUserId() {
    const { data, error } = await client.auth.getSession();
    if (error) throwStoreError(error, 'Impossible de lire la session.');
    const userId = data?.session?.user?.id;
    if (!userId) throwStoreError(null, 'Authentification requise.');
    return userId;
  }

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

    /** All établissements tracked by the current account, most recently added first. */
    async listPlaces() {
      const userId = await currentUserId();
      const { data, error } = await client
        .from('places')
        .select('*')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });
      if (error) throwStoreError(error, 'Impossible de lire les établissements.');
      return (data ?? []).map(mapPlaceRow);
    },

    /**
     * Adds an établissement, keyed by its Google `placeId`. Re-adding an already-tracked
     * `placeId` never creates a duplicate row (enforced by the database's unique
     * constraint) and appends no new activity-log entry — only a genuine first add does,
     * recording the établissement's initial statut (à visiter).
     *
     * @param {{ placeId: string, name?: string, address?: string, lat?: number|null, lng?: number|null, types?: string[] }} place
     * @returns {Promise<{ place: object, created: boolean }>}
     */
    async upsertPlace({ placeId, name = '', address = '', lat = null, lng = null, types = [] }) {
      if (!placeId) throw new Error('placeId requis.');
      const userId = await currentUserId();

      const { data: inserted, error } = await client
        .from('places')
        .upsert(
          { user_id: userId, place_id: placeId, name, address, lat, lng, types },
          { onConflict: 'user_id,place_id', ignoreDuplicates: true }
        )
        .select();
      if (error) throwStoreError(error, "Impossible d'ajouter l'établissement.");

      if (inserted && inserted.length) {
        const row = inserted[0];
        const { error: logError } = await client.from('activity_log').insert({
          user_id: userId,
          action: 'place_added',
          place_name: row.name,
          address: row.address,
          details: 'Statut initial : à visiter.',
        });
        if (logError) throwStoreError(logError, "Impossible d'enregistrer l'historique.");
        return { place: mapPlaceRow(row), created: true };
      }

      const { data: existing, error: fetchError } = await client
        .from('places')
        .select('*')
        .eq('user_id', userId)
        .eq('place_id', placeId)
        .maybeSingle();
      if (fetchError) throwStoreError(fetchError, "Impossible de lire l'établissement existant.");
      return { place: mapPlaceRow(existing), created: false };
    },

    /**
     * A page of the current account's activity_log, most-recently-added first.
     *
     * @param {{ page?: number, pageSize?: number }} [options]
     * @returns {Promise<{ entries: object[], total: number, page: number, pageSize: number }>}
     */
    async listActivityLog({ page = 1, pageSize = 50 } = {}) {
      const userId = await currentUserId();
      const from = (page - 1) * pageSize;
      const to = from + pageSize - 1;
      const { data, error, count } = await client
        .from('activity_log')
        .select('*', { count: 'exact' })
        .eq('user_id', userId)
        .order('at', { ascending: false })
        .range(from, to);
      if (error) throwStoreError(error, 'Impossible de lire le journal.');
      return { entries: (data ?? []).map(mapActivityLogRow), total: count ?? 0, page, pageSize };
    },

    /**
     * The current calendar month's Google Maps Platform usage for this account: Places
     * and Maps request counts, their combined total, and the account's monthly limit.
     * A read-only companion to checkAndConsumeQuota() — it never counts a request.
     *
     * @returns {Promise<{ places: number, maps: number, total: number, monthlyLimit: number }>}
     */
    async getQuotaUsage() {
      const userId = await currentUserId();
      const month = currentMonthUTC();

      const [quotaResult, settingsResult] = await Promise.all([
        client.from('quota').select('*').eq('user_id', userId).eq('month', month).maybeSingle(),
        client.from('settings').select('*').eq('user_id', userId).maybeSingle(),
      ]);
      if (quotaResult.error) throwStoreError(quotaResult.error, 'Impossible de lire le quota.');
      if (settingsResult.error) throwStoreError(settingsResult.error, 'Impossible de lire le quota.');

      const places = quotaResult.data?.places_count ?? 0;
      const maps = quotaResult.data?.maps_count ?? 0;
      return {
        places,
        maps,
        total: places + maps,
        monthlyLimit: settingsResult.data?.monthly_quota_limit ?? DEFAULT_MONTHLY_LIMIT,
      };
    },
  };
}
