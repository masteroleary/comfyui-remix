// ── A searchable combo ─────────────────────────────────────────────────────
// For a choice list too long to scroll through: every checkpoint ComfyUI can
// load is one option, and it spells them as paths relative to the models folder
// ("SDXL/realism/juggernaut.safetensors"), so a plain <select> is a few hundred
// rows of folder prefixes with the name you are looking for at the end of each.
//
// The search runs over the whole relative path, not just the filename, so the
// subdirectories are searchable too: "sdxl jugg" finds the file above, and
// "realism/" narrows to that folder. Every word has to match, in any order.
// Hits in the filename rank above hits that only matched a folder.
//
// It only ever sets a value from the list. A model name typed freehand that
// ComfyUI does not have fails the run, so the box is a filter, not an input.
const { ref, computed, watch, nextTick, onBeforeUnmount } = window.Vue;

const norm = s => String(s == null ? '' : s).replace(/\\/g, '/');
const splitPath = s => {
  const p = norm(s), i = p.lastIndexOf('/');
  return i < 0 ? { dir: '', name: p } : { dir: p.slice(0, i), name: p.slice(i + 1) };
};
const LIMIT = 200;

export default {
  name: 'ComboSearch',
  props: {
    modelValue: { default: '' },
    options: { type: Array, default: () => [] },
    placeholder: { type: String, default: 'Search…' },
  },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    const open = ref(false);
    const q = ref('');
    const hi = ref(0);
    const root = ref(null);
    const box = ref(null);
    const list = ref(null);

    const current = computed(() => splitPath(props.modelValue));
    const entries = computed(() => (props.options || []).map(v => {
      const { dir, name } = splitPath(v);
      return { v, dir, name, lcName: name.toLowerCase(), lcAll: norm(v).toLowerCase() };
    }));
    const matches = computed(() => {
      const words = q.value.toLowerCase().replace(/\\/g, '/').split(/\s+/).filter(Boolean);
      if (!words.length) return entries.value;
      const inName = [], inDir = [];
      for (const e of entries.value) {
        if (!words.every(w => e.lcAll.includes(w))) continue;
        (words.some(w => e.lcName.includes(w)) ? inName : inDir).push(e);
      }
      return inName.concat(inDir);
    });
    const shown = computed(() => matches.value.slice(0, LIMIT));

    function show() {
      if (open.value) return;
      open.value = true; q.value = '';
      const i = shown.value.findIndex(e => e.v === props.modelValue);
      hi.value = i < 0 ? 0 : i;
      nextTick(() => { if (box.value) box.value.focus(); scrollToHi(); });
    }
    function hide() { open.value = false; }
    function pick(e) { if (e) emit('update:modelValue', e.v); hide(); }
    function scrollToHi() {
      const el = list.value && list.value.children[hi.value];
      if (el) el.scrollIntoView({ block: 'nearest' });
    }
    function onKey(ev) {
      const n = shown.value.length;
      if (ev.key === 'ArrowDown') { ev.preventDefault(); if (n) hi.value = (hi.value + 1) % n; nextTick(scrollToHi); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); if (n) hi.value = (hi.value - 1 + n) % n; nextTick(scrollToHi); }
      else if (ev.key === 'Enter') { ev.preventDefault(); pick(shown.value[hi.value]); }
      else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); hide(); }
    }
    watch(q, () => { hi.value = 0; });
    // A value filled in from a file made on Windows can spell the subfolder with
    // a backslash where ComfyUI's list has a forward slash. Same file: adopt the
    // list's spelling, so it shows as selected and the run sends a listed value.
    watch(() => [props.modelValue, props.options], () => {
      const v = props.modelValue, opts = props.options || [];
      if (typeof v !== 'string' || !v || opts.includes(v)) return;
      const same = opts.find(o => typeof o === 'string' && norm(o) === norm(v));
      if (same !== undefined) emit('update:modelValue', same);
    }, { immediate: true });

    // Close on a press anywhere else. mousedown rather than click, so the press
    // that lands on another field closes this one before that one opens.
    const onDoc = ev => { if (open.value && root.value && !root.value.contains(ev.target)) hide(); };
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('touchstart', onDoc, true);
    onBeforeUnmount(() => {
      document.removeEventListener('mousedown', onDoc, true);
      document.removeEventListener('touchstart', onDoc, true);
    });

    return { open, q, hi, root, box, list, current, matches, shown, show, hide, pick, onKey, LIMIT };
  },
  template: `
    <div class="cbs" ref="root">
      <button v-if="!open" type="button" class="rmx-inp cbs-cur" @click="show" :title="modelValue">
        <span class="cbs-name">{{ current.name || '—' }}</span>
        <span v-if="current.dir" class="cbs-dir">{{ current.dir }}/</span>
        <span class="cbs-caret">▾</span>
      </button>
      <template v-else>
        <input ref="box" class="rmx-inp cbs-q" type="search" v-model="q" :placeholder="placeholder"
               autocomplete="off" spellcheck="false" @keydown="onKey">
        <div class="cbs-pop">
          <div class="cbs-count">{{ matches.length }} of {{ options.length }}<template v-if="matches.length > LIMIT"> — showing the first {{ LIMIT }}, type to narrow</template></div>
          <div class="cbs-list" ref="list">
            <div v-for="(e, i) in shown" :key="e.v" class="cbs-opt" :class="{hi: i === hi, sel: e.v === modelValue}"
                 @mousedown.prevent="pick(e)" @mousemove="hi = i" :title="e.v">
              <span class="cbs-name">{{ e.name }}</span>
              <span v-if="e.dir" class="cbs-dir">{{ e.dir }}/</span>
            </div>
            <div v-if="!shown.length" class="cbs-none">Nothing matches.</div>
          </div>
        </div>
      </template>
    </div>
  `,
};
