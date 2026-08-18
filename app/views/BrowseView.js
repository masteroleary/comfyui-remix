// ── Browse ─────────────────────────────────────────────────────────────────
// The media grid. The URL owns what is being shown — root, folder, page, search,
// sort, filter — so this view is a function of the route: it watches the route,
// pulls the listing, and puts it in the store. Nothing else writes those fields,
// which is what makes Back, refresh and deep links work at all (none of them did
// before the rewrite).
import { store, showToast, registerReload, toggleSelected } from '../store.js';
import { api } from '../api.js';
import { browseQuery, browseTo, viewTo } from '../router.js';
import MediaTile from '../components/MediaTile.js';

const { watch, onMounted, onUnmounted } = window.Vue;
const { useRoute, useRouter } = window.VueRouter;

export default {
  name: 'BrowseView',
  components: { MediaTile },
  setup() {
    const route = useRoute();
    const router = useRouter();

    async function load() {
      // Roots are needed to turn /browse/out/x back into an absolute dir, so they
      // have to be known before the first listing — fetched once, then cached.
      if (!store.roots.fav) {
        try { store.roots = await api.roots(); } catch { /* listing below will report it */ }
      }
      const q = browseQuery(route, store.roots);
      Object.assign(store, q);
      store.loading = true; store.error = '';
      try {
        const data = await api.list({
          dir: q.dir || '', page: q.page, limit: store.limit,
          search: q.search, sort: q.sort,
          // The server tests `asc !== 'false'`, so '0' reads as ascending and
          // descending never happens. Legacy sent the boolean; so do we.
          asc: q.asc ? 'true' : 'false',
          type: q.type, flatten: q.flatten ? '1' : '0',
          // Safe mode is filtered server-side. It isn't in the URL — it's a
          // standing preference, not a property of the view being linked to —
          // so flipping it has to re-fetch explicitly (watched below).
          safe: store.safeOn ? '1' : '0',
        });
        store.items = data.items || [];
        store.total = data.total || 0;
        store.pages = data.pages || 1;
        store.parent = data.parent ?? null;
        if (data.favoritesDir || data.comfyOutputDir) {
          store.roots = { fav: data.favoritesDir || store.roots.fav, out: data.comfyOutputDir || store.roots.out };
        }
      } catch (e) {
        store.error = e.message;
        store.items = [];
        showToast('Could not list that folder: ' + e.message);
      }
      store.loading = false;
    }

    // fullPath rather than params: page and search changes are query-only, and a
    // watcher on params alone would leave the grid showing the previous page.
    watch(() => route.fullPath, load);
    watch(() => store.safeOn, load);        // not in the URL, still changes the listing
    const unregister = registerReload(load); // dialogs and bulk actions refresh in place
    onUnmounted(unregister);
    onMounted(load);

    // The listing marks folders with isDir — there is no `type` field on an item.
    const open = item => {
      if (store.multiSelect) { toggleSelected(item.path); return; }
      if (item.isDir) { router.push(browseTo({ dir: item.path }, null, store.roots)); return; }
      const to = viewTo(item.path, store.roots);
      if (to) router.push(to);
      else showToast('Cannot open that file from here — it is outside the media roots');
    };

    // The info bar under the thumbnail is a hit area of its own, as it was
    // before the rewrite folded the whole tile into one button: the thumbnail
    // opens the viewer, the bar under it raises Remix. Anything Remix cannot
    // act on — folders, audio, stray files — falls through to open(), so the
    // bar is never a dead click.
    const canRemix = item => !item.isDir && (item.isImage || item.isVideo);
    const openRemix = item => {
      if (store.multiSelect) { toggleSelected(item.path); return; }
      if (!canRemix(item)) { open(item); return; }
      // AppShell owns the dialog and imports the run engine eagerly, so raising
      // it is a store write: nothing to load, and the job outlives this route.
      store.ui.remix = item;
    };

    return { store, open, openRemix };
  },
  template: `
    <div class="browse" :class="{ 'blur-on': store.blurOn }">
      <div v-if="store.loading" class="loading"><div class="spinner"></div> Loading…</div>
      <div v-else-if="store.error" class="loading">{{ store.error }}</div>
      <div v-else-if="!store.items.length" class="loading">Nothing here.</div>
      <div v-else class="grid">
        <MediaTile v-for="it in store.items" :key="it.path" :item="it"
                   :selected="store.selected.has(it.path)"
                   @open="open(it)" @remix="openRemix(it)" />
      </div>
    </div>
  `,
};
