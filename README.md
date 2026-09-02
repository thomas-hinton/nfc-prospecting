# NFC Prospection

Outil local pour rechercher des établissements Google, suivre leur statut commercial et copier un lien Google Maps à encoder sur une carte NFC.

## Démarrage

1. Lancez `server.py` puis ouvrez `http://127.0.0.1:4173/` ; ne double-cliquez pas simplement sur `index.html`.
2. Les données sont sauvegardées automatiquement dans `C:\Users\Dell\Documents\Projet Google Add\NFC prospection\prospection.json`.
3. Cliquez sur le réglage ⚙ et collez votre clé Google Maps API. Elle est conservée uniquement dans le stockage local de ce navigateur.

La clé doit avoir les deux restrictions d’API suivantes : Maps JavaScript API et Places API, ainsi que des restrictions de site web incluant `http://localhost/*` et `http://127.0.0.1/*`.

## Limites de sécurité

- 50 nouveaux établissements par jour
- 1 000 nouveaux établissements par mois

Un même établissement n’est compté qu’une seule fois : son `place_id` sert de dédoublonnage.
