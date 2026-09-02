let backlogPage = 1, backlogPageSize = 50;
const $ = selector => document.querySelector(selector);
const escapeHtml = (text = '') => String(text).replace(/[&<>'"]/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[character]);
function formatDate(value) { try { return new Date(value).toLocaleString('fr-FR', { dateStyle:'medium', timeStyle:'short' }); } catch { return value || ''; } }
async function loadBacklog() {
  const list = $('#backlog-list'); list.innerHTML = '<p class="backlog-empty">Chargement…</p>';
  try {
    const response = await fetch(`/api/logs?page=${backlogPage}&pageSize=${backlogPageSize}`); if (!response.ok) throw new Error('server');
    const data = await response.json(); renderBacklog(data);
  } catch { $('#backlog-summary').textContent = 'Le journal est indisponible : vérifie que le serveur local est lancé.'; list.innerHTML = '<p class="backlog-empty">Impossible de charger le journal.</p>'; }
}
function renderBacklog({ logs = [], total = 0, page = 1, pageSize = 50 }) {
  const first = total ? (page - 1) * pageSize + 1 : 0, last = Math.min(page * pageSize, total);
  $('#backlog-summary').textContent = total ? `${first}-${last} sur ${total} événement${total > 1 ? 's' : ''} · plus récent en premier` : 'Aucun événement enregistré pour le moment.';
  $('#backlog-list').innerHTML = logs.length ? logs.map(log => `<article class="backlog-item"><div class="backlog-time">${escapeHtml(formatDate(log.at))}</div><div><strong>${escapeHtml(log.action)}</strong><h2>${escapeHtml(log.placeName)}</h2><p>${escapeHtml(log.address)}</p>${log.details ? `<blockquote>${escapeHtml(log.details)}</blockquote>` : ''}</div></article>`).join('') : '<p class="backlog-empty">Aucun événement enregistré pour le moment.</p>';
  const totalPages = Math.max(1, Math.ceil(total / pageSize)), pagination = $('#backlog-pagination'); pagination.classList.toggle('hidden', totalPages <= 1); if (totalPages <= 1) return;
  const pages = new Set([1, totalPages, page - 1, page, page + 1]); const buttons = [];
  [...pages].filter(value => value >= 1 && value <= totalPages).sort((a,b) => a-b).forEach((value, index, array) => { if (index && value - array[index - 1] > 1) buttons.push('<span>…</span>'); buttons.push(`<button data-backlog-page="${value}" class="${value === page ? 'active' : ''}" type="button">${value}</button>`); });
  pagination.innerHTML = `<button data-backlog-page="${page - 1}" type="button" ${page === 1 ? 'disabled' : ''}>Précédent</button>${buttons.join('')}<button data-backlog-page="${page + 1}" type="button" ${page === totalPages ? 'disabled' : ''}>Suivant</button>`;
  pagination.querySelectorAll('[data-backlog-page]').forEach(button => button.onclick = () => { backlogPage = Number(button.dataset.backlogPage); loadBacklog(); });
}
$('#backlog-size').onchange = event => { backlogPageSize = Number(event.target.value); backlogPage = 1; loadBacklog(); };
loadBacklog();
