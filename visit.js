const VISIT_KEYS = { places:'nfc-prospecting-places-v1', quota:'nfc-prospecting-quota-v1', settings:'nfc-prospecting-settings-v1' };
let activeVisitId = null, pendingStatus = null;
const $ = selector => document.querySelector(selector);
const escapeHtml = (text = '') => String(text).replace(/[&<>'"]/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[character]);
const statusMeta = {
  sold:{ label:'Vendu', className:'sold' },
  refused:{ label:'Refusé', className:'refused' },
  non_compliant:{ label:'Non conforme', className:'non_compliant' },
  to_visit:{ label:'À visiter', className:'to_visit' },
};
function loadPlaces() { try { return JSON.parse(localStorage.getItem(VISIT_KEYS.places)) || []; } catch { return []; } }
function savePlaces(places) { localStorage.setItem(VISIT_KEYS.places, JSON.stringify(places)); persistToDisk(); }
function settings() { try { const saved = JSON.parse(localStorage.getItem(VISIT_KEYS.settings)); const salePrice = Number(saved?.salePrice); return { salePrice:Number.isFinite(salePrice) && salePrice >= 0 ? salePrice : 50 }; } catch { return { salePrice:50 }; } }
function quota() { try { return JSON.parse(localStorage.getItem(VISIT_KEYS.quota)) || {}; } catch { return {}; } }
function persistToDisk() { fetch('/api/state', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ places:loadPlaces(), quota:quota(), settings:settings() }) }).catch(() => {}); }
async function restoreFromDisk() {
  try {
    const response = await fetch('/api/state'); if (!response.ok) throw new Error('server');
    const { state } = await response.json(); if (!state?.places) return;
    localStorage.setItem(VISIT_KEYS.places, JSON.stringify(state.places));
    if (state.quota) localStorage.setItem(VISIT_KEYS.quota, JSON.stringify(state.quota));
    if (state.settings) localStorage.setItem(VISIT_KEYS.settings, JSON.stringify(state.settings));
  } catch { /* Les données locales restent disponibles si le serveur est arrêté. */ }
}
function city(place) { const match = (place.address || '').match(/,\s*\d{5}\s+([^,]+?)(?:,\s*France)?$/i); return match ? match[1].trim() : ''; }
function euros(amount) { return Number(amount || 0).toLocaleString('fr-FR', { style:'currency', currency:'EUR' }); }
function scheduledVisits() {
  const needle = $('#visit-search').value.trim().toLocaleLowerCase('fr-FR');
  return loadPlaces().filter(place => place.status === 'scheduled').filter(place => !needle || `${place.name} ${place.address} ${city(place)}`.toLocaleLowerCase('fr-FR').includes(needle)).sort((a,b) => Number(a.statusChangedAt || 0) - Number(b.statusChangedAt || 0));
}
function renderVisits() {
  const visits = scheduledVisits(); $('#visit-count').textContent = visits.length; $('#visit-list-message').textContent = visits.length ? `${visits.length} visite${visits.length > 1 ? 's' : ''} programmée${visits.length > 1 ? 's' : ''}` : 'Aucune visite programmée.';
  $('#visit-list').innerHTML = visits.length ? visits.map(place => `<button class="visit-card ${place.placeId === activeVisitId ? 'active' : ''}" data-visit-id="${escapeHtml(place.placeId)}" type="button"><span class="visit-card-dot"></span><span><strong>${escapeHtml(place.name)}</strong><small>${escapeHtml(place.address)}</small></span><b>›</b></button>`).join('') : '<div class="visit-empty-state"><span>✓</span><strong>Ta liste est terminée.</strong><p>Les établissements programmés pour visite apparaîtront ici.</p></div>';
  document.querySelectorAll('[data-visit-id]').forEach(button => button.onclick = () => { activeVisitId = button.dataset.visitId; pendingStatus = null; renderVisits(); renderEditor(); });
  if (activeVisitId && !visits.some(place => place.placeId === activeVisitId)) { activeVisitId = null; $('#visit-editor').classList.add('hidden'); }
}
function renderEditor() {
  const place = loadPlaces().find(item => item.placeId === activeVisitId), editor = $('#visit-editor');
  if (!place) { editor.classList.add('hidden'); return; }
  const selected = pendingStatus ? statusMeta[pendingStatus] : null;
  let fields = '<p class="visit-field-help">Choisis le résultat de ta visite pour afficher les informations à renseigner.</p>';
  if (pendingStatus === 'sold') fields = `<label>Prix de vente (€)<input id="visit-sale-amount" type="number" min="0" step="0.01" value="${escapeHtml(settings().salePrice)}" /></label><label>Commentaire <span>facultatif</span><textarea id="visit-comment" placeholder="Ex. carte remise, coordonnées du contact…"></textarea></label>`;
  if (pendingStatus === 'refused') fields = '<label>Motif du refus<textarea id="visit-comment" placeholder="Ex. déjà équipé, pas intéressé, budget…"></textarea></label>';
  if (pendingStatus === 'non_compliant') fields = '<label>Commentaire <span>facultatif</span><textarea id="visit-comment" placeholder="Explique pourquoi cet établissement ne correspond pas à ta prospection."></textarea></label>';
  if (pendingStatus === 'to_visit') fields = '<label>Pourquoi reprogrammer cette visite ?<textarea id="visit-comment" placeholder="Ex. fermé, absent, repasser à une autre heure…"></textarea></label>';
  editor.innerHTML = `<button id="visit-close" class="visit-close" type="button" aria-label="Fermer">×</button><p class="eyebrow">VISITE PROGRAMMÉE</p><h2>${escapeHtml(place.name)}</h2><p class="visit-address">${escapeHtml(place.address)}</p><div class="visit-status-options">${Object.entries(statusMeta).map(([key, meta]) => `<button class="${meta.className} ${pendingStatus === key ? 'active' : ''}" data-visit-status="${key}" type="button">${meta.label}</button>`).join('')}</div><div class="visit-fields ${selected ? selected.className : ''}">${fields}</div><button id="visit-save" class="primary visit-save" type="button" ${pendingStatus ? '' : 'disabled'}>Enregistrer la visite</button>`;
  editor.classList.remove('hidden');
  $('#visit-close').onclick = () => { activeVisitId = null; pendingStatus = null; editor.classList.add('hidden'); renderVisits(); };
  document.querySelectorAll('[data-visit-status]').forEach(button => button.onclick = () => { pendingStatus = button.dataset.visitStatus; renderEditor(); });
  $('#visit-save').onclick = requestVisitSave;
}
function requestVisitSave() {
  if (!activeVisitId || !pendingStatus) return;
  const comment = $('#visit-comment')?.value.trim() || '';
  const saleAmount = pendingStatus === 'sold' ? Number($('#visit-sale-amount').value.replace(',', '.')) : null;
  if (pendingStatus === 'sold' && (!Number.isFinite(saleAmount) || saleAmount < 0)) { window.alert('Indique un prix de vente positif ou 0.'); return; }
  const meta = statusMeta[pendingStatus];
  $('#visit-confirm-text').textContent = `Tu vas passer « ${loadPlaces().find(place => place.placeId === activeVisitId)?.name || 'cet établissement'} » au statut « ${meta.label} »${pendingStatus === 'sold' ? ` pour ${euros(saleAmount)}.` : '.'}`;
  $('#visit-confirm').classList.remove('hidden');
  $('#visit-confirm-save').onclick = () => saveVisit(pendingStatus, comment, saleAmount);
}
function saveVisit(status, comment, saleAmount) {
  const places = loadPlaces(), place = places.find(item => item.placeId === activeVisitId); if (!place) return;
  const now = Date.now();
  place.status = status; place.statusChangedAt = now; place.updatedAt = now;
  if (status === 'sold') place.saleAmount = Math.round(saleAmount * 100) / 100;
  else delete place.saleAmount;
  place.visitHistory = Array.isArray(place.visitHistory) ? place.visitHistory : [];
  place.visitHistory.push({ status, changedAt:now, comment, saleAmount:status === 'sold' ? place.saleAmount : null });
  savePlaces(places); $('#visit-confirm').classList.add('hidden'); activeVisitId = null; pendingStatus = null; $('#visit-editor').classList.add('hidden'); renderVisits(); showToast(`Visite enregistrée : ${statusMeta[status].label}.`);
}
function showToast(message) { const toast = $('#visit-toast'); toast.textContent = message; toast.classList.remove('hidden'); window.setTimeout(() => toast.classList.add('hidden'), 3200); }
$('#visit-search').oninput = renderVisits;
$('#visit-confirm-cancel').onclick = () => $('#visit-confirm').classList.add('hidden');
async function boot() { await restoreFromDisk(); renderVisits(); }
boot();
