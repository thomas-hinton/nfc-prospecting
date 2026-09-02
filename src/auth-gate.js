import { bootstrapStore } from './bootstrap.js';

/**
 * Guards every page of the app. The page's own script is named on this script tag via
 * `data-page-script` and is only injected once a session is confirmed, so a logged-out
 * visitor never triggers an établissement read, a map load, or an API-key lookup.
 */

const LOGIN_PAGE = 'login.html';

function reveal() {
  document.body.removeAttribute('data-requires-auth');
}

function redirectToLogin() {
  const next = window.location.pathname.split('/').pop() + window.location.search;
  window.location.replace(`${LOGIN_PAGE}?next=${encodeURIComponent(next)}`);
}

function loadPageScript() {
  const source = document.querySelector('script[data-page-script]')?.dataset.pageScript;
  if (!source) return;
  const script = document.createElement('script');
  script.src = source;
  document.body.appendChild(script);
}

function showMessage(title, body) {
  reveal();
  document.body.innerHTML = `<main class="auth-shell"><div class="auth-card"><h1>${title}</h1><p>${body}</p></div></main>`;
}

async function gate() {
  const store = bootstrapStore(window);
  if (!store) {
    showMessage(
      'Configuration manquante',
      'Les variables Supabase ne sont pas définies pour ce déploiement. ' +
        'Reconstruis le site avec <code>SUPABASE_URL</code> et <code>SUPABASE_ANON_KEY</code>.'
    );
    return;
  }

  const session = await store.getSession().catch(() => null);
  if (!session) {
    redirectToLogin();
    return;
  }

  // A sign-out on this or another tab sends the page straight back to the login screen.
  store.onAuthStateChange((next) => {
    if (!next) redirectToLogin();
  });

  document.querySelector('#sign-out')?.addEventListener('click', () => store.signOut());

  reveal();
  loadPageScript();
}

gate();
