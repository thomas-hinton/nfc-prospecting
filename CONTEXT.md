# NFC Prospection

A prospecting tool: it surfaces businesses from Google Maps, tracks each one through a commercial pipeline, and produces a link meant to be encoded onto a physical NFC card for handoff.

## Language

**Établissement**:
A business location sourced from Google Places and tracked through the prospecting pipeline, keyed by its Google `placeId` (also the de-dup key — the same établissement is never tracked twice). Code identifiers use the English field name `place`/`placeId` for this same concept.

**Statut**:
The commercial pipeline stage of an établissement: à visiter → programmé pour visite → vendu / refusé / non conforme. Terminal outcomes (vendu, refusé, non conforme) can be reopened back to à visiter.

**Visite**:
A field-visit event recorded against an établissement when its status is resolved during an in-person visit (vendu, refusé, non conforme, or reprogrammed back to à visiter). Stored as an entry in the établissement's visit history, separate from the établissement's current status.

**Commune**:
The town an établissement sits in, and the unit the prospector plans a round in. Read out of the tail of the Google-supplied address (the `\d{5} <commune>` before an optional `, France`) at the moment the établissement is first tracked, and stored from then on, so it is one stable value that can be corrected by hand rather than a guess re-made on every render. An address that carries no recognisable commune leaves it unset. Its sibling, the établissement's **type**, stays derived on the fly — the first of Google's `types` that isn't one of the generic ones Google puts on everything (`establishment`, `point_of_interest`, …), or "Autre". Code identifiers use the English field name `city` for this concept.

**Potentiel**:
What a set of not-yet-sold établissements would be worth if every one of them sold at the configured sale price: their count × that price. An estimate, never revenue — no sale has happened, and the figure moves when the sale price is changed in the settings. Only the pipeline statuts (programmé pour visite, à visiter) have one; vendu has an actual amount, and refusé / non conforme have neither.

**Backlog**:
The read-only technical audit trail of everything that happened to the prospecting data — établissement added, status changed, comment added, Google API request made. This is not a product/task backlog; this repo's actual issue backlog lives in GitHub Issues (see `docs/agents/issue-tracker.md`).

**Quota**:
The running count of Google Maps Platform API requests (Places API + Maps JavaScript API, combined) consumed in the current calendar month, checked against the account's monthly limit (1 000 by default) before each request that would consume it. The check and the increment happen together, in the database, so two devices can't both read a stale count and jointly overshoot.

**Store**:
The single client-side data-access module (`src/store.js`) that talks to Supabase. Every page reads and writes prospecting data through it; no other code holds a Supabase client.
