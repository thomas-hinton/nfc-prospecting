import { bootstrapStore } from './bootstrap.js';
import { readConfig } from './supabase-client.js';
import { STATUS_LABELS, euros } from './store.js';
import { placeType } from './place-fields.js';

/**
 * The Prospection page: text search for a business, add it to the tracked list, see it on
 * the map, and copy/open its Google Maps link for NFC encoding. Every Google Places / Maps
 * JavaScript call goes through the store's `checkAndConsumeQuota()` first.
 */

const STATUS_COLORS = { to_visit: '#55a7e8', scheduled: '#e5b72b', sold: '#22a06b', refused: '#e5484d', non_compliant: '#a1a9b7' };
const STATUS_ORDER = ['to_visit', 'scheduled', 'sold', 'refused', 'non_compliant'];
const TERMINAL_STATUSES = new Set(['sold', 'refused', 'non_compliant']);
const DEFAULT_CENTER = { lat: 43.1808, lng: 5.7115 };
const QUOTA_MESSAGE = 'Limite mensuelle de requêtes Google atteinte.';
const MAX_ZONE_REQUESTS = 100;
const MAX_VISIBLE_MARKERS = 250;

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
const state = { places: [], map: null, markers: new Map(), selectedId: null };

function setFormMessage(id, text, isError = false) {
  const message = $(id);
  message.className = `form-message${isError ? ' error' : ''}`;
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

function renderPlaceList() {
  $('#saved-count').textContent = state.places.length;
  const list = $('#place-list');
  list.innerHTML = '';
  if (!state.places.length) {
    list.innerHTML = '<p class="empty-list">Tes établissements suivis apparaîtront ici.</p>';
    return;
  }
  const template = $('#place-item-template');
  state.places.forEach((place) => {
    const item = template.content.firstElementChild.cloneNode(true);
    item.dataset.id = place.placeId;
    const dot = item.querySelector('.status-dot');
    if (place.status !== 'to_visit') dot.classList.add(place.status);
    item.querySelector('strong').textContent = place.name;
    item.querySelector('small').textContent = place.address;
    item.querySelector('.place-item-main').addEventListener('click', () => selectPlace(place.placeId, true));
    list.appendChild(item);
  });
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

/** Caps the markers drawn on the map at MAX_VISIBLE_MARKERS, sampling each statut bucket separately so a scan of a dense zone doesn't drown out other statuts, and always keeping `selectedId`'s marker visible. */
export function chooseVisibleMarkers(places, bounds, selectedId = null) {
  if (places.length <= MAX_VISIBLE_MARKERS || !bounds) return places;
  let remaining = MAX_VISIBLE_MARKERS;
  let result = [];
  for (const status of STATUS_ORDER) {
    if (!remaining) break;
    const group = places.filter((place) => place.status === status);
    const selected = group.find((place) => place.placeId === selectedId);
    const sample = spatialSample(group, remaining, bounds);
    if (selected && !sample.some((place) => place.placeId === selected.placeId)) {
      sample.pop();
      sample.unshift(selected);
    }
    result = result.concat(sample);
    remaining -= sample.length;
  }
  return result;
}

function renderMarkers() {
  if (!state.map || !window.google) return;
  state.markers.forEach((marker) => marker.setMap(null));
  state.markers.clear();
  const bounds = state.map.getBounds();
  const inFrame = bounds
    ? state.places.filter((place) => place.lat != null && place.lng != null && bounds.contains({ lat: place.lat, lng: place.lng }))
    : state.places.filter((place) => place.lat != null && place.lng != null);
  const displayed = chooseVisibleMarkers(inFrame, bounds, state.selectedId);
  const countEl = $('#map-count');
  if (countEl) countEl.textContent = inFrame.length ? `${displayed.length} affiché${displayed.length > 1 ? 's' : ''} sur ${inFrame.length} dans la zone` : '';
  displayed.forEach((place) => {
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
  renderMarkers();
  if (pan && state.map && place.lat != null && place.lng != null) {
    state.map.panTo({ lat: place.lat, lng: place.lng });
    state.map.setZoom(Math.max(state.map.getZoom(), 16));
  }
  renderDetail(place);
}

/** Replaces `updated` in state.places, and re-renders whatever's currently showing it. */
function applyPlaceUpdate(updated) {
  state.places = state.places.map((place) => (place.id === updated.id ? updated : place));
  renderPlaceList();
  renderMarkers();
  if (state.selectedId === updated.placeId) renderDetail(updated);
}

async function onStatusChange(place, status) {
  if (status === place.status) return;
  const reopening = TERMINAL_STATUSES.has(place.status) && status === 'to_visit';
  if (reopening) {
    const warning = place.status === 'sold' ? '\n\nSon montant de vente sera supprimé.' : '';
    if (!window.confirm(`Remettre « ${place.name} » au statut « À visiter » ?${warning}`)) return;
  }
  try {
    applyPlaceUpdate(await store.setStatus(place.id, status));
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
    applyPlaceUpdate(await store.setSaleAmount(place.id, amount));
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
  card.innerHTML = `<button class="close-detail" type="button" aria-label="Fermer">×</button><h2>${escapeHtml(place.name)}</h2><p>${escapeHtml(place.address)}</p><div class="place-type">${escapeHtml(placeType(place).replaceAll('_', ' '))}</div>${saleBlock}<div class="status-select">${statusButtons}</div><div class="link-actions"><button data-action="copy" type="button">Copier le lien NFC</button><button data-action="open" type="button">Ouvrir la fiche Google</button></div><code class="place-id">Place ID : ${escapeHtml(place.placeId)}</code>`;

  card.querySelector('.close-detail').onclick = () => {
    state.selectedId = null;
    card.classList.add('hidden');
    renderMarkers();
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
    renderPlaceList();
    renderMarkers();
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
          renderPlaceList();
          renderMarkers();
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
    return;
  }

  try {
    await loadGoogleMapsScript(googleMapsApiKey);
  } catch (error) {
    console.error(error);
    placeholderText.textContent = 'La carte ne se charge pas. Réessaie plus tard.';
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
  renderMarkers();
}

async function start() {
  store = bootstrapStore(window);
  const config = readConfig(window);
  if (!store || !config) return;

  if (!config.googleMapsApiKey) {
    $('#map-placeholder-text').textContent = 'Clé Google Maps manquante pour ce déploiement.';
    $('#search-button').disabled = true;
    $('#center-button').disabled = true;
    $('#scan-button').disabled = true;
    return;
  }

  $('#search-form').addEventListener('submit', onSearchSubmit);
  $('#city-form').addEventListener('submit', onCenterSubmit);
  $('#scan-button').addEventListener('click', onScanZone);

  state.places = await store.listPlaces().catch((error) => {
    console.error(error);
    return [];
  });
  renderPlaceList();

  await initMap(config.googleMapsApiKey);
}

if (typeof document !== 'undefined') start();
