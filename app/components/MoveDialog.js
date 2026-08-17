// ── Move dialog ────────────────────────────────────────────────────────────
// Moves the selected files and folders into a destination picked from a lazily
// expanded tree (/api/dirs, one level per disclosure) so a deep library is never
// walked up front. Works on any mix of files and folders.
//
// The tree rows are a component that recurses into itself. Selection, the
// can't-move-into-itself rule and the New Folder plumbing are provided to that
// subtree rather than drilled through props, so a row twelve levels down reads
// the same state the sheet does.
import { store, showToast, exitMultiSelect } from '../store.js';
import { api } from '../api.js';

const { reactive, computed, provide, inject, watch, nextTick, ref, onBeforeUnmount } = window.Vue;

const npath = s => String(s || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

// One level of the tree. api.dirs() covers the root call; children need the
// `dir` parameter the helper doesn't take, so they go direct — keeping the 404
// message the pre-SPA page carried, because a server that predates /api/dirs
// answers in plain text and "HTTP 404" is a useless thing to show for
// "restart the server".
async function fetchLevel(dir) {
  const res = await fetch('/api/dirs?dir=' + encodeURIComponent(dir), { credentials: 'same-origin' });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  if (!data) {
    if (res.status === 404) throw new Error('Server is out of date — restart it to pick up /api/dirs');
    throw new Error('HTTP ' + res.status + ': ' + text.slice(0, 120));
  }
  if (data.error) throw new Error(data.error);
  return data;
}
async function fetchDirs(dir) {
  const r = dir ? await fetchLevel(dir) : await api.dirs();
  return (r.dirs || []).map(d => ({
    name: d.name, path: d.path, hasChildren: d.hasChildren,
    children: null, open: false, loading: false,
  }));
}

const DirNode = {
  name: 'DirNode',
  props: { node: { type: Object, required: true }, depth: { type: Number, default: 0 } },
  setup(props) {
    const ctx = inject('moveTree');
    const picked = computed(() => !!ctx.state.selected && npath(ctx.state.selected) === npath(props.node.path));
    const blocked = computed(() => ctx.blocked(props.node.path));
    // The caret owns expand/collapse; the rest of the row owns selection.
    const caret = e => { e.stopPropagation(); ctx.toggle(props.node); };
    const pick = () => { if (!blocked.value) ctx.state.selected = props.node.path; };
    return { picked, blocked, caret, pick };
  },
  template: `
    <div>
      <div class="tree-row" :class="{ sel: picked, dis: blocked }" :style="{ paddingLeft: (10 + depth * 16) + 'px' }"
           <!-- No apostrophe: the escape resolves before the compiler sees it, so
                'Can\'t' ends the expression's string literal and the whole
                component fails to compile. -->
           :title="blocked ? 'Cannot move a folder into itself' : node.path" @click="pick">
        <span class="tree-caret" :class="{ open: node.open }" @click="caret">
          <span v-if="node.loading" class="tree-spin"></span>
          <svg v-else-if="node.hasChildren" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor"
               stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 5 16 12 9 19"/></svg>
        </span>
        <span class="tree-emoji">{{ node.open ? '📂' : '📁' }}</span>
        <span class="tree-label">{{ node.name }}</span>
      </div>
      <div v-if="node.open && node.children">
        <dir-node v-for="ch in node.children" :key="ch.path" :node="ch" :depth="depth + 1"></dir-node>
      </div>
    </div>
  `,
};

export default {
  name: 'MoveDialog',
  components: { DirNode },
  // `items` is optional: with nothing passed the dialog takes a snapshot of the
  // current selection, which is what every caller wants. Passing it explicitly
  // is for a one-off move that isn't the selection.
  props: {
    open: { type: Boolean, default: false },
    items: { type: Array, default: null },
  },
  emits: ['close', 'done'],
  setup(props, { emit }) {
    const s = reactive({
      items: [], roots: [], selected: null,
      loading: false, busy: false, err: '',
      mkOpen: false, mkName: '', mkBusy: false,   // inline "New Folder" prompt
    });
    const mkInput = ref(null);

    // Selection is a Set of paths; isDir and the display name come from the
    // listing where the path is on the current page, and from the path itself
    // where it isn't (a selection can outlive a page change).
    function snapshot() {
      if (props.items) return props.items.map(i => ({ path: i.path, isDir: !!i.isDir, name: i.name || '' }));
      const byPath = new Map(store.items.map(i => [i.path, i]));
      return Array.from(store.selected).map(p => {
        const it = byPath.get(p);
        return {
          path: p,
          // Unknown (selected on an earlier page) counts as a folder: blocked()
          // only guards entries with isDir, so guessing "file" would quietly
          // offer a folder as its own destination and the server would refuse.
          isDir: it ? !!it.isDir : true,
          name: (it && it.name) || String(p).split(/[\\/]/).pop(),
        };
      });
    }

    // A folder can't be moved into itself or into one of its own descendants.
    const blocked = p => {
      const t = npath(p);
      return s.items.some(it => it.isDir && (t === npath(it.path) || t.startsWith(npath(it.path) + '/')));
    };

    async function expand(node) {
      if (node.children) { node.open = true; return; }
      node.loading = true;
      try { node.children = await fetchDirs(node.path); node.open = true; }
      catch (e) { s.err = e.message; }
      finally { node.loading = false; }
    }
    const toggle = node => { if (node.open) node.open = false; else expand(node); };

    // Open the branch leading to the folder being browsed, so the tree lands
    // with the user's current location already in view. Nothing is pre-selected
    // — "move here" into the folder you're already in would be a no-op.
    async function revealCurrent() {
      const cur = npath(store.dir);
      if (!cur) return;
      let level = s.roots;
      for (let depth = 0; depth < 32; depth++) {
        const node = level.find(nd => cur === npath(nd.path) || cur.startsWith(npath(nd.path) + '/'));
        if (!node) return;
        await expand(node);
        if (cur === npath(node.path) || !node.children || !node.children.length) return;
        level = node.children;
      }
    }

    // Walk roots + loaded children for the node at `p` (the tree is sparse, so a
    // collapsed branch simply isn't there — callers treat null as nothing to patch).
    function findNode(p) {
      const t = npath(p);
      const walk = list => {
        for (const nd of list || []) {
          if (npath(nd.path) === t) return nd;
          const hit = nd.children ? walk(nd.children) : null;
          if (hit) return hit;
        }
        return null;
      };
      return walk(s.roots);
    }

    function init() {
      s.items = snapshot();
      s.selected = null;
      s.err = '';
      s.busy = false;
      s.mkOpen = false;
      s.mkName = '';
      s.mkBusy = false;
      s.roots = [];
      s.loading = true;
      fetchDirs('')
        .then(async roots => { s.roots = roots; await revealCurrent(); })
        .catch(e => { s.err = e.message; })
        .finally(() => { s.loading = false; });
    }
    watch(() => props.open, isOpen => { if (isOpen) init(); }, { immediate: true });

    function close() { if (!s.busy) emit('close'); }

    // ── New Folder: create inside the highlighted destination ──
    function mkOpen() {
      if (!s.selected || s.busy) return;
      s.mkName = '';
      s.err = '';
      s.mkOpen = true;
      nextTick(() => { if (mkInput.value) { mkInput.value.focus(); mkInput.value.select(); } });
    }
    function mkCancel() { if (!s.mkBusy) { s.mkOpen = false; s.mkName = ''; } }
    async function mkCreate() {
      const parent = s.selected;
      const name = s.mkName.trim();
      if (!parent || s.mkBusy) return;
      // Mirrors the server's rule so a typo is caught before the round trip.
      if (!/^[A-Za-z0-9][A-Za-z0-9 -]*$/.test(name)) {
        s.err = name ? 'Use letters, numbers, spaces and dashes only' : 'Folder name is required';
        return;
      }
      s.mkBusy = true; s.err = '';
      try {
        const r = await api.mkdir(parent, name);
        const pn = findNode(parent);
        if (pn) {
          pn.hasChildren = true;
          if (pn.children) {
            pn.children.push({ name: r.name, path: r.path, hasChildren: false, children: [], open: false, loading: false });
            pn.children.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
            pn.open = true;
          } else {
            await expand(pn);      // first expand pulls the new folder in with its siblings
          }
        }
        s.selected = r.path;       // land on the folder you just made
        s.mkOpen = false;
        s.mkName = '';
        showToast('📁 Created "' + r.name + '"');
      } catch (e) {
        s.err = e.message;
      } finally {
        s.mkBusy = false;
      }
    }

    async function confirmMove() {
      if (!s.selected || s.busy) return;
      s.busy = true; s.err = '';
      try {
        const r = await api.move(s.items.map(i => i.path), s.selected);
        showToast('📦 Moved ' + r.moved + ' item(s)' +
          (r.skipped ? ' — ' + r.skipped + ' already there' : '') +
          (r.errors && r.errors.length ? ' — ' + r.errors.length + ' failed' : ''));
        if (r.errors && r.errors.length) console.warn('[move] partial failures:', r.errors);
        emit('done', { paths: s.items.map(i => i.path), target: s.selected, moved: r.moved });
        exitMultiSelect();
        emit('close');
      } catch (e) {
        s.err = e.message;
      } finally {
        s.busy = false;
      }
    }

    // Capture phase, as before: while the name prompt is up it owns Enter and
    // Escape, or Enter would move into the parent folder instead of creating the
    // one being typed.
    function onKey(e) {
      if (!props.open) return;
      if (s.mkOpen) {
        if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); mkCancel(); }
        else if (e.key === 'Enter') { e.stopPropagation(); e.preventDefault(); mkCreate(); }
        return;
      }
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      else if (e.key === 'Enter' && s.selected) { e.stopPropagation(); confirmMove(); }
    }
    document.addEventListener('keydown', onKey, true);
    onBeforeUnmount(() => document.removeEventListener('keydown', onKey, true));

    provide('moveTree', { state: s, blocked, toggle });

    const dest = computed(() => (s.selected || '').replace(/\\/g, '/'));
    const label = computed(() => s.items.length + ' item' + (s.items.length === 1 ? '' : 's'));

    return { s, mkInput, dest, label, close, go: confirmMove, mk: mkOpen, mkGo: mkCreate, mkCancel };
  },
  template: `
    <div v-if="open" class="confirm-overlay open" @click.self="close">
      <div class="tree-sheet">
        <div class="confirm-title">Move {{ label }}</div>
        <div class="tree-dest">
          <template v-if="s.selected">To: {{ dest }}</template>
          <span v-else class="tree-dest-hint">Pick a destination folder</span>
        </div>
        <div class="tree-box">
          <div v-if="s.loading" class="loading"><div class="spinner"></div> Loading…</div>
          <template v-else>
            <dir-node v-for="nd in s.roots" :key="nd.path" :node="nd" :depth="0"></dir-node>
          </template>
        </div>
        <div v-if="s.mkOpen" class="tree-mk">
          <input ref="mkInput" v-model="s.mkName" type="text" maxlength="64" autocomplete="off"
                 spellcheck="false" placeholder="New folder name" :disabled="s.mkBusy">
          <button class="tree-mk-go" :disabled="s.mkBusy || !s.mkName.trim()" @click="mkGo">{{ s.mkBusy ? '…' : 'Create' }}</button>
          <button class="tree-mk-x" :disabled="s.mkBusy" @click="mkCancel">✕</button>
        </div>
        <div v-else class="tree-mk-row">
          <button class="tree-mk-btn" :disabled="!s.selected || s.busy" @click="mk"
                  :title="s.selected ? 'Create a folder inside ' + dest : 'Pick a folder first — the new one is created inside it'">➕ New Folder</button>
          <span class="tree-mk-hint">letters, numbers, spaces and dashes</span>
        </div>
        <div v-if="s.err" class="tree-err">⚠ {{ s.err }}</div>
        <div class="confirm-btns">
          <button class="btn-cancel" :disabled="s.busy" @click="close">Cancel</button>
          <button class="btn-ok btn-move" :disabled="!s.selected || s.busy" @click="go">{{ s.busy ? 'Moving…' : '📦 Move here' }}</button>
        </div>
      </div>
    </div>
  `,
};
