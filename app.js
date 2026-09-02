const MONTHLY_LIMIT = 1000;
const MAX_ZONE_REQUESTS = 100;
const MAX_VISIBLE_MARKERS = 250;
const KEYS = { places: 'nfc-prospecting-places-v1', quota: 'nfc-prospecting-quota-v1', apiKey: 'nfc-prospecting-api-key-v1', settings: 'nfc-prospecting-settings-v1' };
let map, infoWindow, markers = [], activeFilter = 'all', selectedId = null, manualCandidate = null, currentView = 'home';
let dashboardSelectedIds = new Set();
let dashboardPage = 1, dashboardPageSize = 100;

const $ = (selector) => document.querySelector(selector);
const escapeHtml = (text = '') => String(text).replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[c]);
const monthKey = () => new Date().toISOString().slice(0, 7);
const dayKey = () => new Date().toISOString().slice(0, 10);

function loadPlaces() { try { return JSON.parse(localStorage.getItem(KEYS.places)) || []; } catch { return []; } }
function savePlaces(places) { localStorage.setItem(KEYS.places, JSON.stringify(places)); persistToDisk(); renderPlaces(); renderMarkers(); renderDashboard(); }
function quota() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEYS.quota));
    if (saved?.version === 'requests-v2') return saved;
    // Relevé Google communiqué le 27 août : Places 115, Maps JavaScript 39.
    // Il sert de point de départ exact au nouveau suivi séparé.
    if (saved?.version === 'requests-v1') return { version:'requests-v2', month:monthKey(), places:115, maps:39 };
  } catch { /* aucune donnée locale */ }
  return { version:'requests-v2', month:monthKey(), places:0, maps:0 };
}
function quotaTotal(q = normalQuota()) { return Number(q.places || 0) + Number(q.maps || 0); }
function normalQuota() { const q = quota(); if (q.month !== monthKey()) { q.places = 0; q.maps = 0; q.month = monthKey(); } localStorage.setItem(KEYS.quota, JSON.stringify(q)); return q; }
function updateQuota() {
  const q = normalQuota(), total = quotaTotal(q);
  $('#quota-summary').textContent = `${total.toLocaleString('fr-FR')} / ${MONTHLY_LIMIT.toLocaleString('fr-FR')} requêtes ce mois`;
  if ($('#quota-total')) { $('#quota-total').textContent = total.toLocaleString('fr-FR'); $('#quota-places').textContent = Number(q.places || 0).toLocaleString('fr-FR'); $('#quota-maps').textContent = Number(q.maps || 0).toLocaleString('fr-FR'); }
}
function remainingQuota() { return Math.max(0, MONTHLY_LIMIT - quotaTotal()); }
function consumeQuota(count = 1, activity = 'Requête Places API') { const q = normalQuota(); q.places = Number(q.places || 0) + count; q.lastEvent = { api:'Places API', activity, count, at:Date.now() }; localStorage.setItem(KEYS.quota, JSON.stringify(q)); persistToDisk(); updateQuota(); }
function consumeMapLoad() { const q = normalQuota(); q.maps = Number(q.maps || 0) + 1; q.lastEvent = { api:'Maps JavaScript API', activity:'Chargement de la carte', count:1, at:Date.now() }; localStorage.setItem(KEYS.quota, JSON.stringify(q)); persistToDisk(); updateQuota(); }
function settings() { try { const saved = JSON.parse(localStorage.getItem(KEYS.settings)); const salePrice = Number(saved?.salePrice); return { salePrice: Number.isFinite(salePrice) && salePrice >= 0 ? salePrice : 50 }; } catch { return { salePrice:50 }; } }
function saveSettings(next) { localStorage.setItem(KEYS.settings, JSON.stringify(next)); persistToDisk(); }
function euros(amount) { return Number(amount || 0).toLocaleString('fr-FR', { style:'currency', currency:'EUR' }); }
function diskState() { return { places: loadPlaces(), quota: normalQuota(), settings: settings() }; }
function persistToDisk() { fetch('/api/state', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(diskState()) }).catch(() => {}); }
async function restoreFromDisk() {
  try {
    const response = await fetch('/api/state');
    if (!response.ok) throw new Error('server');
    const { state } = await response.json();
    if (state?.places && state?.quota) {
      localStorage.setItem(KEYS.places, JSON.stringify(state.places));
      localStorage.setItem(KEYS.quota, JSON.stringify(state.quota));
      if (state.settings) localStorage.setItem(KEYS.settings, JSON.stringify(state.settings));
    } else {
      persistToDisk();
    }
  } catch { /* Le mode navigateur reste utilisable si le serveur local est arrêté. */ }
}
function mapsUrl(place) { return `https://www.google.com/maps/search/?api=1&query_place_id=${encodeURIComponent(place.placeId)}&query=${encodeURIComponent(place.name + ' ' + place.address)}`; }
function statusLabel(status) { return ({to_visit:'À visiter', scheduled:'Programmé pour visite', sold:'Vendu', refused:'Refusé', non_compliant:'Non conforme'})[status] || 'À visiter'; }
function placeCity(place) { const match = (place.address || '').match(/,\s*\d{5}\s+([^,]+?)(?:,\s*France)?$/i); return match ? match[1].trim() : 'Commune non renseignée'; }
function placeType(place) { const ignored = new Set(['point_of_interest','establishment','food','store','premise']); return (place.types || []).find(type => !ignored.has(type)) || 'Autre'; }

function renderPlaces() {
  const all = loadPlaces();
  const bounds = map?.getBounds();
  const visible = bounds ? all.filter(place => place.lat && place.lng && bounds.contains({lat:place.lat, lng:place.lng})) : all;
  const places = activeFilter === 'all' ? visible : visible.filter(p => p.status === activeFilter);
  $('#saved-count').textContent = all.length;
  const list = $('#place-list'); list.innerHTML = '';
  if (!places.length) { list.innerHTML = `<p class="empty-list">${all.length ? 'Aucun établissement enregistré dans la zone visible avec ce statut.' : 'Tes établissements enregistrés apparaîtront ici.'}</p>`; return; }
  const template = $('#place-item-template');
  const statusOrder = { to_visit:0, scheduled:1, sold:2, refused:3, non_compliant:4 };
  places.sort((a,b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9) || a.name.localeCompare(b.name, 'fr')).forEach(place => {
    const item = template.content.firstElementChild.cloneNode(true); item.dataset.id = place.placeId;
    const dot = item.querySelector('.status-dot');
    if (place.status !== 'to_visit') dot.classList.add(place.status);
    item.querySelector('strong').textContent = place.name; item.querySelector('small').textContent = place.address;
    item.querySelector('.place-item-main').addEventListener('click', () => selectPlace(place.placeId, true));
    item.querySelector('.status-menu').addEventListener('click', () => cycleStatus(place.placeId)); list.appendChild(item);
  });
}
function renderMarkers() {
  if (!map || !window.google) return;
  markers.forEach(m => m.setMap(null)); markers = [];
  const bounds = map.getBounds();
  const inFrame = bounds ? loadPlaces().filter(place => place.lat && place.lng && bounds.contains({lat:place.lat, lng:place.lng})) : loadPlaces();
  const places = activeFilter === 'all' ? inFrame : inFrame.filter(place => place.status === activeFilter);
  const displayed = chooseVisibleMarkers(places, bounds);
  $('#map-count').textContent = `${displayed.length} affiché${displayed.length > 1 ? 's' : ''} sur ${places.length} dans la zone`;
  displayed.forEach(place => { const marker = new google.maps.Marker({ position:{lat:place.lat,lng:place.lng}, map, title:place.name, icon: markerIcon(place.status, place.placeId === selectedId) }); marker.addListener('click', () => selectPlace(place.placeId)); markers.push(marker); });
}
function chooseVisibleMarkers(places, bounds) {
  if (places.length <= MAX_VISIBLE_MARKERS || !bounds) return places;
  const order = ['to_visit','scheduled','sold','refused','non_compliant'];
  let remaining = MAX_VISIBLE_MARKERS, result = [];
  for (const status of order) {
    if (!remaining) break;
    const group = places.filter(place => place.status === status);
    const selected = group.find(place => place.placeId === selectedId);
    const sample = spatialSample(group, remaining, bounds);
    if (selected && !sample.some(place => place.placeId === selected.placeId)) sample.pop(), sample.unshift(selected);
    result = result.concat(sample); remaining -= sample.length;
  }
  return result;
}
function spatialSample(places, limit, bounds) {
  if (places.length <= limit) return places;
  const ne = bounds.getNorthEast(), sw = bounds.getSouthWest(), aspect = Math.max(.5, Math.min(2, (ne.lng() - sw.lng()) / Math.max(.0001, ne.lat() - sw.lat())));
  const rows = Math.max(3, Math.round(Math.sqrt(Math.min(limit, places.length) / aspect))), cols = Math.max(3, Math.round(rows * aspect));
  const buckets = Array.from({length: rows * cols}, () => []);
  places.forEach(place => { const row = Math.min(rows - 1, Math.max(0, Math.floor((place.lat - sw.lat()) / (ne.lat() - sw.lat()) * rows))); const col = Math.min(cols - 1, Math.max(0, Math.floor((place.lng - sw.lng()) / (ne.lng() - sw.lng()) * cols))); buckets[row * cols + col].push(place); });
  buckets.forEach(bucket => bucket.sort((a,b) => stableHash(a.placeId) - stableHash(b.placeId)));
  const selected = []; for (let level = 0; selected.length < limit; level++) { let added = false; for (const bucket of buckets) { if (bucket[level]) selected.push(bucket[level]), added = true; if (selected.length === limit) break; } if (!added) break; }
  return selected;
}
function stableHash(value) { let hash = 0; for (let index = 0; index < value.length; index++) hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0; return hash >>> 0; }
function markerIcon(status, selected = false) { const colors = { to_visit:'#55a7e8', scheduled:'#e5b72b', sold:'#22a06b', refused:'#e5484d', non_compliant:'#a1a9b7' }; return { path: google.maps.SymbolPath.CIRCLE, fillColor: colors[status] || colors.to_visit, fillOpacity:1, strokeColor:selected ? '#ff6a3d' : '#fff', strokeWeight:selected ? 4 : 2, scale:selected ? 10 : 8 }; }
function selectPlace(id, pan = false) { const place = loadPlaces().find(p => p.placeId === id); if (!place) return; selectedId = id; renderMarkers(); if (pan && map && place.lat) map.panTo({lat:place.lat,lng:place.lng}), map.setZoom(Math.max(map.getZoom(), 16)); renderDetail(place); }
function renderDetail(place) {
  const card = $('#detail-card'); card.classList.remove('hidden');
  card.innerHTML = `<button class="close-detail" aria-label="Fermer">×</button><h2>${escapeHtml(place.name)}</h2><p>${escapeHtml(place.address)}</p><div class="place-type">${escapeHtml((place.types || []).slice(0,2).join(' · ').replaceAll('_',' '))}</div>${place.status==='sold' ? `<div class="sale-value">Vente : ${euros(place.saleAmount)} <button class="edit-sale" type="button" aria-label="Modifier le montant de la vente" title="Modifier le montant">✎</button></div>` : ''}<div class="status-select">${['to_visit','scheduled','sold','refused','non_compliant'].map(s=>`<button data-status="${s}" class="${place.status===s?'selected-'+s:''}">${statusLabel(s)}</button>`).join('')}</div><div class="link-actions"><button data-action="copy">Copier le lien NFC</button><button data-action="open">Ouvrir la fiche Google</button></div><code class="place-id">Place ID : ${escapeHtml(place.placeId)}</code>`;
  card.querySelector('.close-detail').onclick = () => { selectedId = null; card.classList.add('hidden'); renderMarkers(); };
  card.querySelectorAll('[data-status]').forEach(b => b.onclick = () => setStatus(place.placeId, b.dataset.status));
  card.querySelector('.edit-sale')?.addEventListener('click', () => {
    const entry = window.prompt('Montant de la vente en euros (0 autorisé) :', String(Number(place.saleAmount || 0)).replace('.', ','));
    if (entry === null) return;
    const amount = Number(entry.trim().replace(',', '.'));
    if (!Number.isFinite(amount) || amount < 0) { window.alert('Indique un montant positif ou 0.'); return; }
    const places = loadPlaces(), record = places.find(item => item.placeId === place.placeId);
    record.saleAmount = Math.round(amount * 100) / 100; record.updatedAt = Date.now(); savePlaces(places); renderDetail(record);
  });
  card.querySelector('[data-action="copy"]').onclick = async () => { try { await navigator.clipboard.writeText(mapsUrl(place)); card.querySelector('[data-action="copy"]').textContent = 'Lien copié ✓'; } catch { window.prompt('Copie ce lien :', mapsUrl(place)); } };
  card.querySelector('[data-action="open"]').onclick = () => window.open(mapsUrl(place), '_blank', 'noopener');
}
function setStatus(id, status) { const places = loadPlaces(); const place = places.find(p => p.placeId === id); if (!place) return; const previousStatus = place.status, wasSold = previousStatus === 'sold'; place.status = status; if (status === 'sold' && !wasSold) place.saleAmount = settings().salePrice; if (status !== 'sold') delete place.saleAmount; const now = Date.now(); if (previousStatus !== status) place.statusChangedAt = now; place.updatedAt = now; savePlaces(places); renderDetail(place); }
function setBulkStatus(status) {
  if (!dashboardSelectedIds.size) return;
  const places = loadPlaces();
  places.forEach(place => {
    if (!dashboardSelectedIds.has(place.placeId)) return;
    const previousStatus = place.status, wasSold = previousStatus === 'sold'; place.status = status;
    if (status === 'sold' && !wasSold) place.saleAmount = settings().salePrice;
    if (status !== 'sold') delete place.saleAmount;
    const now = Date.now(); if (previousStatus !== status) place.statusChangedAt = now; place.updatedAt = now;
  });
  dashboardSelectedIds.clear(); savePlaces(places);
}
function cycleStatus(id) {
  const place = loadPlaces().find(p => p.placeId === id); if (!place || place.status === 'to_visit') return;
  if (['sold','non_compliant'].includes(place.status) && !window.confirm(`Remettre « ${place.name} » au statut « À visiter » ?${place.status === 'sold' ? '\n\nSon montant de vente sera supprimé.' : ''}`)) return;
  setStatus(id, 'to_visit');
}

function matchesDashboardFilters(place, { city='', type='', status='' } = {}) {
  return (!city || placeCity(place) === city) && (!type || placeType(place) === type) && (!status || place.status === status);
}
function dashboardValues(places, field, filters) {
  return [...new Set(places.filter(place => matchesDashboardFilters(place, filters)).map(field))].sort((a,b) => a.localeCompare(b, 'fr'));
}
function populateDashboardMenus(places) {
  const citySelect = $('#dashboard-city'), typeSelect = $('#dashboard-type'), statusInput = $('#dashboard-status');
  let city = citySelect.value, type = typeSelect.value, status = statusInput.value;

  // Commune et type se réduisent mutuellement, tout en tenant compte du statut choisi.
  let cities = dashboardValues(places, placeCity, { type, status });
  if (city && !cities.includes(city)) city = '';
  let types = dashboardValues(places, placeType, { city, status });
  if (type && !types.includes(type)) type = '';
  cities = dashboardValues(places, placeCity, { type, status });

  citySelect.innerHTML = '<option value="">Toutes les communes</option>' + cities.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('');
  typeSelect.innerHTML = '<option value="">Tous les types</option>' + types.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value).replaceAll('_',' ')}</option>`).join('');
  citySelect.value = city;
  typeSelect.value = type;

  // Le statut reste toujours disponible (même à 0), mais ses compteurs suivent ville et type.
  const statusLabels = { '':'Tous les statuts', to_visit:'À visiter', scheduled:'Programmé pour visite', sold:'Vendu', refused:'Refusé', non_compliant:'Non conforme' };
  const statusOrder = ['', 'to_visit', 'scheduled', 'sold', 'refused', 'non_compliant'];
  const base = places.filter(place => matchesDashboardFilters(place, { city, type }));
  $('#dashboard-status-menu').innerHTML = statusOrder.map(value => {
    const count = value ? base.filter(place => place.status === value).length : base.length;
    const className = value || 'all';
    return `<button data-dashboard-status="${value}" type="button"><span class="status-dot ${className}"></span><span>${statusLabels[value]}</span><strong>(${count})</strong></button>`;
  }).join('');
  document.querySelectorAll('[data-dashboard-status]').forEach(button => button.onclick = () => setDashboardStatus(button.dataset.dashboardStatus));
}
function dashboardFilteredPlaces(places = loadPlaces()) {
  const city = $('#dashboard-city').value, type = $('#dashboard-type').value, status = $('#dashboard-status').value, sort = $('#dashboard-sort').value;
  const filtered = places.filter(place => matchesDashboardFilters(place, { city, type, status }));
  if (sort === 'created_date_desc') filtered.sort((a,b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  else if (sort === 'created_date_asc') filtered.sort((a,b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
  else if (sort === 'status_date_desc') filtered.sort((a,b) => Number(b.statusChangedAt || 0) - Number(a.statusChangedAt || 0));
  else if (sort === 'status_date_asc') filtered.sort((a,b) => Number(a.statusChangedAt || 0) - Number(b.statusChangedAt || 0));
  else filtered.sort((a,b) => ({name:a.name,city:placeCity(a),type:placeType(a),status:statusLabel(a.status)}[sort]).localeCompare(({name:b.name,city:placeCity(b),type:placeType(b),status:statusLabel(b.status)}[sort]), 'fr'));
  return filtered;
}
function renderDashboard() {
  const places = loadPlaces();
  if (!$('#dashboard-table')) return;
  populateDashboardMenus(places);
  $('#metric-sold').textContent = places.filter(p=>p.status==='sold').length;
  $('#metric-revenue').textContent = euros(places.filter(p=>p.status==='sold').reduce((sum, place) => sum + Number(place.saleAmount || 0), 0));
  $('#metric-refused').textContent = places.filter(p=>p.status==='refused').length;
  const scheduledCount = places.filter(p=>p.status==='scheduled').length, toVisitCount = places.filter(p=>p.status==='to_visit').length, defaultPrice = settings().salePrice;
  $('#metric-scheduled').textContent = scheduledCount;
  $('#metric-to-visit').textContent = toVisitCount;
  $('#metric-scheduled-potential').textContent = `${euros(scheduledCount * defaultPrice)} potentiel`;
  $('#metric-to-visit-potential').textContent = `${euros(toVisitCount * defaultPrice)} potentiel`;
  const filtered = dashboardFilteredPlaces(places);
  $('#dashboard-total').textContent = `${filtered.length} fiche${filtered.length>1?'s':''}`;
  const totalPages = Math.max(1, Math.ceil(filtered.length / dashboardPageSize));
  if (!Number.isFinite(dashboardPage)) dashboardPage = 1;
  dashboardPage = Math.min(Math.max(1, dashboardPage), totalPages);
  const firstIndex = (dashboardPage - 1) * dashboardPageSize;
  const pagePlaces = filtered.slice(firstIndex, firstIndex + dashboardPageSize);
  const visibleIds = new Set(filtered.map(place => place.placeId));
  dashboardSelectedIds = new Set([...dashboardSelectedIds].filter(id => visibleIds.has(id)));
  const selectAll = $('#dashboard-select-all');
  selectAll.checked = filtered.length > 0 && filtered.every(place => dashboardSelectedIds.has(place.placeId));
  selectAll.indeterminate = dashboardSelectedIds.size > 0 && dashboardSelectedIds.size < filtered.length;
  $('#dashboard-table').innerHTML = filtered.length ? pagePlaces.map(p=>`<article class="dashboard-row ${dashboardSelectedIds.has(p.placeId) ? 'is-selected' : ''}"><label class="dashboard-check" title="Sélectionner ${escapeHtml(p.name)}"><input data-dashboard-select="${escapeHtml(p.placeId)}" type="checkbox" ${dashboardSelectedIds.has(p.placeId) ? 'checked' : ''}/><span></span></label><button data-dashboard-id="${escapeHtml(p.placeId)}" type="button"><span><strong>${escapeHtml(p.name)}</strong><small>${escapeHtml(p.address)}</small></span><span>${escapeHtml(placeCity(p))}</span><span>${escapeHtml(placeType(p).replaceAll('_',' '))}</span><span class="status-badge ${escapeHtml(p.status)}">${escapeHtml(statusLabel(p.status))}${p.status === 'sold' ? ` · ${escapeHtml(euros(p.saleAmount))}` : ''}</span></button></article>`).join('') : '<p class="empty-list">Aucun établissement avec ces filtres.</p>';
  document.querySelectorAll('[data-dashboard-id]').forEach(row => row.onclick = () => { switchView('map'); selectPlace(row.dataset.dashboardId, true); });
  document.querySelectorAll('[data-dashboard-select]').forEach(input => input.onchange = () => { input.checked ? dashboardSelectedIds.add(input.dataset.dashboardSelect) : dashboardSelectedIds.delete(input.dataset.dashboardSelect); renderDashboard(); });
  renderPagination(filtered.length, firstIndex, totalPages);
  renderBulkBar();
}
function paginationPages(totalPages) {
  if (totalPages <= 7) return Array.from({length:totalPages}, (_, index) => index + 1);
  const pages = new Set([1, totalPages, dashboardPage - 1, dashboardPage, dashboardPage + 1]);
  return [...pages].filter(page => page >= 1 && page <= totalPages).sort((a,b) => a - b);
}
function renderPagination(total, firstIndex, totalPages) {
  const pagination = $('#dashboard-pagination');
  pagination.classList.toggle('hidden', !total); if (!total) return;
  $('#pagination-summary').textContent = `${firstIndex + 1}-${Math.min(firstIndex + dashboardPageSize, total)} sur ${total}`;
  $('#dashboard-page-size').value = String(dashboardPageSize);
  const pages = paginationPages(totalPages), buttons = [];
  pages.forEach((page, index) => { if (index && page - pages[index - 1] > 1) buttons.push('<span class="pagination-gap">…</span>'); buttons.push(`<button class="${page === dashboardPage ? 'active' : ''}" data-page="${page}" type="button">${page}</button>`); });
  $('#pagination-pages').innerHTML = `<button data-page="${dashboardPage - 1}" type="button" ${dashboardPage === 1 ? 'disabled' : ''}>Précédent</button>${buttons.join('')}<button data-page="${dashboardPage + 1}" type="button" ${dashboardPage === totalPages ? 'disabled' : ''}>Suivant</button>`;
  $('#pagination-pages').querySelectorAll('button[data-page]').forEach(button => button.onclick = () => { const page = Number(button.dataset.page); if (Number.isFinite(page)) { dashboardPage = page; renderDashboard(); } });
}
function renderBulkBar() {
  const bar = $('#bulk-status-bar'), count = dashboardSelectedIds.size;
  bar.classList.toggle('hidden', !count); if (!count) return;
  $('#bulk-selected-count').textContent = `${count} établissement${count > 1 ? 's' : ''} sélectionné${count > 1 ? 's' : ''}`;
  bar.querySelectorAll('[data-bulk-status]').forEach(button => button.onclick = () => setBulkStatus(button.dataset.bulkStatus));
  bar.querySelectorAll('[data-export]').forEach(button => button.onclick = () => exportSelectedPlaces(button.dataset.export));
  $('#bulk-clear').onclick = () => { dashboardSelectedIds.clear(); renderDashboard(); };
}
function selectedExportRows() {
  return dashboardFilteredPlaces().filter(place => dashboardSelectedIds.has(place.placeId)).map(place => ({
    'Nom': place.name,
    'Adresse': place.address,
    'Commune': placeCity(place),
    'Type': placeType(place).replaceAll('_', ' '),
    'Statut': statusLabel(place.status),
    'Vente (€)': place.status === 'sold' ? Number(place.saleAmount || 0) : '',
  }));
}
function exportFileName(extension) { return `nfc-prospection-${new Date().toISOString().slice(0,10)}.${extension}`; }
function loadExportLibrary(source, test) {
  if (test()) return Promise.resolve();
  return new Promise((resolve, reject) => { const script = document.createElement('script'); script.src = source; script.onload = resolve; script.onerror = () => reject(new Error('library')); document.head.appendChild(script); });
}
async function exportSelectedPlaces(format) {
  const rows = selectedExportRows(); if (!rows.length) return;
  const buttons = [...document.querySelectorAll('[data-export]')]; buttons.forEach(button => button.disabled = true);
  try {
    if (format === 'xlsx') {
      await loadExportLibrary('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js', () => Boolean(window.XLSX));
      const sheet = XLSX.utils.json_to_sheet(rows);
      sheet['!cols'] = [{wch:28},{wch:46},{wch:24},{wch:24},{wch:25},{wch:14}];
      const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, sheet, 'Établissements');
      XLSX.writeFile(workbook, exportFileName('xlsx'));
    } else {
      await loadExportLibrary('https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js', () => Boolean(window.jspdf?.jsPDF));
      await loadExportLibrary('https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.2/dist/jspdf.plugin.autotable.min.js', () => Boolean(window.jspdf?.jsPDF?.API?.autoTable));
      const { jsPDF } = window.jspdf, document = new jsPDF({ orientation:'landscape', unit:'mm', format:'a4' });
      document.setFontSize(18); document.text('NFC Prospection - établissements sélectionnés', 14, 16);
      document.setFontSize(9); document.setTextColor(90); document.text(`Export du ${new Date().toLocaleDateString('fr-FR')} - ${rows.length} établissement${rows.length > 1 ? 's' : ''}`, 14, 23);
      document.autoTable({ startY:29, head:[['Nom','Adresse','Commune','Type','Statut','Vente']], body:rows.map(row => [row['Nom'],row['Adresse'],row['Commune'],row['Type'],row['Statut'],row['Vente (€)'] === '' ? '' : euros(row['Vente (€)'])]), styles:{fontSize:7,cellPadding:2}, headStyles:{fillColor:[16,24,40]}, alternateRowStyles:{fillColor:[247,248,250]}, columnStyles:{0:{cellWidth:40},1:{cellWidth:67},2:{cellWidth:32},3:{cellWidth:34},4:{cellWidth:34},5:{cellWidth:20}} });
      document.save(exportFileName('pdf'));
    }
  } catch (error) { console.error(error); window.alert(`Impossible de préparer le fichier ${format === 'xlsx' ? 'Excel' : 'PDF'}. Vérifie ta connexion Internet puis réessaie.`); }
  finally { buttons.forEach(button => button.disabled = false); }
}
function switchView(view) {
  currentView = view; const mapView = view === 'map';
  if (view !== 'dashboard' && dashboardSelectedIds.size) dashboardSelectedIds.clear();
  $('#dashboard-panel').classList.toggle('hidden', view !== 'dashboard');
  $('#manual-panel').classList.toggle('hidden', view !== 'manual');
  $('#home-panel')?.classList.toggle('hidden', view !== 'home');
  $('#visit-panel')?.classList.toggle('hidden', view !== 'visit');
  document.querySelectorAll('.view-tab').forEach(tab=>tab.classList.toggle('active', tab.dataset.view===view));
  if (mapView && !map) { const key = localStorage.getItem(KEYS.apiKey); if (key) loadGoogleMaps(key); }
  else if (mapView && map) google.maps.event.trigger(map, 'resize');
}
function setDashboardStatus(status) {
  const labels = { '':'Tous les statuts', to_visit:'À visiter', scheduled:'Programmé pour visite', sold:'Vendu', refused:'Refusé', non_compliant:'Non conforme' };
  $('#dashboard-status').value = status;
  $('#dashboard-status-label').textContent = labels[status];
  const dot = $('#dashboard-status-toggle .status-dot'); dot.className = `status-dot ${status || 'all'}`;
  $('#dashboard-status-menu').classList.add('hidden'); $('#dashboard-status-toggle').setAttribute('aria-expanded', 'false');
  $('#dashboard-status').dispatchEvent(new Event('change'));
}
function queryFromGoogleUrl(rawUrl) {
  const url = new URL(rawUrl), pathMatch = url.pathname.match(/\/place\/([^/]+)/i);
  const fromPath = pathMatch ? decodeURIComponent(pathMatch[1]).replaceAll('+', ' ') : '';
  return url.searchParams.get('query') || url.searchParams.get('q') || fromPath;
}
async function resolveManualLink(url) {
  const response = await fetch('/api/resolve-link', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({url}) });
  if (!response.ok) throw new Error('resolve');
  return (await response.json()).url;
}
async function lookupManualPlace(event) {
  event.preventDefault(); const message = $('#manual-message'); message.className = 'form-message'; manualCandidate = null; $('#manual-preview').classList.add('hidden');
  if (!window.google?.maps?.places?.Place) { message.classList.add('error'); message.textContent = 'Ajoute d’abord ta clé Google Maps dans les réglages.'; return; }
  if (!remainingQuota()) { message.classList.add('error'); message.textContent = 'Limite mensuelle de requêtes atteinte.'; return; }
  const button = $('#manual-lookup'); button.disabled = true; button.textContent = 'Vérification…'; message.textContent = 'Résolution du lien et vérification de la fiche…';
  try {
    const resolvedUrl = await resolveManualLink($('#manual-link').value.trim());
    const query = queryFromGoogleUrl(resolvedUrl);
    if (!query) throw new Error('query');
    consumeQuota(1, 'Vérification d’un lien Google');
    const { places=[] } = await google.maps.places.Place.searchByText({ textQuery:query, fields:['id','displayName','formattedAddress','location','types'], maxResultCount:1 });
    const place = places[0]; if (!place?.id) throw new Error('notfound'); manualCandidate = place;
    const existing = loadPlaces().some(record => record.placeId === place.id);
    const preview = $('#manual-preview');
    preview.innerHTML = `<h3>${escapeHtml(place.displayName || 'Établissement Google')}</h3><p>${escapeHtml(place.formattedAddress || '')}</p><p class="preview-type">${escapeHtml((place.types || []).slice(0,3).join(' · ').replaceAll('_',' '))}</p>${existing ? '<p>Cette fiche est déjà enregistrée.</p>' : '<p>Cette fiche sera ajoutée avec le statut « À visiter ».</p>'}<div class="manual-preview-actions"><button class="primary" id="manual-confirm" type="button" ${existing ? 'disabled' : ''}>Ajouter cette fiche</button><button id="manual-cancel" type="button">Annuler</button></div>`;
    preview.classList.remove('hidden'); message.textContent = 'Fiche vérifiée. Confirme l’ajout si elle correspond bien.';
    $('#manual-confirm')?.addEventListener('click', confirmManualPlace); $('#manual-cancel').onclick = () => { manualCandidate = null; preview.classList.add('hidden'); message.textContent = 'Ajout annulé.'; };
  } catch (error) { console.error(error); message.classList.add('error'); message.textContent = 'Lien non reconnu ou fiche introuvable. Essaie le lien Google Maps complet de l’établissement.'; }
  finally { button.disabled = false; button.textContent = 'Vérifier la fiche'; }
}
function confirmManualPlace() {
  if (!manualCandidate?.id) return;
  const added = addPlaces([manualCandidate]);
  const message = $('#manual-message'); message.textContent = added ? 'Fiche ajoutée à la carte.' : 'Cette fiche est déjà enregistrée.';
  $('#manual-preview').classList.add('hidden'); $('#manual-link').value = '';
  if (added) { switchView('map'); selectPlace(manualCandidate.id, true); }
}

async function doSearch(event) {
  event.preventDefault(); const message = $('#search-message'); message.className = 'form-message';
  if (!window.google?.maps?.places?.Place) { message.classList.add('error'); message.textContent = 'Ajoute ta clé Google Maps dans les réglages avant de rechercher.'; return; }
  const left = remainingQuota(); if (!left) { message.classList.add('error'); message.textContent = 'Limite mensuelle de requêtes atteinte. La recherche sera disponible le mois prochain.'; return; }
  if (!map?.getBounds()) { message.classList.add('error'); message.textContent = 'La carte est en cours de chargement.'; return; }
  const activity = $('#query').value.trim(); const button = $('#search-button'); button.disabled = true; button.textContent = 'Balayage…'; message.textContent = 'Préparation du balayage de la zone…';
  try {
    let places = [];
    if (activity) {
      const center = map.getCenter();
      consumeQuota(1, 'Recherche par activité');
      ({ places = [] } = await google.maps.places.Place.searchByText({ textQuery: `${activity} près de ${center.lat()}, ${center.lng()}`, fields:['id','displayName','formattedAddress','location','types'], maxResultCount: Math.min(20, left) }));
      const added = addPlaces(places);
      message.textContent = added ? `${added} nouvelle${added>1?'s':''} fiche${added>1?'s':''} ajoutée${added>1?'s':''}.` : 'Aucune nouvelle fiche à ajouter : elles sont peut-être déjà enregistrées.';
    } else {
      const cells = zoneCells(map.getBounds()); let added = 0;
      for (let index = 0; index < cells.length && remainingQuota() > 0; index++) {
        const cell = cells[index];
        message.textContent = `Balayage de la zone… ${index + 1} / ${cells.length} · ${added} nouvelle${added>1?'s':''} fiche${added>1?'s':''}.`;
        consumeQuota(1, 'Balayage de zone');
        ({ places = [] } = await google.maps.places.Place.searchNearby({ fields:['id','displayName','formattedAddress','location','types'], locationRestriction:{ center:cell.center, radius:cell.radius }, maxResultCount: 20 }));
        added += addPlaces(places);
      }
      message.textContent = added ? `Balayage terminé : ${added} nouvelle${added>1?'s':''} fiche${added>1?'s':''} ajoutée${added>1?'s':''}.` : 'Balayage terminé : aucune nouvelle fiche dans cette zone.';
    }
  } catch (error) { console.error(error); message.classList.add('error'); message.textContent = 'Google a refusé la recherche. Vérifie que les deux APIs sont activées et que la clé autorise localhost.'; }
  finally { button.disabled = false; button.textContent = 'Balayer la zone affichée'; }
}

function addPlaces(places) {
  const existing = loadPlaces(), known = new Set(existing.map(p => p.placeId));
  const fresh = places.filter(p => p.id && !known.has(p.id));
  const now = Date.now();
  const records = fresh.map(p => ({ placeId:p.id, name:p.displayName || 'Établissement Google', address:p.formattedAddress || '', lat:p.location?.lat?.(), lng:p.location?.lng?.(), types:p.types || [], status:'to_visit', createdAt:now, statusChangedAt:now, updatedAt:now }));
  if (records.length) savePlaces([...existing, ...records]);
  return records.length;
}

function zoneCells(bounds) {
  const ne = bounds.getNorthEast(), sw = bounds.getSouthWest(), centerLat = (ne.lat() + sw.lat()) / 2;
  const latSpan = ne.lat() - sw.lat(), lngSpan = ne.lng() - sw.lng();
  const latMeters = latSpan * 111320, lngMeters = lngSpan * 111320 * Math.cos(centerLat * Math.PI / 180);
  // Même une petite zone est découpée en 3 × 3 : Google plafonne les résultats
  // d'un cercle dense, donc un unique appel pourrait masquer des commerces voisins.
  const cellSide = 1200, rows = Math.max(3, Math.min(10, Math.ceil(latMeters / cellSide))), cols = Math.max(3, Math.min(10, Math.ceil(lngMeters / cellSide)));
  const total = Math.min(MAX_ZONE_REQUESTS, rows * cols), cells = [];
  for (let row = 0; row < rows && cells.length < total; row++) for (let col = 0; col < cols && cells.length < total; col++) {
    const lat = sw.lat() + latSpan * ((row + .5) / rows), lng = sw.lng() + lngSpan * ((col + .5) / cols);
    const halfLat = latMeters / rows / 2, halfLng = lngMeters / cols / 2;
    cells.push({ center:{lat,lng}, radius:Math.max(50, Math.sqrt(halfLat**2 + halfLng**2) * 1.12) });
  }
  return cells;
}

function haversine(lat1, lon1, lat2, lon2) { const r = 6371000, dLat = (lat2-lat1)*Math.PI/180, dLon = (lon2-lon1)*Math.PI/180; const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2; return 2*r*Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); }
async function centerOnLocation() {
  const input = $('#location'), message = $('#search-message'), textQuery = input.value.trim(); message.className = 'form-message';
  if (!textQuery) { message.classList.add('error'); message.textContent = 'Indique une ville avant de centrer la carte.'; return; }
  if (!window.google?.maps?.places?.Place) { message.classList.add('error'); message.textContent = 'Ajoute ta clé Google Maps dans les réglages avant de rechercher.'; return; }
  const button = $('#center-button'); button.disabled = true; button.textContent = 'Centrage…';
  try { if (!remainingQuota()) throw new Error('quota'); consumeQuota(1, 'Centrage sur une ville'); const { places=[] } = await google.maps.places.Place.searchByText({ textQuery, fields:['displayName','location','viewport'], maxResultCount:1 }); const place=places[0]; if (!place?.location) throw new Error('not found'); if (place.viewport) map.fitBounds(place.viewport); else { map.setCenter(place.location); map.setZoom(13); } message.textContent = `Carte centrée sur ${place.displayName || textQuery}. Ajuste le zoom, puis lance la recherche de zone.`; }
  catch { message.classList.add('error'); message.textContent = 'Ville introuvable. Essaie avec la commune et le pays.'; }
  finally { button.disabled = false; button.textContent = 'Centrer la carte sur cette ville'; }
}

function loadGoogleMaps(apiKey) {
  if (window.google?.maps) return initMap(); const script = document.createElement('script'); script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&libraries=places&v=weekly&language=fr&region=FR`; script.async = true; consumeMapLoad(); script.onload = initMap; script.onerror = () => { $('#map-placeholder').classList.remove('hidden'); $('#map-placeholder p').textContent = 'La carte ne se charge pas. Vérifie la clé et ses restrictions.'; }; document.head.appendChild(script);
}
function initMap() { $('#map-placeholder').classList.add('hidden'); map = new google.maps.Map($('#map'), { center:{lat:43.1808,lng:5.7115}, zoom:12, mapId:'bde09a7761141982702e4cba', streetViewControl:false, mapTypeControl:false, fullscreenControl:false }); infoWindow = new google.maps.InfoWindow(); map.addListener('idle', () => { renderPlaces(); renderMarkers(); }); renderMarkers(); renderPlaces(); }
function openSettings() { $('#api-key').value = localStorage.getItem(KEYS.apiKey) || ''; $('#sale-price').value = settings().salePrice; updateQuota(); $('#settings-dialog').showModal(); }

$('#settings-button').onclick = openSettings; $('#placeholder-settings').onclick = openSettings; $('#cancel-settings').onclick = () => $('#settings-dialog').close(); $('#show-key').onchange = e => $('#api-key').type = e.target.checked ? 'text' : 'password';
$('#settings-form').addEventListener('submit', e => { e.preventDefault(); const key = $('#api-key').value.trim(), salePrice = Number($('#sale-price').value); if (!Number.isFinite(salePrice) || salePrice < 0) return; saveSettings({ salePrice }); if (key) { localStorage.setItem(KEYS.apiKey, key); if (currentView === 'map' && !window.google?.maps) loadGoogleMaps(key); } $('#settings-dialog').close(); renderDashboard(); });
$('#search-form').addEventListener('submit', doSearch);
$('#center-button').addEventListener('click', centerOnLocation);
$('#manual-form').addEventListener('submit', lookupManualPlace);
document.querySelectorAll('.filter').forEach(button => button.onclick = () => { document.querySelector('.filter.active').classList.remove('active'); button.classList.add('active'); activeFilter = button.dataset.filter; renderPlaces(); renderMarkers(); });
document.querySelectorAll('[data-view]').forEach(tab => tab.onclick = () => switchView(tab.dataset.view));
['dashboard-city','dashboard-type','dashboard-status','dashboard-sort'].forEach(id => $("#" + id).addEventListener('change', () => { dashboardPage = 1; renderDashboard(); }));
$('#dashboard-page-size').onchange = event => { dashboardPageSize = Number(event.target.value) || 100; dashboardPage = 1; renderDashboard(); };
$('#dashboard-select-all').onchange = event => {
  const places = loadPlaces(), city = $('#dashboard-city').value, type = $('#dashboard-type').value, status = $('#dashboard-status').value;
  const visible = places.filter(place => matchesDashboardFilters(place, { city, type, status }));
  visible.forEach(place => event.target.checked ? dashboardSelectedIds.add(place.placeId) : dashboardSelectedIds.delete(place.placeId));
  renderDashboard();
};
$('#dashboard-status-toggle').onclick = () => { const menu = $('#dashboard-status-menu'); const open = menu.classList.toggle('hidden'); $('#dashboard-status-toggle').setAttribute('aria-expanded', String(!open)); };
document.addEventListener('click', event => { if (!event.target.closest('.status-filter')) { $('#dashboard-status-menu').classList.add('hidden'); $('#dashboard-status-toggle').setAttribute('aria-expanded', 'false'); } });
async function boot() {
  await restoreFromDisk();
  const places = loadPlaces(); let migrated = false;
  const migrationStart = Date.now() - Math.max(0, places.length - 1) * 2000;
  places.forEach((place, index) => { const fallbackTime = migrationStart + index * 2000; if (!Number.isFinite(Number(place.createdAt))) { place.createdAt = fallbackTime; migrated = true; } if (!Number.isFinite(Number(place.statusChangedAt))) { place.statusChangedAt = fallbackTime; migrated = true; } if (place.status === 'sold' && !Number.isFinite(Number(place.saleAmount))) { place.saleAmount = settings().salePrice; migrated = true; } });
  if (migrated) savePlaces(places); else persistToDisk();
  updateQuota(); renderPlaces(); renderDashboard();
  // La carte est chargée uniquement lorsque l'espace Prospection est ouvert.
  if (document.body.dataset.page === 'prospection') switchView('map');
}
boot();
