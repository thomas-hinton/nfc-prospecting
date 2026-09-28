import { bootstrapStore } from './bootstrap.js';
import { euros } from './store.js';
import { mapsUrl } from './place-fields.js';

/**
 * The Visite page: the établissements programmé pour visite, oldest programmation first,
 * and for each one the outcome of the field visit — vendu, refusé, non conforme, or à
 * visiter (back to the pool) — saved as a single confirmed `store.recordVisit()`. Whatever
 * the outcome, the établissement then leaves the list. There is no undo here: a mistaken
 * outcome is corrected from Prospection.
 */

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (text = '') =>
  String(text).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);

/** The four outcome buttons, in display order, with their labels. */
const OUTCOMES = {
  sold: { label: 'Vendu', className: 'sold' },
  refused: { label: 'Refusé', className: 'refused' },
  non_compliant: { label: 'Non conforme', className: 'non_compliant' },
  to_visit: { label: 'À visiter', className: 'to_visit' },
};

const SAVE_ERROR = "La visite n'a pas pu être enregistrée. Vérifie ta connexion et réessaie : ta saisie est conservée.";

/**
 * The établissements programmé pour visite matching `query` (on name, address or commune,
 * ignoring case), oldest programmation first.
 *
 * @param {object[]} places
 * @param {string} [query]
 * @returns {object[]}
 */
export function scheduledVisits(places, query = '') {
  const needle = query.trim().toLocaleLowerCase('fr-FR');
  return places
    .filter((place) => place.status === 'scheduled')
    .filter((place) => !needle || `${place.name} ${place.address} ${place.city ?? ''}`.toLocaleLowerCase('fr-FR').includes(needle))
    .sort((a, b) => (a.statusChangedAt > b.statusChangedAt ? 1 : a.statusChangedAt < b.statusChangedAt ? -1 : 0));
}

/**
 * The sale amount typed in the vendu field — a comma accepted as the decimal separator —
 * or null when it is empty, negative or not a number. 0 is a valid amount.
 *
 * @param {string|null|undefined} raw
 * @returns {number|null}
 */
export function parseSaleAmount(raw) {
  const text = String(raw ?? '').trim().replace(',', '.');
  if (!text) return null;
  const amount = Number(text);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

let store = null;
const state = { places: [], salePrice: null, activeId: null, pendingStatus: null, saving: false };

const activePlace = () => state.places.find((place) => place.id === state.activeId);

function renderVisits() {
  const visits = scheduledVisits(state.places, $('#visit-search').value);
  $('#visit-count').textContent = visits.length;
  $('#visit-list-message').textContent = visits.length
    ? `${visits.length} visite${visits.length > 1 ? 's' : ''} programmée${visits.length > 1 ? 's' : ''}`
    : 'Aucune visite programmée.';
  $('#visit-list').innerHTML = visits.length
    ? visits
        .map(
          (place) =>
            `<button class="visit-card ${place.id === state.activeId ? 'active' : ''}" data-visit-id="${escapeHtml(place.id)}" type="button"><span class="visit-card-dot"></span><span><strong>${escapeHtml(place.name)}</strong><small>${escapeHtml(place.address)}</small></span><b>›</b></button>`
        )
        .join('')
    : '<div class="visit-empty-state"><span>✓</span><strong>Ta liste est terminée.</strong><p>Les établissements programmés pour visite apparaîtront ici.</p></div>';
  document.querySelectorAll('[data-visit-id]').forEach((button) => {
    button.onclick = () => {
      state.activeId = button.dataset.visitId;
      state.pendingStatus = null;
      renderVisits();
      renderEditor();
    };
  });
  if (state.activeId && !visits.some((place) => place.id === state.activeId)) closeEditor();
}

function closeEditor() {
  state.activeId = null;
  state.pendingStatus = null;
  $('#visit-editor').classList.add('hidden');
}

/** The fields shown for the chosen outcome: the comment is optional for every one, the sale amount required for vendu. */
function outcomeFields(status) {
  const comment = (label, placeholder) =>
    `<label>${label} <span>facultatif</span><textarea id="visit-comment" placeholder="${placeholder}"></textarea></label>`;
  if (status === 'sold') {
    const salePrice = state.salePrice ?? '';
    return `<label>Prix de vente (€)<input id="visit-sale-amount" type="number" min="0" step="0.01" required value="${escapeHtml(salePrice)}" /></label>${comment('Commentaire', 'Ex. carte remise, coordonnées du contact…')}`;
  }
  if (status === 'refused') return comment('Motif du refus', 'Ex. déjà équipé, pas intéressé, budget…');
  if (status === 'non_compliant') return comment('Commentaire', 'Explique pourquoi cet établissement ne correspond pas à ta prospection.');
  if (status === 'to_visit') return comment('Pourquoi reprogrammer cette visite ?', 'Ex. fermé, absent, repasser à une autre heure…');
  return '<p class="visit-field-help">Choisis le résultat de ta visite pour afficher les informations à renseigner.</p>';
}

/** Whether the form holds a savable visit: an outcome is chosen and, for vendu, the sale amount is valid. */
function formIsValid() {
  if (!state.pendingStatus) return false;
  return state.pendingStatus !== 'sold' || parseSaleAmount($('#visit-sale-amount')?.value) !== null;
}

function refreshSaveButton() {
  $('#visit-save').disabled = state.saving || !formIsValid();
}

function renderEditor() {
  const place = activePlace();
  const editor = $('#visit-editor');
  if (!place) {
    editor.classList.add('hidden');
    return;
  }
  const selected = state.pendingStatus ? OUTCOMES[state.pendingStatus] : null;
  const outcomeButtons = Object.entries(OUTCOMES)
    .map(
      ([status, meta]) =>
        `<button class="${meta.className} ${state.pendingStatus === status ? 'active' : ''}" data-visit-status="${status}" type="button">${meta.label}</button>`
    )
    .join('');
  editor.innerHTML = `<button id="visit-close" class="visit-close" type="button" aria-label="Fermer">×</button><p class="eyebrow">VISITE PROGRAMMÉE</p><h2>${escapeHtml(place.name)}</h2><p class="visit-address">${escapeHtml(place.address)}</p><button id="visit-open-google" class="visit-open-google" type="button">Ouvrir la fiche Google</button><div class="visit-status-options">${outcomeButtons}</div><div class="visit-fields ${selected ? selected.className : ''}">${outcomeFields(state.pendingStatus)}</div><p id="visit-error" class="visit-error hidden" role="alert"></p><button id="visit-save" class="primary visit-save" type="button">Enregistrer la visite</button>`;
  editor.classList.remove('hidden');

  $('#visit-close').onclick = () => {
    closeEditor();
    renderVisits();
  };
  $('#visit-open-google').onclick = () => window.open(mapsUrl(place), '_blank', 'noopener');
  document.querySelectorAll('[data-visit-status]').forEach((button) => {
    button.onclick = () => {
      state.pendingStatus = button.dataset.visitStatus;
      renderEditor();
    };
  });
  $('#visit-sale-amount')?.addEventListener('input', refreshSaveButton);
  $('#visit-save').onclick = requestVisitSave;
  refreshSaveButton();
}

function showSaveError(message) {
  const error = $('#visit-error');
  error.textContent = message;
  error.classList.toggle('hidden', !message);
}

function requestVisitSave() {
  const place = activePlace();
  if (!place || !formIsValid()) return;
  const status = state.pendingStatus;
  const comment = $('#visit-comment')?.value.trim() || '';
  const saleAmount = status === 'sold' ? parseSaleAmount($('#visit-sale-amount').value) : undefined;
  $('#visit-confirm-text').textContent = `Tu vas passer « ${place.name || 'cet établissement'} » au statut « ${OUTCOMES[status].label} »${status === 'sold' ? ` pour ${euros(saleAmount)}.` : '.'}`;
  $('#visit-confirm').classList.remove('hidden');
  $('#visit-confirm-save').onclick = () => saveVisit(place, status, { comment, saleAmount });
}

async function saveVisit(place, status, { comment, saleAmount }) {
  if (state.saving) return;
  state.saving = true;
  const confirmButton = $('#visit-confirm-save');
  confirmButton.disabled = true;
  showSaveError('');
  refreshSaveButton();
  try {
    const updated = await store.recordVisit(place.id, status, { comment, saleAmount });
    state.places = state.places.map((item) => (item.id === updated.id ? updated : item));
    $('#visit-confirm').classList.add('hidden');
    closeEditor();
    renderVisits();
    showToast(`Visite enregistrée : ${OUTCOMES[status].label}.`);
  } catch (error) {
    console.error(error);
    // The form is left as it is — outcome, comment and amount — so the save can be retried.
    $('#visit-confirm').classList.add('hidden');
    showSaveError(SAVE_ERROR);
  } finally {
    state.saving = false;
    confirmButton.disabled = false;
    if (activePlace()) refreshSaveButton();
  }
}

function showToast(message) {
  const toast = $('#visit-toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  window.setTimeout(() => toast.classList.add('hidden'), 3200);
}

async function start() {
  store = bootstrapStore(window);
  if (!store) return;

  $('#visit-search').addEventListener('input', renderVisits);
  $('#visit-confirm-cancel').addEventListener('click', () => $('#visit-confirm').classList.add('hidden'));

  // Without the settings the vendu amount simply starts empty, to be typed in.
  store
    .getSettings()
    .then((settings) => (state.salePrice = settings.salePrice))
    .catch((error) => console.error(error));
  try {
    state.places = await store.listPlaces();
  } catch (error) {
    console.error(error);
    $('#visit-list-message').textContent = 'Les visites sont indisponibles. Réessaie dans un instant.';
    return;
  }
  renderVisits();
}

if (typeof document !== 'undefined') start();
