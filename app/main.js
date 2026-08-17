// ── Entry point ────────────────────────────────────────────────────────────
// One app, one root, one router. Vue and Vue Router are the vendored UMD builds
// (globals), so there is still no build step — everything below is a native ES
// module the browser loads directly.
import { router } from './router.js';
import { store, showToast } from './store.js';
import { api } from './api.js';
import AppShell from './components/AppShell.js';

const { createApp } = window.Vue;

const app = createApp(AppShell);
app.use(router);

// Nothing in a Vue app should reach for document.getElementById; where a legacy
// helper is still needed during the port it lives in the component that needs it.
app.config.errorHandler = (err, _vm, info) => {
  console.error('[ComfyRemix]', info, err);
  showToast('Something went wrong — see the console');
};

// Whether the password gate is on decides if the shell offers a logout control.
api.authStatus().then(s => { store.authEnabled = !!(s && s.enabled); }).catch(() => {});

app.mount('#app');
