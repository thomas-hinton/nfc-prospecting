# Publish a built `dist/` and gate each page by deferring its own script

The app is a set of plain HTML pages with classic `<script src>` tags and no build step. The online deployment needs two things that shape does not give: Supabase credentials injected at build time, and a guarantee that a logged-out visitor triggers no établissement read, no map load and no API-key lookup.

`scripts/build.mjs` therefore assembles a `dist/` directory — the static pages, a generated `config.js` holding `SUPABASE_URL`/`SUPABASE_ANON_KEY`, and the esbuild-bundled browser entry points — and Netlify publishes only that. Publishing the repository root instead would have avoided the copy step, but would also serve `src/`, `tests/`, `scripts/`, `supabase/`, `docs/` and `server.py` from the public URL.

Each page's own script (`app.js`, `visit.js`, `backlog.js`) is no longer loaded by the page. It is named on the gate's script tag as `data-page-script` and injected by `src/auth-gate.js` only once a session is confirmed. A module script would have been the obvious gate, but module scripts are deferred and would run *after* the page's classic script — too late to stop anything. The cost is that the pages cannot be opened straight from the repository any more: they must be built first.
