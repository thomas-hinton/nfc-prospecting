import { describe, expect, it } from 'vitest';
import { placeCity, placeType } from '../src/place-fields.js';

describe('placeCity', () => {
  it('reads the commune out of a French address ending in the postcode and town', () => {
    expect(placeCity('12 quai du Port, 83270 Saint-Cyr-sur-Mer')).toBe('Saint-Cyr-sur-Mer');
  });

  it('reads the commune when the address is suffixed with the country', () => {
    expect(placeCity('1 rue de Rivoli, 75001 Paris, France')).toBe('Paris');
  });

  it('keeps a multi-word commune whole', () => {
    expect(placeCity('7 avenue des Anciens Combattants, 83500 La Seyne-sur-Mer, France')).toBe('La Seyne-sur-Mer');
  });

  it('keeps an arrondissement as part of the commune', () => {
    expect(placeCity('Quai du Port, 13002 Marseille 2e Arrondissement, France')).toBe('Marseille 2e Arrondissement');
  });

  it('is not fooled by a five-digit street number earlier in the address', () => {
    expect(placeCity('12345 route de Nice, 06000 Nice, France')).toBe('Nice');
  });

  it('tolerates loose spacing around the postcode and the country', () => {
    expect(placeCity('  3 rue Neuve ,  83000   Toulon ,  France  ')).toBe('Toulon');
  });

  it('leaves the commune unset when the address carries no postcode', () => {
    expect(placeCity('Le Bistrot du Coin, France')).toBeNull();
  });

  it('leaves the commune unset for a non-French address whose postcode does not precede the town', () => {
    expect(placeCity('350 5th Ave, New York, NY 10118, USA')).toBeNull();
  });

  it('leaves the commune unset for a foreign address whose trailing country is not France', () => {
    expect(placeCity('Unter den Linden 1, 10117 Berlin, Deutschland')).toBeNull();
  });

  it('leaves the commune unset when any other segment trails the town', () => {
    expect(placeCity('1 rue de Rivoli, 75001 Paris, Frankreich')).toBeNull();
    expect(placeCity('1 rue de Rivoli, 75001 Paris, France, Europe')).toBeNull();
  });

  it('reads a commune out of a country-less address of French shape, foreign or not', () => {
    // Google's formattedAddress always carries the country, so this shape is not one the
    // app receives; pinned so the rule's real edge is visible rather than assumed.
    expect(placeCity('Unter den Linden 1, 10117 Berlin')).toBe('Berlin');
  });

  it('is not fooled by a six-digit number whose last five digits look like a postcode', () => {
    expect(placeCity('832701 Nice')).toBeNull();
    expect(placeCity('8327012 Nice')).toBeNull();
  });

  it('leaves the commune unset when the postcode is not five digits long', () => {
    expect(placeCity('X, 1234 Nice')).toBeNull();
  });

  it('leaves the commune unset for a missing or empty address', () => {
    expect(placeCity('')).toBeNull();
    expect(placeCity(null)).toBeNull();
    expect(placeCity(undefined)).toBeNull();
  });

  it('never returns an empty string when the postcode is followed by nothing', () => {
    expect(placeCity('rue Sans Nom, 83270')).toBeNull();
    expect(placeCity('rue Sans Nom, 83270 , France')).toBeNull();
  });
});

describe('placeType', () => {
  it('returns the first Google type that is not one of the generic ones', () => {
    expect(placeType({ types: ['establishment', 'point_of_interest', 'bakery'] })).toBe('bakery');
  });

  it('falls back to Autre when every type is generic', () => {
    expect(placeType({ types: ['establishment', 'point_of_interest'] })).toBe('Autre');
  });

  it('falls back to Autre when there are no types at all', () => {
    expect(placeType({})).toBe('Autre');
    expect(placeType({ types: [] })).toBe('Autre');
  });
});
