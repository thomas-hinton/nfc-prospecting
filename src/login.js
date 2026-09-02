import { bootstrapStore } from './bootstrap.js';

const DEFAULT_DESTINATION = 'index.html';

/**
 * Only same-page relative destinations are followed, so a crafted `?next=` can't turn the
 * login screen into an open redirect.
 */
export function safeDestination(next) {
  if (!next || /^[a-z]+:/i.test(next) || next.startsWith('//') || next.startsWith('/')) return DEFAULT_DESTINATION;
  return /^[\w.-]+\.html(\?[^#]*)?$/.test(next) ? next : DEFAULT_DESTINATION;
}

function start() {
  const form = document.querySelector('#login-form');
  const message = document.querySelector('#login-message');
  const submit = document.querySelector('#login-submit');

  const store = bootstrapStore(window);
  if (!store) {
    message.textContent = 'Configuration Supabase manquante pour ce déploiement.';
    submit.disabled = true;
    return;
  }

  const destination = safeDestination(new URLSearchParams(window.location.search).get('next'));

  store.getSession().then((session) => {
    if (session) window.location.replace(destination);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    message.textContent = '';
    submit.disabled = true;
    try {
      await store.signIn(document.querySelector('#login-email').value.trim(), document.querySelector('#login-password').value);
      window.location.replace(destination);
    } catch (error) {
      message.textContent = /invalid login credentials/i.test(error.message)
        ? 'Identifiants incorrects.'
        : error.message;
      submit.disabled = false;
    }
  });
}

if (typeof document !== 'undefined') start();
