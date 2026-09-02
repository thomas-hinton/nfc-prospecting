import { createStore } from './store.js';
import { createSupabaseClient, readConfig } from './supabase-client.js';

/**
 * Builds the store from the page's build-time configuration, shared by every browser
 * entry point. Returns null when the site was published without Supabase variables.
 */
export function bootstrapStore(scope = globalThis) {
  const config = readConfig(scope);
  return config ? createStore({ client: createSupabaseClient(config) }) : null;
}
