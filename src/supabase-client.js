import { createClient } from '@supabase/supabase-js';

/**
 * Build-time configuration, written into `config.js` by scripts/build.mjs from the
 * Netlify environment variables. Returns null when the site was published without it.
 */
export function readConfig(scope = globalThis) {
  const config = scope.NFC_CONFIG;
  if (!config?.supabaseUrl || !config?.supabaseAnonKey) return null;
  return config;
}

export function createSupabaseClient({ supabaseUrl, supabaseAnonKey }) {
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      // Keeps the session in localStorage so a reload doesn't re-prompt for credentials.
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
}
