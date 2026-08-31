// ── Settings ───────────────────────────────────────────────────────────────
// Three tabs over one save button:
//
//   Config   — API keys (masked, cleared explicitly), service URLs, and the two
//              ComfyUI paths with a server-side folder browser beside them.
//   Privacy  — media caching, and the term list safe mode filters on. Shown in plain text,
//              stored encoded (the server does the encoding).
//   Security — the password gate. One control at a time: with no password there
//              is only somewhere to type one, and once there is a password there
//              is nothing to retype, so the boxes give way to the toggle.
//
// The pre-SPA version of this panel was plain DOM — every field read back out of
// the document at save time, and dirty/clear state parked in dataset attributes
// on the inputs. Here the fields *are* the state; nothing is read back out.
import { store, showToast } from '../store.js';
import { api } from '../api.js';
import FolderPicker from './FolderPicker.js';
import { fmtNum, fmtBytes } from '../format.js';

const { reactive, computed, watch, nextTick, ref, onBeforeUnmount } = window.Vue;

const AUTH_MIN_LEN = 7;  // server enforces the same floor

const KEY_FIELDS = [
  { k: 'civitaiApiKey', label: 'Civitai' },
];
const URL_FIELDS = [
  { k: 'comfyUrl', label: 'ComfyUI API', ph: 'http://127.0.0.1:8188' },
];
const PATH_FIELDS = [
  {
    k: 'comfyDir', label: 'ComfyUI install folder', ph: 'D:\\ComfyUI\\...',
    hint: 'Drives the workflow list and the run controls.',
  },
  { k: 'comfyOutput', label: 'ComfyUI output folder', ph: 'D:\\ComfyUI\\output', hint: '' },
];

export default {
  name: 'SettingsPanel',
  components: { FolderPicker },
  // Two shapes, one body. As a dialog it keeps the overlay, the title bar and
  // the tab strip; as a route view (`page`) that chrome falls away and `only`
  // picks the single section to render, because the route already said which
  // one and SettingsView owns the going-back.
  props: {
    open: { type: Boolean, default: false },
    page: { type: Boolean, default: false },
    only: { type: String, default: '' },
  },
  emits: ['close'],
  setup(props, { emit }) {
    const s = reactive({
      tab: 'config',
      restarting: false,   // the button is busy from the click until the port answers
      restartMsg: '',
      loading: false,
      saving: false,
      // Did the two loads actually succeed? Every field below defaults to
      // off/empty, so saving from an unloaded panel writes those defaults over
      // real settings rather than leaving them alone.
      loaded: false,
      nsfwLoaded: false,
      // key  → { value, dirty, clear, placeholder }
      keys: Object.fromEntries(KEY_FIELDS.map(f => [f.k, { value: '', dirty: false, clear: false, placeholder: 'not set' }])),
      urls: Object.fromEntries(URL_FIELDS.map(f => [f.k, ''])),
      // path → { value (editable), loaded, exists, hasWorkflows } — the state
      // badge reports what the server said about `loaded`, not about whatever is
      // being typed over it, which is nothing it has checked yet.
      paths: Object.fromEntries(PATH_FIELDS.map(f => [f.k, { value: '', loaded: '', exists: false, hasWorkflows: undefined }])),
      nsfw: [], nsfwInput: '',
      mediaCache: 'nostore',   // how long the browser may keep media; see Privacy tab
      privacyTab: 'cache',     // 'cache' | 'tags' — the two halves of Privacy
      auth: {
        legacy: false,      // server predates the gate — nothing here can be saved
        hasPassword: false,
        enabled: false,
        pw: '', pw2: '',
        clear: false,       // "Remove password" armed; applied on Save
        editing: false,     // "Change" clicked: show the boxes over a stored password
        placeholder: 'Choose a password',
      },
      picker: { open: false, target: '' },
      // Restore from a backup folder. Three steps, and the middle one is the point:
      // pick a folder, read back what is in it and what that would overwrite, then
      // copy. Nothing is written until the list on screen has been looked at.
      restore: {
        root: '',        // the folder chosen, once it has been inspected
        reading: false,
        reason: '',      // why the folder was refused, if it was
        stamps: [],      // dated folders inside it, when the folder above one was picked
        parts: [],       // what was found, each with its measurement
        pick: {},        // key -> ticked
        job: null,       // the run, while it runs and after it finishes
      },
    });
    const pwInput = ref(null);
    const tagInput = ref(null);

    // ── Load ──
    // The password itself never comes back — only whether one exists. A server
    // with no `security` block at all predates the gate: it answers ok:true to a
    // password save and drops it, so say so rather than let the save look like
    // it worked.
    function applySecurity(st) {
      const sec = st.security || {};
      s.auth.legacy = !st.security;
      s.auth.clear = false;
      s.auth.editing = false;
      s.auth.enabled = !!sec.enabled;
      s.auth.hasPassword = !!sec.hasPassword;
      s.auth.pw = '';
      s.auth.pw2 = '';
      s.auth.placeholder = 'Choose a password';
    }
    function apply(st) {
      for (const f of KEY_FIELDS) {
        const info = (st.keys || {})[f.k] || {};
        s.keys[f.k] = { value: '', dirty: false, clear: false, placeholder: info.set ? info.hint : 'not set' };
      }
      for (const f of URL_FIELDS) s.urls[f.k] = (st.urls || {})[f.k] || '';
      for (const f of PATH_FIELDS) {
        const p = (st.paths || {})[f.k] || {};
        s.paths[f.k] = { value: p.value || '', loaded: p.value || '', exists: !!p.exists, hasWorkflows: p.hasWorkflows };
      }
      // Unknown/absent policy falls back to the safest option rather than to
      // whatever the radio group happens to list first.
      const pol = ((st.privacy || {}).mediaCachePolicy) || 'nostore';
      s.mediaCache = ['nostore', 'validate', 'day'].includes(pol) ? pol : 'nostore';
      applySecurity(st);
      store.settings = st;
    }

    async function load() {
      s.loading = true;
      s.loaded = false; s.nsfwLoaded = false;
      try { apply(await api.settings()); s.loaded = true; }
      catch (e) { showToast('Settings load failed: ' + e.message, 6000); }
      // Decoded server-side for display; re-encoded when saved.
      try {
        const d = await api.nsfwTerms();
        s.nsfw = Array.isArray(d.terms) ? d.terms.slice() : [];
        s.nsfwLoaded = true;
      } catch (e) {
        s.nsfw = [];
        showToast('Tag list failed to load — tags will be left alone on save', 6000);
      }
      s.loading = false;
    }
    watch(() => props.open, isOpen => { if (isOpen) { s.tab = 'config'; load(); } }, { immediate: true });

    // ── Config tab ──
    const keyInput = k => { const f = s.keys[k]; f.dirty = true; f.clear = false; };
    const keyClear = k => {
      const f = s.keys[k];
      f.value = ''; f.placeholder = '(will clear on save)'; f.clear = true; f.dirty = false;
    };
    // Frozen at load, as before: typing a new path doesn't make the server's
    // verdict on the old one wrong, it makes it not yet asked.
    function pathState(k) {
      const p = s.paths[k];
      if (!p || !p.loaded) return null;
      const ok = p.exists && p.hasWorkflows !== false;
      const text = !p.exists ? '✗ missing'
        : (k === 'comfyDir' && p.hasWorkflows === false ? '⚠ no workflows dir inside' : '✓');
      return { text, color: ok ? 'var(--green)' : 'var(--amber)' };
    }
    // The picker is shared by the two path fields and by Restore, so the target is
    // either a path key or the sentinel below. A key that is neither writes nowhere,
    // which is what the guards in pickerSeed and picked are for.
    const RESTORE_TARGET = '__restore';
    const browse = k => { s.picker.target = k; s.picker.open = true; };
    const pickerSeed = computed(() => {
      if (s.picker.target === RESTORE_TARGET) return s.restore.root;
      return s.picker.target && s.paths[s.picker.target] ? s.paths[s.picker.target].value : '';
    });
    function picked(p) {
      if (s.picker.target === RESTORE_TARGET) { restoreInspect(p); return; }
      if (s.picker.target && s.paths[s.picker.target]) s.paths[s.picker.target].value = p;
    }

    // ── Privacy tab ──
    // Displayed alphabetically; the stored order is unaffected.
    const nsfwSorted = computed(() => s.nsfw.slice().sort((a, b) => a.localeCompare(b)));
    function addTag() {
      const v = s.nsfwInput.trim().toLowerCase();
      if (v && !s.nsfw.includes(v)) s.nsfw.push(v);
      s.nsfwInput = '';
      if (tagInput.value) tagInput.value.focus();
    }
    function removeTag(t) {
      const i = s.nsfw.indexOf(t);
      if (i > -1) s.nsfw.splice(i, 1);
    }

    // ── Security tab ──
    // The toggle never appears without a password behind it — saving would
    // bounce off the server, and a ticked box would imply protection that isn't on.
    const stored = computed(() => !s.auth.clear && s.auth.hasPassword);
    const typed = computed(() => s.auth.pw.length);
    const usable = computed(() => !s.auth.legacy && (stored.value || typed.value >= AUTH_MIN_LEN));
    const editing = computed(() => s.auth.legacy || !stored.value || s.auth.editing);
    // Only nag once they've started typing — an empty box explains itself.
    const minHint = computed(() => {
      if (!(editing.value && typed.value > 0 && typed.value < AUTH_MIN_LEN)) return '';
      const n = AUTH_MIN_LEN - typed.value;
      return n + ' more character' + (n === 1 ? '' : 's') + ' before protection can be switched on';
    });
    watch(usable, u => { if (!u) s.auth.enabled = false; });

    function authChange() {
      s.auth.editing = true;
      s.auth.placeholder = 'New password';
      nextTick(() => { if (pwInput.value) pwInput.value.focus(); });
    }
    function authRemove() {
      if (!window.confirm('Remove the password?\n\nThe app becomes reachable to anyone who can reach this server, and every signed-in device is signed out.')) return;
      s.auth.clear = true;
      s.auth.editing = false;
      s.auth.pw = '';
      s.auth.pw2 = '';
    }
    // Typing a new one countermands the removal.
    const authTyped = () => { if (s.auth.clear) s.auth.clear = false; };

    // ── Restart ──
    // The server answers, then goes. So the fetch resolving is not the finish line and a
    // failed fetch afterwards is not an error -- it is the expected middle. What tells us
    // it worked is the port answering again, which is why this polls rather than trusting
    // the reply, and reloads only once something is actually there to load.
    async function restartServer() {
      if (s.restarting) return;
      if (!window.confirm('Restart the server?\\n\\nThe page will reconnect on its own. Anything generating keeps going — ComfyUI is a separate process — but this window loses its live connection for a few seconds.')) return;
      s.restarting = true;
      s.restartMsg = 'Asking the server to restart…';
      try {
        await api.restartServer();
      } catch (e) {
        // A dropped connection here means it went down mid-reply, which is success.
        // Only a real refusal (a 4xx/5xx body) is worth stopping for.
        if (/^HTTP [45]|Could not start the restart helper/.test(e.message)) {
          s.restarting = false;
          s.restartMsg = '';
          // A 404 is not a refusal, it is an age gap: the endpoint lives in server.js,
          // while this button is served from disk and appeared the moment the file did.
          // Saying "refused" for that sends you looking for a permissions problem.
          showToast(/^HTTP 404/.test(e.message)
            ? 'This server is running code from before the Restart button existed. Restart it once by hand — then this button works from here on.'
            : 'Restart refused: ' + e.message, 9000);
          return;
        }
      }
      s.restartMsg = 'Restarting — waiting for the server to come back…';
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 1500));
        try {
          const r = await fetch('/api/auth/status', { cache: 'no-store' });
          if (r.ok || r.status === 401) { s.restartMsg = 'Back up — reloading…'; location.reload(); return; }
        } catch { /* still down, keep waiting */ }
      }
      s.restarting = false;
      s.restartMsg = '';
      showToast('The server did not come back within 90s. Check restart.log in the app folder.', 9000);
    }

    // ── Restore from a backup ──
    // Deliberately here rather than on the Clean page that writes the backups: that page
    // is unavailable whenever its scheduled task is not registered, which is exactly the
    // state of a machine that has just been rebuilt — the one you most want to restore
    // onto. This needs no task, so it sits with the other server actions.
    const restoreBusy = computed(() => !!(s.restore.job && s.restore.job.state === 'running'));

    async function restoreInspect(p) {
      s.restore.reading = true;
      s.restore.reason = '';
      s.restore.stamps = [];
      s.restore.parts = [];
      s.restore.job = null;
      try {
        const d = await api.restoreInspect(p);
        s.restore.root = d.resolved || p;
        if (!d.ok) {
          s.restore.reason = d.reason || 'That does not look like a backup.';
          s.restore.stamps = Array.isArray(d.stamps) ? d.stamps : [];
        } else {
          s.restore.parts = d.parts || [];
          // Everything that has something in it starts ticked, except the settings.
          // Those overwrite config.json — ports, paths, keys, the password hash — over a
          // server that is running on it, so that one is a deliberate second decision
          // rather than something that happens because a folder was picked.
          const pick = {};
          for (const part of s.restore.parts) pick[part.key] = !part.blocked && part.files > 0 && part.key !== 'config';
          s.restore.pick = pick;
        }
      } catch (err) {
        s.restore.reason = 'Could not read that folder: ' + err.message;
      }
      s.restore.reading = false;
    }

    const restorePicked = computed(() =>
      s.restore.parts.filter(p => !p.blocked && p.files > 0 && s.restore.pick[p.key]));
    const restoreTotals = computed(() => {
      let files = 0, bytes = 0, existing = 0;
      for (const p of restorePicked.value) { files += p.files || 0; bytes += p.bytes || 0; existing += p.existing || 0; }
      return { files, bytes, existing };
    });

    // The run outlives the request, so this is what reports it. Stopped on unmount the
    // same way the Clean page's poll is, and for the same reason: a poll already in
    // flight would otherwise reschedule itself forever.
    let restoreTimer = null, restoreStopped = false;
    async function restorePoll() {
      if (restoreStopped) return;
      try {
        const d = await api.restoreState();
        s.restore.job = d.job || null;
      } catch { /* a poll that fails is not worth a toast */ }
      if (!restoreStopped && s.restore.job && s.restore.job.state === 'running') restoreTimer = setTimeout(restorePoll, 900);
    }

    async function runRestore() {
      const picks = restorePicked.value;
      if (!picks.length || restoreBusy.value) return;
      const t = restoreTotals.value;
      const cfg = picks.some(p => p.key === 'config');
      const ok = window.confirm(
        'Restore from\n  ' + s.restore.root + '\n\n'
        + picks.map(p => '  • ' + p.label + ' → ' + p.to).join('\n')
        + '\n\n' + fmtNum(t.files) + ' files, ' + fmtBytes(t.bytes)
        + (t.existing ? '\n' + fmtNum(t.existing) + ' of them already exist and will be OVERWRITTEN.' : '')
        + '\n\nNothing is deleted — files that are only at the destination are left alone.'
        + (cfg ? '\n\nSettings are included: this overwrites config.json, so a different password in the backup will sign you out, and the port and media root need a restart to take effect.' : '')
      );
      if (!ok) return;
      try {
        await api.restore(s.restore.root, picks.map(p => p.key));
        s.restore.job = { state: 'running', files: 0, bytes: 0, folder: '', log: '' };
        restoreTimer = setTimeout(restorePoll, 500);
      } catch (err) {
        showToast('Restore refused: ' + err.message, 9000);
      }
    }

    function restoreClear() {
      if (restoreBusy.value) return;
      clearTimeout(restoreTimer);
      s.restore.root = '';
      s.restore.parts = [];
      s.restore.stamps = [];
      s.restore.reason = '';
      s.restore.job = null;
    }

    // ── Save ──
    async function save() {
      if (s.saving) return;
      const payload = {};
      for (const f of KEY_FIELDS) {
        const k = s.keys[f.k];
        if (k.clear) payload[f.k] = null;                                        // clear
        else if (k.dirty && k.value.trim() !== '') payload[f.k] = k.value.trim();
        // blank + untouched → omit (leave the key unchanged)
      }
      for (const f of URL_FIELDS) {
        const v = (s.urls[f.k] || '').trim();
        if (v !== '') payload[f.k] = v;
      }
      for (const f of PATH_FIELDS) {
        const v = (s.paths[f.k].value || '').trim();
        if (v !== '') payload[f.k] = v;
      }
      payload.mediaCachePolicy = s.mediaCache;
      // Password gate: a blank box means "leave it as it is", so only a typed
      // password is sent. Both halves must match before anything leaves the browser.
      const pw = s.auth.pw, pw2 = s.auth.pw2;
      if (s.auth.clear) payload.authPassword = null;
      else if (pw !== '' || pw2 !== '') {
        if (pw !== pw2) { showToast('The two passwords don’t match'); return; }
        if (pw.length < AUTH_MIN_LEN) { showToast('Password must be at least ' + AUTH_MIN_LEN + ' characters'); return; }
        payload.authPassword = pw;
      }
      // Never save over state we failed to read. Every field here defaults to
      // "off"/"empty", so a save from an unloaded panel doesn't leave settings
      // untouched — it actively writes those defaults: the gate goes off and the
      // tag list is replaced with [].
      if (!s.loaded) { showToast('Settings never loaded — reopen the panel before saving', 6000); return; }
      const wantAuth = s.auth.enabled;
      if (wantAuth && !payload.authPassword && !s.auth.hasPassword) {
        showToast('Set a password before turning protection on'); return;
      }
      if (!s.auth.legacy) payload.authEnabled = wantAuth && !s.auth.clear;

      s.saving = true;
      try {
        const d = await api.saveSettings(payload);
        if (!d || !d.ok) { showToast('Save failed: ' + ((d && d.error) || 'unknown error')); return; }
        // Persist the tag list too (sent plaintext, stored encoded) — but only if
        // it loaded. Posting the empty default would wipe the stored terms and
        // re-tag the whole prompt index, silently disarming safe mode.
        if (s.nsfwLoaded) {
          try {
            const nd = await api.saveNsfwTerms(s.nsfw);
            if (!nd || !nd.ok) throw new Error((nd && nd.error) || 'unknown error');
          } catch (e) { showToast('Tags save failed: ' + e.message); return; }
        }
        // Read the gate back rather than trusting ok:true. A server that doesn't
        // implement these keys still answers ok:true, and "✓ Saved" over a
        // password that was never stored is the worst possible outcome here.
        let after = null;
        if ('authEnabled' in payload || 'authPassword' in payload) {
          after = await api.settings().catch(() => null);
          const got = after && after.security;
          if (!got || !!got.enabled !== !!payload.authEnabled) {
            showToast('Password not saved — this server needs a restart to support it', 6000);
            return;
          }
        }
        // The shell shows its logout control off store.authEnabled.
        api.authStatus().then(a => { store.authEnabled = !!(a && a.enabled); }).catch(() => {});
        // Setting or removing a password keeps the panel open: the tab changes
        // shape when it lands (boxes out, toggle in), and closing over the top of
        // that hides the only confirmation there is.
        if (after && 'authPassword' in payload) {
          applySecurity(after);
          store.settings = after;
          showToast(payload.authPassword === null ? '✓ Password removed'
            : after.security.enabled ? '✓ Password set — protection is on'
              : '✓ Password saved — tick “Require a password” to switch it on', 4500);
          return;
        }
        showToast(d.warning ? '⚠ Saved — ' + d.warning : '✓ Settings saved', d.warning ? 5000 : 2200);
        emit('close');
      } catch (e) {
        showToast('Save failed: ' + e.message);
      } finally {
        s.saving = false;
      }
    }

    function close() { if (!s.saving) emit('close'); }

    // Escape backs out one layer at a time — the folder browser opens on top of
    // this panel, so it has to be the one that closes first.
    function onKey(e) {
      if (!props.open || e.key !== 'Escape') return;
      if (s.picker.open) { s.picker.open = false; return; }
      close();
    }
    window.addEventListener('keydown', onKey);
    onBeforeUnmount(() => {
      window.removeEventListener('keydown', onKey);
      restoreStopped = true;
      clearTimeout(restoreTimer);
    });

    // In page mode the route names the section; in dialog mode the tab strip does.
    const curTab = computed(() => (props.page ? (props.only || 'config') : s.tab));

    return {
      s, curTab, KEY_FIELDS, URL_FIELDS, PATH_FIELDS,
      pwInput, tagInput,
      keyInput, keyClear, pathState, browse, pickerSeed, picked,
      nsfwSorted, addTag, removeTag,
      stored, usable, editing, minHint, authChange, authRemove, authTyped,
      save, close, restartServer,
      RESTORE_TARGET, restoreBusy, restorePicked, restoreTotals,
      restoreInspect, runRestore, restoreClear, fmtNum, fmtBytes,
    };
  },
  template: `
    <div v-if="open" :class="page ? 'set-page' : 'confirm-overlay open center'" @click.self="page ? null : close()">
      <div :class="page ? 'set-page-body' : 'set-sheet'">
        <div v-if="!page" class="set-head">
          <div class="confirm-title">Settings</div>
          <button class="set-x" @click="close">✕</button>
        </div>

        <div v-if="!page" class="file-tabs set-tabs">
          <button class="file-tab" :class="{ active: s.tab === 'config' }" @click="s.tab = 'config'">Config</button>
          <button class="file-tab" :class="{ active: s.tab === 'privacy' }" @click="s.tab = 'privacy'">Privacy</button>
          <button class="file-tab" :class="{ active: s.tab === 'security' }" @click="s.tab = 'security'">Security</button>
        </div>

        <div v-if="s.loading" class="loading"><div class="spinner"></div> Loading…</div>

        <!-- ── Config ── -->
        <div v-show="!s.loading && curTab === 'config'">
          <div class="set-sec">API Keys</div>
          <div v-for="f in KEY_FIELDS" :key="f.k" class="set-field">
            <label>{{ f.label }}</label>
            <div class="set-row">
              <input type="password" autocomplete="off" :placeholder="s.keys[f.k].placeholder"
                     v-model="s.keys[f.k].value" @input="keyInput(f.k)">
              <button class="set-clr" title="Clear" @click="keyClear(f.k)">✕</button>
            </div>
          </div>

          <div class="set-sec">Service URLs</div>
          <div v-for="f in URL_FIELDS" :key="f.k" class="set-field">
            <label>{{ f.label }}</label>
            <div class="set-row"><input type="text" autocomplete="off" :placeholder="f.ph" v-model="s.urls[f.k]"></div>
          </div>

          <div class="set-sec">Paths</div>
          <div v-for="f in PATH_FIELDS" :key="f.k" class="set-field">
            <label>
              {{ f.label }}
              <span v-if="pathState(f.k)" class="set-state" :style="{ color: pathState(f.k).color }">{{ pathState(f.k).text }}</span>
            </label>
            <div class="set-row">
              <input type="text" autocomplete="off" :placeholder="f.ph" v-model="s.paths[f.k].value">
              <button class="set-clr set-browse" title="Browse server folders" @click="browse(f.k)">📁</button>
            </div>
            <div v-if="f.hint" class="set-hint">{{ f.hint }}</div>
          </div>

          <!-- Server actions, not settings: nothing here is saved, so it sits below the
               fields rather than above the Save button it has nothing to do with. -->
          <div class="set-sec">Server</div>
          <div class="set-blurb">
            Applies changes to <code>server.js</code>. The page reconnects on its own.
            Generations keep running — ComfyUI is a separate process.
          </div>
          <div class="set-actions">
            <button class="set-btn" :disabled="s.restarting" @click="restartServer">
              {{ s.restarting ? 'Restarting…' : 'Restart server' }}
            </button>
            <button class="set-btn" :disabled="s.restore.reading || restoreBusy"
                    @click="browse(RESTORE_TARGET)">
              {{ s.restore.reading ? 'Reading…' : (restoreBusy ? 'Restoring…' : 'Restore from backup…') }}
            </button>
            <span v-if="s.restartMsg" class="set-hint set-restart-msg">{{ s.restartMsg }}</span>
          </div>
          <div class="set-hint">
            Copies a backup folder's contents back where they came from. It merges and
            never deletes: a file in the backup replaces the one at the destination, and
            a file only at the destination is left alone.
          </div>

          <!-- Everything below appears only once a folder has been read, so the button
               above is the whole control until there is something to say about it. -->
          <div v-if="s.restore.root" class="rst-box">
            <div class="rst-head">
              <div class="rst-path">{{ s.restore.root }}</div>
              <button class="set-x" :disabled="restoreBusy" @click="restoreClear">✕</button>
            </div>

            <div v-if="s.restore.reason" class="rst-warn">
              {{ s.restore.reason }}
              <!-- Picking the folder the backups go into rather than a backup is the
                   likely mistake, so it is answered with the list rather than denied. -->
              <div v-if="s.restore.stamps.length" class="rst-stamps">
                <button v-for="st in s.restore.stamps" :key="st.path" class="set-clr"
                        @click="restoreInspect(st.path)">{{ st.name }}</button>
              </div>
            </div>

            <template v-else>
              <label v-for="p in s.restore.parts" :key="p.key" class="rst-row"
                     :class="{ off: p.blocked || !p.files }">
                <input type="checkbox" v-model="s.restore.pick[p.key]"
                       :disabled="restoreBusy || !!p.blocked || !p.files">
                <span class="rst-body">
                  <span class="rst-line">
                    <b>{{ p.label }}</b>
                    <span class="rst-size">{{ p.blocked ? '' : (p.files ? fmtNum(p.files) + ' files · ' + fmtBytes(p.bytes) : 'empty') }}</span>
                  </span>
                  <span class="rst-sub">→ {{ p.to }}</span>
                  <span v-if="p.detail" class="rst-sub">{{ p.detail }}</span>
                  <span v-if="p.blocked" class="rst-note">{{ p.blocked }}</span>
                  <!-- The number that makes the decision, on the row it belongs to. -->
                  <span v-else-if="p.existing" class="rst-note">
                    {{ fmtNum(p.existing) }} of these already exist and would be overwritten
                  </span>
                  <span v-if="p.key === 'config' && !p.blocked && p.files" class="rst-note">
                    Overwrites config.json over a running server — a different password in
                    the backup signs you out, and the port and media root need a restart.
                  </span>
                </span>
              </label>

              <div class="rst-foot">
                <div class="rst-total">
                  <template v-if="restorePicked.length">
                    {{ fmtNum(restoreTotals.files) }} files · {{ fmtBytes(restoreTotals.bytes) }}
                    <span v-if="restoreTotals.existing" class="set-hint">
                      — {{ fmtNum(restoreTotals.existing) }} overwritten
                    </span>
                  </template>
                  <span v-else class="set-hint">Nothing ticked</span>
                </div>
                <button class="set-btn btn-ok btn-accent"
                        :disabled="!restorePicked.length || restoreBusy" @click="runRestore">
                  {{ restoreBusy ? 'Restoring…' : 'Restore' }}
                </button>
              </div>
            </template>

            <!-- Stays up after it finishes: what came back, and where, is the thing
                 worth reading once a restore has run. -->
            <div v-if="s.restore.job" class="rst-job" :class="s.restore.job.state">
              <div>
                <b>{{ s.restore.job.state === 'running' ? 'Restoring' : (s.restore.job.state === 'failed' ? 'Restore failed' : 'Restored') }}</b>
                {{ fmtNum(s.restore.job.files) }} files · {{ fmtBytes(s.restore.job.bytes) }}
                <span v-if="s.restore.job.folder" class="set-hint">— {{ s.restore.job.folder }}</span>
              </div>
              <pre v-if="s.restore.job.log" class="rst-log">{{ s.restore.job.log }}</pre>
              <div v-if="s.restore.job.error" class="rst-warn">{{ s.restore.job.error }}</div>
            </div>
          </div>
        </div>

        <!-- ── Privacy ── -->
        <div v-show="!s.loading && curTab === 'privacy'">
          <!-- Two unrelated concerns share this section — what the browser keeps
               on disk, and what safe mode hides — so they get a tab each rather
               than one long scroll. Both still save through the one Save button. -->
          <div class="file-tabs set-tabs">
            <button class="file-tab" :class="{ active: s.privacyTab === 'cache' }" @click="s.privacyTab = 'cache'">Media caching</button>
            <button class="file-tab" :class="{ active: s.privacyTab === 'tags' }" @click="s.privacyTab = 'tags'">Content filter</button>
          </div>

          <div v-show="s.privacyTab === 'cache'">
          <div class="set-sec">Media caching</div>
          <div class="set-blurb">
            How long this browser may keep thumbnails and full media it has already fetched.
            No web header can erase files at a deadline — a time limit only says how long a
            copy may be reused without re-asking, not how long it is kept — so
            <b>Never store on disk</b> is the only option that keeps media out of the cache
            entirely. Applies to whichever browser loads the page; existing cached files are
            unaffected until they are re-fetched.
          </div>
          <div class="cache-opts">
            <label class="cache-opt" :class="{ on: s.mediaCache === 'nostore' }">
              <input type="radio" value="nostore" v-model="s.mediaCache">
              <span class="cache-txt"><b>Never store on disk</b><span class="cache-sub">Nothing is written to the browser cache. Re-downloads on every view — safest, and the default.</span></span>
            </label>
            <label class="cache-opt" :class="{ on: s.mediaCache === 'validate' }">
              <input type="radio" value="validate" v-model="s.mediaCache">
              <span class="cache-txt"><b>Store, but check every time</b><span class="cache-sub">Kept on disk and re-checked with the server on each view. Faster, but the files do sit in the cache.</span></span>
            </label>
            <label class="cache-opt" :class="{ on: s.mediaCache === 'day' }">
              <input type="radio" value="day" v-model="s.mediaCache">
              <span class="cache-txt"><b>Reuse for a day</b><span class="cache-sub">Reused for 24h without asking the server. Fastest on a phone; files can outlive the day on disk.</span></span>
            </label>
          </div>
          <div class="set-blurb" style="margin-top:6px">
            Logging out also asks the browser to purge its cache. Chrome, Edge and Firefox honour
            that; <b>Safari does not</b>, so on iPhone the cache survives logout regardless — which
            is the reason to prefer <b>Never store on disk</b> there.
          </div>
          </div>

          <div v-show="s.privacyTab === 'tags'">
          <div class="set-sec">Filtered terms</div>
          <div class="set-blurb">
            Safe mode (the eye in the browse bar) hides any file whose embedded prompt contains one of
            these words — useful on a shared screen or over someone's shoulder. Matching is whole-word
            and case-insensitive, and it also sees through digit-for-letter spellings. The list is yours
            to fill in; it ships with only a few generic starters. Stored encoded in config.
          </div>
          <div class="nsfw-add">
            <input ref="tagInput" type="text" autocomplete="off" placeholder="Add a word…"
                   v-model="s.nsfwInput" @keydown.enter.prevent="addTag">
            <button class="set-btn btn-ok btn-accent" @click="addTag">Add</button>
          </div>
          <div class="nsfw-list">
            <div v-if="!nsfwSorted.length" class="nsfw-empty">No words yet — safe mode won't hide anything.</div>
            <span v-for="t in nsfwSorted" :key="t" class="nsfw-chip">
              <span>{{ t }}</span>
              <button title="Remove" @click="removeTag(t)">✕</button>
            </span>
          </div>
          </div>
        </div>

        <!-- ── Security ── -->
        <div v-show="!s.loading && curTab === 'security'">
          <div class="set-sec">Password protection</div>
          <div class="set-blurb">
            With this on, every page, API and media file this server hosts is sealed behind a password box until
            you type it — nothing else is reachable. The password is stored hashed (scrypt) in config.json, never
            in plain text, and a logout button appears in the top bar.
          </div>
          <div v-if="s.auth.legacy" class="auth-warn">
            This server is running a build without the password gate — restart it
            (scripts\\register_comfyremix_task.ps1) before setting a password, or the save will do nothing.
          </div>

          <label v-if="usable" class="auth-toggle">
            <input type="checkbox" v-model="s.auth.enabled" :disabled="!usable">
            <span>Require a password to open the app</span>
          </label>

          <div v-if="stored" class="auth-status">
            <span>Password <span class="auth-set">✓ set</span></span>
            <button v-if="!s.auth.editing" class="set-btn btn-cancel" @click="authChange">Change</button>
            <button class="set-btn btn-cancel" @click="authRemove">Remove</button>
          </div>
          <div v-if="s.auth.clear" class="auth-note">
            The password will be removed — and protection switched off — when you save.
          </div>

          <!-- autocomplete=off throughout: these are not sign-in fields, and
               browsers otherwise offer to save/fill a credential over the top. -->
          <div v-if="editing">
            <div class="set-field">
              <label>Password</label>
              <div class="set-row">
                <input ref="pwInput" type="password" autocomplete="off" :placeholder="s.auth.placeholder"
                       :disabled="s.auth.legacy" v-model="s.auth.pw" @input="authTyped">
              </div>
              <div v-if="minHint" class="auth-min">{{ minHint }}</div>
            </div>
            <div class="set-field">
              <label>Confirm password</label>
              <div class="set-row">
                <input type="password" autocomplete="off" placeholder="Type it again"
                       :disabled="s.auth.legacy" v-model="s.auth.pw2">
              </div>
            </div>
          </div>

          <div class="auth-foot">
            Changing or removing the password signs out every device, including this one — this browser is signed
            back in automatically when you save. If you forget it, clear <code>auth</code> in config.json on the
            server and restart.
          </div>
        </div>

        <div class="confirm-btns set-foot">
          <button class="btn-cancel" :disabled="s.saving" @click="close">Cancel</button>
          <button class="btn-ok btn-accent" :disabled="s.saving || s.loading || !s.loaded" @click="save">{{ s.saving ? 'Saving…' : 'Save' }}</button>
        </div>
      </div>

      <folder-picker :open="s.picker.open" :path="pickerSeed"
                     @close="s.picker.open = false" @select="picked"></folder-picker>
    </div>
  `,
};
