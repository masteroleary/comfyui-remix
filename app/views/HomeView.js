// ── Home ───────────────────────────────────────────────────────────────────
// The landing tiles: the media roots plus whichever optional features are turned
// on in config. Ported from the pre-SPA HomeApp, with two changes: the tiles that
// now read straight off the store instead of a homeState mirror.
import { store, showToast } from '../store.js';
import { api } from '../api.js';
import { browseTo } from '../router.js';

const { ref, computed, onMounted } = window.Vue;

export default {
  name: 'HomeView',
  setup() {
    const loading = ref(true);
    const roots = ref({ fav: '', out: '' });
    const features = ref(null);      // null until settings load; array once known
    const httpsPort = ref(8443);
    const recent = ref([]);

    const has = f => !features.value || features.value.includes(f);

    const tiles = computed(() => {
      const out = [];
      out.push({ key: 'favorites', icon: '⭐', label: 'Favorites', sub: 'Everything you kept',
                 to: browseTo({ dir: roots.value.fav }, null, roots.value) });
      if (roots.value.out) {
        out.push({ key: 'output', icon: '🎨', label: 'ComfyUI Output', sub: 'Fresh from the queue',
                   to: browseTo({ dir: roots.value.out }, null, roots.value) });
      }
      out.push({ key: 'jobs', icon: '⚡', label: 'Jobs', sub: 'Running and completed runs',
                 to: { name: 'jobs' } });
      out.push({ key: 'workflows', icon: '🧩', label: 'Workflows', sub: 'The library Remix runs from',
                 to: { name: 'workflows' } });
      out.push({ key: 'prompts', icon: '📝', label: 'Prompts', sub: 'Reusable text for [keyword] rules',
                 to: { name: 'prompts' } });
      out.push({ key: 'settings', icon: '⚙', label: 'Settings', sub: 'Paths, ports and privacy',
                 to: { name: 'settings' } });
      // Last tile, and only when a password is actually in use. The shell hides
      // its own corner logout on this route so there is exactly one of these.
      // Two lines rather than importing AppShell's copy: store.js has no imports
      // and pulling api.js into it would close a cycle (api -> store -> api).
      if (store.authEnabled) {
        out.push({ key: 'logout', icon: '🚪', label: 'Log out', sub: 'End this session',
                   action: async () => {
                     try { await api.logout(); } catch {}
                     location.reload();
                   } });
      }
      return out;
    });


    onMounted(async () => {
      try {
        const [r, settings] = await Promise.all([
          api.roots().catch(() => null),
          api.settings().catch(() => null),
        ]);
        if (r) { roots.value = r; store.roots = r; }
        if (settings) {
          store.settings = settings;
          features.value = (settings.setup && settings.setup.features) || null;
          httpsPort.value = (settings.info && settings.info.httpsPort) || 8443;
        }
        recent.value = (await api.recentOutputs().catch(() => null))?.items?.slice(0, 8) || [];
      } catch (e) {
        showToast('Could not load the home screen: ' + e.message);
      }
      loading.value = false;
    });

    return { store, loading, tiles, recent };
  },
  template: `
    <div class="home">
      <div v-if="loading" class="loading"><div class="spinner"></div> Loading…</div>
      <template v-else>
        <!-- The art carries its own near-black ground, so it sits on the page
             rather than in a card. Intrinsic size is the file's own 960×518 —
             it displays at 320 CSS px, so that is 3x for phone screens. -->
        <img class="home-logo" src="/logo-home.webp" alt="ComfyUI-Remix" width="960" height="518">
        <div class="home-tiles">
          <template v-for="t in tiles" :key="t.key">
            <router-link v-if="t.to" :to="t.to" class="home-tile">
              <span class="home-tile-icon">{{ t.icon }}</span>
              <span class="home-tile-label">{{ t.label }}</span>
              <span class="home-tile-sub">{{ t.sub }}</span>
            </router-link>
            <button v-else type="button" class="home-tile" @click="t.action()">
              <span class="home-tile-icon">{{ t.icon }}</span>
              <span class="home-tile-label">{{ t.label }}</span>
              <span class="home-tile-sub">{{ t.sub }}</span>
            </button>
          </template>
        </div>
      </template>
    </div>
  `,
};
