// ── Workflows ──────────────────────────────────────────────────────────────
// The workflow library as a page of its own. Until now the library was only
// reachable from inside the Remix dialog ("📚 Add to Workflow Library"), which
// meant opening a file first to manage a list that has nothing to do with any
// file. This route is that list: what the Workflow dropdown offers, with the
// same picker behind a ＋ Add button.
//
// A row opens /inspect?wf=<name> — the inspector on a workflow with no file
// behind it, which is what InspectView's file-less mode exists for.
//
// It also owns which detected field plays each role — the ⚙ on a row. That
// replaces the inspect page's node mapping, which named a NODE for three roles
// and was read only by the classic controls (resolvePromptNode and friends);
// field-config runs address fields by id and never looked at it, so the setting
// was invisible in the mode the app actually uses. A role here is saved as a
// field-config edit instead, which buildFieldConfig merges into every detection
// run. Stored mappings are left alone — saveAll still sends them back untouched
// — so nothing breaks for a workflow still on the classic controls.
//
// Shortcuts (`@sc:…` entries — a workflow reopened on saved field values) get no
// row: they have no `.json` of their own, so the inspector has nothing to load
// for one. They are counted on their parent instead rather than silently
// dropped, since the count is the only place they show up outside the dropdown.
import { showToast } from '../store.js';
import { api } from '../api.js';

const { ref, reactive, computed, onMounted } = window.Vue;
const { useRouter } = window.VueRouter;

// The roles worth pinning by hand, and the control types a field must have to
// be a plausible candidate for each. Wider than the three the old node-mapping
// manager offered, because a field override can express what a node mapping
// could not.
const ROLES = [
  { kind: 'prompt', label: 'Prompt', types: ['multiline', 'text'] },
  { kind: 'negative_prompt', label: 'Negative', types: ['multiline', 'text'] },
  { kind: 'seed', label: 'Seed', types: ['int'] },
  { kind: 'steps', label: 'Steps', types: ['int'] },
  { kind: 'cfg', label: 'CFG', types: ['float', 'int'] },
];

export default {
  name: 'WorkflowsView',
  setup() {
    const router = useRouter();
    const loading = ref(true);
    const error = ref('');
    // Every workflow on disk, listed or not — one source for the rows, the
    // picker and the mapping panel, because /api/workflows/manage replaces the
    // whole store and any save has to be able to send all of it back.
    const all = ref([]);
    const shortcuts = ref({});
    const saving = ref(false);
    // The role panel for one workflow: its field config, the edits already
    // stored against it, and the field chosen for each role.
    const roles = reactive({ name: '', loading: false, busy: false, error: '', fields: [], savedEdits: {}, choice: {} });

    async function load() {
      loading.value = true; error.value = '';
      try {
        // Both: /all carries every workflow with its label and enabled flag,
        // /workflows is the only place shortcuts show up.
        const [every, listed] = await Promise.all([api.workflowsAll(), api.workflows()]);
        all.value = (every || []).map(w => ({ ...w, label: w.label || '' }));
        const counts = {};
        for (const w of listed || []) if (w.shortcut && w.parent) counts[w.parent] = (counts[w.parent] || 0) + 1;
        shortcuts.value = counts;
      } catch (e) {
        error.value = e.message;
        all.value = []; shortcuts.value = {};
      }
      loading.value = false;
    }
    onMounted(load);

    const rows = computed(() => all.value
      .filter(w => w.enabled)
      .map(w => ({ ...w, label: w.label || w.name, shortcuts: shortcuts.value[w.name] || 0 }))
      .sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase(), undefined, { numeric: true })));

    const open = w => router.push({ name: 'inspect', query: { wf: w.name } });

    // The store is replaced wholesale on every save, so this always sends every
    // enabled name and every label — a delta would drop the rest.
    async function saveAll(what) {
      if (saving.value) return false;
      saving.value = true;
      const payload = { enabled: [], labels: {} };
      for (const w of all.value) {
        if (w.enabled) payload.enabled.push(w.name);
        const lbl = (w.label || '').trim();
        if (lbl && lbl !== w.name) payload.labels[w.name] = lbl;
      }
      try {
        await api.manageWorkflows(payload);
        await load();
        showToast(what);
        return true;
      } catch (e) {
        showToast('Save failed: ' + e.message, 5000);
        return false;
      } finally {
        saving.value = false;
      }
    }

    // ── Field roles ───────────────────────────────────────────────────────
    // Which detected field plays each role, saved as a field-config edit rather
    // than the node mapping this panel replaces. The mapping addressed a node
    // for three roles and only the classic controls ever read it; an edit
    // addresses the field itself, covers every role, and is merged into every
    // detection run — so it is visible in the mode the app actually uses.
    async function toggleRoles(w) {
      if (roles.name === w.name) { roles.name = ''; return; }
      roles.name = w.name; roles.loading = true; roles.error = '';
      roles.fields = []; roles.savedEdits = {}; roles.choice = {};
      try {
        const cfg = await api.fieldConfig(w.name);
        if (!cfg || !Array.isArray(cfg.fields) || !cfg.fields.length) throw new Error('nothing detected in this workflow');
        roles.fields = cfg.fields;
        roles.savedEdits = cfg.savedEdits || {};
        const choice = {};
        // The detector nominates its own pick by enabling one of the same-kind
        // candidates, so that is what the panel opens on.
        for (const r of ROLES) {
          const same = cfg.fields.filter(f => f.kind === r.kind);
          const pick = same.find(f => f.enabled) || same[0];
          choice[r.kind] = pick ? pick.id : '';
        }
        roles.choice = choice;
      } catch (e) { roles.error = 'Could not read the fields: ' + e.message; }
      roles.loading = false;
    }
    // Same-kind candidates first — the ordinary case is picking a different one
    // of those — then anything whose control could plausibly hold the role.
    const roleOptions = r => {
      const same = roles.fields.filter(f => f.kind === r.kind);
      const others = roles.fields.filter(f => f.kind !== r.kind
        && r.types.includes((f.control && f.control.type) || 'text'));
      return same.concat(others);
    };
    const isForeign = (f, r) => f.kind !== r.kind;
    const fieldLabel = (f) => {
      const t = (f.targets || [])[0] || {};
      const node = t.title || t.class || '';
      return f.label + (node ? ' · ' + node : '') + (t.nodeId == null ? '' : ' #' + t.nodeId);
    };
    async function saveRoles(w) {
      if (roles.busy) return;
      roles.busy = true;
      // Merge into what is already stored: the endpoint replaces the whole edits
      // map, so sending only this panel's keys would drop the inspect page's.
      const edits = JSON.parse(JSON.stringify(roles.savedEdits || {}));
      const put = (id, patch) => { edits[id] = Object.assign({}, edits[id], patch); };
      for (const r of ROLES) {
        const chosen = roles.choice[r.kind];
        for (const f of roles.fields) {
          if (f.kind !== r.kind || f.id === chosen) continue;
          if (f.enabled) put(f.id, { enabled: false });
          // A role that moved must not leave its own override behind, or the
          // field it left keeps claiming the kind it no longer plays.
          if (edits[f.id] && edits[f.id].kind === r.kind) delete edits[f.id].kind;
        }
        if (!chosen) continue;
        const f = roles.fields.find(x => x.id === chosen);
        if (!f) continue;
        put(f.id, { enabled: true });
        // Only when the detector called it something else — otherwise the kind
        // stays detection's to change on the next run.
        if (f.kind !== r.kind) put(f.id, { kind: r.kind });
      }
      try {
        await api.saveFieldConfig(w.name, edits);
        showToast('Field roles saved');
        roles.name = '';
      } catch (e) { showToast('Save failed: ' + e.message, 5000); }
      roles.busy = false;
    }

    // ── ＋ Add: the library picker ─────────────────────────────────────────
    // Ported from RemixDialog's wfLib. It edits the same `all` the page renders,
    // so Cancel has to put the server's answer back rather than merely close.
    const lib = reactive({ open: false, q: '' });
    const openLib = () => { lib.open = true; lib.q = ''; };
    async function cancelLib() { lib.open = false; await load(); }

    const libShown = computed(() => {
      const q = lib.q.trim().toLowerCase();
      const list = q ? all.value.filter(w => (w.name + ' ' + w.label).toLowerCase().includes(q)) : all.value.slice();
      // Already in the library first, so what you just ticked stays in view.
      return list.sort((a, b) => (b.enabled - a.enabled)
        || (a.label || a.name).toLowerCase().localeCompare((b.label || b.name).toLowerCase()));
    });
    const libCount = computed(() => all.value.filter(w => w.enabled).length);
    // Two workflows can reduce to the same default label ("APP VIDEO CLIP SFW"
    // and "APP VIDEO CLIP" both become "VIDEO CLIP"), and the list would then
    // carry two identical entries with no way to tell them apart.
    const libDupes = computed(() => {
      const seen = {}, dupes = new Set();
      for (const w of all.value) {
        if (!w.enabled) continue;
        const k = (w.label || w.name).trim().toLowerCase();
        if (seen[k]) dupes.add(k); else seen[k] = 1;
      }
      return dupes;
    });
    async function saveLib() {
      const n = libCount.value;
      if (await saveAll(n + ' workflow' + (n === 1 ? '' : 's') + ' in the library')) lib.open = false;
    }

    return {
      loading, error, rows, saving, open,
      ROLES, roles, toggleRoles, roleOptions, isForeign, fieldLabel, saveRoles,
      lib, libShown, libCount, libDupes, openLib, cancelLib, saveLib,
    };
  },
  template: `
    <div class="wf-page">
      <div class="wf-head">
        <router-link class="wf-back" to="/" title="Home">←</router-link>
        <h1 class="wf-title">Workflows</h1>
        <button class="wf-add" @click="openLib" title="Pick workflows from your ComfyUI folder">＋ Add</button>
      </div>
      <div class="wf-blurb">The workflows Remix offers. Open one to inspect and run it.</div>

      <div v-if="loading" class="loading"><div class="spinner"></div> Loading…</div>
      <div v-else-if="error" class="loading">{{ error }}</div>
      <div v-else-if="!rows.length" class="loading">
        Nothing in the library yet — ＋ Add picks workflows up from your ComfyUI folder.
      </div>
      <div v-else class="wf-list">
        <div v-for="w in rows" :key="w.name" class="wf-item">
          <div class="wf-item-row">
            <button class="wf-row" :title="w.name" @click="open(w)">
              <span class="wf-row-icon">🧩</span>
              <span class="wf-row-text">
                <span class="wf-row-label">{{ w.label }}</span>
                <span class="wf-row-sub">{{ w.name }}<span v-if="w.shortcuts"> · {{ w.shortcuts }} shortcut{{ w.shortcuts === 1 ? '' : 's' }}</span></span>
              </span>
              <span class="wf-row-go">›</span>
            </button>
            <button class="wf-map-btn" :class="{ on: roles.name === w.name }" @click="toggleRoles(w)"
                    title="Which detected field is the prompt, seed, steps…">⚙</button>
          </div>

          <div v-if="roles.name === w.name" class="wf-maps">
            <div class="wf-maps-note">Which detected field plays each role. The detector's own pick is preselected — change one and that field is switched on and the previous one off. A field the detector called something else is marked ⤳, and saving pins its kind.</div>
            <div v-if="roles.loading" class="rmx-mut">Reading fields…</div>
            <div v-else-if="roles.error" class="rmx-mut">{{ roles.error }}</div>
            <template v-else>
              <label v-for="r in ROLES" :key="r.kind" class="wf-map">
                <span class="wf-map-lbl">{{ r.label }}</span>
                <select class="wf-map-sel" v-model="roles.choice[r.kind]">
                  <option value="">— none —</option>
                  <option v-for="f in roleOptions(r)" :key="f.id" :value="f.id">{{ (isForeign(f, r) ? '⤳ ' : '') + fieldLabel(f) }}</option>
                </select>
              </label>
              <div class="wf-maps-foot">
                <button class="wf-add" :disabled="roles.busy" @click="saveRoles(w)">{{ roles.busy ? 'Saving…' : 'Save roles' }}</button>
              </div>
            </template>
          </div>
        </div>
      </div>

      <!-- The library picker. Markup and classes are the Remix dialog's, so the
           two stay one control rather than drifting into two lookalikes. -->
      <div v-if="lib.open" class="rmx-picker-overlay" data-backdrop @click.self="cancelLib">
        <div class="rmx-picker" style="max-width:720px">
          <div class="rmx-picker-head">
            <b>Workflow library</b>
            <span class="rmx-mut" style="text-transform:none">{{ libCount }} of {{ libShown.length }} in the library</span>
            <button class="rmx-x" style="margin-left:auto" @click="cancelLib">✕</button>
          </div>
          <div class="mb-toolbar"><input class="rmx-inp mb-search" v-model="lib.q" placeholder="Search workflows…"></div>
          <div style="overflow:auto;flex:1;min-height:0;padding:8px 12px">
            <div v-if="!libShown.length" class="rmx-mut" style="padding:16px">No workflows match.</div>
            <div v-for="w in libShown" :key="w.name" class="rmx-lib-row">
              <input type="checkbox" class="rmx-tgl" v-model="w.enabled" :title="w.enabled ? 'Remove from the library' : 'Add to the library'">
              <input class="rmx-inp" v-model="w.label" placeholder="label" title="Shown wherever the workflow is listed">
              <span class="rmx-mut rmx-lib-name" :title="w.name">{{ w.name }}</span>
              <span v-if="w.enabled && libDupes.has((w.label||w.name).trim().toLowerCase())" class="rmx-lib-warn"
                    title="Another workflow in the library uses this same label — rename one so you can tell them apart">⚠</span>
            </div>
          </div>
          <div class="rmx-picker-head" style="border-top:1px solid #2c2c2e;border-bottom:none">
            <span class="rmx-mut" style="text-transform:none">Tick a workflow to add it to the library.</span>
            <button class="rmx-btn2" style="margin-left:auto" @click="cancelLib">Cancel</button>
            <button class="rmx-btn2" :disabled="saving" @click="saveLib">{{ saving ? 'Saving…' : 'Save' }}</button>
          </div>
        </div>
      </div>
    </div>
  `,
};
