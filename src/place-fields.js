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
 * What the address must end in is the postcode and town, optionally followed by `, France`
 * — nothing else. Any other trailing segment blocks the match, which is what rules out the
 * common foreign shapes: `NY 10118, USA` puts a comma between postcode and country, and
 * `10117 Berlin, Deutschland` ends in a country that is not France. A foreign address
 * stripped of its country (`10117 Berlin`) is indistinguishable from a French one and does
 * yield a commune; Google's `formattedAddress` carries the country, so that shape is not
 * one this receives in practice.
 *
 * The word boundary before the postcode is load-bearing: without it `832701 Nice` would
 * match on its last five digits and wrongly yield `Nice`.
 *
 * @param {string|null|undefined} address
 * @returns {string|null}
 */
export function placeCity(address) {
  const match = /\b\d{5}\s+([^,]+?)\s*(?:,\s*France\s*)?$/i.exec(String(address ?? ''));
  return match?.[1].replace(/\s+/g, ' ') ?? null;
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
  return (place.types || []).find((type) => !GENERIC_TYPES.has(type)) || 'Autre';
}
