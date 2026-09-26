import { bootstrapStore } from './bootstrap.js';
import { readConfig } from './supabase-client.js';
import { STATUS_LABELS, euros } from './store.js';
import { placeTypeLabel } from './place-fields.js';
import {
  BULK_STATUSES,
  bulkImpact,
  bulkMoves,
  dashboardMetrics,
  dashboardPage,
  filterMenus,
  filteredPlaceIds,
  anyFilterChosen,
  matchesFilters,
  NO_FILTERS,
  plural,
  printedDocument,
  pruneSelection,
  sortPlaces,
} from './dashboard.js';
import { renderPageStrip } from './page-strip.js';

/**
 * The Prospection page: text search for a business, add it to the tracked list, see it on
 * the map, and copy/open its Google Maps link for NFC encoding. Every Google Places / Maps
 * JavaScript call goes through the store's `checkAndConsumeQuota()` first.
 *
 * The map shares its area with a second view, the Tableau de bord: a paginated table of
 * every tracked établissement, filtered and sorted client-side. Both views draw the same
 * `state.places`, loaded once. The sidebar list belongs to the map view: it lists exactly the
 * établissements whose markers are drawn, and is hidden while the Tableau de bord is on screen.
 */

const STATUS_COLORS = { to_visit: '#55a7e8', scheduled: '#e5b72b', sold: '#22a06b', refused: '#e5484d', non_compliant: '#a1a9b7' };
const STATUS_ORDER = ['to_visit', 'scheduled', 'sold', 'refused', 'non_compliant'];
const TERMINAL_STATUSES = new Set(['sold', 'refused', 'non_compliant']);
const DEFAULT_CENTER = { lat: 43.1808, lng: 5.7115 };
const QUOTA_MESSAGE = 'Limite mensuelle de requêtes Google atteinte.';
const MAX_ZONE_REQUESTS = 100;
const MAX_VISIBLE_MARKERS = 250;
/** The Tableau de bord's sort directions: the direction button's label and spoken word, and what a click switches to. */
const SORT_DIRECTIONS = {
  asc: { label: '↑ Croissant', word: 'croissant', next: 'desc' },
  desc: { label: '↓ Décroissant', word: 'décroissant', next: 'asc' },
};

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (text = '') =>
  String(text).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);

function mapsUrl(place) {
  const query = encodeURIComponent(`${place.name} ${place.address}`.trim());
  return `https://www.google.com/maps/search/?api=1&query_place_id=${encodeURIComponent(place.placeId)}&query=${query}`;
}

function markerIcon(status, selected) {
  return {
    path: google.maps.SymbolPath.CIRCLE,
    fillColor: STATUS_COLORS[status] || STATUS_COLORS.to_visit,
    fillOpacity: 1,
    strokeColor: selected ? '#ff6a3d' : '#fff',
    strokeWeight: selected ? 4 : 2,
    scale: selected ? 10 : 8,
  };
}

let store = null;
const state = {
  places: [],
  map: null,
  markers: new Map(),
  selectedId: null,
  mapUnavailable: false,
  view: 'map',
  /** The configured sale price the potentiel is estimated at; null until read (or if it can't be). */
  salePrice: null,
  dashboard: {
    page: 1,
    pageSize: 25,
    filters: NO_FILTERS,
    sort: { key: 'createdAt', direction: 'desc' },
    /** The ticked établissements' placeIds — always within the filtered set, rows on other pages included. */
    selection: new Set(),
    /** Whether a bulk change is running: the selection and the filters are locked until it ends. */
    bulkRunning: false,
  },
};

function setFormMessage(id, text, isError = false) {
  const message = $(id);
  message.classList.toggle('error', isError);
  message.textContent = text;
}

class QuotaExceededError extends Error {}

/** Consumes one unit of Google API quota, or throws QuotaExceededError when blocked. */
async function requireQuota(api, storeInstance = store) {
  const quota = await storeInstance.checkAndConsumeQuota({ api });
  if (!quota.allowed) throw new QuotaExceededError(QUOTA_MESSAGE);
  return quota;
}

/** Disables `button` with `busyLabel` for the life of `task`, always restoring it after. */
async function withBusyButton(button, busyLabel, task) {
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = busyLabel;
  try {
    return await task();
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

/** Redraws both views after `state.places` changed. */
function renderPlaces() {
  renderDashboard();
  renderMapPlaces();
}

/** Why the sidebar list is empty, for `renderSidebarList`. */
function emptySidebarReason() {
  if (state.mapUnavailable) return 'Carte indisponible : retrouve tes établissements dans le Tableau de bord.';
  if (!state.map?.getBounds()) return 'Chargement de la carte…';
  if (!state.places.length) return 'Tes établissements suivis apparaîtront ici.';
  return 'Aucun établissement suivi dans cette zone de la carte.';
}

/** The sidebar list: the établissements `shown` on the map, or why there are none. */
function renderSidebarList(shown) {
  $('#map-list-count').textContent = `${shown.length} affiché${shown.length > 1 ? 's' : ''}`;
  const list = $('#place-list');
  list.innerHTML = '';
  if (!shown.length) {
    list.innerHTML = `<p class="empty-list">${emptySidebarReason()}</p>`;
    return;
  }
  const template = $('#place-item-template');
  shown.forEach((place) => {
    const item = template.content.firstElementChild.cloneNode(true);
    item.dataset.id = place.placeId;
    if (place.placeId === state.selectedId) {
      item.classList.add('selected');
      item.querySelector('.place-item-main').setAttribute('aria-current', 'true');
    }
    const dot = item.querySelector('.status-dot');
    if (place.status !== 'to_visit') dot.classList.add(place.status);
    item.querySelector('strong').textContent = place.name;
    item.querySelector('small').textContent = place.address;
    item.querySelector('.place-item-main').addEventListener('click', () => selectPlace(place.placeId, true));
    list.appendChild(item);
  });
}

/** Shows the map or the Tableau de bord in the map area; the sidebar's forms stay either way, its list only with the map. */
function showView(view) {
  state.view = view;
  document.querySelectorAll('.view-switch [data-view]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.view === view));
  });
  $('#dashboard-panel').classList.toggle('hidden', view !== 'dashboard');
  $('#map-list-section').classList.toggle('hidden', view !== 'map');
  renderDashboard();
  // The sale price may have been changed in the settings since it was last read: re-read it, so the potentiel follows.
  if (view === 'dashboard') loadSalePrice().then(renderDashboard);
}

/** Reads the configured sale price into `state.salePrice`, keeping the last one read if it can't. */
async function loadSalePrice() {
  try {
    state.salePrice = (await store.getSettings()).salePrice;
  } catch (error) {
    console.error(error);
  }
}

/** Redraws the Tableau de bord's metric cards over the filtered set (see `dashboardMetrics`). */
function renderDashboardMetrics(filters) {
  const metrics = dashboardMetrics(state.places, { filters, salePrice: state.salePrice });
  const card = (modifier, label, count, figure = '') =>
    `<div class="metric ${modifier}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(count)}</strong>${figure ? `<p class="metric-amount">${escapeHtml(figure)}</p>` : ''}</div>`;
  // A potentiel is an estimate, not revenue: the « ≈ » sets it apart from the vendus' amount.
  const estimate = (potentiel) => (potentiel == null ? '—' : `≈ ${euros(potentiel)}`);
  $('#dashboard-metrics').innerHTML = [
    card('sold', 'Vendus', metrics.sold, euros(metrics.revenue)),
    card('scheduled', 'Programmés pour visite', metrics.scheduled, estimate(metrics.potentiel.scheduled)),
    card('visit', 'À visiter', metrics.toVisit, estimate(metrics.potentiel.toVisit)),
    card('refused', 'Refusés', metrics.refused),
  ].join('');
}

/** Fills `select` with an "all" entry (value "") then `options` (greyed out when `disabled`), and selects `value` (null for "all"). */
function fillFilterSelect(select, allLabel, options, value) {
  select.innerHTML = [{ value: '', label: allLabel }, ...options]
    .map((option) => `<option value="${escapeHtml(option.value)}"${option.disabled ? ' disabled' : ''}>${escapeHtml(option.label)}</option>`)
    .join('');
  select.value = value ?? '';
}

/**
 * Redraws the filter menus, the « Réinitialiser les filtres » link — offered only while a filter
 * is set — and the sort controls of the Tableau de bord from `menus` (see `filterMenus`).
 */
function renderDashboardControls(menus) {
  const { city, type, status } = menus.filters;
  const total = menus.statuses.reduce((sum, option) => sum + option.count, 0);
  fillFilterSelect($('#dashboard-city'), 'Toutes les communes', menus.cities, city);
  fillFilterSelect($('#dashboard-type'), 'Tous les types', menus.types, type);
  fillFilterSelect(
    $('#dashboard-status'),
    `Tous les statuts (${total})`,
    menus.statuses.map((option) => ({ ...option, label: `${option.label} (${option.count})` })),
    status
  );
  $('#dashboard-filters-reset').classList.toggle('hidden', !anyFilterChosen(menus.filters));
  const { key, direction } = state.dashboard.sort;
  $('#dashboard-sort').value = key;
  const directionButton = $('#dashboard-sort-direction');
  directionButton.textContent = SORT_DIRECTIONS[direction].label;
  directionButton.setAttribute('aria-label', `Ordre ${SORT_DIRECTIONS[direction].word}, cliquer pour inverser`);
}

/** The Tableau de bord's filtered set, in its sort order — every page of it. */
function dashboardListed() {
  return sortPlaces(
    state.places.filter((place) => matchesFilters(place, state.dashboard.filters)),
    state.dashboard.sort
  );
}

/**
 * Fills the print-only container with the printed Tableau de bord (see `printedDocument`): the
 * ticked établissements, or else the whole filtered set, from the list in memory rather than
 * the rows on screen — so a print of a many-page list holds every page. Run just before the
 * browser prints, whichever way the print was asked for (the button, or the browser's own).
 */
function renderDashboardPrint() {
  const printed = printedDocument(dashboardListed(), state.dashboard.selection, new Date());
  $('#dashboard-print-caption').textContent = printed.caption;
  $('#dashboard-print-rows').innerHTML = printed.rows
    .map(
      (row) =>
        `<tr><td><strong>${escapeHtml(row.name)}</strong><small>${escapeHtml(row.address)}</small></td><td>${escapeHtml(row.city) || '—'}</td><td>${escapeHtml(row.type)}</td><td>${escapeHtml(row.statusLabel)}</td><td class="amount">${escapeHtml(row.saleAmount)}</td></tr>`
    )
    .join('');
}

/** Redraws the Tableau de bord from `state.places` — only while it is the view on screen. */
function renderDashboard() {
  if (state.view !== 'dashboard') return;
  const menus = filterMenus(state.places, state.dashboard.filters);
  state.dashboard.filters = menus.filters;
  state.dashboard.selection = pruneSelection(state.dashboard.selection, state.places, menus.filters);
  renderDashboardControls(menus);
  renderDashboardMetrics(menus.filters);
  const listed = dashboardListed();
  const shown = dashboardPage(listed, state.dashboard);
  state.dashboard.page = shown.page;

  const tracked = state.places.length;
  const range = `${shown.first}-${shown.last} sur ${shown.total} établissement${plural(shown.total)}`;
  // filterMenus never leaves the filters emptying the list, so it is only empty with nothing tracked.
  $('#dashboard-summary').textContent = !tracked
    ? 'Aucun établissement suivi pour le moment.'
    : shown.total === tracked
      ? `${range} suivi${plural(tracked)}`
      : `${range} (sur ${tracked} suivi${plural(tracked)})`;

  const body = $('#dashboard-rows');
  body.innerHTML = shown.rows.length
    ? shown.rows
        .map(
          (row) =>
            `<tr data-id="${escapeHtml(row.placeId)}"><td class="select-cell"><input type="checkbox" aria-label="Sélectionner ${escapeHtml(row.name)}"></td><td><button type="button">${escapeHtml(row.name)}</button><small>${escapeHtml(row.address)}</small></td><td>${escapeHtml(row.city) || '—'}</td><td>${escapeHtml(row.type)}</td><td><span class="status-dot ${escapeHtml(row.status)}"></span>${escapeHtml(row.statusLabel)}</td><td class="amount">${escapeHtml(row.saleAmount)}</td></tr>`
        )
        .join('')
    : '<tr><td class="dashboard-empty" colspan="6">Tes établissements suivis apparaîtront ici.</td></tr>';
  body.querySelectorAll('tr[data-id]').forEach((tableRow) => {
    tableRow.querySelector('.select-cell input').addEventListener('change', (event) => {
      if (event.target.checked) state.dashboard.selection.add(tableRow.dataset.id);
      else state.dashboard.selection.delete(tableRow.dataset.id);
      setFormMessage('#dashboard-bulk-message', '');
      renderDashboardSelection(listed);
    });
    tableRow.addEventListener('click', (event) => {
      // Ticking a row selects it; only a click elsewhere on the row opens it on the map.
      if (event.target.closest('.select-cell')) return;
      showView('map');
      selectPlace(tableRow.dataset.id, true);
    });
  });

  renderDashboardSelection(listed);

  renderPageStrip($('#dashboard-page-strip'), {
    page: shown.page,
    totalPages: shown.totalPages,
    onSelect: (page) => {
      state.dashboard.page = page;
      renderDashboard();
      $('#dashboard-panel').scrollTop = 0;
    },
  });
}

/**
 * Redraws what shows the selection without rebuilding the rows: the row and header ticks, and
 * the action bar — shown only while something is ticked — with its count (and how many of the
 * ticked rows are off this page) and controls. `listed` is the filtered set, which the selection
 * is within.
 */
function renderDashboardSelection(listed) {
  const { selection } = state.dashboard;
  let onPage = 0;
  document.querySelectorAll('#dashboard-rows tr[data-id]').forEach((tableRow) => {
    const ticked = selection.has(tableRow.dataset.id);
    tableRow.querySelector('.select-cell input').checked = ticked;
    tableRow.classList.toggle('is-selected', ticked);
    if (ticked) onPage += 1;
  });

  const selectAll = $('#dashboard-select-all');
  selectAll.checked = listed.length > 0 && selection.size === listed.length;
  selectAll.indeterminate = selection.size > 0 && selection.size < listed.length;

  const count = selection.size;
  const elsewhere = count - onPage;
  $('#dashboard-bulk').classList.toggle('hidden', !count);
  $('#dashboard-selection-count').textContent = `${count} établissement${plural(count)} sélectionné${plural(count)}${elsewhere ? ` (dont ${elsewhere} sur d’autres pages)` : ''}`;
  // While a bulk change runs, what it acts on is frozen: no ticking, no clearing, no filtering.
  const locked = state.dashboard.bulkRunning;
  document.querySelectorAll('#dashboard-rows .select-cell input').forEach((checkbox) => (checkbox.disabled = locked));
  selectAll.disabled = locked || !listed.length;
  ['city', 'type', 'status'].forEach((filter) => ($(`#dashboard-${filter}`).disabled = locked));
  $('#dashboard-filters-reset').disabled = locked;
  $('#dashboard-bulk-status').disabled = locked;
  $('#dashboard-selection-clear').disabled = locked;
  $('#dashboard-bulk-apply').disabled = locked;
}

/** The confirmation every bulk change is preceded by, from its `impact` (see `bulkImpact`). */
function bulkConfirmation(impact) {
  const { count, unchanged, statusLabel, soldCount, amountCleared } = impact;
  let text = `Passer ${count} établissement${plural(count)} au statut « ${statusLabel} » ?`;
  if (unchanged) text += `\n(${unchanged} déjà à ce statut ne change${unchanged > 1 ? 'nt' : ''} pas.)`;
  if (soldCount) {
    text += `\n\n${soldCount} ${soldCount > 1 ? 'sont vendus' : 'est vendu'} : ${soldCount > 1 ? 'leurs montants de vente seront supprimés' : 'son montant de vente sera supprimé'}, soit ${euros(amountCleared)} au total.`;
  }
  return text;
}

/** Moves every ticked établissement to the statut picked in the action bar, after a confirmation. */
async function onBulkStatusChange() {
  const status = $('#dashboard-bulk-status').value;
  const selected = state.places.filter((place) => state.dashboard.selection.has(place.placeId));
  const impact = bulkImpact(selected, status);
  if (!impact.count) {
    setFormMessage('#dashboard-bulk-message', `Ces établissements sont déjà au statut « ${impact.statusLabel} ».`);
    return;
  }
  if (!window.confirm(bulkConfirmation(impact))) return;

  setFormMessage('#dashboard-bulk-message', 'Changement de statut en cours…');
  state.dashboard.bulkRunning = true;
  renderDashboard();
  await withBusyButton($('#dashboard-bulk-apply'), 'Modification…', async () => {
    let report;
    try {
      report = await runBulkStatusChange({ places: selected, status, store });
    } finally {
      state.dashboard.bulkRunning = false;
    }
    applyPlaceUpdates(report.updated);
    const moved = `${report.changed} établissement${plural(report.changed)} passé${plural(report.changed)} au statut « ${impact.statusLabel} »`;
    if (report.error) {
      console.error(report.error);
      setFormMessage(
        '#dashboard-bulk-message',
        `Arrêt sur « ${report.failed.name} » : ${moved} sur ${report.total}. Réessaie : les établissements déjà modifiés ne le seront pas deux fois.`,
        true
      );
      return;
    }
    state.dashboard.selection.clear();
    setFormMessage('#dashboard-bulk-message', `${moved}.`);
  });
  renderDashboard();
}

/** A stable, order-independent hash of a placeId, used to pick a deterministic sample within a bucket. */
function stableHash(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index++) hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  return hash >>> 0;
}

/** Picks up to `limit` places spread evenly across `bounds`, so a dense area doesn't crowd out sparser ones. */
function spatialSample(places, limit, bounds) {
  if (places.length <= limit) return places;
  const ne = bounds.getNorthEast();
  const sw = bounds.getSouthWest();
  const aspect = Math.max(0.5, Math.min(2, (ne.lng() - sw.lng()) / Math.max(0.0001, ne.lat() - sw.lat())));
  const rows = Math.max(3, Math.round(Math.sqrt(Math.min(limit, places.length) / aspect)));
  const cols = Math.max(3, Math.round(rows * aspect));
  const buckets = Array.from({ length: rows * cols }, () => []);
  places.forEach((place) => {
    const row = Math.min(rows - 1, Math.max(0, Math.floor(((place.lat - sw.lat()) / (ne.lat() - sw.lat())) * rows)));
    const col = Math.min(cols - 1, Math.max(0, Math.floor(((place.lng - sw.lng()) / (ne.lng() - sw.lng())) * cols)));
    buckets[row * cols + col].push(place);
  });
  buckets.forEach((bucket) => bucket.sort((a, b) => stableHash(a.placeId) - stableHash(b.placeId)));
  const selected = [];
  for (let level = 0; selected.length < limit; level++) {
    let addedAny = false;
    for (const bucket of buckets) {
      if (bucket[level]) {
        selected.push(bucket[level]);
        addedAny = true;
      }
      if (selected.length === limit) break;
    }
    if (!addedAny) break;
  }
  return selected;
}

/**
 * Caps the markers drawn on the map at MAX_VISIBLE_MARKERS, filling the statut buckets in
 * STATUS_ORDER and sampling each one spatially so a dense zone doesn't crowd out sparser areas.
 * `selectedId`'s établissement — the one whose détail card is open — holds a slot of its own,
 * taken before any bucket, so it stays drawn whatever its statut.
 */
export function chooseVisibleMarkers(places, bounds, selectedId = null) {
  if (places.length <= MAX_VISIBLE_MARKERS || !bounds) return places;
  const selected = places.find((place) => place.placeId === selectedId);
  let remaining = MAX_VISIBLE_MARKERS - (selected ? 1 : 0);
  let result = selected ? [selected] : [];
  for (const status of STATUS_ORDER) {
    if (!remaining) break;
    const group = places.filter((place) => place.status === status && place !== selected);
    const sample = spatialSample(group, remaining, bounds);
    result = result.concat(sample);
    remaining -= sample.length;
  }
  return result;
}

/** Whether `place` has coordinates inside `bounds` (edges included, antimeridian-straddling frames too). */
function inBounds(place, bounds) {
  if (place.lat == null || place.lng == null) return false;
  const ne = bounds.getNorthEast();
  const sw = bounds.getSouthWest();
  if (place.lat < sw.lat() || place.lat > ne.lat()) return false;
  return sw.lng() <= ne.lng() ? place.lng >= sw.lng() && place.lng <= ne.lng() : place.lng >= sw.lng() || place.lng <= ne.lng();
}

/**
 * The établissements the map view draws for the frame `bounds`: `inFrame` is every one inside
 * it, `shown` the capped subset that gets a marker — and, the same set, a row in the sidebar
 * list, the open établissement (`selectedId`) first. No frame yet (the map isn't loaded) means
 * nothing is drawn.
 */
export function placesOnMap(places, bounds, selectedId = null) {
  if (!bounds) return { inFrame: [], shown: [] };
  const inFrame = places.filter((place) => inBounds(place, bounds));
  const shown = chooseVisibleMarkers(inFrame, bounds, selectedId);
  return { inFrame, shown: openFirst(shown, selectedId) };
}

/** `places` with the open établissement (`selectedId`), if among them, moved to the front. */
function openFirst(places, selectedId) {
  const open = places.find((place) => place.placeId === selectedId);
  return open ? [open, ...places.filter((place) => place !== open)] : places;
}

/** Redraws the markers and the sidebar list for the current frame — a local redraw, no Supabase or Google request. */
function renderMapPlaces() {
  const { inFrame, shown } = placesOnMap(state.places, state.map?.getBounds(), state.selectedId);
  renderSidebarList(shown);
  if (!state.map || !window.google) return;
  state.markers.forEach((marker) => marker.setMap(null));
  state.markers.clear();
  $('#map-count').textContent = inFrame.length ? `${shown.length} affiché${shown.length > 1 ? 's' : ''} sur ${inFrame.length} dans la zone` : '';
  shown.forEach((place) => {
    const marker = new google.maps.Marker({
      position: { lat: place.lat, lng: place.lng },
      map: state.map,
      title: place.name,
      icon: markerIcon(place.status, place.placeId === state.selectedId),
    });
    marker.addListener('click', () => selectPlace(place.placeId));
    state.markers.set(place.placeId, marker);
  });
}

function selectPlace(placeId, pan = false) {
  const place = state.places.find((item) => item.placeId === placeId);
  if (!place) return;
  state.selectedId = placeId;
  renderMapPlaces();
  if (pan && state.map && place.lat != null && place.lng != null) {
    state.map.panTo({ lat: place.lat, lng: place.lng });
    state.map.setZoom(Math.max(state.map.getZoom(), 16));
  }
  renderDetail(place);
}

/** Replaces each of `updated` in state.places, and re-renders whatever's currently showing them, once. */
function applyPlaceUpdates(updated) {
  const byId = new Map(updated.map((place) => [place.id, place]));
  state.places = state.places.map((place) => byId.get(place.id) ?? place);
  renderPlaces();
  const inDetail = state.places.find((place) => place.placeId === state.selectedId);
  if (inDetail && byId.has(inDetail.id)) renderDetail(inDetail);
}

async function onStatusChange(place, status) {
  if (status === place.status) return;
  const reopening = TERMINAL_STATUSES.has(place.status) && status === 'to_visit';
  if (reopening) {
    const warning = place.status === 'sold' ? '\n\nSon montant de vente sera supprimé.' : '';
    if (!window.confirm(`Remettre « ${place.name} » au statut « À visiter » ?${warning}`)) return;
  }
  try {
    applyPlaceUpdates([await store.setStatus(place.id, status)]);
  } catch (error) {
    console.error(error);
    window.alert('Impossible de mettre à jour le statut. Réessaie dans un instant.');
  }
}

async function onEditSaleAmount(place) {
  const entry = window.prompt('Montant de la vente en euros (0 autorisé) :', String(Number(place.saleAmount || 0)).replace('.', ','));
  if (entry === null) return;
  const amount = Number(entry.trim().replace(',', '.'));
  if (!Number.isFinite(amount) || amount < 0) {
    window.alert('Indique un montant positif ou 0.');
    return;
  }
  try {
    applyPlaceUpdates([await store.setSaleAmount(place.id, amount)]);
  } catch (error) {
    console.error(error);
    window.alert('Impossible de mettre à jour le montant de la vente. Réessaie dans un instant.');
  }
}

function renderDetail(place) {
  const card = $('#detail-card');
  card.classList.remove('hidden');
  const saleBlock =
    place.status === 'sold'
      ? `<div class="sale-value">Vente : ${euros(place.saleAmount)} <button class="edit-sale" type="button" aria-label="Modifier le montant de la vente" title="Modifier le montant">✎</button></div>`
      : '';
  const statusButtons = STATUS_ORDER.map(
    (status) =>
      `<button data-status="${status}" type="button" class="${place.status === status ? 'selected-' + status : ''}">${STATUS_LABELS[status]}</button>`
  ).join('');
  card.innerHTML = `<button class="close-detail" type="button" aria-label="Fermer">×</button><h2>${escapeHtml(place.name)}</h2><p>${escapeHtml(place.address)}</p><div class="place-type">${escapeHtml(placeTypeLabel(place))}</div>${saleBlock}<div class="status-select">${statusButtons}</div><div class="link-actions"><button data-action="copy" type="button">Copier le lien NFC</button><button data-action="open" type="button">Ouvrir la fiche Google</button></div><code class="place-id">Place ID : ${escapeHtml(place.placeId)}</code>`;

  card.querySelector('.close-detail').onclick = () => {
    state.selectedId = null;
    card.classList.add('hidden');
    renderMapPlaces();
  };
  card.querySelectorAll('[data-status]').forEach((button) => {
    button.onclick = () => onStatusChange(place, button.dataset.status);
  });
  card.querySelector('.edit-sale')?.addEventListener('click', () => onEditSaleAmount(place));
  card.querySelector('[data-action="copy"]').onclick = async (event) => {
    try {
      await navigator.clipboard.writeText(mapsUrl(place));
      event.target.textContent = 'Lien copié ✓';
    } catch {
      window.prompt('Copie ce lien :', mapsUrl(place));
    }
  };
  card.querySelector('[data-action="open"]').onclick = () => window.open(mapsUrl(place), '_blank', 'noopener');
}

function renderResults(results) {
  const section = $('#results-section');
  const list = $('#search-results');
  list.innerHTML = '';
  if (!results.length) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');
  const template = $('#result-item-template');
  const trackedIds = new Set(state.places.map((place) => place.placeId));
  results.forEach((candidate) => {
    if (!candidate.id) return;
    const alreadyTracked = trackedIds.has(candidate.id);
    const item = template.content.firstElementChild.cloneNode(true);
    item.dataset.id = candidate.id;
    item.querySelector('strong').textContent = candidate.displayName || 'Établissement Google';
    item.querySelector('small').textContent = candidate.formattedAddress || '';
    const addButton = item.querySelector('.result-add');
    if (alreadyTracked) {
      addButton.textContent = '✓';
      addButton.disabled = true;
      addButton.title = 'Déjà suivi';
      item.querySelector('.place-item-main').addEventListener('click', () => selectPlace(candidate.id, true));
    } else {
      addButton.addEventListener('click', () => addResult(candidate, addButton));
    }
    list.appendChild(item);
  });
}

async function addResult(candidate, button) {
  button.disabled = true;
  try {
    const { place } = await store.upsertPlace({
      placeId: candidate.id,
      name: candidate.displayName || 'Établissement Google',
      address: candidate.formattedAddress || '',
      lat: candidate.location?.lat?.() ?? null,
      lng: candidate.location?.lng?.() ?? null,
      types: candidate.types || [],
    });
    if (!state.places.some((tracked) => tracked.placeId === place.placeId)) state.places = [place, ...state.places];
    renderPlaces();
    selectPlace(place.placeId, true);
    button.textContent = '✓';
    button.title = 'Déjà suivi';
  } catch (error) {
    console.error(error);
    button.disabled = false;
    window.alert("Impossible d'ajouter cet établissement. Réessaie dans un instant.");
  }
}

async function onSearchSubmit(event) {
  event.preventDefault();
  const query = $('#query').value.trim();
  if (!query) return;
  if (!window.google?.maps?.places?.Place) {
    setFormMessage('#search-message', 'La carte n’est pas encore chargée.', true);
    return;
  }
  setFormMessage('#search-message', 'Recherche en cours…');
  await withBusyButton($('#search-button'), 'Recherche…', async () => {
    try {
      await requireQuota('places');
      const { places: results = [] } = await google.maps.places.Place.searchByText({
        textQuery: query,
        fields: ['id', 'displayName', 'formattedAddress', 'location', 'types'],
        maxResultCount: 10,
      });
      renderResults(results);
      setFormMessage(
        '#search-message',
        results.length ? `${results.length} résultat${results.length > 1 ? 's' : ''}.` : 'Aucun résultat pour cette recherche.'
      );
    } catch (error) {
      if (error instanceof QuotaExceededError) {
        setFormMessage('#search-message', error.message, true);
        return;
      }
      console.error(error);
      setFormMessage('#search-message', 'La recherche a échoué. Réessaie dans un instant.', true);
    }
  });
}

async function onCenterSubmit(event) {
  event.preventDefault();
  const textQuery = $('#city').value.trim();
  if (!textQuery) {
    setFormMessage('#city-message', 'Indique une ville avant de centrer la carte.', true);
    return;
  }
  if (!window.google?.maps?.places?.Place || !state.map) {
    setFormMessage('#city-message', 'La carte n’est pas encore chargée.', true);
    return;
  }
  await withBusyButton($('#center-button'), 'Centrage…', async () => {
    try {
      await requireQuota('places');
      const { places: results = [] } = await google.maps.places.Place.searchByText({
        textQuery,
        fields: ['displayName', 'location', 'viewport'],
        maxResultCount: 1,
      });
      const place = results[0];
      if (!place?.location) {
        setFormMessage('#city-message', 'Ville introuvable. Essaie avec la commune et le pays.', true);
        return;
      }
      if (place.viewport) state.map.fitBounds(place.viewport);
      else {
        state.map.setCenter(place.location);
        state.map.setZoom(13);
      }
      setFormMessage('#city-message', `Carte centrée sur ${place.displayName || textQuery}.`);
    } catch (error) {
      if (error instanceof QuotaExceededError) {
        setFormMessage('#city-message', error.message, true);
        return;
      }
      console.error(error);
      setFormMessage('#city-message', 'Le centrage a échoué. Réessaie dans un instant.', true);
    }
  });
}

/**
 * Splits the visible map `bounds` into a grid of square cells to scan individually — even a
 * small zone is cut into at least 3×3, since Google caps the results of a single dense-area
 * request and a lone call could hide neighboring businesses. Capped at MAX_ZONE_REQUESTS
 * cells total regardless of zone size, matching the per-scan Places request budget.
 */
export function zoneCells(bounds) {
  const ne = bounds.getNorthEast();
  const sw = bounds.getSouthWest();
  const centerLat = (ne.lat() + sw.lat()) / 2;
  const latSpan = ne.lat() - sw.lat();
  const lngSpan = ne.lng() - sw.lng();
  const latMeters = latSpan * 111320;
  const lngMeters = lngSpan * 111320 * Math.cos((centerLat * Math.PI) / 180);
  const cellSide = 1200;
  const rows = Math.max(3, Math.min(10, Math.ceil(latMeters / cellSide)));
  const cols = Math.max(3, Math.min(10, Math.ceil(lngMeters / cellSide)));
  const total = Math.min(MAX_ZONE_REQUESTS, rows * cols);
  const cells = [];
  for (let row = 0; row < rows && cells.length < total; row++) {
    for (let col = 0; col < cols && cells.length < total; col++) {
      const lat = sw.lat() + (latSpan * (row + 0.5)) / rows;
      const lng = sw.lng() + (lngSpan * (col + 0.5)) / cols;
      const halfLat = latMeters / rows / 2;
      const halfLng = lngMeters / cols / 2;
      cells.push({ center: { lat, lng }, radius: Math.max(50, Math.sqrt(halfLat ** 2 + halfLng ** 2) * 1.12) });
    }
  }
  return cells;
}

/** Scans `cells` one at a time via `requireQuota`+`searchCell`, adding every newly discovered établissement through `store.upsertPlace` — the same write path a manual search-and-add uses, so a rediscovered établissement is never duplicated. Stops issuing further requests the moment quota is exhausted, without throwing. */
export async function runZoneScan({ cells, store, searchCell, onCellStart, onPlaceAdded } = {}) {
  let added = 0;
  let cellsProcessed = 0;
  let quotaExhausted = false;

  for (const cell of cells) {
    try {
      await requireQuota('places', store);
    } catch (error) {
      if (!(error instanceof QuotaExceededError)) throw error;
      quotaExhausted = true;
      break;
    }
    cellsProcessed += 1;
    onCellStart?.({ cellsProcessed, cellsTotal: cells.length, added });

    const candidates = (await searchCell(cell)) || [];
    for (const candidate of candidates) {
      if (!candidate.id) continue;
      const { place, created } = await store.upsertPlace({
        placeId: candidate.id,
        name: candidate.displayName || 'Établissement Google',
        address: candidate.formattedAddress || '',
        lat: candidate.location?.lat?.() ?? null,
        lng: candidate.location?.lng?.() ?? null,
        types: candidate.types || [],
      });
      if (created) {
        added += 1;
        onPlaceAdded?.(place);
      }
    }
  }

  return { added, cellsProcessed, cellsTotal: cells.length, quotaExhausted };
}

/**
 * Moves the établissements `places` to `status` (one of BULK_STATUSES — never vendu) with one
 * `store.setStatus` call each, in order: the store's single-établissement write path, so the
 * Backlog trail is the one the same changes made one at a time would leave. No transaction —
 * on the first failure it stops, and the report says how many were `changed` before it and
 * which établissement `failed`, with the `error`. An établissement already at `status` is
 * skipped, and `setStatus` itself is a no-op on one that got there since, so a retry over
 * the same selection never applies a statut twice. `updated` holds the établissements as
 * changed, for the caller to redraw.
 */
export async function runBulkStatusChange({ places, status, store }) {
  const moving = bulkMoves(places, status);
  const updated = [];
  for (const place of moving) {
    try {
      updated.push(await store.setStatus(place.id, status));
    } catch (error) {
      return { changed: updated.length, total: moving.length, updated, failed: place, error };
    }
  }
  return { changed: updated.length, total: moving.length, updated, failed: null, error: null };
}

/** "3 nouvelles fiches ajoutées" / "1 nouvelle fiche ajoutée" / "aucune nouvelle fiche" — French plural agreement for the scan's running add count. */
function addedFichesLabel(count) {
  if (!count) return 'aucune nouvelle fiche';
  return `${count} nouvelle${count > 1 ? 's' : ''} fiche${count > 1 ? 's' : ''} ajoutée${count > 1 ? 's' : ''}`;
}

async function onScanZone() {
  if (!window.google?.maps?.places?.Place || !state.map?.getBounds()) {
    setFormMessage('#scan-message', 'La carte n’est pas encore chargée.', true);
    return;
  }
  const cells = zoneCells(state.map.getBounds());
  let addedSoFar = 0;
  await withBusyButton($('#scan-button'), 'Balayage…', async () => {
    setFormMessage('#scan-message', 'Préparation du balayage de la zone…');
    try {
      const result = await runZoneScan({
        cells,
        store,
        searchCell: async (cell) => {
          const { places = [] } = await google.maps.places.Place.searchNearby({
            fields: ['id', 'displayName', 'formattedAddress', 'location', 'types'],
            locationRestriction: { center: cell.center, radius: cell.radius },
            maxResultCount: 20,
          });
          return places;
        },
        onCellStart: ({ cellsProcessed, cellsTotal, added }) => {
          setFormMessage('#scan-message', `Balayage de la zone… ${cellsProcessed} / ${cellsTotal} · ${addedFichesLabel(added)}.`);
        },
        onPlaceAdded: (place) => {
          addedSoFar += 1;
          state.places = [place, ...state.places];
          renderPlaces();
        },
      });

      if (result.quotaExhausted) {
        setFormMessage('#scan-message', `${QUOTA_MESSAGE} ${addedFichesLabel(result.added)} avant l’arrêt.`, true);
      } else {
        setFormMessage('#scan-message', `Balayage terminé : ${addedFichesLabel(result.added)}.`);
      }
    } catch (error) {
      console.error(error);
      const progress = addedSoFar ? ` ${addedFichesLabel(addedSoFar)} avant l’échec.` : '';
      setFormMessage('#scan-message', `Google a refusé le balayage.${progress} Réessaie dans un instant.`, true);
    }
  });
}

function loadGoogleMapsScript(apiKey) {
  if (window.google?.maps) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=places&v=weekly&language=fr&region=FR`;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Le script Google Maps n’a pas pu être chargé.'));
    document.head.appendChild(script);
  });
}

/** No map this session, so no markers and no sidebar list: says so where the list would be. */
function showMapUnavailable() {
  state.mapUnavailable = true;
  renderSidebarList([]);
}

async function initMap(googleMapsApiKey) {
  const placeholderText = $('#map-placeholder-text');

  try {
    await requireQuota('maps');
  } catch (error) {
    placeholderText.textContent =
      error instanceof QuotaExceededError
        ? `${QUOTA_MESSAGE} La carte sera disponible le mois prochain.`
        : 'Impossible de vérifier le quota Google. Réessaie plus tard.';
    if (!(error instanceof QuotaExceededError)) console.error(error);
    showMapUnavailable();
    return;
  }

  try {
    await loadGoogleMapsScript(googleMapsApiKey);
  } catch (error) {
    console.error(error);
    placeholderText.textContent = 'La carte ne se charge pas. Réessaie plus tard.';
    showMapUnavailable();
    return;
  }

  $('#map-placeholder').classList.add('hidden');
  state.map = new google.maps.Map($('#map'), {
    center: DEFAULT_CENTER,
    zoom: 12,
    mapId: 'bde09a7761141982702e4cba',
    streetViewControl: false,
    mapTypeControl: false,
    fullscreenControl: false,
  });
  // The markers and the sidebar list depend on the frame, so redraw once the map settles after
  // any pan or zoom — including the pan to an établissement picked from the list or the Tableau de bord.
  state.map.addListener('idle', renderMapPlaces);
  renderMapPlaces();
}

async function start() {
  store = bootstrapStore(window);
  const config = readConfig(window);
  if (!store || !config) return;

  document.querySelectorAll('.view-switch [data-view]').forEach((button) => {
    button.addEventListener('click', () => showView(button.dataset.view));
  });
  $('#dashboard-size').addEventListener('change', (event) => {
    state.dashboard.pageSize = Number(event.target.value);
    state.dashboard.page = 1;
    renderDashboard();
  });
  /** Applies a filter or sort change to the Tableau de bord and redraws it from its first page. */
  const redrawDashboardFromFirstPage = ({ filters = {}, sort = {} }) => {
    state.dashboard.filters = { ...state.dashboard.filters, ...filters };
    state.dashboard.sort = { ...state.dashboard.sort, ...sort };
    state.dashboard.page = 1;
    // A filter change can prune the selection a bulk message was about.
    setFormMessage('#dashboard-bulk-message', '');
    renderDashboard();
  };
  ['city', 'type', 'status'].forEach((filter) => {
    $(`#dashboard-${filter}`).addEventListener('change', (event) => redrawDashboardFromFirstPage({ filters: { [filter]: event.target.value || null } }));
  });
  $('#dashboard-filters-reset').addEventListener('click', () => {
    // Resets the filters only: the sort, the page size and the selection are kept.
    redrawDashboardFromFirstPage({ filters: NO_FILTERS });
    // The link just hid itself with no filter left set; keep keyboard focus on the filters.
    $('#dashboard-city').focus();
  });
  $('#dashboard-select-all').addEventListener('change', (event) => {
    // Ticks the whole filtered set, rows on other pages included — not just this page.
    state.dashboard.selection = event.target.checked ? filteredPlaceIds(state.places, state.dashboard.filters) : new Set();
    setFormMessage('#dashboard-bulk-message', '');
    renderDashboard();
  });
  $('#dashboard-selection-clear').addEventListener('click', () => {
    state.dashboard.selection.clear();
    setFormMessage('#dashboard-bulk-message', '');
    renderDashboard();
    // The button just hid itself with the action bar; keep keyboard focus on the table.
    $('#dashboard-select-all').focus();
  });
  $('#dashboard-bulk-status').innerHTML = BULK_STATUSES.map((status) => `<option value="${status}">${STATUS_LABELS[status]}</option>`).join('');
  $('#dashboard-bulk-apply').addEventListener('click', onBulkStatusChange);
  $('#dashboard-print').addEventListener('click', () => window.print());
  // The printed Tableau de bord replaces the page only while it is the view on screen; printing
  // the map view prints the page as it is.
  window.addEventListener('beforeprint', () => {
    const printing = state.view === 'dashboard';
    if (printing) renderDashboardPrint();
    document.body.classList.toggle('printing-dashboard', printing);
  });
  window.addEventListener('afterprint', () => document.body.classList.remove('printing-dashboard'));
  $('#dashboard-sort').addEventListener('change', (event) => redrawDashboardFromFirstPage({ sort: { key: event.target.value } }));
  $('#dashboard-sort-direction').addEventListener('click', () =>
    redrawDashboardFromFirstPage({ sort: { direction: SORT_DIRECTIONS[state.dashboard.sort.direction].next } })
  );

  if (!config.googleMapsApiKey) {
    $('#map-placeholder-text').textContent = 'Clé Google Maps manquante pour ce déploiement.';
    $('#search-button').disabled = true;
    $('#center-button').disabled = true;
    $('#scan-button').disabled = true;
    showMapUnavailable();
    return;
  }

  $('#search-form').addEventListener('submit', onSearchSubmit);
  $('#city-form').addEventListener('submit', onCenterSubmit);
  $('#scan-button').addEventListener('click', onScanZone);

  [state.places] = await Promise.all([
    store.listPlaces().catch((error) => {
      console.error(error);
      return [];
    }),
    loadSalePrice(),
  ]);
  renderPlaces();

  await initMap(config.googleMapsApiKey);
}

if (typeof document !== 'undefined') start();
