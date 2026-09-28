/**
 * The Historique d'un établissement overlay, shared by the Prospection and Visite pages:
 * a panel over the page listing everything that happened to one établissement, read
 * through `store.listPlaceHistory()`. Closed by its × button, the Escape key, or a click
 * on the backdrop around the panel.
 */

const escapeHtml = (text = '') =>
  String(text).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);

function formatDate(value) {
  try {
    return new Date(value).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return value || '';
  }
}

const KINDS = {
  place_added: { label: 'Établissement ajouté', icon: '➕' },
  status_changed: { label: 'Statut modifié', icon: '🔄' },
  sale_amount_changed: { label: 'Montant de vente modifié', icon: '💶' },
  visit_recorded: { label: 'Visite enregistrée', icon: '📍' },
};

// The French labels the local desktop app wrote as `action`, migrated as-is (#11). A
// `Commentaire ajouté` was a comment left on a visit, so it counts as one.
const LEGACY_ACTIONS = {
  'Fiche ajoutée': 'place_added',
  'Statut modifié': 'status_changed',
  'Montant de vente modifié': 'sale_amount_changed',
  'Commentaire ajouté': 'visit_recorded',
};

/**
 * The label and emoji icon a history entry is shown with, from its activity_log `action` —
 * a current code or its migrated French equivalent. An unknown action shows as itself.
 *
 * @param {string} action
 * @returns {{ label: string, icon: string }}
 */
export function historyEntryKind(action) {
  return KINDS[LEGACY_ACTIONS[action] ?? action] ?? { label: action, icon: '•' };
}

function renderEntry(entry) {
  const { label, icon } = historyEntryKind(entry.action);
  return `<li class="history-entry"><span class="history-icon" aria-hidden="true">${icon}</span><div><strong>${escapeHtml(label)}</strong><time>${escapeHtml(formatDate(entry.at))}</time>${entry.details ? `<p>${escapeHtml(entry.details)}</p>` : ''}</div></li>`;
}

let overlay = null;
/** Bumped on every open and close, so a slow read never fills a panel it no longer belongs to. */
let generation = 0;

function onKeydown(event) {
  if (event.key === 'Escape') closePlaceHistory();
}

function closePlaceHistory() {
  generation += 1;
  overlay?.classList.add('hidden');
  document.removeEventListener('keydown', onKeydown);
}

function ensureOverlay() {
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.className = 'history-overlay hidden';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'history-title');
  overlay.innerHTML = `<div class="history-panel"><button class="history-close" type="button" aria-label="Fermer">×</button><p class="eyebrow">HISTORIQUE</p><h2 id="history-title"></h2><p class="history-address"></p><div class="history-body"></div></div>`;
  overlay.querySelector('.history-close').addEventListener('click', closePlaceHistory);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) closePlaceHistory();
  });
  document.body.appendChild(overlay);
  return overlay;
}

/**
 * Opens the history overlay for `place` (an établissement as the store returns it) and
 * fills it from the store.
 *
 * @param {{ listPlaceHistory: (id: string) => Promise<object[]> }} store
 * @param {{ id: string, name?: string, address?: string }} place
 */
export async function openPlaceHistory(store, place) {
  ensureOverlay();
  const current = ++generation;
  overlay.querySelector('#history-title').textContent = place.name || 'Établissement';
  overlay.querySelector('.history-address').textContent = place.address || '';
  const body = overlay.querySelector('.history-body');
  body.innerHTML = '<p class="history-empty">Chargement…</p>';
  overlay.classList.remove('hidden');
  document.addEventListener('keydown', onKeydown);
  overlay.querySelector('.history-close').focus();

  let entries;
  try {
    entries = await store.listPlaceHistory(place.id);
  } catch (error) {
    console.error(error);
    if (current === generation) body.innerHTML = "<p class=\"history-empty\">L'historique est indisponible. Réessaie dans un instant.</p>";
    return;
  }
  if (current !== generation) return;
  body.innerHTML = entries.length
    ? `<ol class="history-list">${entries.map(renderEntry).join('')}</ol>`
    : '<p class="history-empty">Aucun événement enregistré pour cet établissement.</p>';
}
