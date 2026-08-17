// ── Folder picker ──────────────────────────────────────────────────────────
// Browses the server's filesystem one directory at a time (/api/browse-dirs),
// which is how the Settings path fields get filled in without anyone typing a
// Windows path by hand. Directory names only — the endpoint never lists files.
//
// Before the rewrite this was plain DOM: one element grabbed per row and its
// textContent rewritten on every step. It is a component now, so the listing is
// state and the rows are a v-for — nothing here holds a node across a render.
import { api } from '../api.js';
import { showToast } from '../store.js';

const { reactive, watch } = window.Vue;

export default {
  name: 'FolderPicker',
  // `path` seeds the first listing — the field's current value, so Browse opens
  // where the setting already points rather than at the drive list every time.
  props: {
    open: { type: Boolean, default: false },
    path: { type: String, default: '' },
  },
  emits: ['close', 'select'],
  setup(props, { emit }) {
    const s = reactive({
      cur: '',          // the folder being shown; '' is the drive list
      parent: null,     // null at the top, which is what disables ↑
      dirs: [],
      loading: false,
    });

    async function load(p) {
      s.loading = true;
      try {
        const d = await api.browseDirs(p || '');
        s.cur = d.path || '';
        s.parent = d.parent === undefined ? null : d.parent;
        s.dirs = d.dirs || [];
      } catch (e) {
        // An unreadable path (moved, unplugged, permission) falls back to the
        // drive list rather than leaving the sheet stuck on an error.
        if (p) { s.loading = false; load(''); return; }
        showToast('Cannot open: ' + e.message);
        s.dirs = [];
      }
      s.loading = false;
    }

    // Reopening re-reads from the seed path: the field may have been edited by
    // hand since the last browse.
    watch(() => props.open, isOpen => { if (isOpen) load((props.path || '').trim()); }, { immediate: true });

    // The server speaks Windows paths, so rows join with a backslash. Joining on
    // the drive list would produce "\C:\" — there the name *is* the path.
    const enter = name => load(s.cur ? s.cur.replace(/[\\/]+$/, '') + '\\' + name : name);
    const up = () => { if (s.parent !== null) load(s.parent); };
    const choose = () => { if (s.cur) emit('select', s.cur); emit('close'); };

    return { s, enter, up, choose, close: () => emit('close') };
  },
  template: `
    <div v-if="open" class="confirm-overlay open center above" @click.self="close">
      <div class="picker-sheet">
        <div class="dir-head">
          <div class="confirm-title">Select folder</div>
          <button class="set-x" @click="close">✕</button>
        </div>
        <div class="dir-nav">
          <button class="set-clr dir-up" title="Up one level" :disabled="s.parent === null" @click="up">↑</button>
          <div class="dir-current">{{ s.cur || 'Drives' }}</div>
        </div>
        <div class="dir-list">
          <div v-if="s.loading" class="loading"><div class="spinner"></div> Loading…</div>
          <div v-else-if="!s.dirs.length" class="dir-empty">No subfolders</div>
          <div v-else v-for="name in s.dirs" :key="name" class="dir-row" @click="enter(name)">📁 {{ name }}</div>
        </div>
        <div class="confirm-btns dir-foot">
          <button class="btn-cancel" @click="close">Cancel</button>
          <button class="btn-ok btn-accent" :class="{ hidden: !s.cur }" @click="choose">Select this folder</button>
        </div>
      </div>
    </div>
  `,
};
