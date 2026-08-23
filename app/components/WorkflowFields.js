// ── Workflow fields ────────────────────────────────────────────────────────
// The form a workflow declares: whatever /api/workflow-field-config detected,
// rendered as controls, grouped by the graph node each came from, the LoRA
// stacks in their own high/low columns, and everything switched off folded
// away under "hidden".
//
// It lived inside RemixDialog, which is how the inspect page ended up with a
// second, differently-shaped version of the same form — presets alone were a
// row of checkbox chips there and a dropdown here. One component mounted twice
// is the only arrangement where those cannot drift apart again.
//
// It owns no state. cfg.fields are reactive objects and the controls write
// straight into them, exactly as they did in the dialog — the host reads the
// values back off the same array when it builds a run. Only the preset travels
// as a prop, because it is one choice rather than a field.
//
// The LoRA suggestion machinery is deliberately NOT here. FieldControl injects
// it — promptWords, loraTerms, suggestLibrary, addLoraRow, openPicker,
// firstLoraFieldId — so a host with a lora library provides them and a host
// without simply renders the plain rows.
import { fileUrl } from '../api.js';
import { autosize } from '../autosize.js';
import MediaBrowser from './MediaBrowser.js';
import { SKIP_KEY } from '../replacements.js';

const { reactive, ref, computed, watch, inject, provide } = window.Vue;

// Model families, for filtering a long lora list down to the ones that can
// actually load with this workflow's model. Matched against the lora's whole
// path, not its basename, because in a real library the family is usually the
// folder: wan/, wan2.2/, Wan22_Lightx2v/, KREA/, krea2/, LTX/, ltx2/, sdxl/,
// Illustrious/, Pony/.
//
// `model` is the same idea against the workflow's own checkpoint/unet value, so
// the right pill is already on when the form loads. WAI merges are Illustrious
// derivatives and name themselves "wai…" rather than saying so, which is why
// that alias is here.
//
// Order matters only for the auto-pick: the first family whose model pattern
// matches wins.
export const LORA_FAMILIES = [
  { id: 'wan', label: 'WAN', re: /wan/i, model: /wan/i },
  { id: 'krea', label: 'KREA', re: /krea/i, model: /krea/i },
  { id: 'ltx', label: 'LTX', re: /ltx/i, model: /ltx/i },
  { id: 'illustrious', label: 'Illustrious', re: /illustrious|\bwai/i, model: /illustrious|\bwai/i },
  { id: 'pony', label: 'Pony', re: /pony/i, model: /pony/i },
  { id: 'sdxl', label: 'SDXL', re: /sdxl/i, model: /sdxl/i },
  { id: 'flux', label: 'Flux', re: /flux/i, model: /flux/i },
  { id: 'chroma', label: 'Chroma', re: /chroma/i, model: /chroma/i },
];
const familyById = id => LORA_FAMILIES.find(f => f.id === id) || null;
const WIDE = new Set(['prompt', 'negative_prompt', 'lora_list', 'image_input', 'video_input', 'audio_input']);
const loraLast = (a, b) => (/^lora/.test(a.kind) ? 1 : 0) - (/^lora/.test(b.kind) ? 1 : 0);
export const shortLora = s => String(s == null ? '' : s).split(/[\\/]/).pop().replace(/\.safetensors$/i, '');
// A High/Low pair is one lora as far as suggestions go, so they collapse to a
// single key: offering both halves of a pair the user then has to tick twice
// is worse than offering the pair once and letting addLoraRow place both.
// Punctuation is stripped too: the same lora shows up as "wan22-name-…" in a
// saved graph and "WAN_22-name-…" in the library, and those must collapse or
// the one already wired in gets offered again as a suggestion.
// Must collapse every spelling of the noise level that swapHiLo knows about
// (see NOISE_PAIRS), or a pair like "…-HN"/"…-LN" keys apart and both halves
// get offered — which then render as the same file once the side is resolved.
export const canonLora = s => shortLora(s).toLowerCase()
  .replace(/high|low/g, '#')
  .replace(/(^|[^a-z])(hn|ln)(?![a-z])/g, '$1#')
  .replace(/[^a-z0-9#]+/g, '');
// Prompt ↔ lora word matching. Whole words only: lora filenames are dense
// enough that substring hits are almost all noise ("art" inside "artifact").
// Which words count as meaningful is NOT decided here — the server derives
// that vocabulary from the lora library itself and ships it as index.terms
// (see buildLoraIndex in server.js). This only tokenises, and must fold
// exactly the way the server's loraTokens does or the two won't meet.
export const loraWords = s => {
  const out = new Set();
  for (let w of String(s == null ? '' : s).toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 4 || /^\d+$/.test(w)) continue;
    if (w.length > 4 && w.endsWith('s')) w = w.slice(0, -1);   // crude plural fold, applied to both sides
    out.add(w);
  }
  return out;
};
export const ctype = f => (f.control && f.control.type) || 'text';

// ── What the replacement rules have to work on ────────────────────────────
// Every string a run will hand to applyReplacementsToNodes, as far as the form
// can see it — which is what decides whether several rules for one keyword are
// really variations of each other or N ways of changing nothing.
//
// Hidden fields count. A field switched off here is not absent from the graph;
// it carries its own value into it, and a rule finds it there. Numbers,
// toggles, combos, media paths and lora rows do not: those are the inputs
// applyReplacementsToNodes skips, and a checkpoint filename that happens to
// contain a rule's find is not that rule firing. It skips by input name too,
// so the field's widget goes through that very same SKIP_KEY rather than a
// second opinion about which inputs hold prose.
//
// Lives here rather than in replacements.js because this is the component that
// knows what a field is; the rules module knows only text.
const TEXTY = new Set(['text', 'multiline']);
// The graph input this field writes, falling back to its kind — a field added
// by hand has no target and "filename" is as good an answer as the widget name
// would have been.
const widgetOf = f => ((f.targets || [])[0] || {}).widget || f.kind || '';
export const replaceableText = fields => (fields || [])
  .filter(f => f && typeof f.value === 'string' && TEXTY.has(ctype(f))
    && f.kind !== 'seed' && !/_input$/.test(f.kind || '')
    && !SKIP_KEY.test(widgetOf(f)))
  .map(f => f.value)
  .join('\n');

// ── One control ────────────────────────────────────────────────────────────
// Renders whatever the field config says this field is: a prompt box, a seed
// with its pin, a lora stack, a combo, a number, a media path with a picker.
const FieldControl = {
  name: 'FieldControl',
  directives: { autosize },
  props: ['field'],
  setup(props) {
    const loraExpanded = ref(false);
    const promptWords = inject('promptWords', null);
    const loraTerms = inject('loraTerms', null);
    // The family pill above the lora columns. A row that is ON is never hidden by
    // it: it is part of the next run whether or not it matches, and a filter that
    // hides live state is a trap rather than a filter.
    const loraFamily = inject('loraFamily', null);
    const famRe = computed(() => {
      const f = familyById(loraFamily && loraFamily.value);
      return f ? f.re : null;
    });
    // Disabled loras split in two: those whose filename shares a meaningful
    // word with the prompt ride along under the enabled ones, the rest stay
    // behind "＋ N more". "Meaningful" is the server's library-derived
    // vocabulary — with no index (ComfyUI never reached) nothing is suggested,
    // which is quieter than matching on words like "high" that every lora has.
    const loraRows = computed(() => {
      const words = (promptWords && promptWords.value) || null;
      const terms = (loraTerms && loraTerms.value) || null;
      const on = [], hit = [], rest = [];
      const re = famRe.value;
      (Array.isArray(props.field.value) ? props.field.value : []).forEach((r, i) => {
        if (!r) return;
        if (r.on) { on.push({ r, i, match: '', df: 0 }); return; }
        if (re && !re.test(String(r.lora || ''))) return;   // other family, not this one
        let match = '', df = Infinity;
        if (words && words.size && terms) {
          for (const w of loraWords(shortLora(r.lora))) {
            const c = terms[w];
            if (c === undefined || !words.has(w)) continue;   // absent = boilerplate the index dropped
            if (c < df) { df = c; match = w; }                // rarest word across the library wins the chip
          }
        }
        (match ? hit : rest).push({ r, i, match, df });
      });
      hit.sort((a, b) => a.df - b.df || a.i - b.i);           // most specific suggestion first
      return { on, hit, rest };
    });
    const visibleLoras = computed(() => {
      const g = loraRows.value;
      return loraExpanded.value ? g.on.concat(g.hit, g.rest) : g.on.concat(g.hit);
    });
    const hiddenCount = computed(() => loraRows.value.rest.length);
    const suggestLibrary = inject('suggestLibrary', null);
    const firstLoraFieldId = inject('firstLoraFieldId', null);
    const libExpanded = ref(false);
    const libAll = computed(() => {
      if (!suggestLibrary || !firstLoraFieldId) return { list: [], cap: 0 };
      if (props.field.id !== firstLoraFieldId.value) return { list: [], cap: 0 };
      const g = suggestLibrary(props.field);
      const re = famRe.value;
      if (!re) return g;
      // Suggestions are library files this workflow does not have yet, so there is
      // no live state to protect — filter them outright.
      const list = (g.list || []).filter(x => re.test(String(x.lora || '')));
      return { list, cap: Math.min(g.cap, list.length) };
    });
    const library = computed(() => {
      const g = libAll.value;
      return { list: libExpanded.value ? g.list : g.list.slice(0, g.cap), more: Math.max(0, g.list.length - g.cap) };
    });
    const openPicker = inject('openPicker', null);
    const addLoraRow = inject('addLoraRow', null);
    // Width/Height while "Match Input Image" is on. The numbers are about to be
    // replaced by the ones measured off the file going in, so an editable box
    // here would be offering a value no run will ever use.
    const sizeLocked = inject('sizeLocked', null);
    const locked = computed(() => !!(sizeLocked && sizeLocked.value
      && (props.field.kind === 'width' || props.field.kind === 'height')));
    // Drop one file from a multi-file pick, keeping `value` on the first survivor and
    // collapsing back to a plain single pick when only one is left.
    function dropPicked(field, i) {
      if (!Array.isArray(field.values)) return;
      field.values.splice(i, 1);
      if (field.values.length) field.value = field.values[0];
      if (field.values.length <= 1) field.values = null;
    }
    // Ticking a library suggestion appends the row (enabled) and mirrors the
    // high/low pair — the only way loras get added now that the search-and-add
    // box is gone, since it just dumped every lora the server had cached.
    function addFromLibrary(lora) { if (addLoraRow) addLoraRow(props.field, lora); }
    return { t: computed(() => ctype(props.field)), locked, shortLora, loraExpanded, visibleLoras, hiddenCount, library, libExpanded, addFromLibrary, openPicker, dropPicked, fileUrl };
  },
  template: `
    <textarea v-if="t==='multiline'" v-autosize class="rmx-inp rmx-ta" style="width:100%" rows="2" v-model="field.value"></textarea>
    <span v-else-if="field.kind==='seed'" class="rmx-seedwrap">
      <input type="number" class="rmx-inp" style="width:160px" v-model="field.value" placeholder="random" min="0">
      <button type="button" class="rmx-seed" :class="{on: field._pin}" @click="field._pin = !field._pin"
              :title="field._pin ? 'Pinned — exact seed each run' : 'Random each run'"><span class="thumb">{{ field._pin ? '📌' : '🎲' }}</span></button>
      <button v-if="field._mediaSeed != null && String(field.value).trim()===''" type="button" class="rmx-btn2"
              @click="field.value = field._mediaSeed; field._pin = true"
              :title="'Pin the seed this file was generated with (' + field._mediaSeed + ')'">↺ this file's seed</button>
    </span>
    <input v-else-if="t==='boolean'" type="checkbox" v-model="field.value" style="width:16px;height:16px;accent-color:#0a84ff">
    <input v-else-if="t==='int' || t==='float'" type="number" class="rmx-inp" style="width:120px" :step="t==='float' ? '0.01' : '1'" v-model="field.value"
           :disabled="locked" :title="locked ? 'Coming from the input image — untick Match Input Image to set it here' : null">
    <select v-else-if="t==='combo'" class="rmx-inp" v-model="field.value"><option v-for="o in (field.control&&field.control.options||[field.value])" :key="o" :value="o">{{ o }}</option></select>
    <div v-else-if="t==='lora_rows'" class="rmx-loras">
      <div v-for="e in visibleLoras" :key="e.i" class="rmx-lora" :class="{off: !e.r.on, sug: !!e.match}">
        <input type="checkbox" v-model="e.r.on"><label :title="e.r.lora">{{ shortLora(e.r.lora) }}</label>
        <span v-if="e.match" class="rmx-lora-hit" :title="'&quot;' + e.match + '&quot; is in the prompt — tick to use this lora'">{{ e.match }}</span>
        <input type="number" step="0.05" v-model.number="e.r.strength">
      </div>
      <div v-for="s in library.list" :key="'lib:'+s.lora" class="rmx-lora sug">
        <input type="checkbox" :checked="false" :title="'Add ' + shortLora(s.lora) + ' to this workflow'" @change="addFromLibrary(s.lora)">
        <label :title="s.lora">{{ shortLora(s.lora) }}</label>
        <span class="rmx-lora-hit" :title="'&quot;' + s.match + '&quot; is in the prompt'">{{ s.match }}</span>
        <span class="rmx-lora-lib" title="In your lora library but not in this workflow — tick to add it">library</span>
      </div>
      <div v-if="library.more || libExpanded" class="rmx-lora-more" @click="libExpanded=!libExpanded"><span>{{ libExpanded ? 'Hide extra library matches' : ('＋ ' + library.more + ' more in your library match the prompt') }}</span><span class="rmx-lora-arrow" :class="{open: libExpanded}">▾</span></div>
      <div v-if="!field.value.length && !library.list.length" class="rmx-mut" style="font-size:12px">no lora slots</div>
      <div v-else-if="hiddenCount || loraExpanded" class="rmx-lora-more" @click="loraExpanded=!loraExpanded"><span>{{ loraExpanded ? 'Hide disabled loras' : ('＋ ' + hiddenCount + ' more lora' + (hiddenCount===1?'':'s')) }}</span><span class="rmx-lora-arrow" :class="{open: loraExpanded}">▾</span></div>
    </div>
    <span v-else-if="t==='image' || t==='video' || t==='audio'" class="rmx-imgf">
      <input type="text" class="rmx-inp" style="width:200px" v-model="field.value">
      <button v-if="openPicker && t==='image'" type="button" class="rmx-btn2" @click="openPicker(field)">🖼 Browse</button>
      <img v-if="t==='image' && field.value && !(field.values && field.values.length)" :key="field.value" :src="fileUrl(field.value)" @error="$event.target.style.display='none'" title="Selected image">
      <span v-if="t==='image' && field.values && field.values.length" class="rmx-mut" style="font-size:11.5px">{{ field.values.length }} files · one job each</span>
      <div v-if="t==='image' && field.values && field.values.length" class="rmx-picked">
        <div v-for="(p,i) in field.values" :key="p" class="rmx-picked-cell" :title="p">
          <img :src="fileUrl(p)" loading="lazy" @error="$event.target.style.visibility='hidden'">
          <button type="button" class="rmx-picked-x" @click="dropPicked(field, i)" title="Remove">✕</button>
        </div>
      </div>
    </span>
    <input v-else type="text" class="rmx-inp" style="width:280px;max-width:100%" v-model="field.value">
  `,
};

// ── Match Input Image ──────────────────────────────────────────────────────
// The tick that hands the frame size to the file going in. A component rather
// than the markup written out twice: it renders under whichever block holds the
// size fields, which is either the loose flow or one titled group, and a
// control kept in two places is a control that ends up saying two things.
const MatchInput = {
  name: 'MatchInput',
  props: ['cfg', 'batch'],
  template: `
    <label class="rmx-matchin"
           :title="cfg.matchInput ? 'Width and height come from the image going in — untick to type them here' : 'Size every run to the image going into it'">
      <input type="checkbox" class="rmx-tgl" v-model="cfg.matchInput">
      <b>Match Input Image</b>
      <span class="rmx-mut">{{ batch ? 'each picked file sets its own width and height' : 'width and height come from the input image' }}</span>
    </label>
  `,
};

// ── The form ───────────────────────────────────────────────────────────────
export default {
  name: 'WorkflowFields',
  components: { FieldControl, MediaBrowser, MatchInput },
  props: {
    // The live field config: { fields: [...], presets: [...] }, mutated in
    // place by the controls — the contract both hosts already rely on.
    cfg: { type: Object, required: true },
    preset: { type: String, default: '' },
  },
  emits: ['update:preset'],
  setup(props) {
    const fields = computed(() => props.cfg.fields || []);
    const enabledFields = computed(() => fields.value.filter(f => f.enabled).slice().sort(loraLast));
    const hiddenFields = computed(() => fields.value.filter(f => !f.enabled).slice().sort(loraLast));
    const isWide = f => WIDE.has(f.kind);
    // Where the host slot goes: directly above the first block holding a prompt,
    // because what the host puts there is the replacement rules that rewrite it.
    // A slot can only render once, so these are exclusive by v-if.
    const promptAt = computed(() => {
      const isP = f => f.kind === 'prompt' || f.kind === 'negative_prompt';
      if (nodeGroups.value.loose.some(isP)) return 'loose';
      const g = nodeGroups.value.titled.find(x => x.fields.some(isP));
      return g ? g.key : 'top';
    });

    // ── Match Input Image ───────────────────────────────────────────────
    // A workflow that takes an image and also states a frame size is stating it
    // twice: the file going in already has a width and a height, and typing them
    // again is how a remix comes back stretched. So when both are on screen, the
    // size fields default to being driven by the input rather than by the
    // workflow's stored numbers.
    //
    // The tick lives on cfg, not here, for the same reason the field values do:
    // this component owns no state, and the host has to be able to read the
    // answer when it builds a run. matchSize is that answer resolved — the two
    // field ids to overwrite, or null when the workflow has no size pair or no
    // image input — so a host only ever has to ask whether it is there.
    // The first enabled pair, deliberately: a workflow with two size sources
    // (a latent and a resize target, say) gets only the first one matched, and
    // the second keeps whatever the workflow stored. Known and left alone —
    // none of the workflows this has been run against carries two, and guessing
    // that both want the input's dimensions is a guess about the graph.
    const sizePair = computed(() => {
      const w = enabledFields.value.find(f => f.kind === 'width');
      const h = enabledFields.value.find(f => f.kind === 'height');
      return (w && h) ? { w, h } : null;
    });
    const imageInputs = computed(() => enabledFields.value.filter(f => f.kind === 'image_input'));
    const canMatchInput = computed(() => !!sizePair.value && imageInputs.value.length > 0);
    const matchSize = computed(() => (canMatchInput.value
      ? { width: sizePair.value.w.id, height: sizePair.value.h.id }
      : null));
    watch(matchSize, m => { props.cfg.matchSize = m; }, { immediate: true });
    // Re-armed for every form, which is what "automatically checked" means: a
    // switch to another workflow replaces cfg.fields outright, and untangling
    // last workflow's tick from this one's size fields is not a thing a user
    // asked us to remember. Keyed on the array itself, so toggling a field on
    // or off inside the same form leaves the tick where it was put.
    watch(fields, () => { props.cfg.matchInput = true; }, { immediate: true });
    // A batch pick is the case the checkbox exists for: each file gets its own
    // size rather than every run inheriting the first one's.
    const matchBatch = computed(() => imageInputs.value.some(f => Array.isArray(f.values) && f.values.length > 1));
    // Read by FieldControl to grey out the two boxes it governs.
    provide('sizeLocked', computed(() => !!(canMatchInput.value && props.cfg.matchInput)));
    // Where the row goes: under the block holding the size fields, so the tick
    // sits with the controls it disables. `loose` is the fallback rather than a
    // last resort — a size primitive with no siblings flows there — and the row
    // is a sibling of that flow, so it renders whether or not the flow is empty.
    const matchAt = computed(() => {
      if (!canMatchInput.value) return '';
      const isSize = f => f.kind === 'width' || f.kind === 'height';
      if (nodeGroups.value.loose.some(isSize)) return 'loose';
      const g = nodeGroups.value.titled.find(x => x.fields.some(isSize));
      return g ? g.key : 'loose';
    });

    // ── LoRA family filter ──────────────────────────────────────────────
    // Which model this workflow loads decides which pill starts on. Only the
    // model-ish fields are read: a VAE is shared across families often enough
    // (qwen_image_vae under a Krea checkpoint) to be a bad witness.
    const MODEL_KINDS = new Set(['model', 'unet', 'checkpoint']);
    const detectedFamily = computed(() => {
      const vals = fields.value.filter(f => MODEL_KINDS.has(f.kind))
        .map(f => String(f.value == null ? '' : f.value));
      if (!vals.length) return '';
      const hit = LORA_FAMILIES.find(fam => vals.some(v => fam.model.test(v)));
      return hit ? hit.id : '';
    });
    const family = ref('');
    // Re-derived rather than remembered: switching workflow means a new model,
    // and leaving the last workflow's pill on would filter this one's loras to
    // nothing with no obvious reason why.
    watch(detectedFamily, v => { family.value = v; }, { immediate: true });
    provide('loraFamily', family);
    const toggleFamily = id => { family.value = family.value === id ? '' : id; };

    // ── The picker and the LoRA library ─────────────────────────────────
    // Both used to sit in the Remix dialog and be handed down, which is why an
    // image field on the inspect page had no 🖼 Browse: nothing there provided
    // one. They belong to the form, so every host gets them by mounting it.
    // Gallery picker — opens a reusable MediaBrowser over the dialog.
    const picker = reactive({ open: false, type: 'image' });
    let pickerField = null;
    function openPicker(field) { pickerField = field; const k = field.kind; picker.type = k === 'video_input' ? 'video' : k === 'audio_input' ? 'audio' : 'image'; picker.open = true; }
    // Apply hands back an array (multi-select); a single-pick browser still sends a
    // bare path. `value` stays the first file so every existing single-image code path
    // is unchanged; `values` is the batch the Run button fans out over.
    function onPick(paths) {
      const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
      if (pickerField && list.length) {
        pickerField.value = list[0];
        pickerField.values = list.length > 1 ? list : null;
      }
      picker.open = false;
    }
    provide('openPicker', openPicker);

    // Add-LoRA-row support: available lora files + a handler that adds a row and,
    // when the workflow has a High + Low pair of Power Lora Loaders, mirrors the
    // add into the other loader (swapping the high/low token in the filename).
    // Plain fetch: /api/loras answers with data the caller inspects rather than
    // a status, which is not what api.js's req() is for.
    const jget = url => fetch(url, { credentials: 'same-origin' }).then(x => x.json());
    const loraOptions = ref([]);
    const loraTerms = ref(null);   // word -> how many loras carry it; built server-side from the library
    (async () => {
      try {
        const d = await jget('/api/loras');
        loraOptions.value = (d && d.loras) || [];
        loraTerms.value = (d && d.index && d.index.terms) || null;
      } catch (e) {}
    })();
    // High <-> Low swap. `\b` is useless here: `_` is a word character, so
    // /\bhigh\b/ never fires inside a name like NAME_I2V_14B_HIGH_V2 — the
    // dominant naming convention in the library — and the swap used to return the name
    // untouched, which sent the HIGH file straight into the LOW stack. A
    // separator is "anything that isn't a letter", and the replacement copies
    // the original's case so HIGH/High/high all land on real filenames.
    // HN/LN is the same distinction abbreviated; one pair in the library uses it
    // and would otherwise mirror the high file into the low stack.
    const NOISE_PAIRS = [['high', 'low'], ['hn', 'ln']];
    function swapHiLo(name, toLow) {
      if (!name) return name;
      let out = String(name);
      for (const [hi, lo] of NOISE_PAIRS) {
        const from = toLow ? hi : lo, to = toLow ? lo : hi;
        out = out.replace(new RegExp('(^|[^A-Za-z])' + from + '(?![A-Za-z])', 'gi'), (m, pre) => {
          const body = m.slice(pre.length);
          const rep = body === body.toUpperCase() ? to.toUpperCase()
                    : body[0] === body[0].toUpperCase() ? to[0].toUpperCase() + to.slice(1)
                    : to;
          return pre + rep;
        });
      }
      return out;
    }
    const nameIsHigh = n => swapHiLo(n, true) !== n;
    const nameIsLow = n => swapHiLo(n, false) !== n;
    const hasNoiseMark = n => nameIsHigh(n) || nameIsLow(n);
    // Filenames disagree on case — "…-HIGH-v1.0" sits next to "…-low-v1.0" — so
    // the library is matched case-insensitively and the real spelling returned.
    const loraByLower = computed(() => {
      const m = new Map();
      for (const l of loraOptions.value) m.set(String(l).toLowerCase(), l);
      return m;
    });
    // Which noise level a loader is. Not from the label: these nodes carry no
    // title, so the field is called "LoRAs (#185)" and variant is empty. The
    // reliable evidence is what is already loaded in it — a stack whose rows
    // say high_noise IS the high one.
    function loraFieldIsHigh(field) {
      const hay = String((field && field.label) || '') + ' ' + String((field && field.nodeTitle) || '');
      if (/high/i.test(hay)) return true;
      if (/low/i.test(hay)) return false;
      let hi = 0, lo = 0;
      for (const r of (Array.isArray(field && field.value) ? field.value : [])) {
        const n = String((r && r.lora) || '');
        if (swapHiLo(n, true) !== n) hi++;
        else if (swapHiLo(n, false) !== n) lo++;
      }
      return hi === lo ? null : hi > lo;
    }
    const newLoraRow = (lora, on) => ({ slot: null, on: on !== false, lora, strength: 1, strengthTwo: null, _new: true });
    // What the *other* loader should receive, or null for "nothing". A lora with
    // no high/low marker applies to both stacks, so it mirrors as-is. One that is
    // explicitly HIGH must never be copied verbatim into the low stack: if its
    // LOW counterpart isn't installed the pair just stays one-sided, which is
    // recoverable, where a high-noise lora running at low noise is not.
    function counterpartFor(lora, other, field) {
      if (!hasNoiseMark(lora)) return lora;
      let otherHigh = loraFieldIsHigh(other);
      if (otherHigh === null) { const h = loraFieldIsHigh(field); otherHigh = h === null ? null : !h; }
      if (otherHigh === null) return null;
      const cand = swapHiLo(lora, !otherHigh);
      return loraByLower.value.get(String(cand).toLowerCase()) || null;
    }
    function addLoraRow(field, lora) {
      if (!lora) return;
      if (!Array.isArray(field.value)) field.value = [];
      field.value.push(newLoraRow(lora, true));
      // High/Low sync: mirror into the paired loader when there are exactly two.
      const loraFields = fields.value.filter(f => f.enabled && f.kind === 'lora_list');
      if (loraFields.length !== 2) return;
      const other = loraFields.find(f => f.id !== field.id);
      if (!other) return;
      const otherLora = counterpartFor(lora, other, field);
      if (!otherLora) return;
      if (!Array.isArray(other.value)) other.value = [];
      other.value.push(newLoraRow(otherLora, true));
    }
    // loraOptions stays dialog-local: suggestLibrary and the high/low pair lookup
    // read it here, and nothing injects it since the Add LoRA box went.
    provide('addLoraRow', addLoraRow);

    // Words in the *positive* prompt only — a lora surfacing because the thing
    // you asked NOT to see is named in the negative prompt would be backwards.
    const promptWords = computed(() => {
      const f = fields.value.find(x => x.kind === 'prompt' && x.enabled && !x.variant);
      return loraWords(f ? f.value : '');
    });
    provide('promptWords', promptWords);
    provide('loraTerms', loraTerms);

    // Library suggestions: loras the prompt names that this workflow's loader
    // doesn't carry at all. The rows in the graph are only the ones someone
    // wired up once; the library is everything ComfyUI can load, so a matching
    // lora that was never added is exactly the one worth surfacing.
    //
    // Offered by the first loader only. With a High/Low pair both loaders would
    // otherwise show the same suggestion twice, and ticking either one calls
    // addLoraRow, which already mirrors the opposite variant into the other.
    const LIB_SUGGEST_MAX = 8;
    const firstLoraFieldId = computed(() => {
      const f = fields.value.find(x => x.enabled && x.kind === 'lora_list');
      return f ? f.id : null;
    });
    function suggestLibrary(field) {
      const words = promptWords.value, terms = loraTerms.value;
      if (!words.size || !terms || !loraOptions.value.length) return { list: [], cap: LIB_SUGGEST_MAX };
      // Anything already wired into any loader is not a suggestion — it is a row.
      const have = new Set();
      for (const f of fields.value) {
        if (f.kind !== 'lora_list' || !Array.isArray(f.value)) continue;
        for (const r of f.value) if (r && r.lora) have.add(canonLora(r.lora));
      }
      const pair = fields.value.filter(f => f.enabled && f.kind === 'lora_list').length === 2;
      const wantHigh = loraFieldIsHigh(field);
      const seen = new Set(), out = [];
      for (const name of loraOptions.value) {
        const key = canonLora(name);
        if (have.has(key) || seen.has(key)) continue;
        let match = '', df = Infinity;
        for (const w of loraWords(shortLora(name))) {
          const c = terms[w];
          if (c === undefined || !words.has(w)) continue;
          if (c < df) { df = c; match = w; }
        }
        if (!match) continue;
        // Show the half of the pair that belongs in this loader, so addLoraRow's
        // high/low swap sends the right file to each side. A candidate for the
        // opposite side whose counterpart isn't installed is dropped rather than
        // offered: ticking it would load a low-noise lora into the high stack.
        // Decided before `seen` is marked, so skipping one half leaves the other
        // half free to be offered when the scan reaches it.
        let use = name;
        if (pair && wantHigh !== null && hasNoiseMark(name)) {
          const alt = loraByLower.value.get(swapHiLo(name, !wantHigh).toLowerCase());
          if (alt) use = alt;
          else if (wantHigh ? nameIsLow(name) : nameIsHigh(name)) continue;
        }
        seen.add(key);
        out.push({ lora: use, match, df });
      }
      // Longest matched word first. Library rarity is a poor proxy for how much
      // a match is worth — "woman" occurs in exactly one filename here, making it
      // the rarest word and the least useful hit — whereas a long word is a
      // specific concept, so "deepthroat" outranks "face".
      out.sort((a, b) => b.match.length - a.match.length || a.df - b.df || a.lora.localeCompare(b.lora));
      // Full list; the field caps it to LIB_SUGGEST_MAX and expands on demand.
      // It used to hard-truncate here and point at the Add LoRA box for the
      // rest — with that box gone, truncating would strand those loras.
      return { list: out, cap: LIB_SUGGEST_MAX };
    }
    provide('suggestLibrary', suggestLibrary);
    provide('firstLoraFieldId', firstLoraFieldId);
    // Group the non-lora controls by the graph node they came from (each group
    // on its own line under a small node-title heading). LoRAs stay separate.
    const nodeGroups = computed(() => {
      const byKey = new Map();
      for (const f of enabledFields.value) {
        if (/^lora/.test(f.kind)) continue;
        const t = (f.targets || [])[0] || {};
        const key = String(t.nodeId) + '|' + (t.title || t.class || '');
        let g = byKey.get(key);
        if (!g) { g = { key, title: t.title || t.class || ('#' + t.nodeId), fields: [] }; byKey.set(key, g); }
        g.fields.push(f);
      }
      const all = [...byKey.values()];
      // Titled group only for nodes with 2+ controls; single-control nodes flow
      // together in one row (so e.g. separate Width/Height primitives sit side by side).
      return { titled: all.filter(g => g.fields.length >= 2), loose: all.filter(g => g.fields.length < 2).flatMap(g => g.fields) };
    });
    const enabledLoras = computed(() => enabledFields.value.filter(f => /^lora/.test(f.kind)));
    const loraHigh = computed(() => enabledLoras.value.filter(f => f.variant === 'high'));
    const loraLow = computed(() => enabledLoras.value.filter(f => f.variant === 'low'));
    const loraOther = computed(() => enabledLoras.value.filter(f => f.variant !== 'high' && f.variant !== 'low'));
    return { picker, onPick, promptAt, enabledFields, hiddenFields, isWide, nodeGroups, enabledLoras, loraHigh, loraLow, loraOther,
      matchAt, matchBatch, LORA_FAMILIES, family, detectedFamily, toggleFamily };
  },
  template: `
    <div class="rmx-fields">
      <slot v-if="promptAt === 'top'"></slot>
      <slot v-if="promptAt === 'loose'"></slot>
      <div v-if="nodeGroups.loose.length" class="rmx-grid">
        <div v-for="f in nodeGroups.loose" :key="f.id" class="rmx-field" :class="{wide: isWide(f)}">
          <label class="rmx-lbl"><input type="checkbox" class="rmx-tgl" checked @change="f.enabled=false" title="Hide field"> {{ f.label }} <span v-if="f.help" class="rmx-info" tabindex="0" @click.prevent.stop><span class="rmx-tip">{{ f.help }}</span>i</span> <span v-if="f.unreachable" style="color:#ff9f0a" title="not on the output path">⚠</span></label>
          <field-control :field="f"></field-control>
        </div>
      </div>
      <match-input v-if="matchAt === 'loose'" :cfg="cfg" :batch="matchBatch"></match-input>
      <template v-for="g in nodeGroups.titled" :key="g.key">
      <slot v-if="promptAt === g.key"></slot>
      <div class="rmx-nodegroup">
        <div class="rmx-nodegroup-title">{{ g.title }}</div>
        <div class="rmx-grid">
          <div v-for="f in g.fields" :key="f.id" class="rmx-field" :class="{wide: isWide(f)}">
            <label class="rmx-lbl"><input type="checkbox" class="rmx-tgl" checked @change="f.enabled=false" title="Hide field"> {{ f.label }} <span v-if="f.help" class="rmx-info" tabindex="0" @click.prevent.stop><span class="rmx-tip">{{ f.help }}</span>i</span> <span v-if="f.unreachable" style="color:#ff9f0a" title="not on the output path">⚠</span></label>
            <field-control :field="f"></field-control>
          </div>
        </div>
        <match-input v-if="matchAt === g.key" :cfg="cfg" :batch="matchBatch"></match-input>
      </div>
      </template>
      <!-- Above the first lora section: which model family to show. The pills are
           one choice, not a set — two families at once is not a thing a workflow
           can load. -->
      <div v-if="enabledLoras.length" class="rmx-fams">
        <span class="rmx-fams-lbl">LoRAs for</span>
        <button v-for="fam in LORA_FAMILIES" :key="fam.id" type="button" class="rmx-fam"
                :class="{ on: family === fam.id }"
                :title="family === fam.id ? 'Showing only LoRAs with ' + fam.label + ' in the name — click to show all' : 'Show only LoRAs with ' + fam.label + ' in the name'"
                @click="toggleFamily(fam.id)">{{ fam.label }}</button>
        <span v-if="family && family === detectedFamily" class="rmx-fams-note" title="Matched against the model this workflow loads">from the model</span>
      </div>
      <div v-if="loraHigh.length || loraLow.length" class="rmx-lora-cols">
        <div class="rmx-lora-col">
          <div class="rmx-nodegroup-title">High-noise LoRAs</div>
          <div v-for="f in loraHigh" :key="f.id" class="rmx-field"><label class="rmx-lbl"><input type="checkbox" class="rmx-tgl" checked @change="f.enabled=false" title="Hide field"> {{ f.label }}</label><field-control :field="f"></field-control></div>
        </div>
        <div class="rmx-lora-col">
          <div class="rmx-nodegroup-title">Low-noise LoRAs</div>
          <div v-for="f in loraLow" :key="f.id" class="rmx-field"><label class="rmx-lbl"><input type="checkbox" class="rmx-tgl" checked @change="f.enabled=false" title="Hide field"> {{ f.label }}</label><field-control :field="f"></field-control></div>
        </div>
      </div>
      <div v-if="loraOther.length" class="rmx-grid" style="margin-top:6px">
        <div v-for="f in loraOther" :key="f.id" class="rmx-field wide">
          <label class="rmx-lbl"><input type="checkbox" class="rmx-tgl" checked @change="f.enabled=false" title="Hide field"> {{ f.label }}</label>
          <field-control :field="f"></field-control>
        </div>
      </div>
      <div v-if="!enabledFields.length" class="rmx-mut">No fields enabled — see hidden list.</div>
      <div v-if="(cfg.presets || []).length" style="margin-top:12px"><label class="rmx-lbl" style="margin-bottom:5px">Style preset</label>
        <select class="rmx-inp" :value="preset" @change="$emit('update:preset', $event.target.value)"><option value="">— none —</option><option v-for="p in (cfg.presets || [])" :key="p.title" :value="p.title">{{ p.title }}</option></select>
      </div>
      <details class="rmx-hidden" v-if="hiddenFields.length"><summary>{{ hiddenFields.length }} hidden field{{ hiddenFields.length===1?'':'s' }}</summary>
        <div class="rmx-field" v-for="f in hiddenFields" :key="f.id"><label class="rmx-lbl"><input type="checkbox" class="rmx-tgl" @change="f.enabled=true" title="Show field"> {{ f.label }} <span class="rmx-mut" style="text-transform:none">· {{ f.kind }}</span></label><field-control :field="f"></field-control></div>
      </details>
    </div>
    <!-- The gallery an image/video/audio field opens. It lives with the form
         because the field is what raises it — a host only has to mount this. -->
    <div v-if="picker.open" class="rmx-picker-overlay" data-backdrop @click.self="picker.open=false">
      <div class="rmx-picker">
        <div class="rmx-picker-head"><b>Pick {{ picker.type }}</b><button class="rmx-x" style="margin-left:auto" @click="picker.open=false">✕</button></div>
        <media-browser :type="picker.type" :multi="picker.type==='image'" @pick="onPick"></media-browser>
      </div>
    </div>
  `,
};
