import { STATUS_LABELS, euros } from './store.js';
import { placeType } from './place-fields.js';

/**
 * The Tableau de bord's decision logic, as pure functions over plain établissement objects
 * (the shape `store.listPlaces()` returns) — no DOM, no Supabase client, no Google call. The
 * Prospection page draws what these return.
 */

/**
 * What one table row shows for `place`, already formatted for display. The sale amount is
 * only shown for a vendu établissement; a missing commune is left empty.
 */
export function dashboardRow(place) {
  return {
    placeId: place.placeId,
    name: place.name,
    address: place.address,
    commune: place.city ?? '',
    type: placeType(place).replaceAll('_', ' '),
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
