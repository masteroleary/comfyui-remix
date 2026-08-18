// ── Media browser ──────────────────────────────────────────────────────────
// The gallery a field opens to pick a file: roots, folders, a grid, multi-select.
// Lifted out of RemixDialog so the form component can raise it wherever it is
// mounted — the picker belongs to the field, not to the dialog that used to be
// the only thing rendering fields.
import { api, fileUrl, thumbUrl } from '../api.js';
import { store } from '../store.js';

const { reactive, ref, computed, watch, onMounted } = window.Vue;

// Reusable picker (search names+prompts, prompt-word directory, sort, folder
// navigation, uniform-height thumbnails). Emits 'pick' with a path or an array.
const MB_SORTS = [{ s: 'date', a: false, l: 'Newest' }, { s: 'date', a: true, l: 'Oldest' }, { s: 'name', a: true, l: 'A–Z' }, { s: 'name', a: false, l: 'Z–A' }, { s: 'size', a: false, l: 'Largest' }];
export default {
  name: 'MediaBrowser',
  props: { type: { type: String, default: 'image' }, multi: { type: Boolean, default: false } },
  emits: ['pick'],
  setup(props, { emit }) {
    // Multi-select: ticks accumulate across folder changes and searches (the pool is
    // outside `state`, which load() replaces), and Apply hands back the whole list in
    // pick order — that order becomes the order the jobs are queued in.
    const sel = reactive([]);
    const isSel = p => sel.includes(p);
    const toggleSel = (p) => { const i = sel.indexOf(p); if (i < 0) sel.push(p); else sel.splice(i, 1); };
    const clearSel = () => sel.splice(0, sel.length);
    const applySel = () => { if (sel.length) emit('pick', sel.slice()); };
    const state = reactive({ items: [], parent: null, dir: '', loading: false });
    const roots = reactive({ output: '', favorites: '' });
    const activeRoot = ref('output');
    const search = ref('');
    const sortIdx = ref(0);
    const words = reactive({ open: false, list: [], filter: '', loading: false });
    let timer = null;
    async function load(dir) {
      state.loading = true;
      try {
        // `asc` is the string 'true'/'false' on purpose — the server tests for the
        // literal 'false', so any other spelling reads as ascending.
        const so = MB_SORTS[sortIdx.value];
        const p = { limit: '200', sort: so.s, asc: so.a ? 'true' : 'false' };
        if (search.value.trim()) { p.search = search.value.trim(); p.scope = 'all'; }
        else if (dir != null) p.dir = dir;
        const r = await api.list(p);
        const t = props.type;
        state.items = (r.items || []).filter(it => it.isDir || (t === 'image' ? it.isImage : t === 'video' ? it.isVideo : it.isAudio));
        roots.output = r.comfyOutputDir || roots.output; roots.favorites = r.favoritesDir || roots.favorites;
        state.parent = r.parent; state.dir = r.dir || '';
      } catch (e) {}
      state.loading = false;
    }
    function switchRoot(which) { activeRoot.value = which; search.value = ''; load(which === 'output' ? roots.output : roots.favorites); }
    onMounted(async () => {
      // The two roots are app-wide, so take the shared copy when it is already
      // known and only pay for the discovery request when it isn't.
      if (!store.roots.out && !store.roots.fav) { try { store.roots = await api.roots(); } catch (e) {} }
      roots.output = store.roots.out || ''; roots.favorites = store.roots.fav || '';
      activeRoot.value = roots.output ? 'output' : 'favorites';
      load(activeRoot.value === 'output' ? roots.output : (roots.favorites || ''));
    });
    function onSearch() { clearTimeout(timer); timer = setTimeout(() => load(search.value.trim() ? null : state.dir), 350); }
    function clickItem(it) {
      if (it.isDir) { search.value = ''; load(it.path); return; }
      if (props.multi) toggleSel(it.path); else emit('pick', it.path);
    }
    const thumb = it => it.isVideo ? (it.thumb ? thumbUrl(it.path, it.thumbV) : '') : fileUrl(it.path, it.v);
    const dirName = computed(() => (state.dir || '').split(/[\\/]/).filter(Boolean).pop() || 'Media');
    const sortLabel = computed(() => MB_SORTS[sortIdx.value].l);
    function cycleSort() { sortIdx.value = (sortIdx.value + 1) % MB_SORTS.length; load(search.value.trim() ? null : state.dir); }
    // No safe flag: the picker lists every phrase, safe mode or not — the same
    // thing the pre-SPA page asked for as ?safe=0.
    async function openWords() { words.open = true; if (words.list.length) return; words.loading = true; try { const d = await api.promptWords(); words.list = d.words || []; } catch (e) {} words.loading = false; }
    const filteredWords = computed(() => { const f = words.filter.trim().toLowerCase(); const l = f ? words.list.filter(w => w.t.includes(f)) : words.list; return l.slice().sort((a, b) => b.n - a.n || a.t.localeCompare(b.t)).slice(0, 400); });
    function pickWord(w) { words.open = false; search.value = w.t; load(null); }
    return { state, roots, activeRoot, switchRoot, search, words, load, onSearch, clickItem, thumb, dirName, sortLabel, cycleSort, openWords, filteredWords, pickWord, sel, isSel, clearSel, applySel };
  },
  template: `
    <div class="mb">
      <div class="mb-toolbar">
        <div class="mb-roots">
          <button :class="{on: activeRoot==='output'}" @click="switchRoot('output')" :disabled="!roots.output">Output</button>
          <button :class="{on: activeRoot==='favorites'}" @click="switchRoot('favorites')" :disabled="!roots.favorites">Favorites</button>
        </div>
        <input class="rmx-inp mb-search" type="search" placeholder="Search names & prompts…" v-model="search" @input="onSearch">
        <button class="rmx-btn2" @click="openWords" title="Browse prompt words"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M20.6 13.4l-7.1 7.1a2 2 0 0 1-2.8 0l-6.2-6.2A2 2 0 0 1 3.9 12.8l.5-7a1.5 1.5 0 0 1 1.4-1.4l7-.5a2 2 0 0 1 1.5.6l6.3 6.3a2 2 0 0 1 0 2.6z"/><circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none"/></svg></button>
        <button class="rmx-btn2" @click="cycleSort" :title="'Sort: ' + sortLabel">{{ sortLabel }}</button>
        <button v-if="state.parent && !search" class="rmx-btn2" @click="load(state.parent)">↑ Up</button>
        <span class="rmx-mut" style="margin-left:auto;font-size:12px">{{ search ? 'search results' : dirName }}</span>
      </div>
      <div v-if="state.loading" class="rmx-mut" style="padding:16px">Loading…</div>
      <div v-else-if="!state.items.length" class="rmx-mut" style="padding:16px">Nothing here.</div>
      <div v-else class="mb-grid">
        <div v-for="it in state.items" :key="it.path" class="mb-cell" :class="{folder: it.isDir, sel: multi && isSel(it.path)}" @click="clickItem(it)" :title="it.name">
          <span v-if="it.isDir" class="mb-folder-ico">📁</span>
          <img v-else-if="thumb(it)" :src="thumb(it)" loading="lazy" @error="$event.target.style.visibility='hidden'">
          <span v-else class="mb-folder-ico">🎞️</span>
          <input v-if="multi && !it.isDir" type="checkbox" class="mb-tick" :checked="isSel(it.path)" @click.stop="clickItem(it)">
          <span class="mb-cap">{{ it.name }}</span>
        </div>
      </div>
      <div v-if="multi" class="mb-selbar">
        <span :class="sel.length ? '' : 'rmx-mut'">{{ sel.length }} selected</span>
        <button v-if="sel.length" class="rmx-btn2" @click="clearSel">Clear</button>
        <span class="rmx-mut" style="margin-left:auto;font-size:11.5px">Each file becomes its own job</span>
        <button class="rmx-btn2" :disabled="!sel.length" @click="applySel">Apply<span v-if="sel.length"> ({{ sel.length }})</span></button>
      </div>
      <div v-if="words.open" class="mb-words" data-backdrop @click.self="words.open=false">
        <div class="mb-words-panel">
          <input class="rmx-inp" type="search" placeholder="Filter prompt words…" v-model="words.filter" style="width:100%;margin-bottom:8px">
          <div v-if="words.loading" class="rmx-mut">Loading…</div>
          <div v-else class="mb-words-list">
            <div v-for="w in filteredWords" :key="w.t" class="mb-word" @click="pickWord(w)"><span>{{ w.t }}</span><span class="rmx-mut">{{ w.n }}</span></div>
            <div v-if="!filteredWords.length" class="rmx-mut" style="padding:12px">No matches</div>
          </div>
        </div>
      </div>
    </div>
  `,
};
