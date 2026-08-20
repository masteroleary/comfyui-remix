// ── App shell ──────────────────────────────────────────────────────────────
// The single root. Everything the app ever shows renders inside this component's
// <router-view>; the chrome that outlives a view — toolbar, pagers, toast, the
// logout control, the dialogs — lives here rather than being duplicated per page
// as it was across the four pre-SPA HTML files.
import { store, showToast, reload, setBlur, exitMultiSelect } from '../store.js';
import { api } from '../api.js';
import AppToolbar from './AppToolbar.js';
import Pager from './Pager.js';
import { runningCount, leadPct } from './RemixDialog.js';
import MoveDialog from './MoveDialog.js';
import MergeDialog from './MergeDialog.js';

const { computed, onMounted, onUnmounted, ref, defineAsyncComponent } = window.Vue;

// The remix dialog pulls in the ComfyUI job engine on import, so it loads on
// first use rather than on every page load.
const RemixDialog = defineAsyncComponent(() => import('./RemixDialog.js'));
const { useRoute, useRouter } = window.VueRouter;

export default {
  name: 'AppShell',
  components: { AppToolbar, Pager, MoveDialog, MergeDialog, RemixDialog },
  setup() {
    const route = useRoute();
    const router = useRouter();
    const isBrowse = computed(() => route.name === 'browse');
    const isHome = computed(() => route.name === 'home');
    const isJobs = computed(() => route.name === 'jobs');
    // Anything that takes the screen: the shell's own dialogs, and the viewer,
    // which is a route rather than an overlay but reads as one.
    const overlayUp = computed(() => !!(store.ui.remix || store.ui.move
      || store.ui.merge || confirmBox.value || route.name === 'view'));
    const confirmBox = ref(null);   // { title, body, ok, run } or null

    async function logout() {
      // Reload either way: on success the server answers the next request with
      // the lock screen, and on failure the reload surfaces whatever state we're in.
      try { await api.logout(); } catch {}
      location.reload();
    }

    // The toolbar raises every bulk action; the two destructive ones confirm
    // first, and all of them refresh the listing in place — the route hasn't
    // changed, so nothing else would.
    async function onBulk({ action, paths, folders, videos }) {
      if (action === 'move') { store.ui.move = true; return; }
      if (action === 'merge-folders') { store.ui.merge = true; return; }
      if (action === 'merge-videos') { store.ui.merge = true; return; }

      const many = paths.length;
      const ask = action === 'delete'
        ? { title: 'Delete ' + many + ' item' + (many === 1 ? '' : 's') + '?',
            body: 'This removes the files from disk. It cannot be undone.', ok: 'Delete' }
        : { title: 'Favorite ' + many + ' item' + (many === 1 ? '' : 's') + '?',
            body: 'They move into your Favorites folder.', ok: 'Favorite' };

      confirmBox.value = {
        ...ask,
        run: async () => {
          confirmBox.value = null;
          try {
            if (action === 'delete') await api.bulkDelete(paths);
            else for (const p of paths) await api.favorite(p);   // no bulk endpoint for favorites
            showToast('✓ ' + many + ' item' + (many === 1 ? '' : 's') + ' ' + (action === 'delete' ? 'deleted' : 'favorited'));
          } catch (e) {
            showToast('Failed: ' + e.message, 5000);
          }
          exitMultiSelect();
          await reload();
        },
      };
    }

    // Re-censor when the tab is hidden: the point of blur is that a glance at the
    // screen shows nothing, so coming back to an uncensored grid defeats it. Lives
    // in the shell so it holds while you're off in chat or the viewer, not only
    // while the toolbar that owns the toggle happens to be mounted.
    const onHide = () => { if (document.hidden) setBlur(true); };
    onMounted(() => document.addEventListener('visibilitychange', onHide));
    onUnmounted(() => document.removeEventListener('visibilitychange', onHide));

    // A move or merge changes the listing without changing the route, so nothing
    // would re-fetch on its own.
    async function afterMutation() {
      exitMultiSelect();
      await reload();
    }

    // Jobs is a route now, so the badge navigates. Remix is still an overlay and
    // would sit on top of the page it takes you to, so it comes down first.
    const openJobs = () => { store.ui.remix = null; router.push({ name: 'jobs' }); };

    return { store, isBrowse, isHome, isJobs, overlayUp, logout, onBulk, confirmBox, afterMutation,
             runningCount, leadPct, openJobs };
  },
  template: `
    <div class="app-shell">
      <AppToolbar v-if="isBrowse" @bulk="onBulk" />

      <!-- Settings lives in the shell, not the toolbar. The toolbar only renders on
           browse routes, which left Settings unreachable from Home, the viewer,
           chat, voice and inspect — including on a fresh install, where Home is
           where you land and configuring the media root is the first thing needed. -->
      <router-link v-if="!isBrowse && !isHome && !overlayUp" class="shell-settings" title="Settings" :to="{ name: 'settings' }">⚙</router-link>

      <!-- Home carries Log out as the last tile in its menu and browse carries it
           inline in .hdr-row1, so on those two routes the corner button would be a
           free-floating duplicate. The viewer, inspect and friends still need it. -->
      <button v-if="store.authEnabled && !isHome && !isBrowse && !overlayUp" class="shell-logout" title="Log out" @click="logout">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
          <polyline points="16 17 21 12 16 7"/><path d="M21 12H9"/>
        </svg>
      </button>

      <!-- The top page strip moved into the toolbar's switch bar, where it sits
           between the root and tile-size switches. The copy below the grid stays:
           it is the one you reach after scrolling a page of results. -->
      <router-view v-slot="{ Component }">
        <suspense>
          <component :is="Component" />
          <template #fallback>
            <div class="loading"><div class="spinner"></div> Loading…</div>
          </template>
        </suspense>
      </router-view>
      <Pager v-if="isBrowse" />

      <!-- Dialogs. Held here, not in the view that happens to open them: the same
           dialog is raised from a card menu, the toolbar and the viewer, and
           closing it must not depend on which of those is still mounted. -->

      <!-- Global run chrome: a hairline progress bar across the top and a count
           badge, both only while something is actually running and nothing has
           taken the screen. They live in the shell because a job outlives the
           dialog that started it and any route it was started from — but a
           dialog is not a page, and floating chrome over one lands on its own
           controls. Hidden on /jobs too: there the badge would point at the page
           it is already sitting on, and the list shows the same progress. -->
      <div v-if="runningCount > 0 && !overlayUp && !isJobs" class="rmx-topbar"
           :title="runningCount + ' job(s) running — click for Jobs'" @click="openJobs">
        <div class="rmx-topbar-fill" :class="{ indet: leadPct === 0 }"
             :style="leadPct > 0 ? { width: leadPct + '%' } : {}"></div>
      </div>
      <button v-if="runningCount > 0 && !overlayUp && !isJobs" class="rmx-fab" title="Running jobs"
              @click="openJobs">⚡ {{ runningCount }}</button>

      <MoveDialog :open="store.ui.move" @close="store.ui.move = false" @done="afterMutation" />
      <MergeDialog :open="store.ui.merge" @close="store.ui.merge = false" @done="afterMutation" />
      <RemixDialog v-if="store.ui.remix" :item="store.ui.remix" :key="store.ui.remix.path"
                   @close="store.ui.remix = null" />

      <div v-if="confirmBox" class="confirm-overlay open" data-backdrop @click.self="confirmBox = null">
        <div class="confirm-sheet">
          <div class="confirm-title">{{ confirmBox.title }}</div>
          <div class="confirm-body">{{ confirmBox.body }}</div>
          <div class="confirm-btns">
            <button class="btn-cancel" @click="confirmBox = null">Cancel</button>
            <button class="btn-ok" @click="confirmBox.run()">{{ confirmBox.ok }}</button>
          </div>
        </div>
      </div>

      <transition name="toast">
        <div v-if="store.toast.text" class="toast">{{ store.toast.text }}</div>
      </transition>
    </div>
  `,
};
