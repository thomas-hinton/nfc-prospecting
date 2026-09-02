# NFC Prospection

A prospecting tool: it surfaces businesses from Google Maps, tracks each one through a commercial pipeline, and produces a link meant to be encoded onto a physical NFC card for handoff.

## Language

**Établissement**:
A business location sourced from Google Places and tracked through the prospecting pipeline, keyed by its Google `placeId` (also the de-dup key — the same établissement is never tracked twice). Code identifiers use the English field name `place`/`placeId` for this same concept.

**Statut**:
The commercial pipeline stage of an établissement: à visiter → programmé pour visite → vendu / refusé / non conforme. Terminal outcomes (vendu, refusé, non conforme) can be reopened back to à visiter.

**Visite**:
A field-visit event recorded against an établissement when its status is resolved during an in-person visit (vendu, refusé, non conforme, or reprogrammed back to à visiter). Stored as an entry in the établissement's visit history, separate from the établissement's current status.

**Backlog**:
The read-only technical audit trail of everything that happened to the prospecting data — établissement added, status changed, comment added, Google API request made. This is not a product/task backlog; this repo's actual issue backlog lives in GitHub Issues (see `docs/agents/issue-tracker.md`).

**Quota**:
The running count of Google Maps Platform API requests (Places API + Maps JavaScript API, combined) consumed in the current calendar month, checked against a fixed monthly limit before each request that would consume it.
