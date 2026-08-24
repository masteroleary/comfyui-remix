// ── The store ──────────────────────────────────────────────────────────────
// One reactive object for the whole app, replacing the pre-SPA arrangement of a
// plain `S` object holding the real values plus seven Vue.reactive mirrors that
// imperative code pushed into by hand. That split was the source of the standing
// "computeds read the mirror or they cache stale" trap: anything computed off `S`
// never re-evaluated, because a plain object has nothing to track.
//
// Everything below is reactive. Nothing writes to a shadow copy, and no component
// owns state another component needs — they read this.
const { reactive, computed } = window.Vue;

const num = (v, fallback) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : fallback; };
const readLs = (k, fallback) => { try { const v = localStorage.getItem(k); return v == null ? fallback : v; } catch { return fallback; } };
const writeLs = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

// The tile sizes the browse grid offers. Exported so the control that switches
// them and the guard that validates a stored one read the same list — a fourth
// size added here shows up in the switch without being named twice.
export const THUMB_SIZES = ['m', 'l', 'xl'];

// Slideshow cadence, slowest → fastest; ‹ › become − + while playing.
export const SLIDE_STEPS = [8000, 5000, 3000, 2000, 1500, 1000, 700, 500];
export const TYPES = [
  { t: 'all', label: 'All' }, { t: 'folder', label: '📁 Folders' },
  { t: 'video', label: '🎬 Videos' }, { t: 'image', label: '🖼 Images' },
  { t: 'audio', label: '🎵 Audio' },
];

export const store = reactive({
  // ── Browsing ──
  // dir/page/search/sort/type are mirrored into the URL by the router, so these
  // are set from the route rather than written directly by the grid. See router.js.
  dir: null, parent: null,
  // The two media roots, absolute. URLs carry a root key plus a relative path
  // (/browse/out/2026-08) rather than an absolute one: an absolute Windows path
  // in the address bar is unreadable, leaks the server's layout, and every
  // bookmark breaks the day mediaDir moves.
  roots: { fav: '', out: '' },
  page: 1, limit: 48, total: 0, pages: 0,
  search: '', sort: 'date', asc: false, type: 'all',
  flatten: false,           // recursive grouped view of the current dir
  items: [],                // current page, as returned
  loading: true, error: '',

  // ── Selection ──
  multiSelect: false,
  selected: new Set(),      // paths; a Set stays cheap as the page grows
  activeCard: null,         // card with its action menu open

  // ── Viewer ──
  // A route, not a flag: /view/<path> deep-links and survives a refresh. `open`
  // stays as the render switch so transitions don't have to await navigation.
  viewer: {
    open: false, item: null, idx: -1, count: 0,
    muted: true, loading: false,
    playing: false, speedIdx: num(readLs('archiveSlideSpeed', '2'), 2),
    videoPlay: readLs('archiveSlideVideoPlay', '') === '1',
    overDialog: false,
  },

  // ── Chrome ──
  blurOn: readLs('archiveBlur', '1') === '1',
  // Reset to '1' on logout, from two places: api.js's logout() covers the SPA, and
  // auth-ui.js covers inspect.html -- a plain script that cannot import from here, so
  // it spells the key out literally. Rename this and that copy silently stops working.
  safeOn: readLs('archiveSafe', '1') === '1',
  // How big the browse grid draws its tiles. Read back through the allowed set
  // rather than trusted: it comes out of localStorage, and an unknown value
  // would land as a class nothing styles — a grid of zero-width tiles.
  thumbSize: THUMB_SIZES.includes(readLs('archiveThumbSize', 'm')) ? readLs('archiveThumbSize', 'm') : 'm',
  filtersOpen: false,
  toast: { text: '', until: 0 },

  // ── Dialogs ──
  // Which overlays are up. Held centrally because a dialog can be opened from
  // several places (a card menu, the toolbar, a keyboard shortcut) and closing
  // one must not depend on which of them opened it.
  ui: {
    move: false,
    merge: false,
    picker: false,
    remix: null,            // the item being remixed, or null
    // No `jobs` here: the run list is the /jobs route, not a dialog. It was one
    // until opening an output — a navigation — tore it down and lost your place.
  },

  // ── Session ──
  authEnabled: false,       // password gate in use → show the logout control
  settings: null,           // last /api/settings payload, or null before first load
});

// Persisted chrome. Written here rather than at every call site that flips them.
export function setBlur(on) { store.blurOn = !!on; writeLs('archiveBlur', on ? '1' : '0'); }
export function setSafe(on) { store.safeOn = !!on; writeLs('archiveSafe', on ? '1' : '0'); }
export function setThumbSize(s) {
  if (!THUMB_SIZES.includes(s)) return;
  store.thumbSize = s; writeLs('archiveThumbSize', s);
}

// ── Reload hook ─────────────────────────────────────────────────────────────
// After a mutation — favourite, delete, move, merge — the route is unchanged, so
// the view that watches it has no reason to re-fetch. BrowseView registers its
// loader here and anything that changes the library calls reload().
let reloader = null;
export function registerReload(fn) {
  reloader = fn;
  // Unregister on teardown. A loader left behind fires against the route that
  // replaced it — BrowseView's, run from the viewer, builds a dir out of a file
  // path and overwrites the listing with the resulting error.
  return () => { if (reloader === fn) reloader = null; };
}
export function reload() { return reloader ? reloader() : Promise.resolve(); }
export function setSlideSpeed(i) { store.viewer.speedIdx = i; writeLs('archiveSlideSpeed', String(i)); }
export function setSlideVideoPlay(on) { store.viewer.videoPlay = !!on; writeLs('archiveSlideVideoPlay', on ? '1' : '0'); }

// ── Derived ─────────────────────────────────────────────────────────────────
// Computeds live with the state they read, so a view never recomputes a label
// the toolbar already knows how to derive.
// Listing items carry isDir/isVideo/isImage/isAudio booleans — there is no `type`
// field, so testing for one silently passes everything, folders included.
export const mediaItems = computed(() =>
  store.items.filter(i => !i.isDir && (i.isVideo || i.isImage || i.isAudio)));
export const selectedCount = computed(() => store.selected.size);
export const onHome = computed(() => store.dir == null && !store.search);
// Root-relative, and headed by the root under the name the home screen gives it.
// Splitting the absolute dir instead would lead with D: / ComfyRemix / Media —
// unclickable, and it puts the server's layout on screen.
export const crumbs = computed(() => {
  const norm = p => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const dir = norm(store.dir);
  if (!dir) return [];
  const out = norm(store.roots.out), fav = norm(store.roots.fav);
  const inOut = out && dir.toLowerCase().startsWith(out.toLowerCase());
  const base = inOut ? out : fav;
  const head = { label: inOut ? 'ComfyUI Output' : 'Favorites', dir: base, last: dir.length <= base.length };
  const rel = dir.length > base.length ? dir.slice(base.length + 1) : '';
  const parts = rel ? rel.split('/').filter(Boolean) : [];
  return [head, ...parts.map((label, i) => ({
    label,
    dir: base + '/' + parts.slice(0, i + 1).join('/'),
    last: i === parts.length - 1,
  }))];
});
export const sortLabel = computed(() => {
  const name = { date: 'Date', name: 'Name', size: 'Size' }[store.sort] || store.sort;
  return name + (store.asc ? ' ↑' : ' ↓');
});
export const filterCount = computed(() => (store.type === 'all' ? 0 : 1) + (store.flatten ? 1 : 0));

// ── Toast ───────────────────────────────────────────────────────────────────
let toastTimer = null;
export function showToast(text, ms = 2200) {
  store.toast.text = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { store.toast.text = ''; }, ms);
}

// ── Selection helpers ───────────────────────────────────────────────────────
// Set mutation is reactive in Vue 3, but replacing the Set is not required — the
// proxy tracks add/delete/clear, so callers can treat it as a plain Set.
export function toggleSelected(path) {
  if (store.selected.has(path)) store.selected.delete(path); else store.selected.add(path);
}
export function clearSelection() { store.selected.clear(); }
export function exitMultiSelect() { store.multiSelect = false; store.selected.clear(); }
