// ── Viewer ─────────────────────────────────────────────────────────────────
// The full-screen media viewer, ported from the pre-SPA ModalApp. Everything it
// used to do it still does — slideshow with its cadence ladder, Video Play,
// prev/next that walks into the adjacent page, mute, swipe, the action row and
// its tools flyout — with one structural change: it is a ROUTE, not a flag.
//
// What that buys, and what it costs:
//   * /view/<absolute path> deep-links, survives a refresh, and Back leaves the
//     viewer instead of leaving the app. The modal could do none of that.
//   * The item on screen is derived from the URL rather than assigned. Stepping
//     to the next item is a router.replace, and one watcher turns the new path
//     back into an item + index. There is no second copy of "which item" to get
//     out of step with the address bar — the trap the rewrite exists to kill.
//   * Replace, never push: a slideshow through 300 clips must not bury the grid
//     under 300 history entries.
//
// The store fields (store.viewer.*) are still written on every change, because
// they are the app-wide record of what the viewer is showing; they are derived
// here, never read back as the source of truth.
import { store, mediaItems, SLIDE_STEPS, setSlideSpeed, setSlideVideoPlay, showToast } from '../store.js';
import { api, fileUrl } from '../api.js';
import { browseTo, viewTo, joinRoot } from '../router.js';

const { ref, computed, watch, onMounted, onUnmounted, nextTick, defineAsyncComponent } = window.Vue;
const { useRoute, useRouter } = window.VueRouter;

// This view carries its own stylesheet so it is styled wherever it is reached
// from. Idempotent: the <link> in index.html wins and this no-ops.
(function injectCss() {
  const href = '/app/styles/viewer.css';
  if (document.querySelector('link[data-viewer-css], link[href="' + href + '"]')) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet'; l.href = href; l.setAttribute('data-viewer-css', '');
  document.head.appendChild(l);
})();

// Remix opens over the viewer rather than replacing it, so the dialog is a
// child here — loaded on demand, because the workflow editor and its job engine
// are far larger than the viewer and nobody pays for them until they ask.
const RemixDialog = defineAsyncComponent(() => import('../components/RemixDialog.js'));

// Paths arrive three ways — backslashed from the API, slashed from the URL, and
// slashed-but-differently-cased from either — so every comparison goes through
// here. Windows paths are case-insensitive; treating them otherwise shows the
// right file with the wrong index and breaks ‹ ›.
const norm = p => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
const same = (a, b) => !!a && !!b && norm(a).toLowerCase() === norm(b).toLowerCase();
const parentDir = p => norm(p).replace(/\/[^/]*$/, '');
const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

// Same extension sets the listing endpoint classifies by, so a deep-linked file
// that isn't in the loaded page still renders as the right kind of media.
const VIDEO_EXT = ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v'];
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'];
const AUDIO_EXT = ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg'];
function stubItem(abs) {
  const name = norm(abs).split('/').pop() || '';
  const ext = (name.split('.').pop() || '').toLowerCase();
  return {
    path: abs, name, v: 0,
    isDir: false,
    isVideo: VIDEO_EXT.includes(ext),
    isImage: IMAGE_EXT.includes(ext),
    isAudio: AUDIO_EXT.includes(ext),
  };
}

// /api/tools/last-frame reads `source`; api.js's helper posts `path`, so it
// comes back 400 "No video given". Ask through api.js first — the day that
// helper is corrected this shim stops being reached — and only send the name
// the endpoint actually reads when it refuses. (api.favorite / api.del need no
// such thing: they already post `filePath`.)
async function lastFrame(p) {
  try { return await api.lastFrame(p); }
  catch (e) {
    if (!/no video given/i.test(e.message || '')) throw e;
    const res = await fetch('/api/tools/last-frame', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: p }),
    });
    if (res.status === 401) { location.reload(); throw new Error('Locked'); }
    let data = null;
    try { data = JSON.parse(await res.text()); } catch {}
    if (!res.ok || (data && data.error)) throw new Error((data && data.error) || ('HTTP ' + res.status));
    return data;
  }
}

// ── Tools ──────────────────────────────────────────────────────────────────
// One list, so adding a tool is one entry. `applies` decides whether it's live
// for the item on screen and `why` explains it when it isn't — a disabled entry
// that says "Videos only" beats a menu that silently hides half its items.
const MEDIA_TOOLS = [{
  id: 'last-frame',
  icon: '🎞',
  label: 'Last frame → clips',
  sub: 'Save the final frame as a PNG in ComfyUI\'s clips folder',
  busy: 'Extracting frame…',
  applies: it => !!it.isVideo,
  why: 'Videos only',
  run: async it => '🎞 Saved ' + (await lastFrame(it.path)).rel,
}];

export default {
  name: 'ViewerView',
  components: { RemixDialog },
  props: {
    root: { type: String, default: 'fav' },
    path: { type: [Array, String], default: () => [] },
  },
  setup(props) {
    const route = useRoute();
    const router = useRouter();
    const vid = ref(null);
    const toolsEl = ref(null);
    const toolsOpen = ref(false);
    const toolRunning = ref('');
    const ask = ref(null);        // pending confirm: { title, msg, okLabel, okClass, run }

    // ── What we're looking at ────────────────────────────────────────────
    // The URL is the truth. `list` is the media-only slice of the loaded page,
    // and the index is a lookup into it rather than a number we carry around.
    // The URL carries a root key and a relative path; the server speaks absolute
    // paths, so this is where the two meet.
    const abs = computed(() => {
      const rel = Array.isArray(props.path) ? props.path.join('/') : String(props.path || '');
      return joinRoot(props.root || 'fav', rel, store.roots);
    });
    // mediaItems filters on a `type` field the listing doesn't send (see the
    // report); the isDir/isVideo/isImage/isAudio booleans it does send are what
    // decides whether an item is something the viewer can page onto.
    const list = computed(() => mediaItems.value.filter(i => !i.isDir && (i.isVideo || i.isImage || i.isAudio)));
    const idx = computed(() => list.value.findIndex(m => same(m.path, abs.value)));
    const count = computed(() => list.value.length);
    // A deep-linked file (or one whose page hasn't arrived yet) still has to
    // render. Hold a stand-in built from the path until the listing supplies
    // the real item — rebuilt only when the path changes, or the <video> would
    // be torn down and restarted on every unrelated store write.
    const held = ref(stubItem(abs.value));
    watch(abs, v => { held.value = stubItem(v); });
    const cur = computed(() => (idx.value >= 0 ? list.value[idx.value] : held.value));

    const src = computed(() => (cur.value ? fileUrl(cur.value.path, cur.value.v) : ''));

    // Mirror into the store: other views read what the viewer is showing there.
    watch([cur, idx, count], () => {
      store.viewer.item = cur.value;
      store.viewer.idx = idx.value;
      store.viewer.count = count.value;
    }, { immediate: true });

    // ── Reach ────────────────────────────────────────────────────────────
    // ‹ › are live at the edges of the page too: there may be another page to
    // walk into. page/pages come from the listing, which is why the pre-SPA
    // viewer had to mirror them by hand.
    const hasPrev = computed(() => idx.value > 0 || store.page > 1);
    const hasNext = computed(() => idx.value < count.value - 1 || store.page < store.pages);
    const canPlay = computed(() => count.value > 1 || store.pages > 1);
    const speedIdx = computed(() => clamp(store.viewer.speedIdx, 0, SLIDE_STEPS.length - 1));
    const canSlower = computed(() => speedIdx.value > 0);
    const canFaster = computed(() => speedIdx.value < SLIDE_STEPS.length - 1);
    const speedLabel = computed(() => (SLIDE_STEPS[speedIdx.value] / 1000).toFixed(1) + 's');
    // While a clip plays out, the interval isn't what's driving the slideshow.
    const onVideo = computed(() => store.viewer.playing && store.viewer.videoPlay && !!(cur.value && cur.value.isVideo));

    // ── Listing ──────────────────────────────────────────────────────────
    // Same params BrowseView sends, deliberately: the viewer pages through the
    // grid's list, and a listing built from different params would step through
    // a different set of files than the grid behind it shows.
    async function loadPage(p, dirOverride) {
      const dir = dirOverride || store.dir || parentDir(abs.value);
      const data = await api.list({
        dir: dir || '', page: p, limit: store.limit,
        search: store.search, sort: store.sort,
        // '0' reads as ascending to the server (it tests `asc !== 'false'`), so
        // the viewer paged through a differently-ordered list than the grid.
        asc: store.asc ? 'true' : 'false',
        type: store.type, flatten: store.flatten ? '1' : '0',
        safe: store.safeOn ? '1' : '0',
      });
      store.items = data.items || [];
      store.total = data.total || 0;
      store.pages = data.pages || 1;
      store.page = data.page || p;
      store.dir = dir;
      store.parent = data.parent ?? store.parent;
      if (data.favoritesDir || data.comfyOutputDir) {
        store.roots = { fav: data.favoritesDir || store.roots.fav, out: data.comfyOutputDir || store.roots.out };
      }
      return data;
    }

    // ── Stepping ─────────────────────────────────────────────────────────
    // Awaitable, and that matters: the modal moved by assigning `item`, so the
    // caller could read the result on the next line. Here the move is a
    // navigation, and callers like the slideshow ask "did we actually land
    // somewhere new?" straight afterwards. Wait for the route AND the render
    // that follows it, or every such check reads the item we just left.
    async function show(i) {
      const it = list.value[i];
      if (!it || same(it.path, abs.value)) return;
      // viewTo answers null for a path under neither root; replace(null) would
      // throw into the catch below and read as a failed navigation.
      const to = viewTo(it.path, store.roots);
      if (!to) { console.warn('[viewer] no route for', it.path); return; }
      try { await router.replace(to); }
      catch (e) { console.warn('[viewer] navigation failed', e); return; }
      await nextTick();
    }

    let navBusy = false;
    async function nav(delta) {
      const ni = idx.value + delta;
      if (ni >= 0 && ni < count.value) { await show(ni); return; }
      if (navBusy) return;
      navBusy = true;
      store.viewer.loading = true;
      try { await navPage(delta); }
      finally { navBusy = false; store.viewer.loading = false; }
    }

    // Walk pages in `delta`'s direction until one has media to show; pages
    // holding only folders are skipped. If the direction runs dry we return to
    // the page we started on, still showing the same item.
    async function navPage(delta) {
      const fromPage = store.page, fromPath = cur.value ? cur.value.path : null;
      for (let p = fromPage + delta; p >= 1 && p <= (store.pages || 1); p += delta) {
        try { await loadPage(p); }
        catch (e) { showToast('Could not load page ' + p + ': ' + e.message); break; }
        if (!store.viewer.open) return;   // closed mid-load — leave the grid where it landed
        if (!count.value) continue;
        await show(delta > 0 ? 0 : count.value - 1);
        window.scrollTo(0, 0);
        return;
      }
      if (store.page !== fromPage) {
        try { await loadPage(fromPage); } catch {}
        const back = list.value.findIndex(m => same(m.path, fromPath));
        if (back >= 0) await show(back);
      }
    }

    // ── Slideshow ────────────────────────────────────────────────────────
    // Auto-advance through the list, wrapping from the last item back to the
    // first. In a flattened / searched view the whole list is one page, so the
    // loop covers every file under the folder; browsing normally it walks page
    // by page like ‹ › do. Self-scheduling timeout (not setInterval) so a slow
    // page fetch can't stack up ticks.
    let slideTimer = null, slideGuard = null;
    // Video Play: hold on a clip until it ends instead of ticking through it.
    // The <video> loses its `loop` while we wait, so `ended` actually fires.
    const waitsForVideo = () => store.viewer.playing && store.viewer.videoPlay && !!(cur.value && cur.value.isVideo);
    // Is the <video> on screen the current item's, and already rolling?
    const videoRolling = () => {
      const el = vid.value;
      return !!(el && !el.paused && !el.ended && el.getAttribute('src') === src.value);
    };
    function slideSchedule() {
      clearTimeout(slideTimer); slideTimer = null;
      clearTimeout(slideGuard); slideGuard = null;
      if (!store.viewer.playing) return;
      if (waitsForVideo()) {
        // A clip that's already running reports `ended` on its own, however
        // long it is. Only guard the case where nothing ever starts (blocked
        // autoplay, dead file) so the slideshow can't be stranded on it —
        // @playing clears it.
        if (!videoRolling()) slideGuard = setTimeout(() => { if (waitsForVideo()) slideTick(); }, 10000);
        return;
      }
      slideTimer = setTimeout(slideTick, SLIDE_STEPS[speedIdx.value]);
    }
    async function slideTick() {
      if (!store.viewer.playing || !store.viewer.open) return;
      await slideAdvance();
      if (store.viewer.playing && store.viewer.open) slideSchedule();
    }
    function slideStart() { if (!store.viewer.playing) { store.viewer.playing = true; slideSchedule(); } }
    function slideStop() {
      store.viewer.playing = false;
      clearTimeout(slideTimer); slideTimer = null;
      clearTimeout(slideGuard); slideGuard = null;
    }
    function toggleVideoPlay() {
      setSlideVideoPlay(!store.viewer.videoPlay);
      slideSchedule();   // switch between "wait for `ended`" and the interval
    }
    // delta > 0 = faster (shorter interval). Restarts the pending tick at the
    // new pace, so a change is felt now rather than after the current wait.
    function slideSpeed(delta) {
      const ni = speedIdx.value + delta;
      if (ni < 0 || ni >= SLIDE_STEPS.length) return;
      setSlideSpeed(ni);
      slideSchedule();
    }
    async function slideAdvance() {
      if (idx.value + 1 < count.value) { await show(idx.value + 1); return; }
      if (store.page < (store.pages || 1)) {
        const before = cur.value ? cur.value.path : null;
        await nav(1);
        // Every page ahead held only folders — nav put us back where we were.
        if (store.viewer.open && cur.value && same(cur.value.path, before)) await slideWrap();
        return;
      }
      await slideWrap();
    }
    // Back to the very first item of the list.
    async function slideWrap() {
      if (store.page === 1 || (store.pages || 1) <= 1) { if (count.value) await show(0); return; }
      if (navBusy) return;
      navBusy = true;
      store.viewer.loading = true;
      try {
        await loadPage(1);
        if (!store.viewer.open) return;
        if (count.value) { await show(0); window.scrollTo(0, 0); }
        else await navPage(1);   // page 1 holds only folders — walk forward
      } catch (e) {
        showToast('Could not restart the slideshow: ' + e.message);
      } finally { navBusy = false; store.viewer.loading = false; }
    }

    // ── Leaving ──────────────────────────────────────────────────────────
    // Back where there is somewhere to go back to, so the viewer behaves like
    // the overlay it replaced. Opened cold from a bookmark there is no history
    // to unwind, and dropping the user on a blank tab would be worse than
    // showing them the folder the file lives in.
    // Guards a double Esc mid-navigation. It has to be cleared when the viewer
    // lands on a file again, because /view/A → /view/B reuses this component
    // rather than remounting it: left set, the next ✕ or Esc did nothing at all
    // and the viewer could not be closed for the rest of the session.
    let leaving = false;
    watch(() => route.fullPath, () => { leaving = false; });
    function close() {
      if (leaving) return;
      leaving = true;
      slideStop();
      if (window.history.state && window.history.state.back) router.back();
      else router.push(browseTo({ dir: store.dir || parentDir(abs.value) }, null, store.roots));
    }

    // ── Media ────────────────────────────────────────────────────────────
    function toggleMute() {
      store.viewer.muted = !store.viewer.muted;
      if (vid.value) vid.value.muted = store.viewer.muted;
    }
    // Clicking the media stops a running slideshow (the speed is kept for the
    // next ▶); with nothing playing the click is left to the media itself.
    function onMediaClick() { if (store.viewer.playing) slideStop(); }
    function onVideoPlaying() { clearTimeout(slideGuard); slideGuard = null; }
    function onVideoEnd() { if (waitsForVideo()) slideTick(); }
    function onVideoError() { if (waitsForVideo()) slideTick(); }   // unplayable file: move on

    // While the slideshow runs, ‹ › drive the cadence instead of the position.
    function prev() { if (store.viewer.playing) slideSpeed(-1); else nav(-1); }
    function next() { if (store.viewer.playing) slideSpeed(1); else nav(1); }
    function togglePlay() { if (store.viewer.playing) slideStop(); else slideStart(); }

    // Swipe walks the gallery, but these handlers sit on the viewer root and
    // anything opened over it still bubbles up here. Panning a lora list or a
    // wide row inside Remix was stepping the file underneath. gestureBlocked is
    // declared further down, after `remixing` exists.
    let touchX = null;
    function onTouchStart(e) {
      // null, not 0: a gesture that STARTS while a dialog is up must not become
      // a swipe if the dialog closes mid-drag.
      touchX = gestureBlocked.value ? null : e.touches[0].clientX;
    }
    function onTouchEnd(e) {
      if (touchX === null || gestureBlocked.value) return;
      const dx = e.changedTouches[0].clientX - touchX;
      touchX = null;
      if (Math.abs(dx) > 55) { if (dx > 0) prev(); else next(); }
    }

    // ── Actions ──────────────────────────────────────────────────────────
    // Where the inspector lives for this file. The viewer no longer offers it
    // as a button — Remix is the way in, and the workflow half of the inspector
    // is reached from the Workflows page — but the fallback below still needs a
    // route to send you to when the dialog's module will not load.
    const inspectTo = it => ({
      path: '/inspect',
      query: { path: it.path, name: it.name, type: it.isVideo ? 'video' : it.isImage ? 'image' : 'audio' },
    });

    // Remix hands this file to the workflow dialog, which opens OVER the viewer
    // (.rmx-overlay is z-index 3000 to the viewer's 200) and closes back to it —
    // the pre-SPA viewer had to take itself down first because it sat above the
    // whole dialog stack. The video is paused rather than dropped so closing the
    // dialog doesn't restart a long clip from the top.
    const remixing = ref(false);
    // Every overlay that can sit above the viewer. Declared here rather than
    // beside the touch handlers so it comes after `remixing` — a computed body
    // is lazy, so the other order happens to work, which is exactly the kind of
    // thing that stops working when someone reads it during setup.
    const gestureBlocked = computed(() => remixing.value || toolsOpen.value || !!ask.value);
    async function remix() {
      const it = cur.value;
      if (!it) return;
      slideStop();
      if (vid.value) { try { vid.value.pause(); } catch {} }
      // The dialog is mid-port by another hand. If its module won't load, fall
      // back to the standalone inspector — the same fallback the pre-SPA page
      // used when the remix script wasn't there — rather than a dead button.
      try { await import('../components/RemixDialog.js'); remixing.value = true; }
      catch (e) {
        console.warn('[viewer] remix dialog unavailable', e);
        router.push(inspectTo(it));
      }
    }

    function askFav() {
      const it = cur.value; if (!it) return;
      slideStop();
      ask.value = {
        title: 'Add to Favorites',
        msg: 'Move "' + it.name + '" to the Favorites folder?',
        okLabel: '⭐ Move', okClass: 'btn-fav',
        run: () => act('fav', it),
      };
    }
    function askDel() {
      const it = cur.value; if (!it) return;
      slideStop();
      ask.value = {
        title: 'Delete File',
        msg: 'Permanently delete "' + it.name + '"? This cannot be undone.',
        okLabel: '🗑 Delete', okClass: '',
        run: () => act('del', it),
      };
    }
    // The sheet closes before the work starts, and the item it was raised for
    // travels in the closure: confirming acts on the file the question named,
    // never on whatever happens to be on screen when the answer arrives.
    function confirmOk() {
      const a = ask.value;
      ask.value = null;
      if (a) a.run();
    }
    async function act(kind, it) {
      try {
        await (kind === 'fav' ? api.favorite(it.path) : api.del(it.path));
        showToast(kind === 'fav' ? '⭐ Moved to Favorites' : '🗑 Deleted');
        await afterRemoval(it.path);
      } catch (e) { showToast('Error: ' + e.message); }
    }
    // The item on screen was just favorited/deleted: stay open and show the one
    // that slid into its slot (the next), falling back to the previous at the
    // end of the list. Closes only when nothing is left.
    async function afterRemoval(p) {
      const at = idx.value;
      const gi = store.items.findIndex(i => same(i.path, p));
      if (gi < 0) {
        // Not on the loaded page — the list can't be advanced safely, so
        // refresh it and step out rather than guess.
        try { await loadPage(store.page); } catch {}
        close();
        return;
      }
      store.items.splice(gi, 1);
      if (store.total > 0) store.total--;
      if (!count.value) { close(); return; }
      await show(clamp(at < 0 ? 0 : at, 0, count.value - 1));
    }

    // ── Tools flyout ─────────────────────────────────────────────────────
    const tools = computed(() => MEDIA_TOOLS.map(t => ({ ...t, ok: !!cur.value && t.applies(cur.value) })));
    async function pickTool(t) {
      if (toolRunning.value || !cur.value) return;
      toolRunning.value = t.id;
      toolsOpen.value = false;
      showToast(t.busy, 60000);
      try { showToast(await t.run(cur.value)); }
      catch (e) { showToast('✕ ' + t.label + ' failed: ' + e.message, 4000); }
      finally { toolRunning.value = ''; }
    }
    function onDocDown(e) {
      if (toolsOpen.value && toolsEl.value && !toolsEl.value.contains(e.target)) toolsOpen.value = false;
    }

    // ── Keyboard ─────────────────────────────────────────────────────────
    function onKey(e) {
      if (!store.viewer.open) return;
      if (remixing.value) return;   // the dialog on top owns the keyboard
      if (e.key === 'Escape') {
        // Innermost thing first: the flyout, then the confirm sheet, then the
        // viewer. Esc closing all three at once is how you delete by accident.
        if (toolsOpen.value) { toolsOpen.value = false; e.stopPropagation(); e.preventDefault(); return; }
        if (ask.value) { ask.value = null; e.preventDefault(); return; }
        close();
        return;
      }
      if (ask.value) return;
      // Arrows mirror the on-screen ‹ ›: position normally, speed while playing.
      if (e.key === 'ArrowLeft') { store.viewer.playing ? slideSpeed(-1) : nav(-1); return; }
      if (e.key === 'ArrowRight') { store.viewer.playing ? slideSpeed(1) : nav(1); return; }
      // Space toggles play, unless the browser is already using it (focused control).
      if (e.key === ' ' && !/^(VIDEO|AUDIO|INPUT|TEXTAREA|BUTTON|SELECT)$/.test(e.target.tagName || '')) {
        e.preventDefault();
        store.viewer.playing ? slideStop() : slideStart();
      }
    }

    // Censor / hide: the shell re-engages the blur when the tab actually goes
    // away (switched away / minimized); the viewer's own half of that is to
    // close, so coming back shows the censored grid rather than a full-screen
    // image. Not while Remix is open over it — that would take the dialog, and
    // whatever is queued in it, down with the viewer.
    function onVisibility() {
      if (document.hidden && !remixing.value) close();
    }

    // ── Lifecycle ────────────────────────────────────────────────────────
    store.viewer.open = true;
    store.viewer.overDialog = false;
    store.viewer.loading = false;
    if (!(store.viewer.speedIdx >= 0 && store.viewer.speedIdx < SLIDE_STEPS.length)) setSlideSpeed(2);

    onMounted(async () => {
      document.body.style.overflow = 'hidden';
      document.addEventListener('keydown', onKey, true);
      document.addEventListener('mousedown', onDocDown, true);
      document.addEventListener('touchstart', onDocDown, true);
      document.addEventListener('visibilitychange', onVisibility);

      // Entered cold (bookmark, refresh, a link from elsewhere): there is no
      // loaded page behind us, so ‹ › would have nothing to step through.
      // Fetch the folder this file lives in and page from there.
      if (idx.value < 0) {
        if (!store.roots.fav) { try { store.roots = await api.roots(); } catch {} }
        store.viewer.loading = true;
        try { await loadPage(store.page || 1, parentDir(abs.value)); }
        catch (e) { showToast('Could not list this folder: ' + e.message); }
        finally { store.viewer.loading = false; }
      }
    });

    onUnmounted(() => {
      slideStop();
      store.viewer.open = false;
      store.viewer.item = null;   // drops the media element, stopping playback
      store.viewer.idx = -1;
      store.viewer.count = 0;
      document.body.style.overflow = '';
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDocDown, true);
      document.removeEventListener('touchstart', onDocDown, true);
      document.removeEventListener('visibilitychange', onVisibility);
    });

    return {
      store, cur, src, abs,
      hasPrev, hasNext, canPlay, canSlower, canFaster, speedLabel, onVideo,
      prev, next, togglePlay, toggleVideoPlay, toggleMute, close,
      onMediaClick, onVideoPlaying, onVideoEnd, onVideoError,
      onTouchStart, onTouchEnd,
      remix, remixing, askFav, askDel, ask, confirmOk,
      tools, toolsOpen, toolRunning, toolsEl, pickTool,
      vid,
    };
  },
  template: `
    <div class="viewer" :class="{ 'over-dialog': store.viewer.overDialog }"
         @click.self="close" @touchstart.passive="onTouchStart" @touchend.passive="onTouchEnd">

      <div class="viewer-actions">
        <button v-if="cur && (cur.isImage || cur.isVideo)" class="viewer-act-btn m-remix" @click="remix" title="Remix this file">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" style="vertical-align:-2px"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg> Remix
        </button>

        <div v-if="cur" class="tools-wrap" ref="toolsEl">
          <button class="viewer-act-btn m-tools" :class="{ on: toolsOpen }" @click.stop="toolsOpen = !toolsOpen" title="Tools for this file">
            🛠 Tools <span style="font-size:9px;opacity:.7">{{ toolsOpen ? '▲' : '▼' }}</span>
          </button>
          <div v-if="toolsOpen" class="tools-menu" @click.stop>
            <button v-for="t in tools" :key="t.id" class="tools-item"
                    :disabled="!t.ok || !!toolRunning" :title="t.ok ? t.sub : t.why" @click="pickTool(t)">
              <span>{{ t.icon }}</span>
              <span class="t-txt">{{ t.label }}<span class="t-sub">{{ t.ok ? t.sub : t.why }}</span></span>
            </button>
          </div>
        </div>
        <button class="viewer-act-btn m-fav" @click="askFav">⭐ Fav</button>
        <button class="viewer-act-btn m-del" @click="askDel">🗑 Del</button>
      </div>

      <button class="viewer-close" @click="close">✕</button>

      <button class="viewer-nav viewer-prev"
              :disabled="store.viewer.playing ? !canSlower : (!hasPrev || store.viewer.loading)"
              :title="store.viewer.playing ? 'Slower' : 'Previous'"
              @click="prev">{{ store.viewer.playing ? '−' : '‹' }}</button>

      <div class="viewer-ctl">
        <div class="viewer-ctl-side is-left">
          <button v-if="cur && cur.isVideo" class="viewer-nav viewer-mute" @click="toggleMute">{{ store.viewer.muted ? '🔇' : '🔊' }}</button>
          <span class="viewer-speed" :class="{ on: store.viewer.playing, waiting: onVideo }">{{ speedLabel }}</span>
        </div>
        <button class="viewer-nav viewer-play" :class="{ on: store.viewer.playing }" :disabled="!canPlay"
                :title="store.viewer.playing ? 'Stop slideshow' : 'Play slideshow'"
                @click="togglePlay">{{ store.viewer.playing ? '⏸' : '▶' }}</button>
        <div class="viewer-ctl-side is-right">
          <button class="viewer-chip" :class="{ on: store.viewer.videoPlay }" @click="toggleVideoPlay"
                  title="Let videos play to the end before the slideshow advances"><span class="chip-emoji">🎬</span>Video Play</button>
        </div>
      </div>

      <button class="viewer-nav viewer-next"
              :disabled="store.viewer.playing ? !canFaster : (!hasNext || store.viewer.loading)"
              :title="store.viewer.playing ? 'Faster' : 'Next'"
              @click="next">{{ store.viewer.playing ? '+' : '›' }}</button>

      <div class="viewer-body" @click="onMediaClick">
        <video v-if="cur && cur.isVideo" ref="vid" :key="cur.path" :src="src" controls playsinline autoplay
               :loop="!onVideo" @loadstart="$event.target.muted = store.viewer.muted"
               @playing="onVideoPlaying" @ended="onVideoEnd" @error="onVideoError"></video>
        <img v-else-if="cur && cur.isImage" :key="cur.path" :src="src" :alt="cur.name">
        <div v-else-if="cur && cur.isAudio" class="viewer-audio">
          <div style="font-size:64px">🎵</div>
          <audio :key="cur.path" :src="src" controls autoplay></audio>
        </div>
        <div v-else class="viewer-missing">Nothing to show for<br>{{ abs }}</div>
      </div>

      <div class="viewer-label">{{ cur ? cur.name : '' }}</div>

      <remix-dialog v-if="remixing" :item="cur" @close="remixing = false"></remix-dialog>

      <div v-if="ask" class="viewer-confirm" @click.self="ask = null">
        <div class="viewer-confirm-sheet">
          <div class="viewer-confirm-title">{{ ask.title }}</div>
          <div class="viewer-confirm-msg">{{ ask.msg }}</div>
          <div class="viewer-confirm-btns">
            <button class="btn-cancel" @click="ask = null">Cancel</button>
            <button class="btn-ok" :class="ask.okClass" @click="confirmOk">{{ ask.okLabel }}</button>
          </div>
        </div>
      </div>
    </div>
  `,
};
