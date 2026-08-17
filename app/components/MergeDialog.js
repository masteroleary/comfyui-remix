// ── Merge dialog ───────────────────────────────────────────────────────────
// Two merges, one sheet, picked from what is selected:
//
//   videos  — join the selected clips into one new file, top to bottom, saved
//             beside the first clip. The order is the grid order and can be
//             dragged into any other before committing.
//   folders — move the contents of every selected folder into the last one
//             (alphanumerically), then delete the emptied ones.
//
// Dragging is pointer-event based (HTML5 drag-and-drop never fires on touch) and
// only *previews* the landing spot while the finger is down — see the
// .vm-row.dragging note in dialogs.css for why the DOM has to hold still.
import { store, showToast, exitMultiSelect } from '../store.js';
import { api, thumbUrl } from '../api.js';

const { reactive, computed, watch, onBeforeUnmount } = window.Vue;

export default {
  name: 'MergeDialog',
  // `mode` is normally left alone: 'auto' reads the selection and picks. Passing
  // 'videos' / 'folders' is for a caller that already knows.
  props: {
    open: { type: Boolean, default: false },
    mode: { type: String, default: 'auto' },
    items: { type: Array, default: null },
  },
  emits: ['close', 'done'],
  setup(props, { emit }) {
    const s = reactive({
      kind: '',        // 'videos' | 'folders' | '' while unusable
      items: [],       // videos, in merge order
      folders: [],     // folders, sorted alphanumerically — the last is the target
      busy: false, err: '', bad: '',
      dragIdx: -1, overIdx: -1,
    });

    // Selection is a Set of paths; everything else about an item (isDir,
    // isVideo, its thumbnail) comes from the listing it was selected in.
    // Grid order, not click order: a Set iterates by insertion, so ticking clip 3
    // then 1 then 2 merged them 3,1,2. The pre-SPA code read checked boxes out of
    // the DOM, which was grid order by construction.
    function selection() {
      if (props.items) return props.items;
      return store.items.filter(it => store.selected.has(it.path));
    }
    // A selection made on another page isn't in store.items, so it would be
    // dropped silently — the toolbar counts 3, the merge writes 2.
    const missingFromPage = () => store.selected.size - selection().length;

    function init() {
      const sel = selection();
      if (!props.items && missingFromPage() > 0) {
        s.bad = missingFromPage() + ' selected item(s) are on another page. Merge works on what the current page shows — page back and select them together.';
        return;
      }
      const vids = sel.filter(it => it.isVideo);
      const dirs = sel.filter(it => it.isDir);
      const want = props.mode === 'auto'
        ? (dirs.length >= 2 && dirs.length === sel.length ? 'folders'
          : vids.length >= 2 ? 'videos' : '')
        : props.mode;
      Object.assign(s, { kind: '', items: [], folders: [], busy: false, err: '', bad: '', dragIdx: -1, overIdx: -1 });

      if (want === 'folders') {
        // Folders only — a selected file has no meaning here.
        if (dirs.length < 2) { s.bad = '🗂 Pick at least 2 folders to merge'; return; }
        if (sel.length > dirs.length) { s.bad = '🗂 Merge works on folders only'; return; }
        // Sorted alphanumerically by name — the last one is the merge target
        // ("2" sorts before "10", matching how the listing reads).
        const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
        s.folders = dirs.map(d => ({ path: d.path, name: d.name || String(d.path).split(/[\\/]/).pop() }))
          .sort((a, b) => coll.compare(a.name, b.name));
        s.kind = 'folders';
        return;
      }
      if (want === 'videos') {
        if (vids.length < 2) { s.bad = '🎬 Pick at least 2 videos to merge'; return; }
        // Videos only — an image or a folder has no place in a concatenation.
        if (sel.length > vids.length) { s.bad = '🎬 Merge works on videos only'; return; }
        s.items = vids.map(it => ({ path: it.path, name: it.name, thumb: !!it.thumb, thumbV: it.thumbV || it.v }));
        s.kind = 'videos';
        return;
      }
      s.bad = 'Select 2 or more videos (to join them) or 2 or more folders (to merge them)';
    }
    watch(() => props.open, isOpen => { if (isOpen) init(); }, { immediate: true });

    function close() { if (!s.busy) emit('close'); }

    // ── Reorder ──
    function moveItem(from, to) {
      if (from === to || from < 0 || to < 0 || from >= s.items.length || to >= s.items.length) return;
      const [it] = s.items.splice(from, 1);
      s.items.splice(to, 0, it);
    }
    const nudge = (i, d) => { if (!s.busy) moveItem(i, i + d); };

    // Hit-test rather than measure: rows are found by what's under the pointer,
    // so a scrolled list needs no coordinate bookkeeping.
    function rowAt(x, y) {
      const el = document.elementFromPoint(x, y);
      const row = el && el.closest ? el.closest('.vm-row') : null;
      return row && row.dataset.idx !== undefined ? Number(row.dataset.idx) : -1;
    }
    let release = null;
    function grab(idx, e) {
      if (s.busy) return;
      e.preventDefault();                      // no text selection / native image drag
      s.dragIdx = idx;
      s.overIdx = idx;
      const move = ev => { const i = rowAt(ev.clientX, ev.clientY); if (i >= 0) s.overIdx = i; };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        release = null;
        const from = s.dragIdx, to = s.overIdx;
        s.dragIdx = -1; s.overIdx = -1;
        moveItem(from, to);
      };
      release = up;
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    }
    onBeforeUnmount(() => { if (release) release(); });

    function rowClass(i) {
      if (s.dragIdx < 0 || s.overIdx === s.dragIdx) return null;
      return {
        dragging: i === s.dragIdx,
        'drop-above': i === s.overIdx && s.overIdx < s.dragIdx,
        'drop-below': i === s.overIdx && s.overIdx > s.dragIdx,
      };
    }

    // ── Commit ──
    async function go() {
      if (s.busy) return;
      s.busy = true; s.err = '';
      try {
        if (s.kind === 'videos') {
          if (s.items.length < 2) return;
          const r = await api.mergeVideos(s.items.map(it => it.path));
          showToast('🎬 Saved "' + r.name + '"' + (r.mode === 'encode' ? ' (re-encoded)' : ''), 3200);
          emit('done', { kind: 'videos', name: r.name });
        } else {
          const target = s.folders[s.folders.length - 1];
          const sources = s.folders.slice(0, -1);
          const r = await api.mergeFolders(sources.map(d => d.path), target.path);
          showToast('🗂 Moved ' + r.moved + ' item(s) into "' + target.name + '"' +
            (r.errors && r.errors.length ? ' — ' + r.errors.length + ' failed' : ''));
          if (r.errors && r.errors.length) console.warn('[merge] partial failures:', r.errors);
          emit('done', { kind: 'folders', target: target.path, moved: r.moved });
        }
        exitMultiSelect();
        emit('close');
      } catch (e) {
        s.err = e.message;
      } finally {
        s.busy = false;
      }
    }

    // Where the joined clip lands: beside the first source.
    const destDir = computed(() => {
      const p = (s.items[0] || {}).path || '';
      return p.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
    });
    const target = computed(() => s.folders[s.folders.length - 1] || { name: '' });
    const sourceList = computed(() => s.folders.slice(0, -1).map(d => '"' + d.name + '"').join(', '));

    return { s, destDir, target, sourceList, close, go, grab, nudge, rowClass, thumbUrl };
  },
  template: `
    <div v-if="open" class="confirm-overlay open" @click.self="close">
      <!-- Nothing mergeable was selected: say which, rather than closing with a
           toast the way the pre-SPA buttons did — the sheet is already open. -->
      <div v-if="s.bad" class="confirm-sheet">
        <div class="confirm-title">Merge</div>
        <div class="confirm-msg">{{ s.bad }}</div>
        <div class="confirm-btns">
          <button class="btn-cancel" @click="close">Close</button>
        </div>
      </div>

      <div v-else-if="s.kind === 'folders'" class="confirm-sheet">
        <div class="confirm-title">Merge Folders</div>
        <div class="confirm-msg">
          Move the contents of {{ sourceList }} into "{{ target.name }}", then delete the emptied
          folder{{ s.folders.length > 2 ? 's' : '' }}?
        </div>
        <div v-if="s.err" class="tree-err">⚠ {{ s.err }}</div>
        <div class="confirm-btns">
          <button class="btn-cancel" :disabled="s.busy" @click="close">Cancel</button>
          <button class="btn-ok" :disabled="s.busy" @click="go">{{ s.busy ? 'Merging…' : '🗂 Merge ' + s.folders.length }}</button>
        </div>
      </div>

      <div v-else class="tree-sheet">
        <div class="confirm-title">Merge {{ s.items.length }} clips</div>
        <div class="vm-note">Joined top to bottom into one new video, saved beside the first clip in <b>{{ destDir }}</b>.</div>
        <div class="vm-list">
          <div v-for="(it, i) in s.items" :key="it.path" class="vm-row" :data-idx="i" :class="rowClass(i)">
            <div class="vm-num">{{ i + 1 }}</div>
            <div class="vm-thumb"><img v-if="it.thumb" :src="thumbUrl(it.path, it.thumbV)" alt=""><span v-else>🎬</span></div>
            <div class="vm-name" :title="it.name">{{ it.name }}</div>
            <div class="vm-nudge">
              <button :disabled="i === 0 || s.busy" title="Move up" @click="nudge(i, -1)">▲</button>
              <button :disabled="i === s.items.length - 1 || s.busy" title="Move down" @click="nudge(i, 1)">▼</button>
            </div>
            <div class="vm-grip" title="Drag to reorder" @pointerdown="grab(i, $event)">⠿</div>
          </div>
        </div>
        <div v-if="s.busy" class="vm-busy"><span class="tree-spin"></span> Merging — long clips can take a minute…</div>
        <div v-if="s.err" class="tree-err">⚠ {{ s.err }}</div>
        <div class="confirm-btns">
          <button class="btn-cancel" :disabled="s.busy" @click="close">Cancel</button>
          <button class="btn-ok btn-merge" :disabled="s.busy || s.items.length < 2" @click="go">{{ s.busy ? 'Merging…' : '🎬 Merge ' + s.items.length }}</button>
        </div>
      </div>
    </div>
  `,
};
