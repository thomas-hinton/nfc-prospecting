/**
 * The store: the only module that talks to Supabase.
 *
 * It takes an already-built client so tests can drive the same public interface against
 * an in-memory fake (see tests/fake-supabase.js). This foundation slice covers session
 * management and the quota RPC; feature tickets extend it with établissement, visite,
 * activity-log and settings methods.
 */

const DEFAULT_MONTHLY_LIMIT = 1000;
const DEFAULT_SALE_PRICE = 50;

/** The commercial pipeline stages' French display labels, keyed by statut. Terminal statuts (sold, refused, non_compliant) can be reopened back to to_visit. Shared with the UI so the two never drift. */
export const STATUS_LABELS = {
  to_visit: 'À visiter',
  scheduled: 'Programmé pour visite',
  sold: 'Vendu',
  refused: 'Refusé',
  non_compliant: 'Non conforme',
};

function throwStoreError(error, fallback) {
  throw new Error(error?.message || fallback);
}

/** Formats a euro amount the way every activity_log detail and the UI display it. */
export function euros(amount) {
  return Number(amount || 0).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
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

  /** The current account's place row (raw, snake_case), by its database id. Throws if it doesn't exist or belongs to someone else. */
  async function findPlaceRow(userId, id) {
    const { data, error } = await client.from('places').select('*').eq('user_id', userId).eq('id', id).maybeSingle();
    if (error) throwStoreError(error, "Impossible de lire l'établissement.");
    if (!data) throw new Error('Établissement introuvable.');
    return data;
  }

  async function readSalePrice(userId) {
    const { data, error } = await client.from('settings').select('*').eq('user_id', userId).maybeSingle();
    if (error) throwStoreError(error, 'Impossible de lire les paramètres.');
    return data?.sale_price ?? DEFAULT_SALE_PRICE;
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
     * Moves an établissement through the commercial pipeline. A no-op (no write, no
     * activity_log entry) when `status` matches the établissement's current statut.
     *
     * Marking vendu without an explicit `saleAmount` defaults to the configured sale
     * price (see getSettings). Moving away from vendu — including reopening a terminal
     * statut back to à visiter — always clears the sale amount. Every real change
     * appends one activity_log entry describing the transition, including the sale
     * amount when the new statut is vendu.
     *
     * @param {string} id - The établissement's database id (place.id).
     * @param {string} status
     * @param {{ saleAmount?: number }} [options]
     * @returns {Promise<object>}
     */
    async setStatus(id, status, { saleAmount } = {}) {
      if (!STATUS_LABELS[status]) throw new Error(`Statut inconnu : ${status}`);
      const userId = await currentUserId();
      const current = await findPlaceRow(userId, id);
      const previousStatus = current.status;
      if (previousStatus === status) return mapPlaceRow(current);

      const nextSaleAmount =
        status === 'sold' ? Math.round((saleAmount != null ? saleAmount : await readSalePrice(userId)) * 100) / 100 : null;
      const now = new Date().toISOString();

      const { data: updated, error } = await client
        .from('places')
        .update({ status, sale_amount: nextSaleAmount, status_changed_at: now, updated_at: now })
        .eq('user_id', userId)
        .eq('id', id)
        .select();
      if (error) throwStoreError(error, 'Impossible de mettre à jour le statut.');
      const row = (Array.isArray(updated) ? updated[0] : updated) ?? { ...current, status, sale_amount: nextSaleAmount };

      let details = `Statut : ${STATUS_LABELS[previousStatus]} → ${STATUS_LABELS[status]}.`;
      if (status === 'sold') details += ` Montant de vente : ${euros(nextSaleAmount)}.`;
      const { error: logError } = await client.from('activity_log').insert({
        user_id: userId,
        action: 'status_changed',
        place_name: row.name,
        address: row.address,
        details,
      });
      if (logError) throwStoreError(logError, "Impossible d'enregistrer l'historique.");

      return mapPlaceRow(row);
    },

    /**
     * Edits the sale amount of an already-vendu établissement without changing its
     * statut. Appends a distinct "sale amount changed" activity_log entry.
     *
     * @param {string} id - The établissement's database id (place.id).
     * @param {number} saleAmount
     * @returns {Promise<object>}
     */
    async setSaleAmount(id, saleAmount) {
      if (!Number.isFinite(saleAmount) || saleAmount < 0) throw new Error('Montant de vente invalide.');
      const userId = await currentUserId();
      const current = await findPlaceRow(userId, id);
      if (current.status !== 'sold') throw new Error("Cet établissement n'est pas vendu.");
      const previousSaleAmount = current.sale_amount;
      saleAmount = Math.round(saleAmount * 100) / 100;

      const now = new Date().toISOString();
      const { data: updated, error } = await client
        .from('places')
        .update({ sale_amount: saleAmount, updated_at: now })
        .eq('user_id', userId)
        .eq('id', id)
        .select();
      if (error) throwStoreError(error, 'Impossible de mettre à jour le montant de la vente.');
      const row = (Array.isArray(updated) ? updated[0] : updated) ?? { ...current, sale_amount: saleAmount };

      const { error: logError } = await client.from('activity_log').insert({
        user_id: userId,
        action: 'sale_amount_changed',
        place_name: row.name,
        address: row.address,
        details: `Montant de vente : ${euros(previousSaleAmount)} → ${euros(saleAmount)}.`,
      });
      if (logError) throwStoreError(logError, "Impossible d'enregistrer l'historique.");

      return mapPlaceRow(row);
    },

    /** The account's configured sale price, defaulting to 50 € before any settings row exists. */
    async getSettings() {
      const userId = await currentUserId();
      return { salePrice: await readSalePrice(userId) };
    },

    /** @param {{ salePrice: number }} next */
    async saveSettings({ salePrice }) {
      if (!Number.isFinite(salePrice) || salePrice < 0) throw new Error('Prix de vente invalide.');
      const userId = await currentUserId();
      const { error } = await client
        .from('settings')
        .upsert({ user_id: userId, sale_price: salePrice, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
      if (error) throwStoreError(error, "Impossible d'enregistrer les paramètres.");
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
