import { describe, expect, it } from 'vitest';
import { parseSaleAmount, scheduledVisits } from '../src/visit.js';

function place(overrides = {}) {
  return {
    placeId: 'place-1',
    name: 'Boulangerie du Port',
    address: '12 quai du Port, 83270 Saint-Cyr-sur-Mer',
    city: 'Saint-Cyr-sur-Mer',
    status: 'scheduled',
    statusChangedAt: '2026-09-01T08:00:00.000Z',
    ...overrides,
  };
}

describe('scheduledVisits', () => {
  it('lists only établissements programmé pour visite', () => {
    const places = ['to_visit', 'scheduled', 'sold', 'refused', 'non_compliant'].map((status) => place({ placeId: status, status }));
    expect(scheduledVisits(places).map((visit) => visit.placeId)).toEqual(['scheduled']);
  });

  it('lists the oldest programmation first', () => {
    const places = [
      place({ placeId: 'recent', statusChangedAt: '2026-09-20T08:00:00.000Z' }),
      place({ placeId: 'oldest', statusChangedAt: '2026-09-01T08:00:00.000Z' }),
      place({ placeId: 'middle', statusChangedAt: '2026-09-10T08:00:00.000Z' }),
    ];
    expect(scheduledVisits(places).map((visit) => visit.placeId)).toEqual(['oldest', 'middle', 'recent']);
  });

  it.each([
    ['the name', 'boulangerie'],
    ['the address', 'QUAI DU PORT'],
    ['the commune', 'saint-cyr'],
  ])('matches a search on %s, ignoring case', (_field, query) => {
    const places = [place({ placeId: 'match' }), place({ placeId: 'other', name: 'Garage', address: '1 rue X, 83000 Toulon', city: 'Toulon' })];
    expect(scheduledVisits(places, query).map((visit) => visit.placeId)).toEqual(['match']);
  });

  it('ignores surrounding blanks in the search and tolerates a missing commune', () => {
    const places = [place({ placeId: 'no-city', city: null })];
    expect(scheduledVisits(places, '  boulangerie  ')).toHaveLength(1);
  });
});

describe('parseSaleAmount', () => {
  it.each([
    ['50', 50],
    ['0', 0],
    ['12.5', 12.5],
    ['12,5', 12.5],
    [' 80 ', 80],
  ])('reads %j as %s', (raw, expected) => {
    expect(parseSaleAmount(raw)).toBe(expected);
  });

  it.each(['', '   ', '-1', 'abc', '12abc', undefined, null])('rejects %j', (raw) => {
    expect(parseSaleAmount(raw)).toBeNull();
  });
});
