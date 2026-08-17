// ── Toolbar ────────────────────────────────────────────────────────────────
// The sticky header: breadcrumbs, back/home, blur + safe mode, settings, search,
// the prompt-word directory, sort, type filters, flatten, the multi-select bar,
// the root tabs, and the stats line.
//
// Ported from the pre-SPA #toolbarApp, with one structural change that touches
// every control: the old toolbar wrote into a plain `S` object plus a `tbar`
// mirror and then called loadDir() to make the change real. Here the URL is the
// source of truth, so nothing below fetches or assigns browsing state — each
// control pushes a route built by browseTo() and BrowseView reloads off the
// route it lands on. That is what makes Back, refresh and deep links work on a
// sort or a filter, none of which they did before.
//
// Renders on browse routes only; the shell decides where it goes.
import {
  store, TYPES, setBlur, setSafe, showToast, clearSelection, exitMultiSelect,
  crumbs, sortLabel, filterCount, selectedCount, onHome,
} from '../store.js';
import { api } from '../api.js';
import { browseQuery, browseTo, splitRoot, joinRoot } from '../router.js';

const { ref, computed, watch, onMounted, onBeforeUnmount } = window.Vue;
const { useRoute, useRouter } = window.VueRouter;

// Styles live in app/styles/toolbar.css, linked from index.html alongside the
// other per-component sheets.

// Sort cycle, in the order the button walks them. Unchanged from the pre-SPA
// SORTS list; the label comes from the store's sortLabel so the button and any
// other reader can never disagree about what "Date ↓" means.
const SORTS = [
  { sort: 'name', asc: true }, { sort: 'name', asc: false },
  { sort: 'size', asc: true }, { sort: 'size', asc: false },
  { sort: 'date', asc: true }, { sort: 'date', asc: false },
];

const norm = p => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export default {
  name: 'AppToolbar',
  // Bulk actions run in dialogs the toolbar does not own. Move, Merge and
  // Settings have somewhere to go already — store.ui is the shared registry of
  // which overlay is up, and those dialogs read the selection themselves — so
  // those buttons just raise the flag. Every action also emits `bulk` with the
  // intent and the selection it was made against, which is the only route
  // Favorite and Delete have until the confirm sheet is ported.
  emits: ['bulk'],
  setup(props, { emit }) {
    const route = useRoute();
    const router = useRouter();

    // The browse state spelled by the current URL — the base every patch is
    // applied to, so a sort change keeps the folder and a page change keeps the
    // search. Reading it from the route (not the store) keeps the toolbar honest
    // even while a listing is still in flight.
    const cur = computed(() => browseQuery(route, store.roots));

    // Every control ends here. page resets to 1 unless the caller is the pager,
    // matching the old loadDir(dir, 1, …) at each of these call sites.
    function go(patch) {
      router.push(browseTo({ page: 1, ...patch }, cur.value, store.roots));
    }

    // ── Path / breadcrumbs ──────────────────────────────────────────────────
    // store.crumbs splits the ABSOLUTE dir, so its first segments are the drive
    // and the server's folder layout ("D:", "ComfyRemix", "Media"). Those are
    // not places a person can navigate to — anything above a root resolves back
    // to the root anyway — so they're dropped and the root itself is shown under
    // the name it has on the home screen.
    const rootKey = computed(() => splitRoot(store.dir || '', store.roots).key);
    const rootDir = computed(() => norm(rootKey.value === 'out' ? store.roots.out : store.roots.fav));
    const rootLabel = computed(() => (rootKey.value === 'out' ? 'ComfyUI Output' : 'Favorites'));
    // store.crumbs is already root-relative and already headed by the root under
    // its home-screen name, so this is just a pass-through. Slicing it again by
    // the absolute root's segment depth ate every folder in between, leaving a
    // path bar that read "Favorites" no matter how deep you were.
    const crumbList = computed(() => crumbs.value);
    const searchLabel = computed(() => (store.search ? 'Search: ' + store.search : ''));
    const pathHome = computed(() => onHome.value);
    const showControls = computed(() => !onHome.value);

    function goCrumb(cr) { go({ dir: cr.dir, search: '' }); }

    // ── Back / home ─────────────────────────────────────────────────────────
    // The old Back replayed a hand-kept navStack. The browser's own Back does
    // that now (that is the point of putting the state in the URL), so this is
    // the other half of what the stack was used for: leave a search, else go up
    // one folder. It hides itself (see .back-btn[disabled]) at a root.
    const upDir = computed(() => {
      const { key, rel } = splitRoot(store.dir || '', store.roots);
      if (!rel) return null;                       // already at a root
      const segs = rel.split('/').filter(Boolean);
      segs.pop();
      return joinRoot(key, segs.join('/'), store.roots);
    });
    const backDisabled = computed(() => !store.search && !upDir.value);
    function back() {
      if (store.search) go({ dir: store.dir, search: '' });
      else if (upDir.value) go({ dir: upDir.value, search: '' });
    }
    function goHome() { router.push('/'); }

    // ── Blur / safe mode ────────────────────────────────────────────────────
    function toggleBlur() { setBlur(!store.blurOn); }
    function toggleSafe() { setSafe(!store.safeOn); }
    // Re-engage the blur when the tab actually becomes hidden (switched away /
    // minimised) — not when focus moves to browser chrome like the Back button.
    // Ported with the toggle it belongs to; it wants to live in the shell once
    // there is one place for privacy behaviour.
    const onVisibility = () => { if (document.hidden) setBlur(true); };

    // ── Search ──────────────────────────────────────────────────────────────
    // Typed into a local ref, pushed to the URL on a 380ms debounce. Chromium
    // ignores autocomplete="off", so the field keeps the anti-autofill hacks: a
    // random name per load defeats saved-entry suggestions, and it stays
    // readonly (against personal-data autofill) until it is actually touched.
    const q = ref(store.search || '');
    const locked = ref(true);
    const nfName = 'nf-' + Math.random().toString(36).slice(2);
    let searchTimer = null;
    const unlock = () => { locked.value = false; };

    // Route → input: Back, a crumb, or a cleared search all change the URL under
    // the box, and the text has to follow or the next keystroke resurrects it.
    watch(() => store.search, v => { if ((v || '') !== q.value.trim()) q.value = v || ''; });

    function commitSearch() {
      clearTimeout(searchTimer);
      const term = q.value.trim();
      if (term === (store.search || '')) return;
      // The flatten view has no search box in the old app; entering a search
      // leaves it rather than silently combining the two.
      const loc = browseTo({ page: 1, search: term, flatten: term ? false : cur.value.flatten },
                           cur.value, store.roots);
      // Refining a search replaces: one entry per search, not one per keystroke.
      // Entering or leaving one pushes, so Back steps out of it.
      if (store.search && term) router.replace(loc); else router.push(loc);
    }
    function onSearchInput() {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(commitSearch, 380);
    }
    function clearSearch() { q.value = ''; commitSearch(); }

    // ── Sort / filters / flatten ────────────────────────────────────────────
    function cycleSort() {
      const i = SORTS.findIndex(o => o.sort === store.sort && o.asc === store.asc);
      const next = SORTS[(i + 1) % SORTS.length];
      go({ sort: next.sort, asc: next.asc });
    }
    function toggleFilters() {
      store.filtersOpen = !store.filtersOpen;
      if (store.filtersOpen && store.multiSelect) exitMultiSelect();
    }
    function setType(t) { go({ type: t }); }
    // Recursive view of everything under this folder. It ignores the search box,
    // so entering it drops the term the way the old folder chip did.
    function toggleFlatten() { go({ flatten: !store.flatten, search: '' }); }

    // ── Root tabs ───────────────────────────────────────────────────────────
    // The old Files view's tabs, now just "which media root am I in" — the same
    // two roots the home screen offers, addressable because the root key is in
    // the URL. Hidden while searching, as before.
    const fileTabs = computed(() => [
      { id: 'out', label: 'ComfyUI Output', dir: store.roots.out },
      { id: 'fav', label: 'Favorites', dir: store.roots.fav },
    ].filter(t => t.dir).map(t => ({ ...t, active: t.id === rootKey.value })));
    const showFileTabs = computed(() => !store.search && fileTabs.value.length > 1);
    function clickTab(t) {
      if (!t.active) go({ dir: t.dir, search: '', flatten: false });
    }

    // ── Stats ───────────────────────────────────────────────────────────────
    const stats = computed(() => store.total + ' item' + (store.total !== 1 ? 's' : ''));
    const pageInfo = computed(() => (store.pages > 1 ? 'Page ' + store.page + ' / ' + store.pages : ''));

    // ── Multi-select ────────────────────────────────────────────────────────
    // Counts come from the selection crossed with the current page, replacing
    // the old count-the-checked-checkboxes DOM walk. A selected path that is not
    // on this page counts as a file: it can't be a folder we know about, and the
    // folders-only actions should stay blocked rather than silently include it.
    const byPath = computed(() => new Map(store.items.map(it => [it.path, it])));
    const selectedItems = computed(() =>
      store.items.filter(it => store.selected.has(it.path)));   // grid order
    const bulkDirCount = computed(() => selectedItems.value.filter(it => it.isDir).length);
    const bulkFileCount = computed(() => selectedCount.value - bulkDirCount.value);
    const bulkVideoCount = computed(() => selectedItems.value.filter(it => !it.isDir && it.isVideo).length);

    function toggleSelect() {
      if (store.multiSelect) exitMultiSelect();
      else { store.multiSelect = true; store.filtersOpen = false; }
    }
    function bulkSelAll() {
      const all = store.items.length > 0 && store.items.every(it => store.selected.has(it.path));
      if (all) clearSelection();
      else store.items.forEach(it => store.selected.add(it.path));
    }
    function bulkSelFiles() {
      const files = store.items.filter(it => !it.isDir);
      const all = files.length > 0 && files.every(it => store.selected.has(it.path));
      files.forEach(it => { if (all) store.selected.delete(it.path); else store.selected.add(it.path); });
    }

    // Folders sorted alphanumerically — the last one is the merge target ("2"
    // sorts before "10", matching how the listing reads). Videos keep grid order,
    // which is the order the merge dialog opens on.
    function bulk(action) {
      const paths = [...store.selected];
      if (!paths.length) { showToast('Nothing selected'); return; }
      const known = paths.map(p => byPath.value.get(p)).filter(Boolean);
      // The dialogs that exist open themselves off the store; the merge sheet
      // works out folders-vs-videos from the same selection, so both Merge
      // buttons raise the one flag.
      if (action === 'move') store.ui.move = true;
      if (action === 'merge-folders' || action === 'merge-videos') store.ui.merge = true;
      emit('bulk', {
        action, paths, items: known,
        folders: known.filter(it => it.isDir).slice().sort((a, b) => collator.compare(a.name, b.name)),
        videos: selectedItems.value.filter(it => !it.isDir && it.isVideo),
      });
    }

    // ── Prompt words ────────────────────────────────────────────────────────
    // Phrase directory: every phrase in the prompt index with how many images
    // carry it; picking one searches for it. Component-local because nothing
    // else needs it and it holds no state worth surviving a close.
    const words = ref({ open: false, loading: false, error: '', list: [], byCount: true });
    const wordFilter = ref('');
    const wordList = computed(() => {
      const f = wordFilter.value.trim().toLowerCase();
      const list = (f ? words.value.list.filter(w => String(w.t).includes(f)) : words.value.list).slice();
      list.sort(words.value.byCount
        ? (a, b) => b.n - a.n || String(a.t).localeCompare(String(b.t))
        : (a, b) => String(a.t).localeCompare(String(b.t)));
      return list;
    });
    async function openWords() {
      words.value.open = true;
      words.value.error = '';
      words.value.loading = true;
      try {
        // Pass safe mode through, or the phrase list happily offers the NSFW
        // wording that safe mode exists to keep off the screen.
        const d = await api.promptWords(store.safeOn);
        words.value.list = (d && d.words) || [];
      } catch (e) { words.value.error = e.message; }
      words.value.loading = false;
    }
    function closeWords() { words.value.open = false; }
    function pickWord(w) {
      closeWords();
      q.value = w.t;
      commitSearch();
    }

    const onKey = e => { if (e.key === 'Escape' && words.value.open) closeWords(); };

    onMounted(() => {
      document.addEventListener('visibilitychange', onVisibility);
      document.addEventListener('keydown', onKey);
    });
    onBeforeUnmount(() => {
      clearTimeout(searchTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('keydown', onKey);
    });

    return {
      store, TYPES, sortLabel, filterCount, selectedCount,
      crumbList, searchLabel, pathHome, showControls, goCrumb,
      back, backDisabled, goHome, toggleBlur, toggleSafe,
      q, locked, nfName, unlock, onSearchInput, commitSearch, clearSearch,
      cycleSort, toggleFilters, setType, toggleFlatten,
      fileTabs, showFileTabs, clickTab, stats, pageInfo,
      toggleSelect, bulkSelAll, bulkSelFiles, bulk,
      bulkDirCount, bulkFileCount, bulkVideoCount,
      words, wordFilter, wordList, openWords, closeWords, pickWord,
      // Same two lines as the shell's copy. Reload either way: on success the
      // server answers the next request with the lock screen, and on failure the
      // reload surfaces whatever state we are in.
      logout: async () => {
        try { await api.logout(); } catch {}
        location.reload();
      },
    };
  },
  template: `
    <div class="toolbar">
      <!-- Header + filter/select bars: one sticky block (see .hdr-stack) -->
      <div class="hdr-stack">
        <div class="hdr">
          <div class="hdr-path">
            <div class="path-wrap"><div class="path-txt">
              <b v-if="pathHome">Home</b>
              <b v-else-if="searchLabel">{{ searchLabel }}</b>
              <template v-else>
                <template v-for="(cr, i) in crumbList" :key="cr.dir">
                  <span v-if="i" style="color:var(--text3)"> / </span>
                  <b v-if="cr.last">{{ cr.label }}</b>
                  <span v-else style="color:var(--accent);cursor:pointer" @click="goCrumb(cr)">{{ cr.label }}</span>
                </template>
              </template>
            </div></div>
          </div>

          <div class="hdr-row1">
            <button class="back-btn" :disabled="backDisabled" @click="back">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>
              Back
            </button>
            <button class="home-btn" title="Home" @click="goHome"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h14V9.5"/><path d="M9.5 20v-5h5v5"/></svg></button>
            <button v-if="store.authEnabled" class="blur-btn" title="Log out" @click="logout">
              <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
                   stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                <polyline points="16 17 21 12 16 7"/><path d="M21 12H9"/>
              </svg>
            </button>
          </div>

          <div class="hdr-row2" v-show="showControls">
            <span class="search-wrap">
              <input class="search-inp" type="search" v-model="q" :name="nfName" :readonly="locked"
                     placeholder="Search names & prompts…" autocomplete="off" aria-autocomplete="none"
                     autocorrect="off" autocapitalize="off" spellcheck="false"
                     @touchstart.passive="unlock" @focus="unlock"
                     @input="onSearchInput" @keydown.enter.prevent="commitSearch">
              <button v-show="q" class="search-clear" title="Clear search" @click="clearSearch">✕</button>
            </span>
            <button class="sort-btn" title="Browse prompt words" @click="openWords"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px"><path d="M20.6 13.4l-7.1 7.1a2 2 0 0 1-2.8 0l-6.2-6.2A2 2 0 0 1 3.9 12.8l.5-7a1.5 1.5 0 0 1 1.4-1.4l7-.5a2 2 0 0 1 1.5.6l6.3 6.3a2 2 0 0 1 0 2.6z"/><circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none"/></svg></button>
            <button class="sort-btn" @click="cycleSort">{{ sortLabel }}</button>
          </div>
        </div>

        <!-- Filters (collapsible) + Select toggle -->
        <div class="filter-bar" v-show="showControls">
          <!-- Blur and safe mode sit with Filters and Select because that is what
               they are — view filters — not navigation like Back/Home/Settings.
               Each stays within one metaphor: the lock swaps closed for open, the
               eye swaps struck-through for plain. -->
          <button class="filter-chip" :class="{active: store.blurOn}" title="Toggle blur" @click="toggleBlur"><span v-if="store.blurOn">🔒</span><span v-else>🔓</span></button>
          <button class="filter-chip" :class="{active: store.safeOn}" title="Safe mode — hide items matching your filtered terms" @click="toggleSafe">
            <svg v-if="store.safeOn" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px"><path d="M3 3 21 21"/><path d="M10.6 10.7a2 2 0 0 0 2.7 2.9"/><path d="M6.5 6.6C4.3 8 3 10 3 12c0 0 3.5 6 9 6 1.2 0 2.3-.2 3.3-.6M9.9 5.2A9 9 0 0 1 12 5c5.5 0 9 6 9 6a15 15 0 0 1-2.2 2.9"/></svg>
            <svg v-else viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
          <button class="filter-chip" :class="{active: filterCount > 0}" title="Show type filters" @click="toggleFilters">Filters ({{ filterCount }})</button>
          <div v-show="store.filtersOpen" class="filter-group">
            <button v-for="ft in TYPES" :key="ft.t" class="filter-chip" :class="{active: store.type === ft.t}" @click="setType(ft.t)">{{ ft.label }}</button>
            <button class="filter-chip" :class="{active: store.flatten}"
                    title="Show every media file under this folder, grouped by subfolder"
                    @click="toggleFlatten">🗃 Flatten</button>
          </div>
          <!-- Doubles as the running count and as the way out: toggling off clears the
               selection, which is what the old Cancel chip did. -->
          <button v-show="!store.filtersOpen" class="filter-chip" :class="{active: store.multiSelect}"
                  :title="store.multiSelect ? 'Stop selecting and clear the selection' : 'Make items checkable'"
                  @click="toggleSelect">
            <svg v-if="store.multiSelect" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-3px"><rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M7.5 12.5l3 3 6-7" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <svg v-else viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-3px"><rect x="3.5" y="3.5" width="17" height="17" rx="4"/></svg>
            {{ store.multiSelect ? selectedCount + ' Selected' : 'Select' }}
          </button>
        </div>

        <!-- Bulk actions (revealed when Select is active) -->
        <div class="filter-bar" v-show="store.multiSelect">
          <div class="bulk-group">
            <button class="filter-chip bulk" title="Select every folder and file on this page (again to clear)" @click="bulkSelAll">All</button>
            <button class="filter-chip bulk" title="Select every file on this page, skipping folders (again to clear)" @click="bulkSelFiles">Files</button>
            <button v-show="bulkDirCount > 1" class="filter-chip bulk bulk-merge" :disabled="bulkFileCount > 0"
                    :title="bulkFileCount > 0 ? 'Merge takes folders only — deselect the ' + bulkFileCount + ' file(s)' : 'Move the contents of the selected folders into the last one (alphanumerically) and delete the empties'"
                    @click="bulk('merge-folders')">🗂 Merge {{ bulkDirCount }}</button>
            <button v-show="bulkVideoCount > 1 && bulkDirCount === 0" class="filter-chip bulk bulk-vmerge" :disabled="bulkFileCount > bulkVideoCount"
                    :title="bulkFileCount > bulkVideoCount ? 'Merge takes videos only — deselect the ' + (bulkFileCount - bulkVideoCount) + ' other file(s)' : 'Join the selected clips end to end into one new video'"
                    @click="bulk('merge-videos')">🎬 Merge {{ bulkVideoCount }}</button>
            <button class="filter-chip bulk bulk-move" :disabled="!selectedCount" title="Move the selected files and folders into another folder" @click="bulk('move')">📦 Move</button>
            <button class="filter-chip bulk bulk-fav" :disabled="bulkDirCount > 0"
                    :title="bulkDirCount > 0 ? 'Favorite takes files only — deselect the ' + bulkDirCount + ' folder(s)' : 'Move the selected files to Favorites'"
                    @click="bulk('favorite')">⭐ Fav</button>
            <button class="filter-chip bulk bulk-del" title="Delete the selected files and folders" @click="bulk('delete')">🗑 Del</button>
          </div>
        </div>
      </div><!-- /.hdr-stack -->

      <!-- Which media root you are in; hidden while searching -->
      <div class="file-tabs" v-show="showFileTabs">
        <button v-for="t in fileTabs" :key="t.id" class="file-tab" :class="{active: t.active}" @click="clickTab(t)">{{ t.label }}</button>
      </div>

      <div class="stats"><span>{{ stats }}</span><span>{{ pageInfo }}</span></div>

      <!-- Prompt word directory -->
      <div v-if="words.open" class="words-overlay" @click.self="closeWords">
        <div class="words-sheet">
          <div class="words-hdr">
            <div class="words-title">Prompt words</div>
            <span class="words-count">{{ wordList.length }} phrases</span>
            <button class="words-close" title="Close" @click="closeWords">✕</button>
          </div>
          <div class="words-tools">
            <input class="words-filter" type="search" v-model="wordFilter" placeholder="Filter…" autocomplete="off">
            <button class="sort-btn" style="white-space:nowrap" @click="words.byCount = !words.byCount">{{ words.byCount ? 'Times ↓' : 'A-Z' }}</button>
          </div>
          <div class="words-list">
            <div v-if="words.loading" class="words-empty">Loading…</div>
            <div v-else-if="words.error" class="words-error">{{ words.error }}</div>
            <div v-else-if="!wordList.length" class="words-empty">No matches</div>
            <div v-else v-for="w in wordList.slice(0, 800)" :key="w.t" class="words-row" @click="pickWord(w)">
              <span class="words-term">{{ w.t }}</span><span class="words-n">{{ w.n }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
};
