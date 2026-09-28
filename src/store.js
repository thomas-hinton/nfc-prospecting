/**
 * The store: the only module that talks to Supabase.
 *
 * It takes an already-built client so tests can drive the same public interface against
 * an in-memory fake (see tests/fake-supabase.js). It covers session management, the quota
 * RPC, établissements and their statut, visites, settings and the activity log.
 */
import { placeCity } from './place-fields.js';

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

/** The outcomes a visite can resolve a programmé établissement to (see recordVisit). */
const VISIT_OUTCOMES = new Set(['sold', 'refused', 'non_compliant', 'to_visit']);

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
    city: row.city ?? null,
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
    placeRef: row.place_ref ?? null,
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

  /** Appends one activity_log entry about the établissement `row` (a raw `places` row), linked to it by `place_ref`. */
  async function logActivity(userId, action, row, details) {
    const { error } = await client.from('activity_log').insert({
      user_id: userId,
      action,
      place_ref: row.id,
      place_name: row.name,
      address: row.address,
      details,
    });
    if (error) throwStoreError(error, "Impossible d'enregistrer l'historique.");
  }

  /**
   * Moves the établissement `current` (a raw `places` row) to `status` and logs the
   * transition — the write path setStatus and recordVisit share. See setStatus.
   */
  async function changeStatus(userId, current, status, saleAmount) {
    const previousStatus = current.status;
    if (previousStatus === status) return mapPlaceRow(current);

    const nextSaleAmount =
      status === 'sold' ? Math.round((saleAmount != null ? saleAmount : await readSalePrice(userId)) * 100) / 100 : null;
    const now = new Date().toISOString();

    const { data: updated, error } = await client
      .from('places')
      .update({ status, sale_amount: nextSaleAmount, status_changed_at: now, updated_at: now })
      .eq('user_id', userId)
      .eq('id', current.id)
      .select();
    if (error) throwStoreError(error, 'Impossible de mettre à jour le statut.');
    const row = (Array.isArray(updated) ? updated[0] : updated) ?? { ...current, status, sale_amount: nextSaleAmount };

    let details = `Statut : ${STATUS_LABELS[previousStatus]} → ${STATUS_LABELS[status]}.`;
    if (status === 'sold') details += ` Montant de vente : ${euros(nextSaleAmount)}.`;
    await logActivity(userId, 'status_changed', row, details);

    return mapPlaceRow(row);
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
     * The établissement's commune is derived from `address` here and written with the row.
     * Because a re-add is ignored rather than merged, it is derived exactly once — at the
     * moment the établissement is first tracked — so a commune corrected by hand in the
     * Supabase table editor is never overwritten by a later rediscovery (issue #7).
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
          { user_id: userId, place_id: placeId, name, address, lat, lng, types, city: placeCity(address) },
          { onConflict: 'user_id,place_id', ignoreDuplicates: true }
        )
        .select();
      if (error) throwStoreError(error, "Impossible d'ajouter l'établissement.");

      if (inserted && inserted.length) {
        const row = inserted[0];
        await logActivity(userId, 'place_added', row, 'Statut initial : à visiter.');
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
      return changeStatus(userId, await findPlaceRow(userId, id), status, saleAmount);
    },

    /**
     * Records the outcome of a field visite on an établissement programmé pour visite:
     * vendu, refusé, non conforme, or à visiter (back to the pool, to be reprogrammed).
     *
     * Appends exactly one visit_history entry and one `visit_recorded` activity_log entry —
     * even without a comment, so a visite made on site stays distinguishable from a statut
     * changed by hand — then moves the statut through the same write path as setStatus.
     * The statut change comes last on purpose: if a write fails midway the établissement is
     * still programmé, stays on the Visite list, and the save can simply be retried (at the
     * cost of a rare duplicate visite entry).
     *
     * A vendu requires an explicit, valid `saleAmount` (0 allowed); there is no fallback
     * to the configured sale price here, the Visite page pre-fills it instead.
     *
     * @param {string} id - The établissement's database id (place.id).
     * @param {'sold'|'refused'|'non_compliant'|'to_visit'} status
     * @param {{ comment?: string, saleAmount?: number }} [options]
     * @returns {Promise<object>}
     */
    async recordVisit(id, status, { comment = '', saleAmount } = {}) {
      if (!VISIT_OUTCOMES.has(status)) throw new Error(`Résultat de visite inconnu : ${status}`);
      if (status === 'sold' && !(Number.isFinite(saleAmount) && saleAmount >= 0)) throw new Error('Montant de vente invalide.');
      const userId = await currentUserId();
      const current = await findPlaceRow(userId, id);
      if (current.status !== 'scheduled') throw new Error("Cet établissement n'est pas programmé pour visite.");

      comment = String(comment ?? '').trim();
      const visitSaleAmount = status === 'sold' ? Math.round(saleAmount * 100) / 100 : null;

      const { error } = await client.from('visit_history').insert({
        user_id: userId,
        place_id: current.id,
        status,
        comment,
        sale_amount: visitSaleAmount,
        changed_at: new Date().toISOString(),
      });
      if (error) throwStoreError(error, "Impossible d'enregistrer la visite.");

      let details = `Résultat : ${STATUS_LABELS[status]}.`;
      if (status === 'sold') details += ` Montant de vente : ${euros(visitSaleAmount)}.`;
      if (comment) details += ` Commentaire : ${comment}`;
      await logActivity(userId, 'visit_recorded', current, details);

      return changeStatus(userId, current, status, visitSaleAmount);
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
      await logActivity(userId, 'sale_amount_changed', row, `Montant de vente : ${euros(previousSaleAmount)} → ${euros(saleAmount)}.`);

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
