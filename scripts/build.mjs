#!/usr/bin/env node
/**
 * Build step for the Netlify deployment (and for running the same site locally).
 *
 * Assembles `dist/`: the static pages, the generated `config.js` holding the build-time
 * environment, and the bundled browser entry points. Only `dist/` is published, so the
 * repository's sources, tests, tooling and docs never reach the public site.
 */
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

const STATIC_FILES = [
  'index.html',
  'login.html',
  'prospection.html',
  'visite.html',
  'backlog.html',
  'styles.css',
  'visit.js',
];

const supabaseUrl = process.env.SUPABASE_URL ?? '';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY ?? '';
const googleMapsApiKey = process.env.GOOGLE_MAPS_API_KEY ?? '';

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('[build] SUPABASE_URL / SUPABASE_ANON_KEY are not set — the site will show a configuration error.');
}
if (!googleMapsApiKey) {
  console.warn('[build] GOOGLE_MAPS_API_KEY is not set — the Prospection map and search will be unavailable.');
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

for (const file of STATIC_FILES) copyFileSync(join(root, file), join(dist, file));

writeFileSync(
  join(dist, 'config.js'),
  '// Généré par scripts/build.mjs — ne pas modifier à la main.\n' +
    `window.NFC_CONFIG = ${JSON.stringify({ supabaseUrl, supabaseAnonKey, googleMapsApiKey }, null, 2)};\n`
);

await esbuild.build({
  entryPoints: {
    'nfc-auth-gate': join(root, 'src/auth-gate.js'),
    'nfc-login': join(root, 'src/login.js'),
    'nfc-prospection': join(root, 'src/prospection.js'),
    'nfc-backlog': join(root, 'src/backlog.js'),
  },
  outdir: dist,
  bundle: true,
  format: 'iife',
  target: 'es2020',
  minify: true,
  logLevel: 'info',
});

console.log(`[build] ${STATIC_FILES.length + 1} static files + 4 bundles → dist/`);
