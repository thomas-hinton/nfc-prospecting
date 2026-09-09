/**
 * The two fields an établissement carries beyond what Google hands back verbatim: its
 * commune and its type. Both are derived here and nowhere else — the store, the Tableau
 * de bord and the backfill script all import these, so the rule has one implementation.
 *
 * Pure and dependency-free on purpose: no Google call, no Supabase client, no DOM.
 */

/**
 * The commune read out of the tail of a Google-supplied `formattedAddress`: the town
 * following the five-digit postcode, before an optional `, France`.
 *
 * Deliberately not taken from Google's structured address components — requesting those
 * raises the Places billing tier on every search and on every cell of a zone scan, and the
 * quota counter counts requests rather than euros, so the increase would be invisible to
 * the app (issue #7).
 *
 * An address that carries no recognisable commune yields `null`, never a placeholder: the
 * établissement's commune is genuinely unknown, the filter groups those under "sans
 * commune", and a correction is a hand-filled cell in the Supabase table editor.
 *
 * A foreign address is left unset rather than guessed at. `10117 Berlin, Deutschland` has
 * the same shape as a French address but the trailing country is what makes the postcode
 * a French one; without it the match is not safe to trust.
 *
 * @param {string|null|undefined} address
 * @returns {string|null}
 */
export function placeCity(address) {
  const match = /\b\d{5}\s+([^,]*?)\s*(?:,\s*France\s*)?$/i.exec(String(address ?? ''));
  const city = match?.[1].replace(/\s+/g, ' ').trim();
  return city || null;
}

/** Google puts these on nearly every établissement, so they say nothing about what it is. */
const GENERIC_TYPES = new Set(['point_of_interest', 'establishment', 'food', 'store', 'premise']);

/**
 * The établissement's type: the first of Google's `types` that actually distinguishes it,
 * or "Autre". Unlike the commune this stays derived on the fly — it comes from `types`,
 * which is already stored on the row, so there is nothing to stabilize.
 *
 * @param {{ types?: string[] }} place
 * @returns {string}
 */
export function placeType(place) {
  return (place?.types || []).find((type) => !GENERIC_TYPES.has(type)) || 'Autre';
}
