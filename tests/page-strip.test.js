import { describe, expect, it } from 'vitest';
import { pageStrip } from '../src/page-strip.js';

/** The strip as a human reads it: ‹ for Précédent, › for Suivant, [n] for the current page, … for a gap. */
function read(entries) {
  return entries
    .map((entry) => {
      if (entry.kind === 'gap') return '…';
      if (entry.kind === 'previous') return entry.disabled ? '(‹)' : `‹${entry.page}`;
      if (entry.kind === 'next') return entry.disabled ? '(›)' : `›${entry.page}`;
      return entry.current ? `[${entry.page}]` : String(entry.page);
    })
    .join(' ');
}

describe('pageStrip', () => {
  it('shows no strip at all when everything fits on one page', () => {
    expect(pageStrip({ page: 1, totalPages: 1 })).toEqual([]);
  });

  it('lists every page of a short strip, with Précédent disabled on the first page', () => {
    expect(read(pageStrip({ page: 1, totalPages: 3 }))).toBe('(‹) [1] 2 3 ›2');
  });

  it('stays compact in the middle of a long list: first, neighbours, last, with gaps between', () => {
    expect(read(pageStrip({ page: 8, totalPages: 16 }))).toBe('‹7 1 … 7 [8] 9 … 16 ›9');
  });

  it('never shows more than five page numbers, however many pages there are', () => {
    for (let page = 1; page <= 400; page++) {
      const numbers = pageStrip({ page, totalPages: 400 }).filter((entry) => entry.kind === 'page');
      expect(numbers.length).toBeLessThanOrEqual(5);
    }
  });

  it('disables Suivant on the last page and drops the trailing gap', () => {
    expect(read(pageStrip({ page: 16, totalPages: 16 }))).toBe('‹15 1 … 15 [16] (›)');
  });

  it('marks a single skipped page as a gap too, as the Backlog always has', () => {
    expect(read(pageStrip({ page: 4, totalPages: 5 }))).toBe('‹3 1 … 3 [4] 5 ›5');
  });

  it('joins the ends with no gap when the neighbours touch them', () => {
    expect(read(pageStrip({ page: 2, totalPages: 3 }))).toBe('‹1 1 [2] 3 ›3');
  });
});
