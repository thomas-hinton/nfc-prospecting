/**
 * Which entries a page-number strip shows — shared by the Backlog and the Tableau de bord.
 * `pageStrip` decides the entries; `renderPageStrip` draws them into a container.
 */

/**
 * The entries of a Précédent / page numbers / Suivant strip for `page` of `totalPages`: the
 * first and last pages and the current page with its two neighbours, with a gap wherever
 * numbers are skipped. That caps the strip at seven numbers, however many pages there are.
 * A single page (or none) yields no strip at all.
 *
 * @param {{ page: number, totalPages: number }} position
 * @returns {Array<{ kind: 'previous'|'next', page: number, disabled: boolean }
 *   | { kind: 'page', page: number, current: boolean } | { kind: 'gap' }>}
 */
export function pageStrip({ page, totalPages }) {
  if (totalPages <= 1) return [];
  const numbers = [...new Set([1, page - 1, page, page + 1, totalPages])]
    .filter((value) => value >= 1 && value <= totalPages)
    .sort((a, b) => a - b);

  const entries = [{ kind: 'previous', page: page - 1, disabled: page <= 1 }];
  numbers.forEach((value, index) => {
    if (index && value - numbers[index - 1] > 1) entries.push({ kind: 'gap' });
    entries.push({ kind: 'page', page: value, current: value === page });
  });
  entries.push({ kind: 'next', page: page + 1, disabled: page >= totalPages });
  return entries;
}

/**
 * Draws the strip for `page` of `totalPages` into `container` (hidden when there is a single
 * page), calling `onSelect(page)` when a Précédent, Suivant or page-number button is clicked.
 */
export function renderPageStrip(container, { page, totalPages, onSelect }) {
  const entries = pageStrip({ page, totalPages });
  container.classList.toggle('hidden', !entries.length);
  container.innerHTML = entries
    .map((entry) => {
      if (entry.kind === 'gap') return '<span>…</span>';
      if (entry.kind === 'page') return `<button data-page="${entry.page}" class="${entry.current ? 'active' : ''}" type="button">${entry.page}</button>`;
      const label = entry.kind === 'previous' ? 'Précédent' : 'Suivant';
      return `<button data-page="${entry.page}" type="button" ${entry.disabled ? 'disabled' : ''}>${label}</button>`;
    })
    .join('');
  container.querySelectorAll('[data-page]').forEach((button) => {
    button.onclick = () => onSelect(Number(button.dataset.page));
  });
}
