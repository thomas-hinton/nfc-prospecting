# NFC Prospection

Outil local pour rechercher des établissements Google, suivre leur statut commercial et copier un lien Google Maps à encoder sur une carte NFC.

## Application preview

![NFC Prospecting map interface](docs/images/nfc-prospecting-map.png)

## Version en ligne (Netlify + Supabase)

C’est la version prise en charge : la page Prospection, son moteur de recherche et sa
carte sont entièrement adossés à Supabase (plus de fichier local ni de clé Google Maps
personnelle à coller). Le site déployé est protégé par un compte unique : toute page
ouverte sans session valide renvoie vers `login.html`, et aucune donnée d’établissement
ni aucun appel Google n’est déclenché avant la connexion.

- **Provisionner** Supabase, la clé Google Maps et Netlify : `./scripts/provision.sh`
  (assistant pas à pas). Il crée le projet Supabase, applique `supabase/migrations/`,
  crée l’unique compte, désactive l’inscription publique, relie Netlify au dépôt, crée
  une clé Google Maps restreinte au domaine Netlify, et remplit `.env`.
- **Construire le site** : `npm ci && SUPABASE_URL=… SUPABASE_ANON_KEY=… GOOGLE_MAPS_API_KEY=… npm run build`.
  La construction assemble `dist/` (pages statiques + `config.js` + bundles `nfc-*.js`) ;
  c’est le seul dossier publié. Netlify exécute la même commande à chaque `push` sur `main`.
  Pour ouvrir l’application localement, servez `dist/` (les pages restent vides sans
  construction préalable : les bundles sont manquants).
- **Tester** : `npm test`. Les tests d’intégration du RPC `increment_quota` ne s’exécutent
  que si `.env` fournit un projet Supabase (`set -a && . ./.env && set +a && npm test`).

Tout accès à Supabase passe par `src/store.js` (« le store ») : c’est le seul module qui
parle à la base. Les clés `service_role` et Google Maps restent respectivement locale et
côté build ; ni l’une ni l’autre n’est saisissable depuis l’interface.

## Mode local historique

`server.py` et `app.js` (à la racine du dépôt) sont l’ancien prototype 100 % local,
antérieur à la migration Supabase : il sauvegardait dans un fichier JSON et demandait de
coller une clé Google Maps personnelle dans les réglages. Il n’est plus maintenu et ne
fonctionne pas avec les pages actuelles, qui exigent la construction `dist/` ci-dessus.

## Limites de sécurité

- 50 nouveaux établissements par jour
- 1 000 nouveaux établissements par mois

Un même établissement n’est compté qu’une seule fois : son `place_id` sert de dédoublonnage.
