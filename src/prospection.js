import { bootstrapStore } from './bootstrap.js';
import { readConfig } from './supabase-client.js';

/**
 * The Prospection page: text search for a business, add it to the tracked list, see it on
 * the map, and copy/open its Google Maps link for NFC encoding. Every Google Places / Maps
 * JavaScript call goes through the store's `checkAndConsumeQuota()` first.
 */

const STATUS_COLORS = { to_visit: '#55a7e8', scheduled: '#e5b72b', sold: '#22a06b', refused: '#e5484d', non_compliant: '#a1a9b7' };
const DEFAULT_CENTER = { lat: 43.1808, lng: 5.7115 };
const QUOTA_MESSAGE = 'Limite mensuelle de requêtes Google atteinte.';

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (text = '') =>
  String(text).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);

function placeType(place) {
  const ignored = new Set(['point_of_interest', 'establishment', 'food', 'store', 'premise']);
  return (place.types || []).find((type) => !ignored.has(type)) || 'Autre';
}

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
async function requireQuota(api) {
  const quota = await store.checkAndConsumeQuota({ api });
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

function renderMarkers() {
  if (!state.map || !window.google) return;
  state.markers.forEach((marker) => marker.setMap(null));
  state.markers.clear();
  state.places.forEach((place) => {
    if (place.lat == null || place.lng == null) return;
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

function renderDetail(place) {
  const card = $('#detail-card');
  card.classList.remove('hidden');
  card.innerHTML = `<button class="close-detail" type="button" aria-label="Fermer">×</button><h2>${escapeHtml(place.name)}</h2><p>${escapeHtml(place.address)}</p><div class="place-type">${escapeHtml(placeType(place).replaceAll('_', ' '))}</div><div class="link-actions"><button data-action="copy" type="button">Copier le lien NFC</button><button data-action="open" type="button">Ouvrir la fiche Google</button></div><code class="place-id">Place ID : ${escapeHtml(place.placeId)}</code>`;

  card.querySelector('.close-detail').onclick = () => {
    state.selectedId = null;
    card.classList.add('hidden');
    renderMarkers();
  };
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
    return;
  }

  $('#search-form').addEventListener('submit', onSearchSubmit);
  $('#city-form').addEventListener('submit', onCenterSubmit);

  state.places = await store.listPlaces().catch((error) => {
    console.error(error);
    return [];
  });
  renderPlaceList();

  await initMap(config.googleMapsApiKey);
}

if (typeof document !== 'undefined') start();
