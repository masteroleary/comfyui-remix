// ── Inspect ────────────────────────────────────────────────────────────────
// The workflow/metadata inspector: what a file was made with, and how to make
// another one like it. Ported from inspect.html, which was a 2,719-line
// standalone document driving itself through getElementById and innerHTML.
//
// What the port actually changed, beyond "it's a component now":
//
//  • The file under inspection comes from the route (useRoute().query), not
//    location.search, so /inspect?path=… deep-links and the overlay's "Open
//    Meta" link is a router navigation rather than a full page load.
//  • Every value the old page read back out of the DOM at submit time — prompt
//    text, seed, LoRA rows, detected-field controls — is reactive state now.
//    That deletes syncFieldValuesFromDOM() outright: there is no second copy of
//    the truth to sync from, and re-rendering the fields panel can no longer
//    discard an in-progress edit.
//  • Rendering is a template. The old page built node cards, LoRA rows and the
//    manage-workflows list as HTML strings and hand-escaped every value with
//    .replace(/</g,'&lt;'); Vue escapes interpolations, so a prompt containing
//    markup is no longer a rendering hazard.
//  • The page's own <head>, /ui-guards.js, /auth-ui.js and #logoutBtn are gone —
//    the shell owns guards, the stylesheet and logout.
//
// Not ported, deliberately: nothing. The run/queue/output half of the page has
// no other home on this branch, so it comes along.
import { showToast } from '../store.js';
import { api, fileUrl } from '../api.js';

const { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } = window.Vue;
const { useRoute, useRouter } = window.VueRouter;

// The shell links every view's sheet up front; this is only a safety net for a
// shell that doesn't, so the view is never unstyled. No-op when the link is
// already there, and never removed — a removed sheet would flash on re-entry.
const CSS_HREF = '/app/styles/inspect.css';
if (!document.querySelector('link[href="' + CSS_HREF + '"]')) {
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = CSS_HREF;
  document.head.appendChild(link);
}

const enc = encodeURIComponent;
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'];
const VIDEO_EXT = ['mp4', 'webm', 'mkv', 'mov'];
const EMBEDDABLE_RE = /\.(png|mp4|webm|mkv|mov)$/i;
const extOf = name => String(name || '').split('.').pop().toLowerCase();
const isVideoFile = name => VIDEO_EXT.includes(extOf(name));

// localStorage is per-workflow scratch state here (last prompt, seed, LoRA
// toggles). Wrapped because a private-mode browser throws on access.
const LS = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

// Plain fetch for what api.js has no helper for — the run/queue/manage side:
// /api/workflow-config, /api/workflow-prompt, /api/workflow-match,
// /api/workflow-nodes, /api/workflows/{manage,save}, /api/replacements,
// /api/recent-outputs?since=…, the /api/comfy/* proxy, /api/debug-results and
// because several of those are read as a stream or checked by status.
const getJson = async (url, opts) => {
  const r = await fetch(url, { credentials: 'same-origin', ...(opts || {}) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
};
const postJson = (url, body) => fetch(url, {
  method: 'POST', credentials: 'same-origin',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
});

// ── Job tracker ─────────────────────────────────────────────────────────────
// IndexedDB, shared with the jobs view via the same store name + channel, so a
// batch started here is still visible after a refresh or from another tab.
const JobDB = {
  _db: null,
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('comfyJobs', 1);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('jobs')) {
          db.createObjectStore('jobs', { keyPath: 'id' }).createIndex('startTime', 'startTime');
        }
      };
      req.onsuccess = () => { this._db = req.result; resolve(this._db); };
      req.onerror = () => reject(req.error);
    });
  },
  async put(job) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('jobs', 'readwrite');
      tx.objectStore('jobs').put(JSON.parse(JSON.stringify(job)));  // structured-clone-safe
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
};

// ── LoRA rows ───────────────────────────────────────────────────────────────
// One row per LoRA: on/off, name, strength. Used by the classic LoRA lists and
// again by the detected-fields panel's lora_rows control — the old page reached
// for the same renderLoraRows() with a container element.
const LoraRows = {
  name: 'LoraRows',
  props: { rows: { type: Array, required: true } },
  emits: ['change'],
  methods: {
    short(l) { return String(l.lora || '').replace(/\.safetensors$/, ''); },
    setStrength(l, v) { l.strength = parseFloat(v) || 0; this.$emit('change'); },
  },
  template: `
    <div>
      <div v-for="(l, i) in rows" :key="i" class="lora-row" :class="{ off: !l.on }">
        <input type="checkbox" v-model="l.on" @change="$emit('change')">
        <label :title="l.lora">{{ short(l) }}</label>
        <input type="number" :value="l.strength" step="0.1" min="0" max="10"
               @change="setStrength(l, $event.target.value)">
      </div>
    </div>
  `,
};

// ── Detected field row ──────────────────────────────────────────────────────
// A field from /api/workflow-field-config: enable toggle, label, and whichever
// control its kind/type asks for. Values live on the field object itself, so the
// run path reads f.value instead of querying [data-fid] out of the document.
const FieldRow = {
  name: 'FieldRow',
  components: { LoraRows },
  props: { f: { type: Object, required: true }, fileName: { type: String, default: '' } },
  emits: ['toggle'],
  data() { return { thumbOk: true }; },
  computed: {
    type() { return (this.f.control && this.f.control.type) || 'text'; },
    options() { return (this.f.control && this.f.control.options) || [this.f.value]; },
    // A workflow's seed default of -1 means "randomize" — show that as empty.
    seedText() { return Number(this.f.value) >= 0 ? String(this.f.value) : ''; },
    seedPinned() { return !!this.f.__seedPinned && this.seedText !== ''; },
    thumbUrl() { return this.f.value ? fileUrl(String(this.f.value)) : ''; },
  },
  methods: {
    onSeed(v) { this.f.value = String(v).trim() === '' ? -1 : parseInt(v, 10); },
    useCurrent() { if (this.fileName) { this.f.value = this.fileName; this.thumbOk = true; } },
  },
  template: `
    <div class="fc-field">
      <label class="fc-lbl">
        <input type="checkbox" class="fc-hidden-tgl" :checked="f.enabled"
               :title="f.enabled ? 'Hide this field' : 'Show this field'"
               @change="f.enabled = $event.target.checked; $emit('toggle', f)">
        {{ f.label }}
        <span v-if="f.unreachable" class="fc-warn" title="not on the output path — may do nothing"> ⚠</span>
        <span v-if="f.inactive" class="fc-warn" title="target is muted/bypassed"> ⚠muted</span>
      </label>

      <span v-if="f.kind === 'seed'" class="fc-seed">
        <input type="number" class="fc-input" min="0" step="1" placeholder="random"
               :value="seedText" @input="onSeed($event.target.value)"
               :style="{ borderColor: seedPinned ? '#0a84ff' : '#48484a' }">
        <button type="button" class="seed-switch" :class="{ on: f.__seedPinned }"
                title="Off = new random seed each run · On = pin this exact seed"
                @click="f.__seedPinned = !f.__seedPinned">
          <span class="thumb">{{ f.__seedPinned ? '📌' : '🎲' }}</span>
        </button>
      </span>

      <textarea v-else-if="type === 'multiline'" rows="3" class="fc-input fc-multiline" v-model="f.value"></textarea>

      <input v-else-if="type === 'boolean'" type="checkbox" class="fc-bool" v-model="f.value">

      <input v-else-if="type === 'int' || type === 'float'" type="number" class="fc-input fc-num"
             :step="type === 'float' ? '0.01' : '1'" v-model="f.value">

      <LoraRows v-else-if="type === 'lora_rows'" :rows="f.value" />

      <span v-else-if="type === 'image' || type === 'video' || type === 'audio'" class="fc-media">
        <img v-if="type === 'image' && f.value && thumbOk" :src="thumbUrl" @error="thumbOk = false">
        <input type="text" class="fc-input" v-model="f.value">
        <button type="button" class="btn btn-sm" title="Use the currently-viewed file" @click="useCurrent">📷 current</button>
      </span>

      <select v-else-if="type === 'combo'" class="fc-input" v-model="f.value">
        <option v-for="o in options" :key="o" :value="o">{{ o }}</option>
      </select>

      <input v-else type="text" class="fc-input fc-text" v-model="f.value">
    </div>
  `,
};

export default {
  name: 'InspectView',
  components: { LoraRows, FieldRow },
  setup() {
    const route = useRoute();
    const router = useRouter();

    // ── The file under inspection ─────────────────────────────────────────
    const filePath = ref('');     // absolute; mutates when Fav moves the file
    const fileName = ref('');
    const isVideo = ref(false);
    const mediaUrl = computed(() => fileUrl(filePath.value));

    const tab = ref('workflow');
    const status = ref('Loading metadata...');
    const statusColor = ref('');

    // ── Metadata ──────────────────────────────────────────────────────────
    const metaLoading = ref(true);
    const metaError = ref('');
    const noMeta = ref(false);
    const metaUrl = computed(() => '/api/metadata?path=' + enc(filePath.value));
    const promptData = ref(null);        // the file's embedded API prompt, untouched
    const workflowData = ref(null);      // the file's embedded visual graph, untouched
    const workingPrompt = ref(null);     // editable copy — what an Inherit run submits
    const workingWorkflow = ref(null);
    const appWorkflowGraph = ref(null);  // graph returned with an APP workflow's prompt
    const inheritPromptRef = ref(null);
    const fileHasNoEmbeddedWf = ref(false);

    // ── Node list ─────────────────────────────────────────────────────────
    const nodesOpen = ref(false);
    const rawPromptOpen = ref(false);
    const rawWorkflowOpen = ref(false);
    const nodeSearch = ref('');
    const editingId = ref(null);
    const editDraft = ref({});
    const editedIds = ref(new Set());
    const editFormEl = ref(null);
    const setEditForm = el => { if (el) editFormEl.value = el; };

    const summary = computed(() => {
      const models = [], loras = [];
      const p = workingPrompt.value;
      if (p) for (const node of Object.values(p)) {
        const cls = (node.class_type || '').toLowerCase();
        const inputs = node.inputs || {};
        if (cls.includes('checkpointloader') || cls.includes('unetloader') || cls.includes('diffusionmodel')) {
          const n = inputs.ckpt_name || inputs.unet_name || inputs.model_name || '';
          if (n && typeof n === 'string') models.push(n);
        }
        if (cls.includes('lora')) {
          const n = inputs.lora_name || '';
          if (n && typeof n === 'string') loras.push(n);
        }
      }
      return { models, loras };
    });

    // Node cards derive from workingPrompt, so an applied edit updates the card
    // without the old page's manual walk over .node-input elements.
    const nodeEntries = computed(() => {
      const p = workingPrompt.value;
      if (!p) return [];
      const entries = Object.entries(p).sort((a, b) => {
        const at = ((a[1]._meta && a[1]._meta.title) || '').toUpperCase();
        const bt = ((b[1]._meta && b[1]._meta.title) || '').toUpperCase();
        const am = at.startsWith('MAIN') ? 0 : 1, bm = bt.startsWith('MAIN') ? 0 : 1;
        return am !== bm ? am - bm : parseInt(a[0]) - parseInt(b[0]);
      });
      return entries.map(([id, node]) => {
        const inputs = [], editable = [];
        for (const [k, v] of Object.entries(node.inputs || {})) {
          if (Array.isArray(v)) continue;   // a wire, not a value
          let display = typeof v === 'string' ? v : JSON.stringify(v);
          if (display.length > 120) display = display.substring(0, 120) + '...';
          inputs.push({ key: k, display });
          if (typeof v === 'string' || typeof v === 'number') editable.push({ key: k, val: v, type: typeof v });
        }
        const vals = editable.map(i => (typeof i.val === 'string' ? i.val : '')).join(' ');
        const cls = node.class_type || '?';
        const title = (node._meta && node._meta.title) || '';
        return {
          id, cls, title, inputs, editable,
          search: (cls + ' ' + title + ' ' + id + ' ' + vals).toLowerCase(),
        };
      });
    });
    const visibleNodes = computed(() => {
      const q = nodeSearch.value.toLowerCase().trim();
      return q ? nodeEntries.value.filter(n => n.search.includes(q)) : nodeEntries.value;
    });
    const rawPromptJson = computed(() => (promptData.value ? JSON.stringify(promptData.value, null, 2) : ''));
    const rawWorkflowJson = computed(() => (workflowData.value ? JSON.stringify(workflowData.value, null, 2) : ''));

    function toggleEdit(n) {
      if (!n.editable.length) return;
      if (editingId.value === n.id) { editingId.value = null; return; }
      const draft = {};
      for (const e of n.editable) draft[e.key] = e.val;
      editDraft.value = draft;
      editingId.value = n.id;
      nextTick(() => {
        const first = editFormEl.value && editFormEl.value.querySelector('.edit-input');
        if (first) first.focus();
      });
    }
    function applyEdit(n) {
      const node = workingPrompt.value && workingPrompt.value[n.id];
      if (node && node.inputs) {
        for (const e of n.editable) {
          let val = editDraft.value[e.key];
          if (e.type === 'number') {
            val = Number(val);
            if (Number.isInteger(val)) val = Math.round(val);   // keep ints integral
          }
          node.inputs[e.key] = val;
        }
      }
      editedIds.value.add(n.id);
      editingId.value = null;
    }

    // ── Workflow selection ────────────────────────────────────────────────
    const wfOptions = ref([]);
    const hasInherit = ref(true);
    const wfName = ref(LS.get('archiveWorkflowSelect') || 'inherit');
    const savedWorkflow = LS.get('archiveWorkflowSelect');
    const runCount = ref(LS.get('archiveRunCount') || '1');
    const frames = ref(LS.get('archiveFrames') || 'inherit');
    const showFrames = ref(false);
    const showRun = ref(false);
    const showPrompt = ref(false);
    const promptText = ref('');
    const showCopyImgPrompt = ref(false);

    const loras = ref([]);
    const lorasHigh = ref([]);
    const lorasLow = ref([]);
    const hasHLLoras = ref(false);
    const showLora = ref(false);
    const presets = ref([]);

    const hasSeedControl = ref(false);
    const hasStepsControl = ref(false);
    const hasCfgControl = ref(false);
    const hasHLControl = ref(false);
    const seedValue = ref('');
    const seedPinMode = ref(false);
    const seedPlaceholder = ref('random');
    const stepsValue = ref('');
    const highStepsValue = ref('');
    const lowStepsValue = ref('');
    const cfgValue = ref('');
    let lastUsedSeed = null;

    const showGen = computed(() => hasSeedControl.value || hasStepsControl.value || hasHLControl.value || hasCfgControl.value);
    const hlTotal = computed(() => (parseInt(highStepsValue.value, 10) || 0) + (parseInt(lowStepsValue.value, 10) || 0));
    const seedPinned = computed(() => hasSeedControl.value && seedPinMode.value
      && String(seedValue.value).trim() !== '' && parseInt(seedValue.value, 10) >= 0);
    const seedTitle = computed(() => (seedPinMode.value
      ? 'Pinned — this exact seed is used every run'
      : 'Ignored while unpinned — runs use random seeds'));

    function persistGen() {
      const name = wfName.value;
      if (!name || name === 'inherit') return;
      LS.set('archiveSeed_' + name, seedValue.value);
      LS.set('archiveSeedPin_' + name, seedPinMode.value ? '1' : '');
      LS.set('archiveSteps_' + name, stepsValue.value);
      LS.set('archiveHighSteps_' + name, highStepsValue.value);
      LS.set('archiveLowSteps_' + name, lowStepsValue.value);
      LS.set('archiveCfg_' + name, cfgValue.value);
    }
    // One switch: OFF randomizes every run (and clears the box); ON pins the
    // exact value shown. A number sitting in the box does not pin by itself.
    function toggleSeedPin() {
      seedPinMode.value = !seedPinMode.value;
      if (seedPinMode.value) {
        if (String(seedValue.value).trim() === '') {
          seedValue.value = lastUsedSeed !== null ? String(lastUsedSeed) : String(Math.floor(Math.random() * 2147483647));
        }
      } else {
        seedValue.value = '';
      }
      persistGen();
    }
    function savePresets() {
      const name = wfName.value;
      if (name !== 'inherit') {
        LS.set('archivePresets_' + name, JSON.stringify(presets.value.map(p => ({ title: p.title, on: p.on }))));
      }
    }
    function saveLoras() {
      const name = wfName.value;
      if (name === 'inherit') return;
      const pack = arr => JSON.stringify(arr.map(l => ({ slot: l.slot, on: l.on, strength: l.strength })));
      if (hasHLLoras.value) {
        LS.set('archiveLorasHigh_' + name, pack(lorasHigh.value));
        LS.set('archiveLorasLow_' + name, pack(lorasLow.value));
      } else {
        LS.set('archiveLoras_' + name, pack(loras.value));
      }
    }
    function onPromptInput() {
      const name = wfName.value;
      if (name !== 'inherit') LS.set('archivePrompt_' + name, promptText.value);
      updateCopyPromptBtn();   // reappears when the text diverges from the image's prompt
    }
    const persistRunCount = () => LS.set('archiveRunCount', runCount.value);
    const persistFrames = () => LS.set('archiveFrames', frames.value);

    // ── The image's own prompt / seed / LoRAs ──────────────────────────────
    // Returns {nodeId, key, text} of the best positive-prompt source, or null.
    function extractImagePromptRef() {
      const wp = workingPrompt.value;
      if (!wp) return null;
      const tiers = [[], [], []];   // MAIN PROMPT · positive-prompt titled · any prompt-ish text
      for (const [nodeId, node] of Object.entries(wp)) {
        if (!node || !node.inputs) continue;
        const title = (node._meta && node._meta.title) || '';
        const cls = node.class_type || '';
        if (/negative|neg\b/i.test(title)) continue;
        let text = '', key = null;
        for (const [k, v] of Object.entries(node.inputs)) {
          if (typeof v === 'string' && v.length > text.length) { text = v; key = k; }
        }
        if (!text.trim()) continue;
        const ref_ = { nodeId, key, text };
        if (/MAIN/i.test(title) && /PROMPT/i.test(title)) tiers[0].push(ref_);
        else if (/positive/i.test(title) && /prompt/i.test(title)) tiers[1].push(ref_);
        else if (text.length > 20 && /CLIPTextEncode|TextBox|wildcards|String|concat/i.test(cls)) tiers[2].push(ref_);
      }
      for (const tier of tiers) if (tier.length) return tier.sort((a, b) => b.text.length - a.text.length)[0];
      return null;
    }
    const extractImagePrompt = () => { const r = extractImagePromptRef(); return r ? r.text : ''; };

    // The image's actual seed (a rgthree Seed node wins over any other).
    function extractImageSeed() {
      const wp = workingPrompt.value || {};
      let fallback = null;
      for (const n of Object.values(wp)) {
        if (!n || !n.inputs) continue;
        for (const [k, v] of Object.entries(n.inputs)) {
          if (!k.includes('seed') || typeof v !== 'number' || v < 0) continue;
          if (n.class_type === 'Seed (rgthree)') return v;
          if (fallback === null) fallback = v;
        }
      }
      return fallback;
    }

    function collectInheritLoras() {
      const rows = [];
      const wp = workingPrompt.value || {};
      for (const [nodeId, n] of Object.entries(wp)) {
        const cls = n.class_type || '';
        if (/Power Lora Loader/i.test(cls)) {
          for (const [k, v] of Object.entries(n.inputs || {})) {
            if (/^lora_\d+$/.test(k) && v && typeof v === 'object' && v.lora) {
              rows.push({ kind: 'power', nodeId, key: k, lora: v.lora, on: v.on !== false, strength: typeof v.strength === 'number' ? v.strength : 1 });
            }
          }
        } else if (cls === 'LoraLoader' || cls === 'LoraLoaderModelOnly') {
          const inp = n.inputs || {};
          if (typeof inp.lora_name === 'string') {
            const s = typeof inp.strength_model === 'number' ? inp.strength_model : 1;
            rows.push({ kind: 'plain', nodeId, lora: inp.lora_name, on: s !== 0, strength: s || 1 });
          }
        } else if (/Lora Loader \(LoraManager\)/i.test(cls)) {
          const arr = n.inputs && n.inputs.loras && Array.isArray(n.inputs.loras.__value__) ? n.inputs.loras.__value__ : [];
          arr.forEach((e, idx) => {
            if (e && e.name) rows.push({ kind: 'lm', nodeId, idx, lora: e.name, on: e.active !== false, strength: typeof e.strength === 'number' ? e.strength : 1 });
          });
        }
      }
      return rows;
    }

    function updateCopyPromptBtn() {
      const imgPrompt = extractImagePrompt();
      // Hidden while the box already holds the image's prompt (auto-loaded or
      // previously copied); it comes back if the text diverges.
      showCopyImgPrompt.value = wfName.value !== 'inherit' && showPrompt.value
        && !!imgPrompt && promptText.value.trim() !== imgPrompt.trim();
    }
    function copyImagePrompt() {
      const text = extractImagePrompt();
      if (!text) return;
      promptText.value = text;
      if (wfName.value !== 'inherit') LS.set('archivePrompt_' + wfName.value, text);
      updateCopyPromptBtn();
    }

    // ── Inherit-mode controls ─────────────────────────────────────────────
    // An Inherited run replays the prompt embedded in this file; the controls are
    // built from that prompt and are per-file and ephemeral (never persisted the
    // way an APP workflow's settings are).
    function setupInheritControls() {
      presets.value = [];
      showFrames.value = false;
      hasStepsControl.value = false;
      hasCfgControl.value = false;
      hasHLControl.value = false;

      const r = extractImagePromptRef();
      inheritPromptRef.value = r;
      if (r) { promptText.value = r.text; showPrompt.value = true; } else { showPrompt.value = false; }
      updateCopyPromptBtn();

      hasSeedControl.value = !!workingPrompt.value;
      if (hasSeedControl.value) { seedValue.value = ''; seedPinMode.value = false; }

      hasHLLoras.value = false; lorasHigh.value = []; lorasLow.value = [];
      loras.value = collectInheritLoras();
      showLora.value = loras.value.length > 0;
    }

    // Merge a config list with any saved on/strength state for this workflow.
    function mergeSaved(list, keyPrefix, name) {
      let st = null;
      const saved = LS.get(keyPrefix + name);
      if (saved) { try { st = JSON.parse(saved); } catch {} }
      return list.map(l => {
        const s = st && st.find(x => x.slot === l.slot);
        return s ? { ...l, on: s.on, strength: s.strength } : { ...l };
      });
    }

    async function loadWorkflowConfig(name) {
      if (!name) return;                       // options still loading
      if (name === 'inherit') { setupInheritControls(); loadFieldConfig('inherit'); return; }
      loadFieldConfig(name);                   // the detected-fields panel, alongside the classic controls
      let cfg;
      try { cfg = await getJson('/api/workflow-config?name=' + enc(name)); } catch { return; }

      // A changed workflow file invalidates everything cached against it —
      // otherwise last week's prompt silently overrides today's default.
      const savedMtime = LS.get('archiveMtime_' + name);
      const fileChanged = !savedMtime || String(cfg.mtime) !== savedMtime;
      if (fileChanged) {
        ['archivePrompt_', 'archiveLoras_', 'archiveLorasHigh_', 'archiveLorasLow_'].forEach(k => LS.del(k + name));
        LS.set('archiveMtime_' + name, String(cfg.mtime));
      }

      const savedPrompt = LS.get('archivePrompt_' + name);
      promptText.value = savedPrompt !== null ? savedPrompt : (cfg.prompt || '');
      showPrompt.value = true;
      updateCopyPromptBtn();

      if (cfg.lorasHigh && cfg.lorasLow && (cfg.lorasHigh.length || cfg.lorasLow.length)) {
        hasHLLoras.value = true;
        loras.value = [];
        lorasHigh.value = mergeSaved(cfg.lorasHigh, 'archiveLorasHigh_', name);
        lorasLow.value = mergeSaved(cfg.lorasLow, 'archiveLorasLow_', name);
        showLora.value = true;
      } else if (cfg.loras && cfg.loras.length > 0) {
        hasHLLoras.value = false;
        lorasHigh.value = []; lorasLow.value = [];
        loras.value = mergeSaved(cfg.loras, 'archiveLoras_', name);
        showLora.value = true;
      } else {
        hasHLLoras.value = false;
        loras.value = []; lorasHigh.value = []; lorasLow.value = [];
        showLora.value = false;
      }

      showFrames.value = cfg.frames !== null && cfg.frames !== undefined;

      if (fileChanged) {
        ['archiveSeed_', 'archiveSeedPin_', 'archiveSteps_', 'archiveHighSteps_', 'archiveLowSteps_', 'archiveCfg_', 'archivePresets_']
          .forEach(k => LS.del(k + name));
      }

      hasSeedControl.value = cfg.seed !== null && cfg.seed !== undefined;
      if (hasSeedControl.value) {
        const savedSeed = LS.get('archiveSeed_' + name);
        // A workflow default of -1 means "randomize" → show blank.
        seedValue.value = savedSeed !== null ? savedSeed : (Number(cfg.seed) >= 0 ? String(cfg.seed) : '');
        seedPinMode.value = LS.get('archiveSeedPin_' + name) === '1';
      } else { seedPinMode.value = false; }

      hasStepsControl.value = cfg.steps !== null && cfg.steps !== undefined;
      if (hasStepsControl.value) {
        const s = LS.get('archiveSteps_' + name);
        stepsValue.value = s !== null ? s : String(cfg.steps);
      }

      // Dual high/low sampler steps (Wan video) replace the single Steps box —
      // the two passes sum to the total, so a steps override would double up.
      hasHLControl.value = !!cfg.highLowSteps;
      if (hasHLControl.value) {
        const h = LS.get('archiveHighSteps_' + name), l = LS.get('archiveLowSteps_' + name);
        highStepsValue.value = h !== null ? h : String(cfg.highLowSteps.high);
        lowStepsValue.value = l !== null ? l : String(cfg.highLowSteps.low);
        hasStepsControl.value = false;
      }

      hasCfgControl.value = cfg.cfg !== null && cfg.cfg !== undefined;
      if (hasCfgControl.value) {
        const c = LS.get('archiveCfg_' + name);
        cfgValue.value = c !== null ? c : String(cfg.cfg);
      }

      if (cfg.presets && cfg.presets.length > 0) {
        let state = null;
        const saved = LS.get('archivePresets_' + name);
        if (saved) { try { state = JSON.parse(saved); } catch {} }
        presets.value = cfg.presets.map(p => {
          const s = state && state.find(x => x.title === p.title);
          return s ? { title: p.title, on: s.on } : { title: p.title, on: !!p.on };
        });
      } else {
        presets.value = [];
      }
    }

    function onWorkflowChange(name) {
      wfName.value = name;
      LS.set('archiveWorkflowSelect', name);
      loadWorkflowConfig(name);
      updateApplyBtnVisibility();
    }

    async function refreshWorkflowDropdown(selectName) {
      const prev = selectName || wfName.value;
      let wfs = [];
      try { wfs = await api.workflows(); } catch { return; }
      wfOptions.value = wfs || [];
      const has = n => n === 'inherit' ? hasInherit.value : (n && wfOptions.value.some(w => w.name === n));
      if (has(prev)) wfName.value = prev;
      else if (has(savedWorkflow)) wfName.value = savedWorkflow;
      else if (!hasInherit.value && wfOptions.value.length) wfName.value = wfOptions.value[0].name;
      if (wfName.value !== 'inherit') await loadWorkflowConfig(wfName.value);
    }
    const wfReady = refreshWorkflowDropdown().then(() => updateApplyBtnVisibility());

    // Which preset groups were active in an embedded graph — mirrors the
    // server's detectPresetGroups (rgthree "Fast Groups Muter", max-one, over
    // purple groups; a group is ON when any member node is unmuted).
    function embeddedPresetStates(wf) {
      const nodes = (wf && wf.nodes) || [];
      const groups = (wf && wf.groups) || [];
      const muter = nodes.find(n => (n.type || '').includes('Fast Groups Muter')
        && n.properties && (n.properties.matchColors || '').toLowerCase() === 'purple'
        && n.properties.toggleRestriction === 'max one');
      if (!muter) return null;
      const inGroup = (node, g) => {
        if (!node.pos || !g.bounding) return false;
        const [gx, gy, gw, gh] = g.bounding;
        return node.pos[0] >= gx - 2 && node.pos[1] >= gy - 2 && node.pos[0] <= gx + gw && node.pos[1] <= gy + gh;
      };
      const states = {};
      groups.filter(g => (g.color || '').toLowerCase() === '#a1309b').forEach(g => {
        states[g.title] = nodes.filter(n => inGroup(n, g)).some(n => (n.mode || 0) === 0);
      });
      return states;
    }

    // Structural recognition: if this file's graph matches an enabled APP
    // workflow (same nodes/wiring, values may differ), switch off Inherit and
    // preload the controls with the file's own prompt/seed/LoRAs/preset.
    async function recognizeWorkflow(wf) {
      if (wfName.value !== 'inherit') return false;
      try {
        const r = await postJson('/api/workflow-match', { workflow: wf });
        if (!r.ok) return false;
        const m = await r.json();
        if (!m || !m.name) return false;
        await wfReady;
        if (wfName.value !== 'inherit') return false;                       // user picked something meanwhile
        if (!wfOptions.value.some(w => w.name === m.name)) return false;
        wfName.value = m.name;
        LS.set('archiveWorkflowSelect', m.name);
        await loadWorkflowConfig(m.name);
        log('Recognized saved workflow "' + (m.label || m.name) + '" (' + Math.round(m.score * 100) + '% match) — switched from Inherit');

        const embPrompt = extractImagePrompt();
        if (embPrompt && showPrompt.value) { promptText.value = embPrompt; updateCopyPromptBtn(); }
        const embSeed = extractImageSeed();
        if (hasSeedControl.value && embSeed !== null) {
          seedValue.value = String(embSeed);
          seedPinMode.value = false;   // visible but unpinned: runs randomize until 📌
        }
        const embLoras = collectInheritLoras();
        if (loras.value.length && embLoras.length) {
          for (const row of loras.value) {
            const e = embLoras.find(x => x.lora === row.lora);
            if (e) { row.on = e.on; row.strength = e.strength; }
          }
        }
        // Reflect the preset that actually made this file, not whatever was
        // ticked last time (session-only, like the other preloads).
        const embPresets = embeddedPresetStates(wf);
        if (embPresets && presets.value.length) {
          for (const p of presets.value) if (p.title in embPresets) p.on = embPresets[p.title];
        }
        log("Controls preloaded from the image's prompt, seed, LoRAs, and preset");
        return true;
      } catch { return false; }
    }

    // Legacy fallback: pull prompt/LoRA/frames out of an embedded APP VIDEO
    // graph when structural recognition finds nothing.
    function applyEmbeddedConfig(wf) {
      const nodes = wf.nodes || [];
      let embeddedPrompt = '', embeddedFrames = null, hasLoraLoader = false;
      const embeddedLoras = [];
      for (const node of nodes) {
        const title = (node.title || '').toUpperCase();
        if (title.includes('MAIN') && title.includes('PROMPT')) {
          const wv = node.widgets_values || [];
          if (typeof wv[0] === 'string') embeddedPrompt = wv[0];
        }
        if (title === 'FRAMES' && node.type === 'mxSlider') {
          const wv = node.widgets_values || [];
          embeddedFrames = typeof wv[0] === 'number' ? wv[0] : null;
        }
        if ((node.type || '').includes('Power Lora Loader') && !hasLoraLoader) {
          hasLoraLoader = true;
          (node.widgets_values || []).forEach((v, i) => {
            if (v && typeof v === 'object' && v.lora) {
              embeddedLoras.push({ slot: i, on: !!v.on, strength: v.strength || 1, lora: v.lora });
            }
          });
        }
      }
      if (!hasLoraLoader && embeddedFrames === null) return;

      const videoOpt = wfOptions.value.find(w => w.name.includes('VIDEO'));
      if (videoOpt) { wfName.value = videoOpt.name; LS.set('archiveWorkflowSelect', videoOpt.name); }
      if (embeddedPrompt) { promptText.value = embeddedPrompt; showPrompt.value = true; }
      if (embeddedLoras.length > 0) {
        hasHLLoras.value = false; lorasHigh.value = []; lorasLow.value = [];
        loras.value = embeddedLoras;
        showLora.value = true;
      }
      if (embeddedFrames !== null) {
        showFrames.value = true;
        frames.value = embeddedFrames <= 49 ? '49' : (embeddedFrames <= 121 ? '121' : 'inherit');
      }
    }

    // ── Metadata load ─────────────────────────────────────────────────────
    function applyBoot() {
      const q = route.query;
      filePath.value = String(q.path || '');
      fileName.value = String(q.name || (filePath.value.split(/[\\/]/).pop() || ''));
      isVideo.value = String(q.type || 'image') === 'video';
      document.title = 'Workflow - ' + fileName.value;
    }

    async function loadMetadata() {
      metaLoading.value = true; metaError.value = ''; noMeta.value = false;
      promptData.value = null; workflowData.value = null;
      workingPrompt.value = null; workingWorkflow.value = null;
      editedIds.value = new Set(); editingId.value = null; nodeSearch.value = '';
      favDone.value = false;
      // Everything below belonged to the file we are leaving. As a standalone
      // page these reset because opening another file was a page load; as a route
      // they persist, and each one misattributes the old file's state to the new:
      //   hasInherit       -> one file without a graph removes Inherit for every
      //                       file after it, for the rest of the session
      //   fileHasNoEmbeddedWf -> offers to "save the workflow into the file" over
      //                       a file that already has one
      hasInherit.value = true;
      fileHasNoEmbeddedWf.value = false;
      status.value = 'Fetching: ' + metaUrl.value.substring(0, 80) + '...';

      let data;
      try {
        data = await api.metadata(filePath.value);
      } catch (e) {
        metaLoading.value = false;
        metaError.value = e.message;
        status.value = 'Error: ' + e.message;
        return;
      }
      metaLoading.value = false;

      if (!data.prompt && !data.workflow) {
        noMeta.value = true;
        status.value = 'No metadata';
        fileHasNoEmbeddedWf.value = true;
        // Nothing to inherit, but an APP workflow can still be run against this
        // file (images upload into its MAIN IMAGE node), so keep the run
        // controls and drop the Inherit option.
        showRun.value = true;
        hasInherit.value = false;
        await wfReady;
        if (!wfName.value || wfName.value === 'inherit') {
          const first = wfOptions.value[0];
          if (first) { wfName.value = first.name; await loadWorkflowConfig(first.name); }
        }
        updateApplyBtnVisibility();
        return;
      }

      promptData.value = data.prompt;
      workflowData.value = data.workflow || null;
      // Working copy for edits, plus the visual graph: nodes that introspect the
      // graph (WidgetToString and friends) read extra_pnginfo["workflow"] and
      // crash on None if it isn't submitted alongside the prompt.
      workingPrompt.value = data.prompt ? JSON.parse(JSON.stringify(data.prompt)) : null;
      workingWorkflow.value = data.workflow || null;
      status.value = 'Rendering...';
      if (data.prompt) showRun.value = true;

      if (data.workflow && data.workflow.nodes) {
        recognizeWorkflow(data.workflow).then(matched => { if (!matched) applyEmbeddedConfig(data.workflow); });
      }
      updateCopyPromptBtn();
      if (wfName.value === 'inherit') setupInheritControls();
      updateApplyBtnVisibility();
      status.value = '';
    }

    // ── Detected Fields ───────────────────────────────────────────────────
    const WIDE_KINDS = new Set(['prompt', 'negative_prompt', 'lora_list', 'image_input', 'video_input', 'audio_input']);
    const fieldConfig = ref(null);
    const fieldsMode = ref(false);
    const fieldsMsg = ref('');

    async function loadFieldConfig(name) {
      if (!name || name === 'inherit') { fieldConfig.value = null; fieldsMode.value = false; return; }
      let cfg = null;
      try { cfg = await api.fieldConfig(name); } catch { cfg = null; }
      if (!cfg || cfg.error || !Array.isArray(cfg.fields)) { fieldConfig.value = null; fieldsMode.value = false; return; }
      // A lora_rows control renders (and mutates) an array in place, so give it
      // one up front rather than patching f.value from inside the template.
      for (const f of cfg.fields) {
        if ((f.control && f.control.type) === 'lora_rows' && !Array.isArray(f.value)) f.value = [];
      }
      fieldConfig.value = cfg;
      prefillFieldsFromMedia();
      setFieldsMode(LS.get('archiveClassic_' + name) !== '1');
    }
    function setFieldsMode(on) {
      fieldsMode.value = on;
      const name = wfName.value;
      if (name && name !== 'inherit') LS.set('archiveClassic_' + name, on ? '' : '1');
    }
    // A generated file carries the prompt/seed that made it — preload those so
    // opening your own video shows its prompt, not the workflow file's default.
    function prefillFieldsFromMedia() {
      if (!fieldConfig.value) return;
      try {
        const p = extractImagePrompt();
        if (p && p.trim()) {
          const pf = fieldConfig.value.fields.find(f => f.kind === 'prompt' && !f.variant);
          if (pf) pf.value = p;
        }
        const s = extractImageSeed();
        if (s != null && Number(s) >= 0) {
          const sf = fieldConfig.value.fields.find(f => f.kind === 'seed');
          if (sf) sf.value = s;
        }
      } catch {}
    }

    const loraLast = (a, b) => (/^lora/.test(a.kind) ? 1 : 0) - (/^lora/.test(b.kind) ? 1 : 0);
    const enabledFields = computed(() => (fieldConfig.value ? fieldConfig.value.fields.filter(f => f.enabled).slice().sort(loraLast) : []));
    const hiddenFields = computed(() => (fieldConfig.value ? fieldConfig.value.fields.filter(f => !f.enabled).slice().sort(loraLast) : []));
    const loraPair = computed(() => {
      const hi = enabledFields.value.find(f => f.kind === 'lora_list' && f.variant === 'high');
      const lo = enabledFields.value.find(f => f.kind === 'lora_list' && f.variant === 'low');
      return hi && lo ? { hi, lo } : null;
    });
    // Narrow controls share a flex row; prompts, LoRA lists and media pickers
    // take a row of their own. Grouping is a computed list of blocks so the
    // template stays declarative instead of appending into a container.
    const fieldBlocks = computed(() => {
      const blocks = [];
      const pair = loraPair.value;
      let grid = null;
      for (const f of enabledFields.value) {
        if (pair && (f === pair.hi || f === pair.lo)) {
          if (f === pair.hi) { grid = null; blocks.push({ type: 'pair', hi: pair.hi, lo: pair.lo, key: 'pair-' + pair.hi.id }); }
          continue;
        }
        if (WIDE_KINDS.has(f.kind)) { grid = null; blocks.push({ type: 'field', field: f, key: 'f-' + f.id }); }
        else {
          if (!grid) { grid = { type: 'grid', fields: [], key: 'g-' + f.id }; blocks.push(grid); }
          grid.fields.push(f);
        }
      }
      return blocks;
    });

    function saveFieldEdits() {
      const name = wfName.value;
      if (!fieldConfig.value || name === 'inherit') return;
      // Persist `enabled` ONLY where it differs from what detection recommends.
      // Saving every field froze that run's defaults forever: better detection
      // could never switch a field back on, and rewiring the graph left dead
      // fields stuck on. Labels have no detectable default, so they ride along.
      const edits = {};
      for (const f of fieldConfig.value.fields) {
        const e = { label: f.label };
        if (!!f.enabled !== !!f.recommended) e.enabled = !!f.enabled;
        edits[f.id] = e;
      }
      postJson('/api/workflow-field-config', { name, edits })
        .then(r => r.json())
        .then(r => {
          fieldsMsg.value = r.ok ? 'Saved.' : ('Save failed: ' + (r.error || ''));
          setTimeout(() => { fieldsMsg.value = ''; }, 2500);
        })
        .catch(e => { fieldsMsg.value = 'Save failed: ' + e.message; });
    }
    function fieldsSeedPinnedNow() {
      if (!fieldsMode.value || !fieldConfig.value) return false;
      const sf = fieldConfig.value.fields.find(f => f.kind === 'seed' && f.enabled);
      return !!(sf && sf.__seedPinned && String(sf.value == null ? '' : sf.value).trim() !== '' && Number(sf.value) >= 0);
    }
    function collectFieldValues(presetTitle) {
      const fv = {};
      if (fieldConfig.value) for (const f of fieldConfig.value.fields) {
        if (!f.enabled) continue;
        const t = (f.control && f.control.type) || 'text';
        if (f.kind === 'seed') {
          if (f.__seedPinned && String(f.value == null ? '' : f.value).trim() !== '' && Number(f.value) >= 0) fv[f.id] = parseInt(f.value, 10);
          continue;
        }
        if (t === 'lora_rows') { fv[f.id] = (f.value || []).map(r => ({ slot: r.slot, on: r.on, strength: r.strength })); continue; }
        if (t === 'boolean') { fv[f.id] = !!f.value; continue; }
        if (f.value !== '' && f.value != null) {
          fv[f.id] = (f.kind === 'prompt' || f.kind === 'negative_prompt') ? applyReplacements(f.value) : f.value;
        }
      }
      if (presetTitle) fv.__preset = presetTitle;
      return fv;
    }

    // ── Prompt replacements ───────────────────────────────────────────────
    // Global find→replace rules with toggles, applied to the prompt right before
    // a run. Each row keeps its saved value plus a draft, so an edited word turns
    // the ✕ into ✓ (tap to save) instead of saving on every keystroke.
    const replacements = ref([]);
    const withDraft = list => list.map(r => ({ from: r.from || '', to: r.to || '', on: !!r.on, __from: r.from || '', __to: r.to || '' }));
    const packRepl = () => replacements.value.map(r => ({ from: r.from, to: r.to, on: r.on }));
    const activeReplacements = () => replacements.value.filter(r => r.on && r.from && r.from.trim());
    const replaceSummary = computed(() => {
      const n = activeReplacements().length, total = replacements.value.length;
      return n ? ' — ' + n + ' active' : (total ? ' — ' + total + ' off' : '');
    });
    const allReplChecked = computed(() => replacements.value.length > 0 && replacements.value.every(r => r.on));
    const allReplIndeterminate = computed(() => {
      const on = replacements.value.filter(r => r.on).length;
      return on > 0 && on < replacements.value.length;
    });
    function saveReplacements() {
      LS.set('archiveReplacements', JSON.stringify(packRepl()));       // local cache
      postJson('/api/replacements', { replacements: packRepl() }).catch(() => {});
    }
    const isReplDirty = r => r.__from !== r.from || r.__to !== r.to;
    function commitRepl(r) { r.from = r.__from; r.to = r.__to; saveReplacements(); }
    function swapRepl(r) { const a = r.__from; r.__from = r.__to; r.__to = a; commitRepl(r); }
    function replAct(r, i) {
      if (isReplDirty(r)) { commitRepl(r); return; }
      replacements.value.splice(i, 1);
      saveReplacements();
    }
    function toggleAllRepl(on) { replacements.value.forEach(r => { r.on = on; }); saveReplacements(); }
    function addReplacement() {
      replacements.value.push({ from: '', to: '', on: true, __from: '', __to: '' });
      saveReplacements();
    }
    function loadReplacements() {
      // Instant paint from the local cache, then the server copy (shared across
      // devices) wins. One-time migration: push a legacy local-only list up.
      try { replacements.value = withDraft(JSON.parse(LS.get('archiveReplacements', '[]'))); } catch {}
      getJson('/api/replacements').then(d => {
        const serverList = Array.isArray(d.replacements) ? d.replacements : [];
        if (serverList.length === 0 && replacements.value.length > 0) saveReplacements();
        else {
          replacements.value = withDraft(serverList);
          LS.set('archiveReplacements', JSON.stringify(packRepl()));
        }
      }).catch(() => {});
    }

    const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    function applyReplacements(text) {
      if (typeof text !== 'string') return text;
      let out = text;
      for (const r of activeReplacements()) out = out.replace(new RegExp(escRe(r.from), 'gi'), r.to);
      return out;
    }
    // For inherited runs the prompt lives in the graph's string inputs — skip
    // model/sampler/file/numeric-ish keys so only prompt text is touched.
    const REPL_SKIP_KEY = /_name$|name$|filename|ckpt|lora|vae|sampler|scheduler|model|path|url|format|extension|seed|width|height|steps|cfg/i;
    function applyReplacementsToNodes(prompt) {
      if (!activeReplacements().length) return prompt;
      for (const node of Object.values(prompt)) {
        if (!node || !node.inputs) continue;
        for (const key of Object.keys(node.inputs)) {
          if (typeof node.inputs[key] !== 'string' || REPL_SKIP_KEY.test(key)) continue;
          node.inputs[key] = applyReplacements(node.inputs[key]);
        }
      }
      return prompt;
    }

    // ── Execution log / progress ──────────────────────────────────────────
    const execVisible = ref(false);
    const logLines = ref([]);
    const progressPct = ref(0);
    const progressCls = ref('');
    const execLogEl = ref(null);
    const running = ref(false);
    const queued = ref(false);
    const runProgress = ref('');
    const saveLogLabel = ref('Save Log');
    let ws = null;
    let currentPromptId = null;
    let jobChannel = null;

    function log(text, cls) {
      logLines.value.push({ text, cls: cls || '' });
      nextTick(() => { const el = execLogEl.value; if (el) el.scrollTop = el.scrollHeight; });
    }
    const logText = () => logLines.value.map(l => l.text).join('\n');

    // ── Building a prompt to run ──────────────────────────────────────────
    // Write the inherit-mode edits (prompt text, LoRA toggles/strengths, pinned
    // seed) into a clone of the file's own prompt before submitting.
    function applyInheritEdits(prompt) {
      const r = inheritPromptRef.value;
      if (r && showPrompt.value && prompt[r.nodeId] && prompt[r.nodeId].inputs && promptText.value !== r.text) {
        prompt[r.nodeId].inputs[r.key] = promptText.value;
        log('Prompt edited for this run');
      }
      for (const l of loras.value) {
        const n = prompt[l.nodeId];
        if (!n || !n.inputs) continue;
        if (l.kind === 'power' && n.inputs[l.key] && typeof n.inputs[l.key] === 'object') {
          n.inputs[l.key].on = l.on;
          n.inputs[l.key].strength = l.strength;
        } else if (l.kind === 'plain') {
          // A plain LoraLoader has no on/off — strength 0 disables it.
          n.inputs.strength_model = l.on ? l.strength : 0;
          if ('strength_clip' in n.inputs) n.inputs.strength_clip = l.on ? l.strength : 0;
        } else if (l.kind === 'lm') {
          const arr = n.inputs.loras && n.inputs.loras.__value__;
          if (Array.isArray(arr) && arr[l.idx]) { arr[l.idx].active = l.on; arr[l.idx].strength = l.strength; }
        }
      }
      if (seedPinned.value) {
        const v = parseInt(seedValue.value, 10);
        for (const n of Object.values(prompt)) {
          if (!n.inputs) continue;
          for (const k of Object.keys(n.inputs)) {
            if (k.includes('seed') && typeof n.inputs[k] === 'number') n.inputs[k] = v;
          }
        }
      }
      return prompt;
    }

    async function getRunPrompt(presetTitle) {
      const sel = wfName.value;
      if (sel === 'inherit') {
        let p = JSON.parse(JSON.stringify(workingPrompt.value));
        p = applyInheritEdits(p);
        p = applyReplacementsToNodes(p);
        if (activeReplacements().length) log('Applied ' + activeReplacements().length + ' prompt replacement(s)');
        return p;
      }
      // Config-driven path: send generic field values and let the server apply
      // them to the graph. The run loop still handles MAIN IMAGE upload and seed
      // randomization on whatever comes back.
      if (fieldsMode.value && fieldConfig.value) {
        const resp = await postJson('/api/workflow-prompt?name=' + enc(sel), { fieldValues: collectFieldValues(presetTitle) });
        if (!resp.ok) throw new Error('Failed to load workflow: HTTP ' + resp.status);
        const data = await resp.json();
        if (data.error) throw new Error(data.error);
        if (Array.isArray(data.fieldWarnings)) data.fieldWarnings.forEach(w => log('field: ' + w, 'log-err'));
        appWorkflowGraph.value = data.workflow || null;
        return data.prompt || data;
      }

      const overrides = {};
      if (promptText.value.trim()) {
        overrides.prompt = applyReplacements(promptText.value);
        if (activeReplacements().length && overrides.prompt !== promptText.value) log('Applied prompt replacement(s)');
      }
      const packLoras = arr => arr.map(l => ({ slot: l.slot, on: l.on, strength: l.strength }));
      if (hasHLLoras.value) {
        if (lorasHigh.value.length) overrides.lorasHigh = packLoras(lorasHigh.value);
        if (lorasLow.value.length) overrides.lorasLow = packLoras(lorasLow.value);
      } else if (loras.value.length > 0) {
        overrides.loras = packLoras(loras.value);
      }
      if (frames.value !== 'inherit') overrides.frames = parseInt(frames.value);
      if (hasStepsControl.value && String(stepsValue.value).trim()) overrides.steps = parseInt(stepsValue.value);
      if (hasCfgControl.value && String(cfgValue.value).trim()) overrides.cfg = parseFloat(cfgValue.value);
      if (hasHLControl.value) {
        const h = parseInt(highStepsValue.value, 10), l = parseInt(lowStepsValue.value, 10);
        if (!isNaN(h) && !isNaN(l) && h >= 0 && l >= 0 && h + l > 0) { overrides.highSteps = h; overrides.lowSteps = l; }
      }
      if (seedPinned.value) overrides.seed = parseInt(seedValue.value, 10);
      if (presetTitle) overrides.preset = presetTitle;

      const resp = await postJson('/api/workflow-prompt?name=' + enc(sel), overrides);
      if (!resp.ok) throw new Error('Failed to load workflow: HTTP ' + resp.status);
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      const wfPrompt = data.prompt || data;                 // {prompt, workflow}, older shape as fallback
      appWorkflowGraph.value = data.workflow || null;       // submitted as extra_pnginfo

      if (IMAGE_EXT.includes(extOf(fileName.value))) {
        for (const [id, node] of Object.entries(wfPrompt)) {
          const title = ((node._meta && node._meta.title) || '').toUpperCase();
          if (title.includes('MAIN IMAGE') && node.inputs) {
            node.inputs.image = fileName.value;
            log('Set MAIN IMAGE node [' + id + '] to: ' + fileName.value);
          }
        }
      }
      return wfPrompt;
    }

    // ── Uploads ───────────────────────────────────────────────────────────
    async function uploadBlobToComfy(blob, ext) {
      const uploadName = 'app_input_' + Date.now() + '.' + (ext || 'png');
      const fd = new FormData();
      fd.append('image', blob, uploadName);
      fd.append('overwrite', 'true');
      const resp = await fetch('/api/comfy/upload/image', { method: 'POST', credentials: 'same-origin', body: fd });
      if (!resp.ok) { log('Upload POST failed: HTTP ' + resp.status, 'log-err'); return null; }
      const result = await resp.json();
      log('ComfyUI upload result: ' + JSON.stringify(result));
      return result.name || uploadName;
    }
    async function uploadImageToComfy(imagePath) {
      const imgResp = await fetch(fileUrl(imagePath), { credentials: 'same-origin' });
      if (!imgResp.ok) { log('Upload fetch failed: HTTP ' + imgResp.status, 'log-err'); return null; }
      const blob = await imgResp.blob();
      const origName = imagePath.split(/[\\/]/).pop();
      return uploadBlobToComfy(blob, origName.includes('.') ? origName.split('.').pop() : 'png');
    }
    // Decode the first frame of a video in the browser, as a PNG blob — no
    // server round trip, works for any codec the browser can play.
    function firstVideoFrameBlob(videoUrl) {
      return new Promise((resolve, reject) => {
        const v = document.createElement('video');
        v.muted = true; v.playsInline = true; v.preload = 'auto';
        let settled = false;
        const finish = (fn, arg) => { if (!settled) { settled = true; v.removeAttribute('src'); v.load(); fn(arg); } };
        v.onerror = () => finish(reject, new Error('the browser could not decode this video'));
        // Seek just past 0 once data exists — 'seeked' guarantees a drawable frame.
        v.onloadeddata = () => { try { v.currentTime = 0.001; } catch {} };
        v.onseeked = () => {
          if (settled) return;
          try {
            const c = document.createElement('canvas');
            c.width = v.videoWidth; c.height = v.videoHeight;
            if (!c.width || !c.height) return finish(reject, new Error('video has no dimensions'));
            c.getContext('2d').drawImage(v, 0, 0);
            c.toBlob(b => (b ? finish(resolve, b) : finish(reject, new Error('canvas export failed'))), 'image/png');
          } catch (e) { finish(reject, e); }
        };
        setTimeout(() => finish(reject, new Error('timed out decoding the video')), 20000);
        v.src = videoUrl;
      });
    }

    // ── ComfyUI availability ──────────────────────────────────────────────
    async function comfyUp(timeoutMs) {
      try {
        const r = await fetch('/api/comfy/system_stats', { credentials: 'same-origin', signal: AbortSignal.timeout(timeoutMs || 4000) });
        return r.ok;
      } catch { return false; }
    }
    // Upload, queue and the WS all need ComfyUI up. If it's down, offer to launch
    // it through the server and poll until the API answers.
    async function ensureComfyRunning() {
      statusColor.value = '';
      status.value = 'Checking ComfyUI...';
      if (await comfyUp()) return true;

      statusColor.value = '#ff453a';
      status.value = 'ComfyUI is not running';
      if (!window.confirm('ComfyUI is not running.\n\nStart it now? Model load usually takes 30–90 seconds.')) return false;

      let data = {};
      try { data = await (await postJson('/api/comfy/start')).json(); } catch {}
      if (!data.started && !data.running) {
        showToast('Could not start ComfyUI: ' + (data.error || 'unknown error'), 5000);
        return false;
      }
      const t0 = Date.now(), deadline = t0 + 180000;
      statusColor.value = '#ff9f0a';
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 3000));
        if (await comfyUp(2500)) { statusColor.value = ''; status.value = 'ComfyUI ready'; return true; }
        status.value = 'Starting ComfyUI… ' + Math.round((Date.now() - t0) / 1000) + 's';
      }
      statusColor.value = '#ff453a';
      status.value = 'ComfyUI did not come up within 3 minutes — check its console/logs';
      return false;
    }

    // ── Run ───────────────────────────────────────────────────────────────
    const outputs = ref([]);
    const outputSelected = ref(new Set());
    const outputFaved = ref(new Set());
    const overlayOpen = ref(false);
    const overlayIndex = ref(0);
    let disposed = false;         // set on unmount so the socket's onclose can't reconnect

    async function onRun() {
      if (!promptData.value && wfName.value === 'inherit') return;
      if (!(await ensureComfyRunning())) return;

      const count = parseInt(runCount.value) || 1;
      // Each ticked preset runs separately (they're mutually exclusive).
      const selectedPresets = (presets.value.length && presets.value.some(p => p.on))
        ? presets.value.filter(p => p.on).map(p => p.title) : [null];
      // Pinning is explicit (📌) — a number in the box doesn't pin by itself.
      // Anything else randomizes, which also keeps ComfyUI from serving the whole
      // graph out of cache because every input matched a previous run.
      const pinned = seedPinned.value || fieldsSeedPinnedNow();
      const totalRuns = selectedPresets.length * count;
      let runIndex = 0;

      const runStartTime = Date.now();
      // Snapshot the existing outputs so only genuinely new files show up. The
      // client clock (a phone) can be skewed against the server's mtimes, so the
      // scans below reuse this 24h window and trust the set-diff, not the clock.
      const preExisting = new Set();
      let snapshotOk = false;
      try {
        const preFiles = await getJson('/api/recent-outputs?since=' + (runStartTime - 86400000));
        (preFiles || []).forEach(f => preExisting.add(f.path));
        snapshotOk = true;
      } catch {}

      running.value = true;
      execVisible.value = true;
      logLines.value = [];
      outputs.value = [];
      outputSelected.value = new Set();
      outputFaved.value = new Set();
      const shownOutputPaths = new Set();

      // Scan outputs after each run so thumbnails appear live rather than all at
      // the end of the batch.
      async function scanNewOutputs() {
        try {
          const since = snapshotOk ? (runStartTime - 86400000) : runStartTime;
          const allRecent = await getJson('/api/recent-outputs?since=' + since);
          const fresh = (allRecent || []).filter(f => !preExisting.has(f.path) && !shownOutputPaths.has(f.path));
          if (fresh.length) {
            // recent-outputs is oldest-first, so append order tracks completion.
            fresh.forEach(f => shownOutputPaths.add(f.path));
            outputs.value.push(...fresh);
            jobRecord.results = outputs.value.map(f => ({ path: f.path, name: f.name, thumbPath: f.thumbPath }));
            JobDB.put(jobRecord).catch(() => {});
          }
          return fresh.length;
        } catch { return 0; }
      }

      // An APP workflow with a MAIN IMAGE node gets this file uploaded first. For
      // a video the first frame goes up instead — otherwise the workflow runs on
      // its own baked-in default image and nothing says so.
      let uploadedImageName = null;
      if (wfName.value !== 'inherit') {
        const ext = extOf(fileName.value);
        if (IMAGE_EXT.includes(ext)) {
          status.value = 'Uploading image to ComfyUI...';
          log('Uploading image for MAIN IMAGE...');
          uploadedImageName = await uploadImageToComfy(filePath.value);
          if (uploadedImageName) log('Uploaded as: ' + uploadedImageName);
          else log('Upload failed, continuing anyway', 'log-err');
        } else if (VIDEO_EXT.includes(ext)) {
          status.value = 'Extracting first video frame...';
          log("Extracting the video's first frame for MAIN IMAGE...");
          try {
            const frame = await firstVideoFrameBlob(fileUrl(filePath.value));
            uploadedImageName = await uploadBlobToComfy(frame, 'png');
            if (uploadedImageName) log('First frame uploaded as: ' + uploadedImageName);
            else log("Frame upload failed — the workflow's own MAIN IMAGE will be used.", 'log-err');
          } catch (e) {
            log('Could not extract a frame from this video (' + e.message + ") — the workflow's own MAIN IMAGE will be used.", 'log-err');
          }
        }
      }

      let jobPromptText = promptText.value;
      let jobLoras = hasHLLoras.value
        ? [...lorasHigh.value, ...lorasLow.value].filter(l => l.on).map(l => ({ slot: l.slot, on: l.on, strength: l.strength }))
        : (loras.value.length > 0 ? loras.value.map(l => ({ slot: l.slot, on: l.on, strength: l.strength })) : null);
      // In fields mode the prompt/LoRAs live in the detected-fields panel, not in
      // the (hidden) classic controls — read them from there for job history.
      if (fieldsMode.value && fieldConfig.value) {
        const pf = fieldConfig.value.fields.find(f => f.kind === 'prompt' && f.enabled);
        if (pf) jobPromptText = String(pf.value == null ? '' : pf.value);
        jobLoras = fieldConfig.value.fields
          .filter(f => f.kind === 'lora_list' && f.enabled)
          .flatMap(f => f.value || [])
          .filter(l => l.on)
          .map(l => ({ slot: l.slot, on: l.on, strength: l.strength }));
      }
      const jobRecord = {
        id: 'job-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
        workflow: wfName.value === 'inherit' ? 'Inherited' : wfName.value.replace(/^APP /, '').replace(/\.json$/, ''),
        workflowFile: wfName.value,
        prompt: jobPromptText.substring(0, 200) || '(inherited)',
        fullPrompt: jobPromptText || '',
        loras: jobLoras,
        frames: frames.value !== 'inherit' ? frames.value : null,
        sourceFile: fileName.value,
        sourcePath: filePath.value,
        sourceImageUrl: fileUrl(filePath.value),
        status: 'running',
        runs: totalRuns,
        presets: selectedPresets.filter(Boolean),
        runsCompleted: 0,
        startTime: runStartTime,
        endTime: null,
        promptIds: [],
        results: [],
      };
      try { await JobDB.put(jobRecord); } catch {}

      if (pinned && count > 1) {
        log('⚠ Seed is pinned (' + String(seedValue.value).trim() + ') — the ' + count
          + ' runs per preset will produce identical images. Clear the Seed box (🎲) for variations.', 'log-err');
      }

      let aborted = false;
      for (const preset of selectedPresets) {
        if (aborted) break;
        for (let run = 0; run < count; run++) {
          runIndex++;
          const label = (preset ? preset + ' ' : '') + (count > 1 ? '#' + (run + 1) : '');
          if (totalRuns > 1) {
            runProgress.value = runIndex + '/' + totalRuns + (label ? ' — ' + label : '');
            log('--- Run ' + runIndex + '/' + totalRuns + (preset ? ' [' + preset + ']' : '')
              + (count > 1 ? ' (' + (run + 1) + '/' + count + ')' : '') + ' ---');
          } else if (preset) {
            log('--- Preset: ' + preset + ' ---');
          }

          let runPrompt;
          try {
            runPrompt = await getRunPrompt(preset);
          } catch (e) {
            log('Error loading workflow: ' + e.message, 'log-err');
            status.value = 'Error: ' + e.message;
            aborted = true;
            break;
          }

          if (uploadedImageName && wfName.value !== 'inherit') {
            for (const node of Object.values(runPrompt)) {
              const title = ((node._meta && node._meta.title) || '').toUpperCase();
              if (title.includes('MAIN IMAGE') && node.inputs) node.inputs.image = uploadedImageName;
            }
          }

          // Randomize every seed input unless one is pinned, and strip is_changed.
          for (const node of Object.values(runPrompt)) {
            if (node.inputs && !pinned) {
              for (const key of Object.keys(node.inputs)) {
                if (key.includes('seed') && typeof node.inputs[key] === 'number') {
                  node.inputs[key] = Math.floor(Math.random() * 2147483647);
                  // Remember the main seed so 📌 can pin "what I just got".
                  if (node.class_type === 'Seed (rgthree)' || key === 'noise_seed' || key === 'seed') {
                    lastUsedSeed = node.inputs[key];
                  }
                }
              }
            }
            delete node.is_changed;
          }
          if (!pinned && lastUsedSeed !== null) seedPlaceholder.value = 'random (last: ' + lastUsedSeed + ')';

          jobRecord.nodeMap = Object.fromEntries(Object.entries(runPrompt)
            .map(([id, n]) => [id, (n._meta && n._meta.title) || n.class_type || id]));
          jobRecord.totalNodes = Object.keys(runPrompt).length;

          const ok = await executePrompt(runPrompt, pid => {
            jobRecord.promptIds.push(pid);
            JobDB.put(jobRecord).catch(() => {});
          });
          if (ok) {
            jobRecord.runsCompleted++;
            await new Promise(r => setTimeout(r, 500));   // brief pause for the disk flush
            await scanNewOutputs();
          } else {
            jobRecord.status = 'error';
            jobRecord.endTime = Date.now();
            try { await JobDB.put(jobRecord); } catch {}
            aborted = true;
            break;
          }
        }
      }

      running.value = false;
      queued.value = false;
      runProgress.value = '';

      // Catch-up scan for stragglers that hadn't flushed when their run finished.
      await new Promise(r => setTimeout(r, 1000));
      await scanNewOutputs();
      log('Batch complete — ' + outputs.value.length + ' output file(s).');
      if (outputs.value.length === 0 && jobRecord.runsCompleted > 0) {
        log('⚠ Runs "succeeded" but produced no new files — ComfyUI served everything from cache. This happens when the seed and all settings exactly match a previous run. Clear the Seed box (🎲) or change a setting, then re-run.', 'log-err');
      }


      if (jobRecord.status === 'running') {
        jobRecord.status = jobRecord.runsCompleted === count ? 'complete' : 'error';
      }
      jobRecord.endTime = Date.now();
      try { await JobDB.put(jobRecord); } catch {}

    }

    function executePrompt(prompt, onPromptId) {
      return new Promise(resolve => {
        const totalNodes = Object.keys(prompt).length;
        let nodesCompleted = 0;
        const nodeMap = Object.fromEntries(Object.entries(prompt)
          .map(([id, n]) => [id, (n._meta && n._meta.title) || n.class_type || id]));

        const clientId = crypto.randomUUID ? crypto.randomUUID() : 'cl-' + Date.now() + '-' + Math.random().toString(36).slice(2);
        let wsReconnects = 0;
        let submitted = false;

        status.value = 'Connecting...';
        progressPct.value = 0;
        progressCls.value = '';

        function done(ok) {
          progressPct.value = 100;
          progressCls.value = ok ? 'done' : 'err';
          if (ws) { ws.close(); ws = null; }
          currentPromptId = null;
          resolve(ok);
        }

        function onWsMessage(evt) {
          if (typeof evt.data !== 'string') return;
          let msg;
          try { msg = JSON.parse(evt.data); } catch { return; }
          const d = msg.data || {};
          if (d.prompt_id && d.prompt_id !== currentPromptId) return;
          const post = m => { if (jobChannel) jobChannel.postMessage(m); };

          switch (msg.type) {
            case 'execution_start':
              status.value = 'Running...';
              log('Execution started');
              post({ type: 'executing', promptId: currentPromptId, node: 'Starting...', pct: 0 });
              break;
            case 'execution_cached':
              if (d.nodes) {
                nodesCompleted += d.nodes.length;
                log('Cached: ' + d.nodes.length + ' node(s) skipped');
                progressPct.value = Math.round(nodesCompleted / totalNodes * 100);
              }
              break;
            case 'executing': {
              if (d.node == null) break;
              const name = nodeMap[d.node] || d.node;
              status.value = 'Running — ' + name;
              log('▶ [' + d.node + '] ' + name);
              post({ type: 'executing', promptId: currentPromptId, node: name, pct: null });
              break;
            }
            case 'executed':
              nodesCompleted++;
              progressPct.value = Math.round(nodesCompleted / totalNodes * 100);
              status.value = 'Running (' + nodesCompleted + '/' + totalNodes + ')';
              if (d.output) {
                (d.output.images || d.output.gifs || []).forEach(f => {
                  if (f.filename && (f.type === 'output' || f.type === 'temp')) {
                    log('Output: subfolder=' + JSON.stringify(f.subfolder) + ' file=' + f.filename);
                  }
                });
              }
              break;
            case 'progress':
              if (d.max > 0) {
                const pct = Math.round(d.value / d.max * 100);
                status.value = 'Running — step ' + d.value + '/' + d.max + ' (' + pct + '%)';
                post({ type: 'progress', promptId: currentPromptId, pct });
              }
              break;
            case 'execution_success':
              status.value = 'Complete!';
              log('Workflow completed successfully!', 'log-done');
              post({ type: 'done', promptId: currentPromptId, ok: true });
              done(true);
              break;
            case 'execution_error':
              status.value = 'Error: ' + (d.exception_message || 'unknown');
              log('Error in node ' + d.node_id + ' (' + (d.node_type || '') + '): ' + (d.exception_message || ''), 'log-err');
              post({ type: 'done', promptId: currentPromptId, ok: false });
              done(false);
              break;
            case 'execution_interrupted':
              status.value = 'Interrupted';
              log('Execution interrupted', 'log-err');
              post({ type: 'done', promptId: currentPromptId, ok: false });
              done(false);
              break;
          }
        }

        function connectWs() {
          try {
            ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/comfy-ws?clientId=' + clientId);
            ws.binaryType = 'arraybuffer';
          } catch (e) {
            log('WebSocket create error: ' + e.message, 'log-err');
            done(false);
            return;
          }
          ws.onmessage = onWsMessage;
          ws.onerror = () => { log('WebSocket error', 'log-err'); };
          ws.onclose = () => {
            // Unmounting closes the socket, which lands here — without this the
            // teardown reconnects up to three times, each holding a proxied
            // ComfyUI connection open on behalf of a destroyed component.
            if (disposed) return;
            if (currentPromptId && wsReconnects < 3) {
              wsReconnects++;
              log('WebSocket dropped, reconnecting (' + wsReconnects + '/3)...');
              setTimeout(connectWs, 1000);
            } else if (currentPromptId) {
              log('WebSocket closed after ' + wsReconnects + ' retries', 'log-err');
              done(false);
            }
          };
          ws.onopen = async () => {
            log('WebSocket connected');
            if (submitted) return;
            submitted = true;
            status.value = 'Queueing workflow...';
            log('Submitting workflow (' + totalNodes + ' nodes)...');
            try {
              const payload = { prompt, client_id: clientId };
              // The matching visual graph rides along as extra_pnginfo: nodes
              // that introspect the graph need it, and it lands in the output
              // file's metadata so the result can be inherited later.
              const pnGraph = wfName.value === 'inherit' ? workingWorkflow.value : appWorkflowGraph.value;
              if (pnGraph) payload.extra_data = { extra_pnginfo: { workflow: pnGraph } };
              const body = JSON.stringify(payload);
              log('Payload: ' + (body.length / 1024).toFixed(1) + ' KB');
              const resp = await fetch('/api/comfy/api/prompt', {
                method: 'POST', credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body,
              });
              log('Response: HTTP ' + resp.status);
              const result = await resp.json();
              if (result.error) {
                log('Error: ' + (result.error.message || JSON.stringify(result.error)), 'log-err');
                if (result.node_errors) {
                  for (const [nid, ne] of Object.entries(result.node_errors)) {
                    const errs = (ne.errors || []).map(e => e.message).join('; ');
                    if (errs) log('  Node [' + nid + ']: ' + errs, 'log-err');
                  }
                }
                done(false);
                return;
              }
              // ComfyUI can answer 200 + prompt_id and still have rejected nodes:
              // it drops the invalid subtree and runs the rest (often just display
              // nodes → instant "success" with no images). Treat that as failure.
              if (result.node_errors && Object.keys(result.node_errors).length > 0) {
                log('ComfyUI rejected ' + Object.keys(result.node_errors).length + ' node(s) — the run would produce no output. Aborting.', 'log-err');
                for (const [nid, ne] of Object.entries(result.node_errors)) {
                  for (const err of (ne.errors || [])) {
                    log('  Node [' + nid + '] ' + (ne.class_type || '') + ': ' + err.message + (err.details ? ' (' + err.details + ')' : ''), 'log-err');
                  }
                }
                status.value = 'Error: workflow validation failed';
                done(false);
                return;
              }
              currentPromptId = result.prompt_id;
              if (onPromptId) onPromptId(currentPromptId);
              status.value = 'Queued...';
              log('Queued - prompt ' + String(currentPromptId).substring(0, 8) + '...');
              queued.value = true;
            } catch (e) {
              status.value = 'Error: ' + e.message;
              log('Error: ' + e.name + ': ' + e.message, 'log-err');
              done(false);
            }
          };
        }

        connectWs();
      });
    }

    async function onCancel() {
      try {
        await postJson('/api/comfy/api/interrupt');
        log('Cancel requested...', 'log-err');
      } catch {}
    }

    // ── Generated files ───────────────────────────────────────────────────
    const anyOutputSelected = computed(() => outputSelected.value.size > 0);
    function toggleOutput(f) {
      if (outputSelected.value.has(f.path)) outputSelected.value.delete(f.path);
      else outputSelected.value.add(f.path);
    }
    async function favoriteSelectedOutputs() {
      for (const f of outputs.value.filter(o => outputSelected.value.has(o.path))) {
        try {
          await api.favorite(f.path);
          outputFaved.value.add(f.path);
          outputSelected.value.delete(f.path);
        } catch {}
      }
    }
    async function deleteSelectedOutputs() {
      const sel = outputs.value.filter(o => outputSelected.value.has(o.path));
      if (!sel.length) return;
      if (!window.confirm('Delete ' + sel.length + ' selected file(s)? This cannot be undone.')) return;
      for (const f of sel) {
        try {
          await api.del(f.path);
          outputs.value = outputs.value.filter(o => o.path !== f.path);
          outputSelected.value.delete(f.path);
        } catch {}
      }
    }
    const overlayItem = computed(() => outputs.value[overlayIndex.value] || null);
    const overlayIsVideo = computed(() => !!overlayItem.value && isVideoFile(overlayItem.value.name));
    const overlayTo = computed(() => (overlayItem.value ? {
      path: '/inspect',
      query: { path: overlayItem.value.path, name: overlayItem.value.name, type: overlayIsVideo.value ? 'video' : 'image' },
    } : '/'));
    function openOverlay(i) { overlayIndex.value = i; overlayOpen.value = true; }
    function closeOverlay() { overlayOpen.value = false; }
    function onKeydown(e) {
      if (!overlayOpen.value) return;
      if (e.key === 'Escape') closeOverlay();
      if (e.key === 'ArrowLeft' && overlayIndex.value > 0) overlayIndex.value--;
      if (e.key === 'ArrowRight' && overlayIndex.value < outputs.value.length - 1) overlayIndex.value++;
    }

    // ── Manage workflows ──────────────────────────────────────────────────
    const manageOpen = ref(false);
    const manageItems = ref([]);
    const manageStatus = ref('');
    const manageError = ref('');
    const manageLoading = ref(false);

    async function openManage() {
      manageOpen.value = true;
      manageStatus.value = ''; manageError.value = ''; manageLoading.value = true;
      try {
        const items = await api.workflowsAll();
        manageItems.value = (items || []).map(it => ({ ...it, mapping: it.mapping || {} }));
      } catch (e) { manageError.value = 'Error: ' + e.message; }
      manageLoading.value = false;
    }
    function candLabel(c) {
      return '[' + c.id + '] ' + c.type + (c.title ? ' — ' + c.title : '') + (c.sample ? ' — ' + c.sample : '');
    }
    const autoLabel = id => '(auto' + (id != null ? ': #' + id : '') + ')';
    function setMap(it, key, value) {
      it.mapping = it.mapping || {};
      if (value === '') delete it.mapping[key];
      else it.mapping[key] = parseInt(value);
    }
    // Candidates are only fetched when a workflow is ticked — the list would be
    // an /api/workflow-nodes call per workflow otherwise.
    async function onManageEnable(it, enabled) {
      it.enabled = enabled;
      if (enabled && !it.candidates) {
        try {
          const data = await getJson('/api/workflow-nodes?name=' + enc(it.name));
          it.candidates = data.candidates; it.detected = data.detected; it.hasPresets = data.hasPresets;
        } catch {}
      }
    }
    async function saveManage() {
      manageStatus.value = 'Saving…';
      const payload = { enabled: [], labels: {}, mappings: {} };
      manageItems.value.forEach(it => {
        if (it.enabled) payload.enabled.push(it.name);
        if (it.label && it.label !== it.name) payload.labels[it.name] = it.label;
        if (it.mapping && Object.keys(it.mapping).length) payload.mappings[it.name] = it.mapping;
      });
      try {
        const r = await postJson('/api/workflows/manage', payload);
        if (!r.ok) { manageStatus.value = 'Save failed (' + r.status + ')'; return; }
        manageStatus.value = 'Saved';
        await refreshWorkflowDropdown();
        setTimeout(() => { manageOpen.value = false; }, 500);
      } catch (e) { manageStatus.value = 'Error: ' + e.message; }
    }

    // ── Debug log ─────────────────────────────────────────────────────────
    function buildLogPayload() {
      return {
        timestamp: new Date().toISOString(),
        host: location.host,
        page: location.href,
        userAgent: navigator.userAgent,
        workflow: wfName.value,
        status: status.value,
        log: logText(),
        wsState: ws ? ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][ws.readyState] : 'null',
        promptId: currentPromptId,
      };
    }
    async function saveLog() {
      try {
        const r = await postJson('/api/debug-results', buildLogPayload());
        if (r.ok) { saveLogLabel.value = 'Saved!'; setTimeout(() => { saveLogLabel.value = 'Save Log'; }, 2000); }
        else saveLogLabel.value = 'Error ' + r.status;
      } catch (e) { saveLogLabel.value = e.message; }
    }


    // ── Save workflow back into the file ──────────────────────────────────
    // Writes the selected app workflow into the file's own metadata (PNG text
    // chunks, or the video container's comment tag) so Inherit runs use it.
    // A rescue control: shown only when there's a concrete reason, stated next
    // to it, rather than sitting there inviting people to overwrite metadata.
    const applyWfVisible = ref(false);
    const applyWfHint = ref('');
    const applyWfBusy = ref(false);
    const applyWfLabel = ref('🖼 Save workflow');
    const applyBtnLabel = () => '🖼 Save workflow to ' + (/\.png$/i.test(filePath.value) ? 'image' : 'video');
    function showApplyBtn(hint) {
      if (!EMBEDDABLE_RE.test(filePath.value)) return;
      applyWfLabel.value = applyBtnLabel();
      applyWfHint.value = hint;
      applyWfVisible.value = true;
    }
    function updateApplyBtnVisibility() {
      const wf = wfName.value;
      if (!wf || wf === 'inherit' || !EMBEDDABLE_RE.test(filePath.value)) { applyWfVisible.value = false; return; }
      const base = (fileName.value || '').replace(/\.[^.]+$/, '');
      if (wf === 'DEBUG - ' + base + '.json') {
        showApplyBtn('This is the fix workflow for this file. A successful ▶ Run saves it back automatically — or tap the button to save it now.');
      } else if (fileHasNoEmbeddedWf.value) {
        showApplyBtn('This file has no embedded workflow. Run this one, and if you like the result tap the button to save it into the file.');
      } else {
        applyWfVisible.value = false;
      }
    }
    async function applyWorkflowToImage(auto) {
      const wf = wfName.value;
      if (wf === 'inherit') {
        if (!auto) showToast('Select an APP workflow first — Inherit has no file to apply.', 4000);
        return;
      }
      if (!EMBEDDABLE_RE.test(filePath.value)) {
        if (auto) log("Auto-apply skipped — this file type can't carry an embedded workflow.");
        else showToast('Only PNG and video files can carry an embedded workflow.', 4000);
        return;
      }
      if (!auto && !window.confirm('Write workflow "' + wf + '" into this file\'s metadata, replacing the embedded one? This edits the original file.')) return;
      applyWfBusy.value = true;
      applyWfLabel.value = 'Saving…';
      try {
        const r = await postJson('/api/image/embed-workflow', { filePath: filePath.value, workflowName: wf });
        const d = await r.json();
        if (!d.ok) throw new Error(d.error || ('HTTP ' + r.status));
        execVisible.value = true;
        log('🖼 Embedded workflow "' + wf + '" into ' + fileName.value + ' — Inherit runs of this file now use it.', 'log-done');
        // Refresh the in-memory copy so an immediate Inherit run uses it.
        try {
          const md = await api.metadata(filePath.value);
          if (md && (md.prompt || md.workflow)) {
            promptData.value = md.prompt;
            workflowData.value = md.workflow || null;
            workingWorkflow.value = md.workflow || null;
          }
        } catch {}
        applyWfLabel.value = '🖼 Saved!';
        fileHasNoEmbeddedWf.value = false;
        setTimeout(() => { applyWfLabel.value = applyBtnLabel(); applyWfBusy.value = false; applyWfVisible.value = false; }, 2500);
      } catch (e) {
        if (auto) {
          log('Auto-save failed: ' + e.message, 'log-err');
          showApplyBtn('The fixed workflow was NOT saved into this file (' + e.message + ') — tap the button to retry.');
        } else showToast('Save failed: ' + e.message, 4000);
        applyWfLabel.value = applyBtnLabel();
        applyWfBusy.value = false;
      }
    }

    // ── Favourite / delete ────────────────────────────────────────────────
    const favDone = ref(false);
    async function favorite() {
      if (!window.confirm('Move this file to Favorites?')) return;
      try {
        const d = await api.favorite(filePath.value);
        // Follow the file, so a later run/delete acts on where it went.
        if (d && d.dest) filePath.value = d.dest.replace(/\\/g, '/');
        favDone.value = true;
      } catch (e) { showToast('Error: ' + e.message, 4000); }
    }
    async function del() {
      if (!window.confirm('Delete this file? This cannot be undone.')) return;
      try {
        await api.del(filePath.value);
        router.back();
      } catch (e) { showToast('Error: ' + e.message, 4000); }
    }

    // ── Lifecycle ─────────────────────────────────────────────────────────
    onMounted(() => {
      try { jobChannel = new BroadcastChannel('comfy-jobs'); } catch { jobChannel = null; }
      loadReplacements();
      window.addEventListener('keydown', onKeydown);
      applyBoot();
      loadMetadata();
    });
    // The overlay's "Open Meta" link is a navigation to this same route, so a
    // query change has to reload the file rather than leave the previous one on
    // screen (a full page load used to do that for free).
    watch(() => route.query.path, async (now, before) => {
      if (route.name !== 'inspect' || now === before) return;
      overlayOpen.value = false;
      // The run side belongs to the previous file too: its outputs, its log, and
      // — because loadWorkflowConfig only re-runs for Inherit — its prompt and
      // seed. Leaving those meant ▶ Run uploaded this file while generating from
      // the last one's prompt.
      applyBoot();
      await loadMetadata();
      if (wfName.value !== 'inherit') await loadWorkflowConfig(wfName.value);
    });
    onBeforeUnmount(() => {
      disposed = true;
      window.removeEventListener('keydown', onKeydown);
      if (ws) { try { ws.close(); } catch {} ws = null; }
      if (jobChannel) { try { jobChannel.close(); } catch {} jobChannel = null; }
      document.title = 'ComfyRemix';
    });

    return {
      // file + chrome
      filePath, fileName, isVideo, mediaUrl, tab, status, statusColor,
      goHome: () => router.push('/'), goBack: () => router.back(),
      favorite, del, favDone,
      // metadata
      metaLoading, metaError, noMeta, metaUrl, summary, workflowData, promptData,
      nodesOpen, rawPromptOpen, rawWorkflowOpen, rawPromptJson, rawWorkflowJson,
      nodeEntries, visibleNodes, nodeSearch,
      editingId, editDraft, editedIds, toggleEdit, applyEdit, setEditForm,
      // run controls
      showRun, wfOptions, wfName, hasInherit, onWorkflowChange, openManage,
      runCount, persistRunCount, frames, persistFrames, showFrames,
      running, queued, runProgress, onRun, onCancel,
      showPrompt, promptText, onPromptInput, showCopyImgPrompt, copyImagePrompt,
      showGen, hasSeedControl, hasStepsControl, hasCfgControl, hasHLControl,
      seedValue, seedPinMode, seedPinned, seedPlaceholder, seedTitle, toggleSeedPin, persistGen,
      stepsValue, highStepsValue, lowStepsValue, cfgValue, hlTotal,
      presets, savePresets, showLora, hasHLLoras, loras, lorasHigh, lorasLow, saveLoras,
      // detected fields
      fieldConfig, fieldsMode, setFieldsMode, fieldBlocks, hiddenFields, saveFieldEdits, fieldsMsg,
      loadFieldConfig,
      // replacements
      replacements, replaceSummary, allReplChecked, allReplIndeterminate,
      saveReplacements, isReplDirty, commitRepl, swapRepl, replAct, toggleAllRepl, addReplacement,
      // execution
      execVisible, logLines, progressPct, progressCls, execLogEl,
      saveLog, saveLogLabel,
      applyWfVisible, applyWfHint, applyWfBusy, applyWfLabel, applyWorkflowToImage,
      // outputs
      outputs, outputSelected, outputFaved, anyOutputSelected, toggleOutput,
      favoriteSelectedOutputs, deleteSelectedOutputs, isVideoFile, fileUrl,
      overlayOpen, overlayIndex, overlayItem, overlayIsVideo, overlayTo, openOverlay, closeOverlay,
      // manage
      manageOpen, manageItems, manageStatus, manageError, manageLoading,
      candLabel, autoLabel, setMap, onManageEnable, saveManage,
    };
  },

  template: `
<div class="inspect">

  <div class="top-bar">
    <h1>{{ fileName }}</h1>
    <div class="top-bar-row">
      <button class="btn btn-back btn-home" title="Home" @click="goHome">⌂</button>
      <button class="btn btn-back" @click="goBack">← Back</button>
      <button class="btn btn-fav" :disabled="favDone" @click="favorite">{{ favDone ? '⭐ Moved!' : '⭐ Fav' }}</button>
      <button class="btn btn-del" @click="del">🗑 Del</button>
      <span class="status" :style="{ color: statusColor }">{{ status }}</span>
    </div>
  </div>

  <div class="tabs">
    <button class="tab" :class="{ active: tab === 'workflow' }" @click="tab = 'workflow'">Workflow</button>
    <button class="tab" :class="{ active: tab === 'preview' }" @click="tab = 'preview'">Preview</button>
  </div>

  <!-- ── Workflow tab ───────────────────────────────────────────────────── -->
  <div class="tab-content" v-show="tab === 'workflow'">

    <div v-show="showRun">
      <div class="run-controls">
        <!-- :value + @change rather than v-model: the handler has to see the new
             selection, and a v-model whose listener order is an implementation
             detail is not something to bet a workflow load on. -->
        <select class="run-select wide" :value="wfName" @change="onWorkflowChange($event.target.value)">
          <option v-if="hasInherit" value="inherit">Inherit</option>
          <option v-for="w in wfOptions" :key="w.name" :value="w.name">{{ w.label }}</option>
        </select>
        <button class="btn btn-back" title="Manage workflows" style="padding:10px 12px" @click="openManage">⚙</button>
        <select class="run-select" :value="runCount" @change="runCount = $event.target.value; persistRunCount()">
          <option v-for="n in ['1','2','3','5','10','20']" :key="n" :value="n">{{ n }}x</option>
        </select>
        <select class="run-select" v-show="showFrames && !fieldsMode"
                :value="frames" @change="frames = $event.target.value; persistFrames()">
          <option value="inherit">Frms: Inherit</option>
          <option value="49">Frms: 49</option>
          <option value="121">Frms: 121</option>
        </select>
        <button class="btn btn-run" v-show="!queued" :disabled="running" @click="onRun">▶ Run</button>
        <button class="btn btn-cancel" v-show="queued" @click="onCancel">■ Cancel</button>
        <span class="run-progress">{{ runProgress }}</span>
      </div>

      <details class="replace-box">
        <summary>
          <span class="cap">Prompt Replacements</span><span>{{ replaceSummary }}</span>
        </summary>
        <div class="replace-body">
          <div class="replace-help">
            Enabled rules are applied to the prompt right before each run (case-insensitive, all matches).
            Edited words turn the ✕ into ✓ — tap to save.
          </div>
          <label class="replace-all">
            <input type="checkbox" :checked="allReplChecked" :indeterminate.prop="allReplIndeterminate"
                   @change="toggleAllRepl($event.target.checked)"> Toggle all on/off
          </label>
          <div>
            <div v-for="(r, i) in replacements" :key="i" class="replace-row">
              <input type="checkbox" v-model="r.on" @change="saveReplacements">
              <span class="replace-cell">
                <input type="text" placeholder="find" v-model="r.__from" @keydown.enter="commitRepl(r)">
                <button class="replace-clear" tabindex="-1" title="Clear" @click="r.__from = ''">✕</button>
              </span>
              <button class="btn btn-swap" title="Swap words" @click="swapRepl(r)">⇄</button>
              <span class="replace-cell">
                <input type="text" placeholder="replace with" v-model="r.__to" @keydown.enter="commitRepl(r)">
                <button class="replace-clear" tabindex="-1" title="Clear" @click="r.__to = ''">✕</button>
              </span>
              <button class="btn btn-repl-act" :class="{ dirty: isReplDirty(r) }"
                      :title="isReplDirty(r) ? 'Save' : 'Delete'" @click="replAct(r, i)">
                {{ isReplDirty(r) ? '✓' : '✕' }}
              </button>
            </div>
          </div>
          <button class="btn btn-sm" style="margin-top:6px" @click="addReplacement">+ Add replacement</button>
        </div>
      </details>

      <div class="section" v-show="showPrompt && !fieldsMode">
        <textarea class="prompt-input" rows="4" placeholder="Prompt text..."
                  v-model="promptText" @input="onPromptInput"></textarea>
        <button class="btn btn-sm" v-show="showCopyImgPrompt" style="margin-top:4px"
                title="Replace the workflow prompt with the prompt embedded in this image"
                @click="copyImagePrompt">📷 Use image's prompt</button>
      </div>

      <div class="section" v-show="showGen && !fieldsMode">
        <div class="gen-row">
          <label class="field-label" v-show="hasSeedControl">Seed
            <span style="display:flex;gap:6px;align-items:center">
              <input type="number" class="num-input seed" min="0" step="1"
                     :placeholder="seedPlaceholder" :title="seedTitle"
                     :style="{ borderColor: seedPinned ? '#0a84ff' : '#48484a' }"
                     v-model="seedValue" @input="persistGen">
              <button type="button" role="switch" class="seed-switch" :class="{ on: seedPinMode }"
                      :aria-checked="seedPinMode ? 'true' : 'false'"
                      title="Off = new random seed each run · On = pin this exact seed"
                      @click="toggleSeedPin"><span class="thumb">{{ seedPinMode ? '📌' : '🎲' }}</span></button>
            </span>
          </label>
          <label class="field-label" v-show="hasStepsControl">Steps
            <input type="number" class="num-input" min="1" max="200" step="1" v-model="stepsValue" @input="persistGen">
          </label>
          <label class="field-label" v-show="hasCfgControl">CFG
            <input type="number" class="num-input" min="0" max="100" step="0.1" v-model="cfgValue" @input="persistGen">
          </label>
        </div>
      </div>

      <div class="section" v-show="presets.length">
        <div class="section-label">Realism / Style Presets
          <span class="plain">— each checked preset runs separately (Presets × Runs)</span>
        </div>
        <div class="preset-list">
          <label v-for="p in presets" :key="p.title" class="preset-chip" :class="{ on: p.on }">
            <input type="checkbox" v-model="p.on" @change="savePresets"> {{ p.title }}
          </label>
        </div>
      </div>

      <div class="section" v-show="hasHLControl && !fieldsMode">
        <div class="gen-row">
          <label class="field-label">High steps
            <input type="number" class="num-input" min="0" max="200" step="1" v-model="highStepsValue" @input="persistGen">
          </label>
          <label class="field-label">Low steps
            <input type="number" class="num-input" min="0" max="200" step="1" v-model="lowStepsValue" @input="persistGen">
          </label>
          <span class="run-note" style="padding-bottom:9px">= {{ hlTotal }} total steps</span>
        </div>
      </div>

      <div class="section" v-show="showLora && !fieldsMode">
        <div v-if="!hasHLLoras">
          <div class="section-label">LoRAs</div>
          <LoraRows :rows="loras" @change="saveLoras" />
        </div>
        <div v-else class="lora-hl-cols">
          <div class="lora-hl-col">
            <div class="lora-hl-label">High-noise LoRAs</div>
            <LoraRows :rows="lorasHigh" @change="saveLoras" />
          </div>
          <div class="lora-hl-col">
            <div class="lora-hl-label">Low-noise LoRAs</div>
            <LoraRows :rows="lorasLow" @change="saveLoras" />
          </div>
        </div>
      </div>

      <!-- Detected Fields: a config-driven generate form that reuses the same
           controls. Enabled fields show; the rest live in the expander below and
           pop up top when switched on. -->
      <div class="section" v-show="fieldConfig">
        <div v-show="fieldsMode">
          <template v-for="b in fieldBlocks" :key="b.key">
            <div v-if="b.type === 'pair'" class="lora-hl-cols">
              <div class="lora-hl-col" v-for="col in [{ f: b.hi, title: 'High-noise LoRAs' }, { f: b.lo, title: 'Low-noise LoRAs' }]" :key="col.f.id">
                <div class="lora-hl-label">
                  <input type="checkbox" class="fc-hidden-tgl" checked title="Hide" @change="col.f.enabled = false">
                  {{ col.title }}
                </div>
                <LoraRows :rows="col.f.value" />
              </div>
            </div>
            <div v-else-if="b.type === 'grid'" class="fc-grid">
              <FieldRow v-for="f in b.fields" :key="f.id" :f="f" :file-name="fileName" />
            </div>
            <FieldRow v-else :f="b.field" :file-name="fileName" />
          </template>
          <div v-if="!fieldBlocks.length" class="fc-empty">No fields enabled — open “hidden fields” below to add some.</div>

          <details class="fields-hidden" v-show="hiddenFields.length">
            <summary><span>{{ hiddenFields.length }} hidden field{{ hiddenFields.length === 1 ? '' : 's' }}</span></summary>
            <div class="fields-hidden-list">
              <FieldRow v-for="f in hiddenFields" :key="f.id" :f="f" :file-name="fileName" />
            </div>
          </details>
        </div>

        <div class="fields-actions">
          <button class="btn btn-sm btn-green" v-show="fieldsMode" @click="saveFieldEdits">Save field setup</button>
          <button class="btn btn-sm" v-show="fieldsMode" title="Re-detect from the workflow file (keeps your on/off edits)"
                  @click="loadFieldConfig(wfName)">↻ Refresh detection</button>
          <button class="btn btn-sm" title="Switch back to the classic controls" @click="setFieldsMode(!fieldsMode)">
            {{ fieldsMode ? '↩ Classic controls' : '⚡ Use detected fields' }}
          </button>
          <span class="fields-msg">{{ fieldsMsg }}</span>
        </div>
      </div>

      <div class="exec-panel" :class="{ vis: execVisible }">
        <div class="progress-wrap">
          <div class="progress-fill" :class="progressCls" :style="{ width: progressPct + '%' }"></div>
        </div>
        <div class="exec-log" ref="execLogEl">
          <div v-for="(l, i) in logLines" :key="i" :class="l.cls">{{ l.text }}</div>
        </div>
        <div class="exec-actions">
          <button class="btn btn-sm" @click="saveLog">{{ saveLogLabel }}</button>
        </div>
        <div class="apply-wf" v-show="applyWfVisible">
          <button class="btn btn-sm" :disabled="applyWfBusy" @click="applyWorkflowToImage(false)"
                  title="Write the selected app workflow into this file's metadata, replacing the embedded one">
            {{ applyWfLabel }}
          </button>
          <span class="apply-wf-hint">{{ applyWfHint }}</span>
        </div>
      </div>

      <div style="margin-top:12px" v-show="outputs.length">
        <div class="output-hdr">
          <h3>Generated Files</h3>
          <div class="output-bulk" v-show="anyOutputSelected">
            <button class="btn btn-sm btn-green" title="Move selected to Favorites" @click="favoriteSelectedOutputs">⭐ Favorite</button>
            <button class="btn btn-sm btn-red" @click="deleteSelectedOutputs">🗑 Delete</button>
          </div>
        </div>
        <div class="output-grid">
          <div v-for="(f, i) in outputs" :key="f.path" class="output-card"
               :class="{ faved: outputFaved.has(f.path) }" @click="openOverlay(i)">
            <input type="checkbox" class="output-cb" :checked="outputSelected.has(f.path)"
                   @click.stop @change="toggleOutput(f)">
            <template v-if="isVideoFile(f.name)">
              <img v-if="f.thumbPath" :src="fileUrl(f.thumbPath, f.thumbV)" loading="lazy">
              <div v-else class="placeholder">🎬</div>
              <div v-if="f.thumbPath" class="play">▶</div>
            </template>
            <img v-else :src="fileUrl(f.path, f.v)" loading="lazy">
            <div class="name">{{ f.name }}</div>
          </div>
        </div>
      </div>
    </div>

    <div class="meta-content">
      <div v-if="metaLoading" class="meta-note">Loading metadata...</div>
      <div v-else-if="metaError" class="meta-note">
        Could not read metadata: {{ metaError }}<br><br>
        <b>URL:</b> {{ metaUrl }}<br>
        <b>Tip:</b> <a :href="metaUrl">Open API directly</a>
      </div>
      <div v-else-if="noMeta" class="meta-note">
        No workflow metadata found in this file. You can still run an APP workflow on it — pick one above.
      </div>
      <template v-else>
        <div class="summary-section">
          <template v-if="summary.models.length">
            <div class="summary-label">Model</div>
            <div class="summary-val"><span v-for="m in summary.models" :key="m" class="tag">{{ m }}</span></div>
          </template>
          <template v-if="summary.loras.length">
            <div class="summary-label">LoRAs</div>
            <div class="summary-val"><span v-for="l in summary.loras" :key="l" class="tag">{{ l }}</span></div>
          </template>
        </div>

        <!-- Editing raw node values below can break the workflow. -->
        <div class="danger-hdr" v-if="nodeEntries.length">⚠ Danger Zone</div>

        <div class="accordion" :class="{ open: nodesOpen }" v-if="nodeEntries.length">
          <div class="accordion-hdr" @click="nodesOpen = !nodesOpen">
            <h2>Nodes ({{ nodeEntries.length }})</h2><span class="accordion-arrow">▶</span>
          </div>
          <div class="accordion-body">
            <input type="text" class="node-search" placeholder="Search nodes..." v-model="nodeSearch">
            <div class="node-grid">
              <div v-for="n in visibleNodes" :key="n.id" class="node-card"
                   :class="{ editable: n.editable.length, editing: editingId === n.id, edited: editedIds.has(n.id) }">
                <div class="node-hdr" @click="toggleEdit(n)">
                  <div class="node-type">[{{ n.id }}] {{ n.cls }}</div>
                  <div class="node-title" v-if="n.title">{{ n.title }}</div>
                </div>
                <div v-for="inp in n.inputs" :key="inp.key" class="node-input">
                  <span class="key">{{ inp.key }}:</span> <span class="val">{{ inp.display }}</span>
                </div>
                <div v-if="n.editable.length && editingId === n.id" class="node-edit-form" :ref="setEditForm">
                  <template v-for="e in n.editable" :key="e.key">
                    <label class="edit-label">{{ e.key }}</label>
                    <textarea v-if="e.type === 'string' && String(e.val).length > 50"
                              class="edit-input" rows="6" v-model="editDraft[e.key]"></textarea>
                    <input v-else-if="e.type === 'number'" type="number" class="edit-input" step="any" v-model="editDraft[e.key]">
                    <input v-else type="text" class="edit-input" v-model="editDraft[e.key]">
                  </template>
                  <div class="edit-actions">
                    <button class="btn btn-apply" @click.stop="applyEdit(n)">Apply</button>
                    <button class="btn btn-edit-cancel" @click.stop="editingId = null">Cancel</button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="accordion" :class="{ open: rawPromptOpen }" v-if="promptData">
          <div class="accordion-hdr" @click="rawPromptOpen = !rawPromptOpen">
            <h2>Raw Prompt JSON</h2><span class="accordion-arrow">▶</span>
          </div>
          <div class="accordion-body"><pre class="raw-pre">{{ rawPromptJson }}</pre></div>
        </div>

        <div class="accordion" :class="{ open: rawWorkflowOpen }" v-if="workflowData">
          <div class="accordion-hdr" @click="rawWorkflowOpen = !rawWorkflowOpen">
            <h2>Raw Workflow JSON</h2><span class="accordion-arrow">▶</span>
          </div>
          <div class="accordion-body"><pre class="raw-pre">{{ rawWorkflowJson }}</pre></div>
        </div>
      </template>
    </div>
  </div>

  <!-- ── Preview tab ────────────────────────────────────────────────────── -->
  <div class="tab-content" v-show="tab === 'preview'">
    <div class="media-wrap">
      <video v-if="isVideo" :src="mediaUrl" controls playsinline muted></video>
      <img v-else :src="mediaUrl" :alt="fileName">
    </div>
  </div>

  <!-- ── Manage workflows ───────────────────────────────────────────────── -->
  <div class="modal-backdrop" v-if="manageOpen" @click.self="manageOpen = false">
    <div class="modal">
      <div class="modal-hdr">
        <h3>Manage Workflows</h3>
        <span class="sub">Tick to expose in the app; set which node is prompt / steps / seed.</span>
        <button class="modal-x" @click="manageOpen = false">✕</button>
      </div>
      <div class="modal-body">
        <div v-if="manageLoading" class="meta-note">Loading…</div>
        <div v-else-if="manageError" class="meta-note" style="color:#e06c6c">{{ manageError }}</div>
        <div v-for="it in manageItems" :key="it.name" class="mw-row">
          <div class="mw-top">
            <input type="checkbox" :checked="it.enabled" @change="onManageEnable(it, $event.target.checked)">
            <input type="text" class="mw-inp label" placeholder="label" v-model="it.label">
            <span class="mw-name">{{ it.name }}</span>
            <span v-if="it.hasPresets" class="mw-badge">presets</span>
          </div>
          <div class="mw-maps" v-if="it.enabled">
            <template v-if="it.candidates">
              <label v-for="m in [
                        { k: 'promptNodeId', label: 'Prompt', list: it.candidates.prompt, cls: 'prompt' },
                        { k: 'stepsNodeId', label: 'Steps', list: it.candidates.steps, cls: '' },
                        { k: 'seedNodeId', label: 'Seed', list: it.candidates.seed, cls: '' }]" :key="m.k">
                {{ m.label }}<br>
                <select class="mw-inp sel" :class="m.cls" :value="it.mapping[m.k] == null ? '' : String(it.mapping[m.k])"
                        @change="setMap(it, m.k, $event.target.value)">
                  <option value="">{{ autoLabel((it.detected || {})[m.k]) }}</option>
                  <option v-for="c in (m.list || [])" :key="c.id" :value="String(c.id)">{{ candLabel(c) }}</option>
                </select>
              </label>
            </template>
            <span v-else class="run-note">Loading node candidates…</span>
          </div>
        </div>
      </div>
      <div class="modal-ftr">
        <span class="status">{{ manageStatus }}</span>
        <button class="btn btn-green" style="margin-left:auto;padding:8px 16px" @click="saveManage">Save</button>
      </div>
    </div>
  </div>

  <!-- ── Output viewer ──────────────────────────────────────────────────── -->
  <div class="output-overlay" v-if="overlayOpen" @click.self="closeOverlay">
    <button class="overlay-x" @click="closeOverlay">✕</button>
    <button class="overlay-nav prev" v-show="overlayIndex > 0" @click="overlayIndex--">‹</button>
    <button class="overlay-nav next" v-show="overlayIndex < outputs.length - 1" @click="overlayIndex++">›</button>
    <div class="overlay-media" v-if="overlayItem">
      <video v-if="overlayIsVideo" :src="fileUrl(overlayItem.path, overlayItem.v)" controls autoplay playsinline></video>
      <img v-else :src="fileUrl(overlayItem.path, overlayItem.v)">
    </div>
    <div class="overlay-info" v-if="overlayItem">
      <span>{{ overlayIndex + 1 }} / {{ outputs.length }} — {{ overlayItem.name }}</span>
      <router-link :to="overlayTo" @click="closeOverlay">Open Meta</router-link>
    </div>
  </div>
</div>
  `,
};
