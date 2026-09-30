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
//
// ── Several at once (`multi`) ──────────────────────────────────────────────
// The model field asks for this. The results are pills to the right of the box
// instead of a list under it, and a pill is a toggle: every job the run queues
// is queued once per picked model (modelCombos in RemixDialog.js). The picks go
// out on `picks` — the field's `values`, the same shape a multi-file image pick
// already uses — with modelValue kept on the first, so every path that reads a
// single value keeps reading one.
//
// The first pick REPLACES the model the form arrived with, and every pick after
// that adds. Switching model was always one click, and it would otherwise take
// two: pick the new one, then find and untick the old one, with a run queued on
// both if the second click was forgotten. So `picks` is null until something is
// picked, and the arrived-with model is drawn differently (.def) — it is what
// runs, but it is not a choice anyone made yet. Clicking it keeps it, which is
// how you get it alongside others. Unpicking the last pick returns to that
// state with the same model rather than refusing the click.
//
// While searching, the pills are the matches, each lit if it is picked, in the
// order the search ranks them — never re-sorted by the selection, so a pill
// does not move out from under the cursor between two clicks. With the box
// empty they are the picks themselves, in pick order, which is the order the
// run queues them in.
const { ref, computed, watch, nextTick, onBeforeUnmount } = window.Vue;

const norm = s => String(s == null ? '' : s).replace(/\\/g, '/');
const splitPath = s => {
  const p = norm(s), i = p.lastIndexOf('/');
  return i < 0 ? { dir: '', name: p } : { dir: p.slice(0, i), name: p.slice(i + 1) };
};
const LIMIT = 200;
// Pills take far more room than list rows, and past a couple of dozen the row
// is a wall to read rather than a result to click. The count says how many
// more there are, and typing narrows them.
const PILLS = 30;
// Same trim shortLora does: the extension every checkpoint carries says
// nothing, where .gguf beside it says which build this is. Exported so the job
// a pick queues is labelled with the name its pill showed.
export const shortModel = s => splitPath(s).name.replace(/\.safetensors$/i, '');
// ── Recently picked ──
// The models you keep comparing, offered as pills while the box is empty so
// they are one click rather than a search each time. One list across every
// multi picker, newest first; each field only shows the ones its own options
// contain, which is what keeps a checkpoint out of a UNET loader's row.
// localStorage, so it is this browser's and may come back empty — a private
// window, cleared site data, or the accessor throwing outright.
const RECENT_KEY = 'crx.recentModels';
const RECENT_MAX = 12;
const RECENT_SHOWN = 5;
const readRecent = () => {
  try { const a = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(a) ? a.filter(x => typeof x === 'string') : []; }
  catch (e) { return []; }
};
const writeRecent = list => { try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch (e) {} };

export default {
  name: 'ComboSearch',
  props: {
    modelValue: { default: '' },
    options: { type: Array, default: () => [] },
    placeholder: { type: String, default: 'Search…' },
    multi: { type: Boolean, default: false },
    picks: { type: Array, default: null },
    // What one option is, for the sentence under several picks.
    unit: { type: String, default: 'option' },
    // A sentence about the picks the host knows and this does not — the model
    // field's is that they come from different families. Shown under the pills.
    warn: { type: String, default: '' },
  },
  emits: ['update:modelValue', 'update:picks'],
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

    // ── multi ──
    const explicit = computed(() => !!(props.picks && props.picks.length));
    const selected = computed(() => (explicit.value ? props.picks
      : (props.modelValue !== '' && props.modelValue != null ? [props.modelValue] : [])));
    const searching = computed(() => q.value.trim() !== '');
    const pills = computed(() => (searching.value
      ? matches.value.slice(0, PILLS).map(e => e.v)
      : selected.value));
    const pillState = v => (!selected.value.includes(v) ? '' : explicit.value ? 'on' : 'def');
    // A value ComfyUI does not list — a file made on another machine brings its
    // model's name with it. It runs exactly as far as that loader and fails
    // there, so it is marked here instead. Only against a real list: with none
    // (ComfyUI never reached) there is nothing to say it is missing from.
    const listed = computed(() => new Set(props.options || []));
    const isMissing = v => listed.value.size > 0 && v !== '' && v != null && !listed.value.has(v);
    const MISSING = 'ComfyUI does not list this ' + props.unit + ' — a run that uses it fails at that node.\n';
    function pillTitle(v) {
      const s = pillState(v), miss = isMissing(v) ? MISSING : '';
      if (s === 'def') return miss + v + '\nThe ' + props.unit + ' this workflow loads. Picking another replaces it; click this one to keep it alongside the others you pick.';
      if (s === 'on') return miss + v + '\nPicked — click to drop it';
      return miss + v + (explicit.value ? '\nClick to add it — every job runs once per picked ' + props.unit : '\nClick to use this instead');
    }
    const recent = ref(props.multi ? readRecent() : []);
    const recentPills = computed(() => (searching.value ? [] : recent.value
      .filter(v => listed.value.has(v) && !selected.value.includes(v)).slice(0, RECENT_SHOWN)));
    // Read fresh before writing: another picker on the page, or another tab,
    // may have added to it since this one mounted.
    function remember(v) {
      const list = [v].concat(readRecent().filter(x => x !== v)).slice(0, RECENT_MAX);
      writeRecent(list); recent.value = list;
    }
    function setPicks(list) {
      if (list && list.length) { emit('update:modelValue', list[0]); emit('update:picks', list.slice()); }
      else emit('update:picks', null);
    }
    function toggle(v) {
      if (v == null) return;
      if (!explicit.value) { setPicks([v]); remember(v); return; }   // first pick: replaces, or keeps the arrived-with one
      const cur = props.picks;
      // Unpicking the last one leaves it as the model, back in the unpicked state.
      if (cur.includes(v)) setPicks(cur.filter(x => x !== v));
      else { setPicks(cur.concat([v])); remember(v); }
    }
    function onMultiKey(ev) {
      // Up/Down rather than Left/Right, which belong to the caret in the box.
      const n = pills.value.length;
      if (ev.key === 'ArrowDown') { ev.preventDefault(); if (n) hi.value = (hi.value + 1) % n; }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); if (n) hi.value = (hi.value - 1 + n) % n; }
      else if (ev.key === 'Enter') { ev.preventDefault(); if (searching.value) toggle(pills.value[hi.value]); }
      else if (ev.key === 'Escape' && searching.value) { ev.preventDefault(); ev.stopPropagation(); q.value = ''; }
    }
    // A value set from outside — a prefill, an Inherit, the shortcut loading —
    // that is not one of the picks means the picks describe a different form.
    // The value wins: it is what the run would send.
    watch(() => props.modelValue, v => {
      if (props.multi && explicit.value && !props.picks.includes(v)) emit('update:picks', null);
    });

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
    // that lands on another field closes this one before that one opens. In
    // multi mode the search is what closes: the pills go back to being the picks.
    const onDoc = ev => {
      if (!root.value || root.value.contains(ev.target)) return;
      if (props.multi) { if (q.value) q.value = ''; return; }
      if (open.value) hide();
    };
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('touchstart', onDoc, true);
    onBeforeUnmount(() => {
      document.removeEventListener('mousedown', onDoc, true);
      document.removeEventListener('touchstart', onDoc, true);
    });

    return { open, q, hi, root, box, list, current, matches, shown, show, hide, pick, onKey, LIMIT,
      explicit, selected, searching, pills, pillState, pillTitle, shortModel, toggle, onMultiKey, PILLS,
      isMissing, MISSING, recentPills };
  },
  template: `
    <div v-if="multi" class="cbs multi" ref="root">
      <input ref="box" class="rmx-inp cbs-q" type="search" v-model="q" autocomplete="off" spellcheck="false"
             :placeholder="placeholder" :title="options.length + ' to choose from — type to search, click the results to pick'"
             @keydown="onMultiKey">
      <!-- mousedown.prevent keeps the focus in the box, so a run of clicks can
           be followed by more typing without reaching for the field again. -->
      <button v-for="(v, i) in pills" :key="v" type="button" class="cbs-pill" :class="[pillState(v), {hi: searching && i === hi, miss: isMissing(v)}]"
              :aria-pressed="!!pillState(v)" :title="pillTitle(v)"
              @mousedown.prevent @click="toggle(v)" @mousemove="hi = i">
        <template v-if="isMissing(v)">⚠ </template>{{ shortModel(v) }}<span v-if="pillState(v) === 'on'" class="cbs-pill-x" aria-hidden="true">✕</span>
      </button>
      <span v-if="searching" class="cbs-note">
        <template v-if="!matches.length">nothing matches</template>
        <template v-else-if="matches.length > PILLS">{{ matches.length - PILLS }} more — keep typing</template>
        <template v-if="selected.length > 1"><template v-if="matches.length"> · </template>{{ selected.length }} picked</template>
      </span>
      <span v-else-if="selected.length > 1" class="cbs-note">every job runs once per {{ unit }}, in this order</span>
      <template v-if="recentPills.length">
        <span class="cbs-note cbs-recent-lbl">recent</span>
        <button v-for="v in recentPills" :key="'r:' + v" type="button" class="cbs-pill rec" :title="pillTitle(v)"
                @mousedown.prevent @click="toggle(v)">{{ shortModel(v) }}</button>
      </template>
      <div v-if="warn" class="cbs-warn">⚠ {{ warn }}</div>
    </div>
    <div v-else class="cbs" ref="root">
      <button v-if="!open" type="button" class="rmx-inp cbs-cur" :class="{miss: isMissing(modelValue)}" @click="show"
              :title="isMissing(modelValue) ? MISSING + modelValue : modelValue">
        <span v-if="isMissing(modelValue)" class="cbs-miss" aria-hidden="true">⚠</span>
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
