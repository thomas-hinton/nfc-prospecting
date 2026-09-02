# Scope every table by user_id + RLS despite there being one user

NFC Prospection has exactly one user (accessed from multiple devices, not multiple people). Even so, every Supabase table carries a `user_id` column and a Row-Level-Security policy scoped to `auth.uid() = user_id`, rather than policies that just require "any authenticated request."

Supabase's anon key ships in the client bundle, so RLS — not the key — is the real access boundary. The cost of scoping now is negligible (one column, one policy per table); the alternative leaves the data exposed to anyone who authenticates if the Auth configuration ever drifts (e.g. public signup accidentally left open).
