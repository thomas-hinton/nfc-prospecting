import { describe, expect, it } from 'vitest';
import { historyEntryKind } from '../src/place-history.js';

describe('historyEntryKind', () => {
  it.each([
    ['place_added', 'Établissement ajouté', '➕'],
    ['status_changed', 'Statut modifié', '🔄'],
    ['sale_amount_changed', 'Montant de vente modifié', '💶'],
    ['visit_recorded', 'Visite enregistrée', '📍'],
  ])('labels %s', (action, label, icon) => {
    expect(historyEntryKind(action)).toEqual({ label, icon });
  });

  it.each([
    ['Fiche ajoutée', 'place_added'],
    ['Statut modifié', 'status_changed'],
    ['Montant de vente modifié', 'sale_amount_changed'],
    ['Commentaire ajouté', 'visit_recorded'],
  ])('gives the migrated %s entry the same label and icon as %s', (legacy, current) => {
    expect(historyEntryKind(legacy)).toEqual(historyEntryKind(current));
  });

  it('shows an unknown action as its raw code, with a neutral icon', () => {
    expect(historyEntryKind('something_new')).toEqual({ label: 'something_new', icon: '•' });
  });
});
