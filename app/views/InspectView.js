// ── Inspect ────────────────────────────────────────────────────────────────
// The workflow/metadata inspector: what a file was made with, and how to make
// another one like it. Ported from inspect.html, which was a 2,719-line
// standalone document driving itself through getElementById and innerHTML.
//
// What the port actually changed, beyond "it's a component now":
//
//  • The file under inspection comes from the route (useRoute().query), not
//    location.search, so /inspect?path=… deep-links and an in-page jump to
//    another file is a router navigation rather than a full page load.
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
import { store, showToast } from '../store.js';
import { api, fileUrl } from '../api.js';
import { viewTo } from '../router.js';
import MediaTile from '../components/MediaTile.js';
// The run engine. It lives in RemixDialog for historical reasons (see the note
// at the top of that file); what matters here is that there is exactly one.
import { launchJob, cancelJob, jobs, link, presetFromEmbedded, outputItems, forgetOutput,
  promptAlternatives } from '../components/RemixDialog.js';
import ReplacementRules from '../components/ReplacementRules.js';
import WorkflowFields, { replaceableText } from '../components/WorkflowFields.js';
import { keptVariations, replacementGroups, replacementText, applyReplacements } from '../replacements.js';

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
const EMBEDDABLE_RE = /\.(png|mp4|webm|mkv|mov)$/i;

// ── Run state, kept across mounts ──────────────────────────────────────────
// The route unmounts this view whenever an output is opened in the viewer, and
// a run's outputs, log and open tab have nothing to do with that. They are
// cleared when the file or workflow being inspected changes (runTarget), not
// when the component happens to be rebuilt.
const runTarget = ref('');
// Which job this page is watching. The job itself lives in the engine's store,
// so a reload or a trip to the viewer picks it back up.
const jobId = ref('');
// The form itself, and which workflow it was built for.
const fieldConfig = ref(null);
const fieldCfgName = ref('');
const selectedPreset = ref('');
// The workflow this file was recognised as, which is the only one whose zones
// the file's own graph can be read against — a workflow picked by hand shares
// nothing with it, node ids included.
const recognizedWf = ref('');
// {nodeId: {input: value}} from the Nodes accordion, re-applied to each built
// prompt by id.
const nodeEdits = ref({});
const editedIds = ref(new Set());
const tab = ref('workflow');
const outputSelected = ref(new Set());
const outputFaved = ref(new Set());
// In flight or not is also the run's business: the loop that sets these keeps
// going in the closure of an unmounted instance, and a fresh mount would
// otherwise offer ▶ Run while a run is still queued.
const status = ref('Loading metadata...');
const statusColor = ref('');

// The target we expect to come straight back to. Set when this page sends you
// to the viewer; consumed by the next mount. Anything else that leaves clears
// the form, so an unsaved edit does not outlive the visit.
let expectReturn = '';
let viewerHookInstalled = false;
function resetRunState(target, force) {
  if (!force && runTarget.value === target) return;
  runTarget.value = target;
  tab.value = 'workflow';
  jobId.value = '';
  fieldConfig.value = null; fieldCfgName.value = '';
  selectedPreset.value = ''; recognizedWf.value = ''; nodeEdits.value = {}; editedIds.value = new Set();
  outputSelected.value = new Set(); outputFaved.value = new Set();
}

// localStorage is per-workflow scratch state here (last prompt, seed, LoRA
// toggles). Wrapped because a private-mode browser throws on access.
const LS = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

// Plain fetch for what api.js has no helper for — the run/queue side:
// /api/workflow-prompt, /api/workflow-match,
// /api/workflow-field-config, /api/image/embed-workflow, /api/replacements,
// /api/recent-outputs?since=…, the /api/comfy/* proxy and /api/debug-results —
// several of which answer with a body the caller inspects rather than a status.
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

export default {
  name: 'InspectView',
  components: { MediaTile, WorkflowFields, ReplacementRules },
  setup() {
    const route = useRoute();
    const router = useRouter();
    // …and if you wander off from the viewer instead of coming back, the trip is
    // over. Registered once for the app, not once per mount.
    if (!viewerHookInstalled) {
      viewerHookInstalled = true;
      router.afterEach((to, from) => { if (from.name === 'view' && to.name !== 'inspect') expectReturn = ''; });
    }

    // ── The file under inspection ─────────────────────────────────────────
    const filePath = ref('');     // absolute; mutates when Fav moves the file
    const fileName = ref('');
    // /inspect?wf=<name> — opened from the Workflows page, with no file behind
    // it. Everything the metadata half renders comes out of a file, so with none
    // the page is the run half alone.
    const wfParam = ref('');
    const fileLess = computed(() => !filePath.value);
    const isVideo = ref(false);
    const mediaUrl = computed(() => fileUrl(filePath.value));




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
    const fileHasNoEmbeddedWf = ref(false);

    // ── Node list ─────────────────────────────────────────────────────────
    const nodesOpen = ref(false);
    const rawPromptOpen = ref(false);
    const rawWorkflowOpen = ref(false);
    const nodeSearch = ref('');
    const editingId = ref(null);
    const editDraft = ref({});

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
      const kv = Object.assign({}, nodeEdits.value[n.id]);
      for (const e of n.editable) {
        let val = editDraft.value[e.key];
        if (e.type === 'number') {
          val = Number(val);
          if (Number.isInteger(val)) val = Math.round(val);   // keep ints integral
        }
        kv[e.key] = val;
        if (node && node.inputs) node.inputs[e.key] = val;     // so the accordion shows it
      }
      nodeEdits.value = Object.assign({}, nodeEdits.value, { [n.id]: kv });
      editedIds.value.add(n.id);
      editingId.value = null;
    }

    // ── Workflow selection ────────────────────────────────────────────────
    const wfOptions = ref([]);
    const hasInherit = ref(true);
    const wfName = ref(LS.get('archiveWorkflowSelect') || 'inherit');
    const savedWorkflow = LS.get('archiveWorkflowSelect');
    const runCount = ref(LS.get('archiveRunCount') || '1');
    const showRun = ref(false);
    // The Run tab goes away with showRun (a file with no metadata and no app
    // workflow to run against it), and a selected tab whose button is gone would
    // leave the page blank.
    watch(showRun, v => { if (!v && tab.value === 'run') tab.value = 'workflow'; });



    let lastUsedSeed = null;


    const persistRunCount = () => LS.set('archiveRunCount', runCount.value);

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





    // The one entry point the rest of the view calls. It used to fetch
    // /api/workflow-config as well — the classic controls' prompt, seed, steps,
    // CFG, loras and their localStorage caches. Detection is the only source of
    // a form now, so this is all that is left of it.
    const loadWorkflowConfig = name => loadFieldConfig(name);
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
        recognizedWf.value = m.name;
        LS.set('archiveWorkflowSelect', m.name);
        await loadWorkflowConfig(m.name);
        log('Recognized saved workflow "' + (m.label || m.name) + '" (' + Math.round(m.score * 100) + '% match) — switched from Inherit');

        return true;
      } catch { return false; }
    }

    // ── Metadata load ─────────────────────────────────────────────────────
    // The label of whatever is selected, for the title bar a file-less visit has
    // no filename to put there.
    const wfLabel = computed(() => {
      const o = wfOptions.value.find(w => w.name === wfName.value);
      return (o && (o.label || o.name)) || wfParam.value || 'workflow';
    });

    function applyBoot() {
      const q = route.query;
      filePath.value = String(q.path || '');
      fileName.value = String(q.name || (filePath.value.split(/[\\/]/).pop() || ''));
      isVideo.value = String(q.type || 'image') === 'video';
      wfParam.value = String(q.wf || '');
      // A round trip to the viewer keeps what is on screen; every other arrival
      // starts from the workflow as stored, edits included.
      const target = filePath.value + '|' + wfParam.value;
      const roundTrip = !!expectReturn && expectReturn === target;
      expectReturn = '';
      resetRunState(target, !roundTrip);
      document.title = 'Workflow - ' + (fileName.value || wfLabel.value);
    }

    // No file: nothing to read metadata from, so skip straight to the run half
    // with the asked-for workflow selected. Inherit is dropped rather than left
    // to fail — it inherits from the file, and there isn't one.
    async function openWorkflowOnly() {
      metaLoading.value = false; metaError.value = ''; noMeta.value = false;
      promptData.value = null; workflowData.value = null;
      workingPrompt.value = null; workingWorkflow.value = null;
      editingId.value = null; nodeSearch.value = '';
      // Node edits and the rest of the form are cleared by resetRunState when the
      // page is pointed at a different file or workflow — not on every mount, or
      // a trip to the viewer and back would throw them away.
      hasInherit.value = false;
      fileHasNoEmbeddedWf.value = false;
      showRun.value = true;
      status.value = '';
      await wfReady;
      const want = wfParam.value;
      if (want && wfOptions.value.some(w => w.name === want)) wfName.value = want;
      else if (wfName.value === 'inherit' && wfOptions.value.length) wfName.value = wfOptions.value[0].name;
      if (wfName.value && wfName.value !== 'inherit') await loadWorkflowConfig(wfName.value);
      document.title = 'Workflow - ' + wfLabel.value;
      updateApplyBtnVisibility();
    }

    async function loadMetadata() {
      metaLoading.value = true; metaError.value = ''; noMeta.value = false;
      promptData.value = null; workflowData.value = null;
      workingPrompt.value = null; workingWorkflow.value = null;
      editingId.value = null; nodeSearch.value = '';
      // Node edits and the rest of the form are cleared by resetRunState when the
      // page is pointed at a different file or workflow — not on every mount, or
      // a trip to the viewer and back would throw them away.
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
        recognizeWorkflow(data.workflow);
      }
      updateApplyBtnVisibility();
      status.value = '';
    }


    const fieldsMsg = ref('');

    // opts.fresh re-reads the workflow and throws away what is on screen — that
    // is what ↻ Refresh detection is for. Every other caller gets the form it
    // already has, edits and all.
    async function loadFieldConfig(name, opts) {
      if (!name) { fieldConfig.value = null; fieldCfgName.value = ''; return; }
      if (!(opts && opts.fresh) && fieldCfgName.value === name && fieldConfig.value) return;
      let cfg = null;
      try {
        // Inherit has no workflow file to name: detection runs against the graph
        // embedded in this file, the same call the Remix dialog makes for it.
        cfg = name === 'inherit'
          ? (workflowData.value ? await api.fieldConfigForGraph(workflowData.value) : null)
          : await api.fieldConfig(name);
      } catch { cfg = null; }
      if (!cfg || cfg.error || !Array.isArray(cfg.fields)) { fieldConfig.value = null; fieldCfgName.value = ''; return; }
      // A lora_rows control renders (and mutates) an array in place, so give it
      // one up front rather than patching f.value from inside the template.
      const inheritNow = name === 'inherit';
      for (const f of cfg.fields) {
        if ((f.control && f.control.type) === 'lora_rows' && !Array.isArray(f.value)) f.value = [];
        // Same rule as the dialog: a number in the seed box means that number
        // will be used, and unpinned it never is — collectFieldValues skips it
        // and the launch re-randomises the built graph. Inherit's config came
        // from this file's own graph, so its seed is the file's; keep it for the
        // ↺ button before clearing the box.
        if (f.kind === 'seed') {
          if (inheritNow && Number(f.value) >= 0 && String(f.value).trim() !== '') f._mediaSeed = Number(f.value);
          f.value = ''; f._pin = false;
        }
      }
      // Both versions of this file's prompt, for the switch above the field —
      // the text that ran, and the text as it was typed before the replacement
      // rules rewrote it. Null when the file has only one of them, or when they
      // are the same.
      cfg.promptAlt = promptAlternatives(promptData.value, workflowData.value);
      fieldConfig.value = cfg;
      fieldCfgName.value = name;
      selectedPreset.value = '';
      prefillFieldsFromMedia();
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
        // Behind the "↺ this file's seed" button rather than in the box — see
        // the seed rule above.
        const s = extractImageSeed();
        if (s != null && Number(s) >= 0) {
          const sf = fieldConfig.value.fields.find(f => f.kind === 'seed');
          if (sf) sf._mediaSeed = s;
        }
        // The style preset is stated by the graph's mute state rather than by a
        // widget, so it has to be read off the file's own graph: Inherit's config
        // already is that graph, and a recognised workflow's config carries the
        // zones its node ids belong to. Same call the Remix dialog makes, so the
        // two surfaces open a file on the same preset.
        const wfg = workflowData.value;
        if (fieldCfgName.value === 'inherit') {
          selectedPreset.value = ((fieldConfig.value.presets || []).find(p => p.on) || {}).title || '';
        } else if (wfg && fieldCfgName.value && fieldCfgName.value === recognizedWf.value) {
          selectedPreset.value = presetFromEmbedded(fieldConfig.value, wfg);
        }
      } catch {}
    }

    // Writes the on-screen values into the workflow's own .json in the ComfyUI
    // folder, through the same applyFieldConfigOverrides a run uses — so a value
    // can only land where a run would have put it. The server keeps a one-time
    // .bak and refuses Inherit (no file) and shortcuts (they aren't files).
    const wfUpdating = ref(false);
    const wfUpdated = ref(false);
    const canUpdateWf = computed(() => !!fieldConfig.value && !!wfName.value
      && wfName.value !== 'inherit' && !wfName.value.startsWith('@sc:'));
    async function updateWorkflow() {
      if (!canUpdateWf.value || wfUpdating.value) return;
      wfUpdating.value = true;
      try {
        const r = await api.updateWorkflow(wfName.value, collectFieldValues());
        if (r && r.error) throw new Error(r.error);
        // Warnings mean part of the write did not land; the file still changed,
        // so say which rather than reporting a clean success.
        if (r && r.warnings && r.warnings.length) {
          showToast('Updated with ' + r.warnings.length + ' warning(s): ' + r.warnings[0], 6000);
        } else {
          wfUpdated.value = true;
          setTimeout(() => { wfUpdated.value = false; }, 2000);
        }
      } catch (e) { showToast('Could not update the workflow: ' + e.message, 5000); }
      finally { wfUpdating.value = false; }
    }

    function saveFieldEdits() {
      const name = wfName.value;
      if (!fieldConfig.value || name === 'inherit') return;
      // Persist `enabled` ONLY where it differs from what detection recommends.
      // Saving every field froze that run's defaults forever: better detection
      // could never switch a field back on, and rewiring the graph left dead
      // fields stuck on. Labels have no detectable default, so they ride along.
      // Merge into what is stored rather than rebuilding it: the endpoint
      // replaces the whole map, and a rebuild from the merged config would drop
      // the kind overrides the Workflows page writes — silently unassigning every
      // role someone set there.
      const edits = JSON.parse(JSON.stringify(fieldConfig.value.savedEdits || {}));
      for (const f of fieldConfig.value.fields) {
        const e = Object.assign({}, edits[f.id], { label: f.label });
        if (!!f.enabled !== !!f.recommended) e.enabled = !!f.enabled;
        else delete e.enabled;
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
    // Every text field a run from this page will rewrite — what the rules panel
    // counts its tabs against, so they are the jobs ▶ Run actually queues.
    const replScope = computed(() => replaceableText((fieldConfig.value && fieldConfig.value.fields) || []));
    // The prompt the rules will rewrite, for the editor to preview.
    const promptFieldText = computed(() => {
      const f = ((fieldConfig.value && fieldConfig.value.fields) || []).find(x => x.kind === 'prompt' && x.enabled && !x.variant);
      return f && f.value != null ? String(f.value) : '';
    });
    function fieldsSeedPinnedNow() {
      if (!fieldConfig.value) return false;
      const sf = fieldConfig.value.fields.find(f => f.kind === 'seed' && f.enabled);
      return !!(sf && sf._pin && String(sf.value == null ? '' : sf.value).trim() !== '' && Number(sf.value) >= 0);
    }
    function collectFieldValues(presetTitle) {
      const fv = {};
      if (fieldConfig.value) for (const f of fieldConfig.value.fields) {
        if (!f.enabled) continue;
        const t = (f.control && f.control.type) || 'text';
        if (f.kind === 'seed') {
          if (f._pin && String(f.value == null ? '' : f.value).trim() !== '' && Number(f.value) >= 0) fv[f.id] = parseInt(f.value, 10);
          continue;
        }
        if (t === 'lora_rows') { fv[f.id] = (f.value || []).map(r => ({ slot: r.slot, on: r.on, strength: r.strength, lora: r.lora })); continue; }
        if (t === 'boolean') { fv[f.id] = !!f.value; continue; }
        if (f.value !== '' && f.value != null) {
          // Not rewritten here: the engine applies the replacement rules to the
          // whole built graph, and doing it twice would substitute twice.
          fv[f.id] = f.value;
        }
      }
      if (presetTitle) fv.__preset = presetTitle;
      return fv;
    }

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
    // Everything below the ComfyUI check is launchJob's: uploads, the prompt
    // build, replacements, node edits, MAIN IMAGE wiring, queueing each run with
    // its own seed, and the socket that reports progress. This view only says
    // what to run and then watches the job it got back.
    const execLogEl = ref(null);
    const saveLogLabel = ref('Save Log');
    const job = computed(() => jobs.list.find(x => x.id === jobId.value) || null);
    const running = computed(() => !!job.value && job.value.status === 'running');
    const jobLog = computed(() => (job.value && job.value._log) || []);
    const progressPct = computed(() => (job.value ? job.value._pct || 0 : 0));
    const progressCls = computed(() => (!job.value ? '' : job.value.status === 'error' ? 'err' : job.value.status === 'done' ? 'done' : ''));
    const runProgress = computed(() => (job.value ? (job.value._node || '') : ''));
    // The log is a scroller, and the engine appends to it from outside this
    // component; follow it rather than leaving the newest line below the fold.
    watch(() => jobLog.value.length, () => {
      nextTick(() => { const el = execLogEl.value; if (el) el.scrollTop = el.scrollHeight; });
    });

    async function onRun() {
      if (running.value) return;
      const inherit = wfName.value === 'inherit';
      const graph = workingWorkflow.value || workflowData.value;
      if (inherit && !graph) { showToast('This file carries no workflow to inherit'); return; }
      if (!fieldConfig.value) { showToast('No fields detected for this workflow'); return; }
      if (!(await ensureComfyRunning())) return;

      const fields = fieldConfig.value.fields;
      const pf = fields.find(f => f.kind === 'prompt' && f.enabled);
      const loras = fields.filter(f => f.kind === 'lora_list' && f.enabled)
        .flatMap(f => f.value || []).filter(l => l.on)
        .map(l => ({ slot: l.slot, on: l.on, strength: l.strength }));
      // Gallery-picked media are library paths; the engine uploads them to
      // ComfyUI and rewrites the field value to the uploaded name.
      const mediaFields = fields
        .filter(f => f.enabled && f.kind === 'image_input' && typeof f.value === 'string' && f.value)
        .map(f => ({ id: f.id, value: f.value }));

      // Match Input Image, ticked in the form above. The two size fields it
      // governs are overwritten at run with what the input file measures — same
      // engine call the Remix dialog makes, since a tick that worked on one
      // surface and did nothing on the other is the bug this page keeps
      // relearning.
      //
      // mediaFields here is every image field with a value, library path or
      // not — unlike the dialog's, which keeps only the paths. So `from` may
      // well be a bare ComfyUI input name that /file/ cannot serve; launchJob
      // measures the file this page is open on when that comes back empty,
      // which is why this does not need to filter.
      const cfgNow = fieldConfig.value;
      const matchSize = (cfgNow.matchSize && cfgNow.matchInput)
        ? { width: cfgNow.matchSize.width, height: cfgNow.matchSize.height, from: (mediaFields[0] && mediaFields[0].value) || '' }
        : null;

      // Several enabled rules for one keyword are variations of each other, so
      // a run queues one job per combination — the same fan-out the dialog does,
      // through the same engine. A rules editor that multiplied the queue on one
      // surface and quietly picked the first rule on the other is the drift this
      // page keeps being the victim of.
      // Judged against the text this form will send, like the dialog: rules for a
      // keyword the prompt does not contain are not alternatives, so they fan out
      // over nothing rather than queueing identical jobs.
      const replText = replaceableText(cfgNow.fields);
      // Ticked tabs only — an unticked one is a job that was never asked for.
      const variations = keptVariations(replText);
      const multi = new Set(replacementGroups(replText).filter(g => g.live && g.rules.length > 1).map(g => g.key));
      const labelFor = (v, n) => (variations.length < 2 ? '' :
        '#' + (n + 1) + '/' + variations.length + ' · ' + v
          .filter(r => multi.has(String(r.from).trim().toLowerCase()))
          .map(r => r.from + ' → ' + String(replacementText(r)).replace(/\s+/g, ' ').trim().slice(0, 28))
          .join(' · '));
      const jobParams = {
        workflowFile: inherit ? '__inherit__' : wfName.value,
        workflowLabel: inherit ? 'Inherited' : wfName.value.replace(/^APP /, '').replace(/\.json$/, ''),
        embeddedWf: inherit ? graph : null,
        // A file-less visit (opened from the Workflows page) has no source to
        // upload; an empty type is what tells the engine there isn't one.
        source: { path: filePath.value, name: fileName.value, type: filePath.value ? (isVideo.value ? 'video' : 'image') : '' },
        fieldValues: collectFieldValues(selectedPreset.value || null),
        mediaFields,
        matchSize,
        loras: loras.length ? loras : null,
        preset: selectedPreset.value || '',
        seedPinned: fieldsSeedPinnedNow(),
        nodeEdits: nodeEdits.value,
        runs: parseInt(runCount.value, 10) || 1,
      };
      let newJobId = null;
      variations.forEach((v, n) => {
        const id = launchJob(Object.assign({}, jobParams, {
          replacementRules: v,
          variationLabel: labelFor(v, n),
          // The record shows the prompt this job actually sends, so it is built
          // from that job's variation rather than once from the whole list.
          promptText: pf ? applyReplacements(String(pf.value == null ? '' : pf.value), v) : '',
        }));
        if (!newJobId) newJobId = id;
      });
      jobId.value = typeof newJobId === 'string' ? newJobId : ((jobs.list[0] && jobs.list[0].id) || '');
      outputSelected.value = new Set();
      outputFaved.value = new Set();
      tab.value = 'run';
      status.value = '';
    }
    function onCancel() { if (job.value) cancelJob(job.value); }

    // The engine records what a run produced; this page just reads it.
    const outputs = computed(() => (job.value && job.value.results) || []);
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
          // The list belongs to the job record, so the row goes from there —
          // and the Jobs dialog stops showing a file that no longer exists.
          forgetOutput(job.value, f.path);
          outputSelected.value.delete(f.path);
        } catch {}
      }
    }
    // An output is a media file like any other, so it renders as the same tile
    // the browser and the Remix dialog use, and goes to the same places: the
    // thumbnail to the viewer, the info bar to Remix on that file. The page's
    // own lightbox went with the switch — it had no other way in.
    const outputTiles = computed(() => outputItems(job.value));
    async function openOutput(t) {
      // Going to look at an output and coming back is not leaving the page.
      expectReturn = runTarget.value;
      // Nothing on this page lists a folder, so the roots the viewer route is
      // built from may never have been fetched — every other surface gets them
      // from a listing it already made.
      if (!store.roots.out && !store.roots.fav) { try { store.roots = await api.roots(); } catch {} }
      // Scoped to this run, like the dialog's grid: the arrows walk the outputs,
      // not whatever else happens to live in the folder they were written to.
      const to = viewTo(t.path, store.roots, job.value ? { job: job.value.id } : null);
      if (!to) { showToast('That output is outside the media roots — open it from its folder instead'); return; }
      router.push(to);
    }
    function remixOutput(t) { store.ui.remix = t; }

    // ── Debug log ─────────────────────────────────────────────────────────
    function buildLogPayload() {
      return {
        timestamp: new Date().toISOString(),
        host: location.host,
        page: location.href,
        userAgent: navigator.userAgent,
        workflow: wfName.value,
        status: job.value ? job.value.status : status.value,
        log: jobLog.value.map(l => l.m).join('\n'),
        comfy: link.comfy ? 'reachable' : 'unreachable',
        promptIds: job.value ? job.value.promptIds : [],
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
        showToast('Embedded "' + wf + '" into ' + fileName.value + ' — Inherit runs of this file now use it', 4000);
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

      applyBoot();
      if (fileLess.value) openWorkflowOnly(); else loadMetadata();
    });
    // Arriving here again with a different file or workflow is a query change,
    // not a mount, so it has to reload rather than leave the previous one on
    // screen (a full page load used to do that for free).
    watch(() => String(route.query.path || '') + '|' + String(route.query.wf || ''), async (now, before) => {
      if (route.name !== 'inspect' || now === before) return;
      // The run side belongs to the previous file too: its outputs, its log and
      // its detected fields. Leaving those meant ▶ Run uploaded this file while
      // generating from the last one's values.
      applyBoot();
      if (fileLess.value) { await openWorkflowOnly(); return; }
      await loadMetadata();
      if (wfName.value !== 'inherit') await loadWorkflowConfig(wfName.value);
    });
    onBeforeUnmount(() => {
      // Nothing to tear down any more: the socket, the cross-tab channel and the
      // job records belong to the engine, which is what lets a run survive this
      // page being unmounted — the whole reason a trip to the viewer used to
      // strand it.
      document.title = 'ComfyRemix';
    });

    return {
      // file + chrome
      filePath, fileName, fileLess, wfLabel, isVideo, mediaUrl, tab, status, statusColor,
      goHome: () => router.push('/'), goBack: () => router.back(),
      favorite, del, favDone,
      // metadata
      metaLoading, metaError, noMeta, metaUrl, summary, workflowData, promptData,
      nodesOpen, rawPromptOpen, rawWorkflowOpen, rawPromptJson, rawWorkflowJson,
      nodeEntries, visibleNodes, nodeSearch,
      editingId, editDraft, editedIds, toggleEdit, applyEdit, setEditForm,
      // run controls
      showRun, wfOptions, wfName, hasInherit, onWorkflowChange,
      runCount, persistRunCount,
      job, running, runProgress, onRun, onCancel,

      selectedPreset,
      // detected fields
      fieldConfig, promptFieldText, replScope, saveFieldEdits, fieldsMsg,
      canUpdateWf, wfUpdating, wfUpdated, updateWorkflow,
      loadFieldConfig,

      // execution
      jobLog, progressPct, progressCls, execLogEl,
      saveLog, saveLogLabel,
      applyWfVisible, applyWfHint, applyWfBusy, applyWfLabel, applyWorkflowToImage,
      // outputs
      outputs, outputTiles, outputSelected, anyOutputSelected, toggleOutput,
      favoriteSelectedOutputs, deleteSelectedOutputs, openOutput, remixOutput, fileUrl,
    };
  },

  template: `
<div class="inspect">

  <!-- One row, so Home and Back sit on the same line as the shell's own ⚙ and
       logout rather than under them. The row reserves the corner those two
       float in; the title takes what is left and ellipsises. -->
  <div class="top-bar">
    <div class="top-bar-row">
      <button class="btn btn-back btn-home" title="Home" @click="goHome">⌂</button>
      <button class="btn btn-back btn-home" title="Back" @click="goBack">←</button>
      <h1>{{ fileName || wfLabel }}</h1>
      <button v-if="!fileLess" class="btn btn-fav" :disabled="favDone" @click="favorite">{{ favDone ? '⭐ Moved!' : '⭐ Fav' }}</button>
      <button v-if="!fileLess" class="btn btn-del" @click="del">🗑 Del</button>
    </div>
    <span class="status" :style="{ color: statusColor }">{{ status }}</span>
  </div>

  <!-- The same Workflow / Run split the Remix dialog has: what the run will be,
       then the running of it. Preview needs a file, so it is only there with one. -->
  <div class="rmx-tabs">
    <button :class="{ on: tab === 'workflow' }" @click="tab = 'workflow'">Workflow</button>
    <button v-if="showRun" :class="{ on: tab === 'run' }" @click="tab = 'run'">Run</button>
    <button v-if="!fileLess" :class="{ on: tab === 'preview' }" @click="tab = 'preview'">Preview</button>
  </div>

  <!-- ── Workflow tab ───────────────────────────────────────────────────── -->
  <div class="tab-content" v-show="tab === 'workflow'">

    <div v-show="showRun">
      <div class="run-controls">
        <!-- :value + @change rather than v-model: the handler has to see the new
             selection, and a v-model whose listener order is an implementation
             detail is not something to bet a workflow load on. -->
        <!-- Opened on a workflow, the dropdown is what you opened, not a picker:
             changing it here would leave the URL pointing at one workflow and the
             page running another. Switch from the Workflows page instead. -->
        <select class="run-select wide" :value="wfName" :disabled="fileLess"
                :title="fileLess ? 'Inspecting this workflow — pick another from the Workflows page' : ''"
                @change="onWorkflowChange($event.target.value)">
          <option v-if="hasInherit" value="inherit">Inherit</option>
          <option v-for="w in wfOptions" :key="w.name" :value="w.name">{{ w.label }}</option>
        </select>
      </div>


      <!-- The form the workflow declares, rendered by the component the Remix
           dialog uses, and mounted the way the dialog mounts it: the tag and
           nothing else. The replacement rules used to be its child, put through
           a slot directly above the prompt they rewrite, from when this page was
           one page with no Run tab to move them to. It has had one for a while,
           so they are at the foot of that instead — same component, same props,
           same place as the dialog — and the tab that states what a run will be
           no longer also carries the control deciding how many runs there are. -->
      <workflow-fields v-if="fieldConfig" :cfg="fieldConfig"
                       :preset="selectedPreset" @update:preset="selectedPreset = $event"></workflow-fields>
      <div v-else-if="showRun" class="fc-empty">
        Nothing detected in this workflow, so there is nothing to set. ↻ Refresh detection re-reads the file.
      </div>

      <div class="fields-actions" v-if="showRun">
        <button v-if="canUpdateWf" class="btn btn-sm" :disabled="wfUpdating" @click="updateWorkflow"
                :title="'Overwrite ' + wfLabel + ' in your ComfyUI folder with the values on screen'">
          {{ wfUpdating ? 'Updating…' : (wfUpdated ? '✓ Updated' : '✏️ Update workflow') }}</button>
        <button v-if="fieldConfig" class="btn btn-sm btn-green" @click="saveFieldEdits"
                title="Remember which fields are shown and what they are called — the workflow file is not touched">Save field setup</button>
        <button class="btn btn-sm" title="Re-detect from the workflow file (keeps your saved edits)"
                @click="loadFieldConfig(wfName, { fresh: true })">↻ Refresh detection</button>
        <span class="fields-msg">{{ fieldsMsg }}</span>
      </div>
    </div>

    <div class="meta-content" v-if="!fileLess">
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

  <!-- ── Run tab ───────────────────────────────────────────────────────── -->
  <div class="tab-content" v-show="tab === 'run'">
    <div v-show="showRun">
      <div class="run-controls">
        <select class="run-select" :value="runCount" @change="runCount = $event.target.value; persistRunCount()">
          <option v-for="n in ['1','2','3','5','10','20']" :key="n" :value="n">{{ n }}x</option>
        </select>

        <button class="btn btn-run" v-show="!running" @click="onRun">▶ Run</button>
        <button class="btn btn-cancel" v-show="running" @click="onCancel">■ Cancel</button>
        <span class="run-progress">{{ runProgress }}</span>
      </div>

      <div class="exec-panel" :class="{ vis: !!job }">
        <div class="progress-wrap">
          <div class="progress-fill" :class="progressCls" :style="{ width: progressPct + '%' }"></div>
        </div>
        <div class="exec-log" ref="execLogEl">
          <div v-for="(l, i) in jobLog" :key="i" :class="'log-' + (l.cls || '')">{{ l.m }}</div>
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
        <div class="rmx-outgrid">
          <MediaTile v-for="t in outputTiles" :key="t.path" :item="t" selectable
                     :selected="outputSelected.has(t.path)"
                     @toggle="toggleOutput(t)" @open="openOutput(t)" @remix="remixOutput(t)" />
        </div>
      </div>

      <!-- Last, under everything the tab has to show — the same component in the
           same place as the dialog’s Run tab. Folded shut, its summary is the
           line that says ▶ Run is about to queue twelve of something; open, its
           tabs are where twelve becomes the five that were wanted. -->
      <replacement-rules :prompt="promptFieldText" :scope="replScope"></replacement-rules>
    </div>
  </div>

  <!-- ── Preview tab ────────────────────────────────────────────────────── -->
  <div class="tab-content" v-show="tab === 'preview' && !fileLess">
    <div class="media-wrap">
      <video v-if="isVideo" :src="mediaUrl" controls playsinline muted></video>
      <img v-else :src="mediaUrl" :alt="fileName">
    </div>
  </div>

</div>
  `,
};
