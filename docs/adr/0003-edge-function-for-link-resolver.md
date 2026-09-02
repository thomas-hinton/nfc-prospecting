# Run the share-link resolver as a Supabase Edge Function, not a Netlify Function

The app needs one piece of server-side compute: resolving a shared Google Maps link (e.g. `maps.app.goo.gl`) by following its redirect server-side and checking the result against a host allowlist. This can't run as client-side JS.

A Netlify Function would have ridden along with the site's existing auto-deploy pipeline for free, since issue #1 asks for automatic deployment from GitHub. A Supabase Edge Function needs its own deploy step instead, so it's wired through a dedicated GitHub Action that runs `supabase functions deploy` alongside Netlify's own auto-deploy, keeping both halves shipping automatically on every push. This was chosen anyway to keep the resolver co-located with the rest of the Supabase-side code and secrets rather than splitting backend logic across two platforms.
