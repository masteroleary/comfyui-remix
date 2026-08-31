// ── Clean thumbs & caches ──────────────────────────────────────────────────
// The console questions of wipe_media.ps1, as a page: measure first, tick second,
// delete last, with one confirmation at the end. That order is the script's, and it is
// the reason the script is safe to hand a button — you never answer a question here
// without the file count and the size that answering "yes" would cost.
//
// This panel owns no truth of its own. The option list, its labels and the mapping from
// a tick to a wipe_media.ps1 flag all come from /api/maintenance/state, so a checkbox
// can never appear that the run would reject; the measurements come from the same
// script's -Report mode, so the numbers beside each row are the ones the run will act
// on rather than a second opinion computed here.
//
// Nothing runs in the browser or even in the server process — see the Clean block in
// server.js for why the work goes to a scheduled task running as the signed-in user.
// The page's whole job after Run is to poll and show the log.
import { showToast } from '../store.js';
import { api } from '../api.js';
import FolderPicker from './FolderPicker.js';
import { fmtNum, fmtBytes } from '../format.js';

const { reactive, computed, onMounted, onBeforeUnmount, ref, watch, nextTick } = window.Vue;

// Which rows only qualify a run rather than name something to delete arrives with the
// options themselves (MAINT_MODIFIERS in server.js). It used to be a constant here as
// well, which is two lists that have to agree: one the server does not know about lets
// an otherwise-empty selection start a run, and one this page does not know about gets
// counted into the totals as something being deleted.

// A ReTrim is only honest if something was freed on D: or E: — see the same rule in
// maintParams on the server.
const FREES_DISK = ['input', 'output', 'media', 'temp', 'samples', 'lora', 'recycle'];

export default {
  name: 'MaintenancePanel',
  components: { FolderPicker },
  emits: ['close'],
  setup() {
    const s = reactive({
      loading: true,
      available: false, reason: '', task: '', setupScript: '',
      options: [],
      modifiers: [],
      sel: {},
      seeded: false,   // the remembered ticks are taken once; a poll must not stomp
      // The backup folder, its verdict, and the picker sheet. The path is remembered in
      // config.json rather than here, so it is the same folder on the phone and at the
      // desk — the run is machine-wide and so is the copy it takes.
      backupPath: '',
      backupChk: null,
      backupChecking: false,
      picker: false,
      report: null,
      job: null,
      log: '',
      startError: '',
    });
    const logBox = ref(null);
    let timer = null;
    // Clearing the timer on the way out is not enough on its own. tick() awaits a
    // fetch *before* it reschedules, so a poll already in flight when the panel
    // unmounts resumes afterwards and installs a fresh timer that nothing is left
    // holding to cancel — an invisible 1.2s loop, with a schtasks launch per tick,
    // for the life of the tab. Navigating away mid-poll would add another one each
    // time, and they stack. This flag is what the resumed poll finds instead.
    let stopped = false;

    const rowFor = key => ((s.report && s.report.items) || []).find(i => i.key === key) || null;

    const active = computed(() => !!(s.job && (s.job.state === 'starting' || s.job.state === 'running')));
    const scanning = computed(() => active.value && s.job.kind === 'scan');
    const cleaning = computed(() => active.value && s.job.kind === 'clean');
    const lastClean = computed(() => !!(s.job && s.job.kind === 'clean' && !active.value));

    // ── Load / poll ──
    async function load() {
      const d = await api.maintenanceState();
      s.available = !!d.available;
      s.reason = d.reason || '';
      s.task = d.task || '';
      s.setupScript = d.setupScript || '';
      s.options = Array.isArray(d.options) ? d.options : [];
      s.modifiers = Array.isArray(d.modifiers) ? d.modifiers : [];
      // Only the first load adopts the remembered ticks. Polling runs every second or so
      // while a clean is going, and re-applying the stored selection then would undo
      // whatever was being ticked for next time.
      if (!s.seeded) {
        const sel = {};
        for (const o of s.options) sel[o.key] = !!(d.selection && d.selection[o.key]);
        s.sel = sel;
        s.backupPath = d.backupDir || '';
        s.seeded = true;
      }
      s.report = d.report || null;
      s.job = d.job || null;
      // The log is one file shared by both kinds of run, so only a clean's output is
      // shown — otherwise opening this page and measuring would blank the transcript of
      // the wipe you came back to read.
      if (s.job && s.job.kind === 'clean') s.log = d.log || '';
    }

    function schedule(ms) {
      clearTimeout(timer);
      if (stopped) return;
      timer = setTimeout(tick, ms || 1200);
    }
    async function tick() {
      if (stopped) return;
      try { await load(); } catch (e) { /* a poll that fails is not worth a toast */ }
      if (active.value) schedule(1200);
    }

    async function scan() {
      s.startError = '';
      try {
        await api.maintenanceScan();
        s.job = { kind: 'scan', state: 'starting' };
        schedule(700);
      } catch (e) {
        s.startError = e.message;
      }
    }

    onMounted(async () => {
      try { await load(); }
      catch (e) { showToast('Could not read the clean state: ' + e.message, 6000); }
      if (stopped) return;   // left again before the first load came back
      s.loading = false;
      // Every visit, not only the ones with no report at all. A report is a file on disk
      // and it outlives everything — the reason this changed is a report a week old being
      // shown as fact, with "already empty" beside a folder that had 124 files in it.
      // Measuring is read-only and takes about a second, so a redundant scan costs far
      // less than a wrong number does, and a stale one is worse than no number: the whole
      // premise of the page is that you never answer a question here without its cost.
      if (s.available && !active.value) scan();
      else if (active.value) schedule(900);
    });
    onBeforeUnmount(() => { stopped = true; clearTimeout(timer); clearTimeout(checkTimer); });

    // Keep the tail in view: the interesting line of a running wipe is always the last.
    watch(() => s.log, () => {
      nextTick(() => { if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight; });
    });

    // ── The list ──
    // Children (Close a running browser) render under their parent rather than as
    // siblings, so a modifier can never read as another thing to delete.
    const groups = computed(() => {
      const out = [];
      for (const o of s.options) {
        if (o.parent) continue;
        let g = out.find(x => x.name === o.group);
        if (!g) { g = { name: o.group, rows: [] }; out.push(g); }
        g.rows.push({ opt: o, children: s.options.filter(c => c.parent === o.key) });
      }
      return out;
    });

    const trimUseful = computed(() => FREES_DISK.some(k => s.sel[k]));
    const isModifier = key => s.modifiers.includes(key);

    function enabled(o) {
      if (cleaning.value) return false;
      if (o.parent) return !!s.sel[o.parent];
      if (o.needsFreed) return trimUseful.value;
      return true;
    }

    // ── The backup ──
    // The row for the backup names the keys it covers (`covers`, off the server's own
    // source list), so what the copy will take is those of them that are ticked — the
    // same report rows the totals below add up, filtered the same way. It is scoped to
    // the ticks because the copy is: a backup makes a purge recoverable, and copying a
    // library this run is not going to touch costs an hour and buys nothing.
    const backupOpt = computed(() => s.options.find(o => o.key === 'backup') || null);
    const backupCovers = computed(() => {
      const opt = backupOpt.value;
      const keys = (opt && Array.isArray(opt.covers)) ? opt.covers : [];
      return keys.filter(k => s.sel[k]).map(k => {
        const row = s.options.find(o => o.key === k);
        return { key: k, label: row ? row.label : k };
      });
    });
    const backupSize = computed(() => {
      let files = 0, bytes = 0, measured = false;
      for (const c of backupCovers.value) {
        const r = rowFor(c.key);
        if (!r) continue;
        measured = true;
        files += r.files || 0;
        bytes += r.bytes || 0;
      }
      return measured ? { files, bytes } : null;
    });

    // ── The backup folder ──
    // Checked by the server as the field is typed into, so the Run button can be
    // disabled with the reason underneath rather than refusing a click and saying
    // nothing. Debounced: this stats a directory, and a request per keystroke over a
    // network path is a stall per keystroke. The server checks the path again when the
    // run arrives — this is what makes the button honest, not what makes it safe.
    let checkTimer = null;
    async function checkBackup(p) {
      s.backupChecking = true;
      try {
        const d = await api.maintenanceBackupCheck(p);
        // Only the answer to the question still on screen. A slow reply about a path
        // that has since been edited would overwrite a newer verdict with an older one.
        if (p === s.backupPath.trim()) s.backupChk = d;
      } catch (err) {
        if (p === s.backupPath.trim()) s.backupChk = { ok: false, reason: 'Could not check that folder: ' + err.message };
      }
      if (p === s.backupPath.trim()) s.backupChecking = false;
    }
    watch(() => s.backupPath, v => {
      clearTimeout(checkTimer);
      const p = (v || '').trim();
      s.backupChk = null;
      if (!p) { s.backupChecking = false; return; }
      s.backupChecking = true;
      checkTimer = setTimeout(() => { if (!stopped) checkBackup(p); }, 350);
    });

    // Ticked and pointed somewhere real, or not ticked at all. There is no third state
    // that Run may fire in: a backup that was asked for and did not happen is the one
    // outcome this row exists to prevent.
    const backupReady = computed(() =>
      !s.sel.backup || !!(s.backupChk && s.backupChk.ok && !s.backupChecking));

    // What the field says about itself. Silent until there is something to say — an
    // untouched field on an unticked row is not a problem to report.
    const backupState = computed(() => {
      if (!s.sel.backup && !s.backupPath.trim()) return null;
      if (s.backupChecking) return { cls: 'dim', text: 'Checking…' };
      const c = s.backupChk;
      if (!c) return { cls: 'bad', text: 'Choose a folder to back up into.' };
      if (!c.ok) return { cls: 'bad', text: c.reason };
      const made = c.willCreate ? ' The folder will be created.' : '';
      // Free space is a warning and never a block: the estimate comes from the wipe's
      // own measurement, which leaves out the git-tracked files the copy takes anyway,
      // and it cannot know that the destination is the volume being emptied.
      const sz = backupSize.value;
      if (sz && c.free != null && sz.bytes > c.free) {
        return { cls: 'bad', text: '⚠ About ' + fmtBytes(sz.bytes) + ' to copy, but only '
          + fmtBytes(c.free) + ' free here.' + made };
      }
      const room = sz && c.free != null
        ? ' — about ' + fmtBytes(sz.bytes) + ' to copy, ' + fmtBytes(c.free) + ' free'
        : '';
      return { cls: 'good', text: '✓ Ready' + room + '.' + made };
    });

    // Picking a folder ticks the row. Choosing a backup destination has no other
    // purpose, and "I chose the folder and it still did not back up" is a worse
    // surprise than a tick that appears. Typing is left alone — a field being edited
    // is not a decision yet.
    function pickFolder(p) {
      s.backupPath = p;
      s.sel.backup = true;
    }

    function meta(key) {
      // The backup has no report row of its own — it copies three of them, and what it
      // costs is what those three hold. Stated on the same line and in the same place as
      // every other row's cost, because it is the same question: what does yes cost.
      if (key === 'backup') {
        // The settings are in every backup and are a rounding error next to the media,
        // so they are not in this number — but they are why it never reads "nothing".
        if (!backupCovers.value.length) return 'settings only';
        const sz = backupSize.value;
        if (!sz) return scanning.value ? 'measuring…' : '';
        if (!sz.files) return 'settings only';
        return '≈ ' + fmtNum(sz.files) + ' files · ' + fmtBytes(sz.bytes) + ' + settings';
      }
      const r = rowFor(key);
      if (!r) return scanning.value ? 'measuring…' : '';
      if (key === 'shadows') {
        if (!r.present) return r.detail || 'none exist';
        return fmtNum(r.files) + ' snapshot' + (r.files === 1 ? '' : 's') + (r.detail ? ' — ' + r.detail : '');
      }
      if (key === 'trim') return '';
      if (!r.present) return 'not present';
      if (!r.files) return 'already empty';
      return fmtNum(r.files) + ' files · ' + fmtBytes(r.bytes);
    }
    function note(key) {
      // Two things that would otherwise only be discovered afterwards — one in the
      // backup folder, one out of it. Both only matter once the row is on, so neither
      // is said until it is.
      //
      //   * A caches-only run deletes none of the three folders a backup copies, so the
      //     dated folder holds settings and nothing else. Said here rather than blocking
      //     Run: caches-only with the box left on is a reasonable thing to do.
      //   * config.json is in every backup, and it carries the API keys and the password
      //     hash. Copying it whole is deliberate — a backup you cannot restore from is
      //     not one — but where it lands is then a place worth choosing carefully.
      if (key === 'backup') {
        if (!s.sel.backup) return '';
        const keys = 'Includes config.json — your API keys and password hash — so keep the folder private.';
        return backupCovers.value.length ? keys
          : 'Settings only: this run deletes none of ComfyUI input, ComfyUI output or the '
            + 'media library, so there is no media to copy. ' + keys;
      }
      const r = rowFor(key);
      if (!r) return '';
      if (r.suspect) return '⚠ enumeration errored — this count may be short';
      if (key === 'browsers' && r.detail) return r.detail;
      return '';
    }

    // Shadow copies are counted apart from the file totals: a snapshot is not a file and
    // adding it to "N files" would be a number that means nothing.
    const totals = computed(() => {
      let files = 0, bytes = 0, unmeasured = false;
      for (const o of s.options) {
        if (isModifier(o.key) || o.key === 'shadows' || !s.sel[o.key]) continue;
        const r = rowFor(o.key);
        if (!r) { unmeasured = true; continue; }
        files += r.files || 0;
        bytes += r.bytes || 0;
      }
      const sh = s.sel.shadows ? rowFor('shadows') : null;
      return { files, bytes, unmeasured, shadows: sh && sh.present ? (sh.files || 0) : 0 };
    });

    const picked = computed(() => s.options.filter(o => !isModifier(o.key) && s.sel[o.key]));
    const canRun = computed(() => s.available && !active.value && picked.value.length > 0 && backupReady.value);

    // The media targets are the ones a busy queue makes unsafe — deleting temp mid-job
    // yanks previews out from under it — and a non-interactive run refuses outright
    // rather than half-doing it, so say so before the button is pressed rather than in
    // the log afterwards.
    const queueBusy = computed(() => !!(s.report && s.report.queueIdle === false && FREES_DISK.some(k => k !== 'recycle' && s.sel[k])));

    async function run() {
      if (!canRun.value) return;
      const names = picked.value.map(o => '  • ' + o.label).join('\n');
      const t = totals.value;
      const size = t.unmeasured ? 'some of it not yet measured'
        : fmtNum(t.files) + ' files, ' + fmtBytes(t.bytes)
          + (t.shadows ? ' — plus ' + t.shadows + ' shadow copy/copies' : '');
      // The backup is the one line in this dialog that is not a warning, so it goes
      // first: what is about to be copied, and where, before what is about to go.
      const covers = backupCovers.value.map(c => c.label).join(', ');
      const backup = !s.sel.backup ? ''
        : 'Backing up first to\n  ' + (s.backupChk && s.backupChk.resolved || s.backupPath.trim())
          + '\n(' + (covers ? covers + ', plus your settings, workflows and prompts'
                             : 'your settings, workflows and prompts only — this run deletes'
                               + ' none of the three media folders')
          + ', into a folder named for the date and time).'
          + (covers ? ' The wipe only starts once every file is copied.' : '') + '\n\n';
      const ok = window.confirm(
        'Clean these?\n\n' + names + '\n\n' + backup + size +
        '\n\nThis deletes PERMANENTLY — nothing goes to the Recycle Bin, and there is no undo.'
      );
      if (!ok) return;
      s.startError = '';
      s.log = '';
      try {
        await api.maintenanceClean(s.sel, s.backupPath.trim());
        s.job = { kind: 'clean', state: 'starting' };
        schedule(700);
      } catch (e) {
        s.startError = e.message;
      }
    }

    // A clean with a backup is one job in two phases: the copy runs in the server
    // process, the wipe in the scheduled task. Both report as kind 'clean', so the
    // phase is what the button and the log heading read.
    const backingUp = computed(() => active.value && s.job.phase === 'backup');

    // A clock, because the label below is a relative age and nothing else on this page
    // ticks: with no run going there is no poll, so "2 minutes ago" would sit there
    // saying two minutes for an hour.
    const now = ref(Date.now());
    const clock = setInterval(() => { now.value = Date.now(); }, 30000);
    onBeforeUnmount(() => clearInterval(clock));

    function ago(ms) {
      const sec = Math.round(ms / 1000);
      if (sec < 90) return 'just now';
      const min = Math.round(sec / 60);
      if (min < 90) return min + ' minutes ago';
      const hr = Math.round(min / 60);
      if (hr < 36) return hr + ' hours ago';
      return Math.round(hr / 24) + ' days ago';
    }

    // The age, never the wall-clock time. This used to be toLocaleTimeString(), which
    // prints no date — so a measurement from last week read as "Measured at 10:57:45 AM"
    // and looked like this morning. An age cannot be misread that way, and the exact
    // timestamp is still on the hover for when it matters.
    const measuredAt = computed(() => {
      if (!s.report || !s.report.generated) return null;
      const d = new Date(s.report.generated);
      if (isNaN(d)) return null;
      const age = now.value - d.getTime();
      return { text: ago(age), when: d.toLocaleString(), stale: age > 10 * 60 * 1000 };
    });

    return {
      s, logBox, groups, enabled, meta, note, totals, picked, canRun, queueBusy,
      active, scanning, cleaning, lastClean, trimUseful, measuredAt, fmtBytes, fmtNum,
      backupState, backupCovers, backupSize, backingUp, pickFolder, scan, run,
    };
  },
  template: `
    <div class="set-page">
      <div class="set-page-body">
        <div v-if="s.loading" class="loading"><div class="spinner"></div> Loading…</div>

        <template v-else>
          <!-- The task is the whole mechanism; without it there is nothing to explain
               away, so say what to run rather than showing a dead button. -->
          <div v-if="!s.available" class="auth-warn">
            {{ s.reason }}
            <div style="margin-top:8px">
              Run <code>{{ s.setupScript }}</code> once at the console — it asks for admin
              once, registers <code>{{ s.task }}</code>, and every run after that needs no prompt.
            </div>
          </div>

          <div class="set-blurb">
            Clears the copies of your media that outlive the files themselves — Explorer's
            thumbnail cache, the browser caches, the Windows record that a file existed — and,
            if you tick them, the generated media folders as well. Everything is measured
            before it is offered, and nothing is deleted until you confirm.
          </div>

          <div class="mnt-scanbar">
            <span v-if="scanning" class="mnt-scanning"><span class="spinner"></span> Measuring…</span>
            <span v-else-if="measuredAt" class="mnt-dim" :class="{ 'mnt-stale': measuredAt.stale }"
                  :title="measuredAt.when">
              Measured {{ measuredAt.text }}
            </span>
            <span v-else class="mnt-dim">Not measured yet</span>
            <button class="set-btn btn-cancel" :disabled="active || !s.available" @click="scan">Re-measure</button>
          </div>

          <div v-for="g in groups" :key="g.name">
            <div class="set-sec">{{ g.name }}</div>
            <label v-for="r in g.rows" :key="r.opt.key" class="mnt-opt"
                   :class="{ danger: r.opt.danger, off: !enabled(r.opt) }">
              <input type="checkbox" v-model="s.sel[r.opt.key]" :disabled="!enabled(r.opt)">
              <span class="mnt-body">
                <span class="mnt-head">
                  <b>{{ r.opt.label }}</b>
                  <span class="mnt-size" :class="{ empty: meta(r.opt.key) === 'already empty' }">{{ meta(r.opt.key) }}</span>
                </span>
                <span class="mnt-sub">{{ r.opt.sub }}</span>

                <!-- The whole row is a <label>, so a click on the field would otherwise
                     be forwarded to the tick it belongs to and typing a path would turn
                     the row off. Stopping the click short of the label is what keeps the
                     two separate. -->
                <span v-if="r.opt.kind === 'path'" class="mnt-path" @click.stop>
                  <span class="mnt-path-row">
                    <input type="text" autocomplete="off" spellcheck="false"
                           placeholder="No folder chosen — type a path, or press 📁"
                           v-model="s.backupPath" :disabled="!enabled(r.opt)">
                    <button type="button" class="set-clr set-browse" title="Browse server folders"
                            :disabled="!enabled(r.opt)" @click="s.picker = true">📁</button>
                  </span>
                  <span v-if="backupState" class="mnt-path-state" :class="backupState.cls">{{ backupState.text }}</span>
                </span>

                <span v-if="note(r.opt.key)" class="mnt-note">{{ note(r.opt.key) }}</span>
                <span v-if="r.opt.needsFreed && !trimUseful" class="mnt-note">
                  Only worth it when something is being freed on D: or E: — tick a media
                  target or the Recycle Bin first.
                </span>

                <!-- Modifiers sit inside their parent's row: they qualify it, they are
                     not another thing to delete. -->
                <label v-for="c in r.children" :key="c.key" class="mnt-child" :class="{ off: !enabled(c) }">
                  <input type="checkbox" v-model="s.sel[c.key]" :disabled="!enabled(c)">
                  <span>
                    <b>{{ c.label }}</b>
                    <span class="mnt-sub">{{ c.sub }}</span>
                  </span>
                </label>
              </span>
            </label>
          </div>

          <div v-if="measuredAt && measuredAt.stale && !scanning" class="mnt-warn">
            These numbers were measured {{ measuredAt.text }} ({{ measuredAt.when }}) and
            nothing has re-measured since. A folder that was empty then may not be now —
            press Re-measure before trusting a row that says it is already empty.
          </div>
          <div v-if="queueBusy" class="mnt-warn">
            ComfyUI is busy. A run refuses the media targets while the queue is working —
            deleting temp mid-job yanks the previews out from under it. Let the queue drain,
            then re-measure.
          </div>
          <div v-if="s.startError" class="mnt-warn">{{ s.startError }}</div>
          <div v-if="s.job && s.job.stalled" class="mnt-warn">{{ s.job.error }}</div>

          <div class="mnt-foot">
            <div class="mnt-total">
              <template v-if="picked.length">
                {{ fmtNum(totals.files) }} files · {{ fmtBytes(totals.bytes) }}
                <span v-if="totals.shadows"> + {{ totals.shadows }} shadow copy/copies</span>
                <span v-if="totals.unmeasured" class="mnt-dim"> (some not measured)</span>
              </template>
              <span v-else class="mnt-dim">Nothing ticked</span>
            </div>
            <button class="set-btn btn-ok btn-accent" :disabled="!canRun" @click="run">
              {{ backingUp ? 'Backing up…' : (cleaning ? 'Cleaning…' : 'Run') }}
            </button>
          </div>
          <div v-if="picked.length" class="mnt-danger">
            Deletes permanently — nothing goes to the Recycle Bin, and there is no undo.
            <template v-if="s.sel.backup">The backup is the only copy that survives it.</template>
          </div>

          <!-- The log is the only report there is on a run that takes minutes, so it
               stays on screen after the run finishes rather than vanishing with it. -->
          <div v-if="cleaning || (lastClean && s.log)" class="mnt-logwrap">
            <div class="set-sec">
              {{ cleaning ? 'Running' : 'Last run' }}
              <span v-if="s.job && s.job.flags" class="mnt-dim">— {{ s.job.flags }}</span>
            </div>
            <!-- The copy can run for an hour over a full library, so it says how far it
                 has got rather than leaving the page looking stopped. It stays up
                 afterwards: what was saved, and where, is the thing worth reading back
                 beside a wipe that has just finished. -->
            <div v-if="s.job && s.job.backup" class="mnt-backup" :class="s.job.backup.state">
              <div>
                <b>{{ s.job.backup.state === 'running' ? 'Backing up' : (s.job.backup.state === 'failed' ? 'Backup failed' : 'Backed up') }}</b>
                {{ fmtNum(s.job.backup.files) }} files · {{ fmtBytes(s.job.backup.bytes) }}
                <span v-if="s.job.backup.folder" class="mnt-dim">— copying {{ s.job.backup.folder }}</span>
                <span v-if="s.job.backup.skipped" class="mnt-dim">— {{ s.job.backup.skipped }} link(s) skipped</span>
              </div>
              <div class="mnt-dim">{{ s.job.backup.dest }}</div>
            </div>
            <pre ref="logBox" class="mnt-log">{{ s.log || 'starting…' }}</pre>
            <div v-if="s.job && s.job.state === 'failed'" class="mnt-warn">{{ s.job.error }}</div>
          </div>

          <folder-picker :open="s.picker" :path="s.backupPath"
                         @close="s.picker = false" @select="pickFolder"></folder-picker>
        </template>
      </div>
    </div>
  `,
};
