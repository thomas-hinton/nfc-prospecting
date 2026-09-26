import { STATUS_LABELS, euros } from './store.js';
import { placeType, placeTypeLabel } from './place-fields.js';

/**
 * The Tableau de bord's decision logic, as pure functions over plain établissement objects
 * (the shape `store.listPlaces()` returns) — no DOM, no Supabase client, no Google call. The
 * Prospection page draws what these return.
 */

/**
 * What one table row shows for `place`, already formatted for display. The sale amount is
 * only shown for a vendu établissement; a missing commune (`city`) is left empty.
 */
export function dashboardRow(place) {
  return {
    placeId: place.placeId,
    name: place.name,
    address: place.address,
    city: place.city ?? '',
    type: placeTypeLabel(place),
    status: place.status,
    statusLabel: STATUS_LABELS[place.status] ?? place.status,
    saleAmount: place.status === 'sold' ? euros(place.saleAmount) : '',
  };
}

/**
 * Page `page` of `places` at `pageSize` rows a page, as table rows plus where it sits in
 * the whole list (`first`/`last` are 1-based row positions, 0 for an empty list). A page
 * past the end — the list shrank, or more rows now fit a page — falls back to the last one.
 */
export function dashboardPage(places, { page: requestedPage, pageSize }) {
  const total = places.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, requestedPage), totalPages);
  const start = (page - 1) * pageSize;
  const rows = places.slice(start, start + pageSize).map(dashboardRow);
  return { rows, page, totalPages, total, first: total ? start + 1 : 0, last: start + rows.length };
}

/**
 * The commune filter's value for "sans commune": the établissements whose address yielded no
 * commune (`city` unset), grouped under an explicit entry rather than silently dropped. Not a
 * name `placeCity` can produce, so it never collides with a real commune.
 */
export const NO_CITY = '(sans commune)';

/** The value `place` has for the commune filter — its commune, or NO_CITY. */
const cityKey = (place) => place.city || NO_CITY;

/**
 * Whether `place` passes the Tableau de bord's filters: `city` (a commune, or NO_CITY),
 * `type` (a Google type, as `placeType` reads it) and `status`. A filter left unset
 * (null/undefined) lets everything through.
 */
export function matchesFilters(place, { city = null, type = null, status = null } = {}) {
  return (city == null || cityKey(place) === city) && (type == null || placeType(place) === type) && (status == null || place.status === status);
}

const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });

/** The distinct values `keyOf` takes over `places`, as menu options sorted by label (French-collated). */
function menuOptions(places, keyOf, labelOf) {
  const labels = new Map();
  places.forEach((place) => labels.set(keyOf(place), labelOf(place)));
  return [...labels].map(([value, label]) => ({ value, label })).sort((a, b) => collator.compare(a.label, b.label));
}

/** The commune menu's options: every commune among `places`, then "Sans commune" last if any has none. */
function cityOptions(places) {
  const withCity = places.filter((place) => place.city);
  const options = menuOptions(withCity, cityKey, (place) => place.city);
  return withCity.length < places.length ? [...options, { value: NO_CITY, label: 'Sans commune' }] : options;
}

/**
 * The Tableau de bord's three filter menus over `places`, and the `filters` they leave in force.
 *
 * The commune and type menus narrow each other: each offers only the values that still yield
 * an établissement under the other one and the chosen statut, so a combination returning
 * nothing can't be picked. A commune or type chosen earlier that has fallen out of its menu —
 * the statut or the data changed under it — is reset, and the menus are drawn under the filters
 * as they stand after that reset. When each still yields établissements on its own but not
 * together, the commune is kept and the type reset: the commune is what a round is planned in.
 *
 * The statut menu doesn't narrow: every statut stays on offer, in pipeline order, with how many
 * établissements it holds under the commune and type filters (not under the statut chosen), so
 * an empty stage shows at zero and the commune's whole pipeline reads at a glance.
 */
export function filterMenus(places, { city = null, type = null, status = null } = {}) {
  const typeLabel = (place) => placeTypeLabel(place);
  const citiesUnder = (filters) => cityOptions(places.filter((place) => matchesFilters(place, filters)));
  const typesUnder = (filters) => menuOptions(places.filter((place) => matchesFilters(place, filters)), placeType, typeLabel);
  const yieldsAny = (filters) => places.some((place) => matchesFilters(place, filters));

  if (!yieldsAny({ city, status })) city = null;
  if (!yieldsAny({ type, status })) type = null;
  if (!yieldsAny({ city, type, status })) type = null;

  const counted = places.filter((place) => matchesFilters(place, { city, type }));
  return {
    filters: { city, type, status },
    cities: citiesUnder({ type, status }),
    types: typesUnder({ city, status }),
    statuses: Object.entries(STATUS_LABELS).map(([value, label]) => ({
      value,
      label,
      count: counted.filter((place) => place.status === value).length,
    })),
  };
}

const byText = (textOf) => (a, b) => collator.compare(textOf(a), textOf(b));
const byDate = (dateOf) => (a, b) => (Date.parse(dateOf(a)) || 0) - (Date.parse(dateOf(b)) || 0);

/**
 * The Tableau de bord's sorts, each an ascending comparator over two établissements. Text is
 * French-collated — accents and case ignored, "Atelier 9" before "Atelier 10" — and a statut
 * or type is compared as displayed. An établissement with no commune sorts after every commune.
 */
export const SORT_COMPARATORS = {
  name: byText((place) => place.name ?? ''),
  city: (a, b) => (!a.city - !b.city) || collator.compare(a.city ?? '', b.city ?? ''),
  type: byText(placeTypeLabel),
  status: byText((place) => STATUS_LABELS[place.status] ?? place.status),
  createdAt: byDate((place) => place.createdAt),
  statusChangedAt: byDate((place) => place.statusChangedAt),
};

/**
 * `places` sorted by `key` (one of SORT_COMPARATORS), `direction` 'asc' or 'desc', as a new
 * list. Établissements that tie keep the order they were given in.
 */
export function sortPlaces(places, { key, direction = 'asc' }) {
  const compare = SORT_COMPARATORS[key];
  const sign = direction === 'desc' ? -1 : 1;
  return [...places].sort((a, b) => sign * compare(a, b));
}
