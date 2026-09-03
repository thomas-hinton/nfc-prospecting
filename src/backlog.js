import { bootstrapStore } from './bootstrap.js';

/**
 * The Backlog page: a paginated, most-recent-first view of the account's activity_log,
 * plus the current month's Google API quota usage — everything the store's read paths
 * expose for auditing activity or investigating unexpected quota usage.
 */

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (text = '') =>
  String(text).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);

function formatDate(value) {
  try {
    return new Date(value).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return value || '';
  }
}

// French labels for known activity_log actions (src/store.js writes 'place_added' on add;
// later tickets add more). An action without a label here still displays as its raw code.
const ACTION_LABELS = { place_added: 'Établissement ajouté' };
const actionLabel = (action) => ACTION_LABELS[action] || action;

let store = null;
const state = { page: 1, pageSize: 50, total: 0, entries: [] };

async function loadQuota() {
  try {
    const quota = await store.getQuotaUsage();
    $('#quota-total').textContent = quota.total.toLocaleString('fr-FR');
    $('#quota-limit').textContent = quota.monthlyLimit.toLocaleString('fr-FR');
    $('#quota-places').textContent = quota.places.toLocaleString('fr-FR');
    $('#quota-maps').textContent = quota.maps.toLocaleString('fr-FR');
  } catch (error) {
    console.error(error);
    $('#quota-total').textContent = '—';
  }
}

function renderPagination() {
  const { total, page, pageSize } = state;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const pagination = $('#backlog-pagination');
  pagination.classList.toggle('hidden', totalPages <= 1);
  if (totalPages <= 1) return;

  const pages = new Set([1, totalPages, page - 1, page, page + 1]);
  const buttons = [];
  [...pages]
    .filter((value) => value >= 1 && value <= totalPages)
    .sort((a, b) => a - b)
    .forEach((value, index, array) => {
      if (index && value - array[index - 1] > 1) buttons.push('<span>…</span>');
      buttons.push(`<button data-backlog-page="${value}" class="${value === page ? 'active' : ''}" type="button">${value}</button>`);
    });

  pagination.innerHTML =
    `<button data-backlog-page="${page - 1}" type="button" ${page === 1 ? 'disabled' : ''}>Précédent</button>` +
    buttons.join('') +
    `<button data-backlog-page="${page + 1}" type="button" ${page === totalPages ? 'disabled' : ''}>Suivant</button>`;

  pagination.querySelectorAll('[data-backlog-page]').forEach((button) => {
    button.onclick = () => {
      state.page = Number(button.dataset.backlogPage);
      loadBacklog();
    };
  });
}

function renderBacklog() {
  const { entries, total, page, pageSize } = state;
  const first = total ? (page - 1) * pageSize + 1 : 0;
  const last = Math.min(page * pageSize, total);
  $('#backlog-summary').textContent = total
    ? `${first}-${last} sur ${total} événement${total > 1 ? 's' : ''} · plus récent en premier`
    : 'Aucun événement enregistré pour le moment.';

  $('#backlog-list').innerHTML = entries.length
    ? entries
        .map(
          (entry) =>
            `<article class="backlog-item"><div class="backlog-time">${escapeHtml(formatDate(entry.at))}</div><div><strong>${escapeHtml(actionLabel(entry.action))}</strong><h2>${escapeHtml(entry.placeName)}</h2><p>${escapeHtml(entry.address)}</p>${entry.details ? `<blockquote>${escapeHtml(entry.details)}</blockquote>` : ''}</div></article>`
        )
        .join('')
    : '<p class="backlog-empty">Aucun événement enregistré pour le moment.</p>';

  renderPagination();
}

async function loadBacklog() {
  const list = $('#backlog-list');
  list.innerHTML = '<p class="backlog-empty">Chargement…</p>';
  try {
    const { entries, total, page, pageSize } = await store.listActivityLog({ page: state.page, pageSize: state.pageSize });
    state.entries = entries;
    state.total = total;
    state.page = page;
    state.pageSize = pageSize;
    renderBacklog();
  } catch (error) {
    console.error(error);
    $('#backlog-summary').textContent = 'Le journal est indisponible. Réessaie dans un instant.';
    list.innerHTML = '<p class="backlog-empty">Impossible de charger le journal.</p>';
  }
}

async function start() {
  store = bootstrapStore(window);
  if (!store) return;

  $('#backlog-size').addEventListener('change', (event) => {
    state.pageSize = Number(event.target.value);
    state.page = 1;
    loadBacklog();
  });

  await Promise.all([loadQuota(), loadBacklog()]);
}

if (typeof document !== 'undefined') start();
