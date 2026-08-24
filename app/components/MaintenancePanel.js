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

const { reactive, computed, onMounted, onBeforeUnmount, ref, watch, nextTick } = window.Vue;

// Everything except these two is a thing to delete; these two only qualify one.
const MODIFIERS = ['closeBrowsers', 'trim'];
// A ReTrim is only honest if something was freed on D: or E: — see the same rule in
// maintParams on the server.
const FREES_DISK = ['input', 'output', 'media', 'temp', 'samples', 'lora', 'recycle'];

const fmtNum = n => (n || 0).toLocaleString();
function fmtBytes(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(i > 0 && v < 10 ? 2 : 0) + ' ' + u[i];
}

export default {
  name: 'MaintenancePanel',
  emits: ['close'],
  setup() {
    const s = reactive({
      loading: true,
      available: false, reason: '', task: '', setupScript: '',
      options: [],
      sel: {},
      seeded: false,   // the remembered ticks are taken once; a poll must not stomp
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
      // Only the first load adopts the remembered ticks. Polling runs every second or so
      // while a clean is going, and re-applying the stored selection then would undo
      // whatever was being ticked for next time.
      if (!s.seeded) {
        const sel = {};
        for (const o of s.options) sel[o.key] = !!(d.selection && d.selection[o.key]);
        s.sel = sel;
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
      // Nothing to show beside the checkboxes until something has been measured, and
      // measuring is read-only and takes about a second — so do it rather than make the
      // first visit a button that says "measure".
      if (s.available && !s.report && !active.value) scan();
      else if (active.value) schedule(900);
    });
    onBeforeUnmount(() => { stopped = true; clearTimeout(timer); });

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
    function enabled(o) {
      if (cleaning.value) return false;
      if (o.parent) return !!s.sel[o.parent];
      if (o.needsFreed) return trimUseful.value;
      return true;
    }

    function meta(key) {
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
        if (MODIFIERS.includes(o.key) || o.key === 'shadows' || !s.sel[o.key]) continue;
        const r = rowFor(o.key);
        if (!r) { unmeasured = true; continue; }
        files += r.files || 0;
        bytes += r.bytes || 0;
      }
      const sh = s.sel.shadows ? rowFor('shadows') : null;
      return { files, bytes, unmeasured, shadows: sh && sh.present ? (sh.files || 0) : 0 };
    });

    const picked = computed(() => s.options.filter(o => !MODIFIERS.includes(o.key) && s.sel[o.key]));
    const canRun = computed(() => s.available && !active.value && picked.value.length > 0);

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
      const ok = window.confirm(
        'Clean these?\n\n' + names + '\n\n' + size +
        '\n\nThis deletes PERMANENTLY — nothing goes to the Recycle Bin, and there is no undo.'
      );
      if (!ok) return;
      s.startError = '';
      s.log = '';
      try {
        await api.maintenanceClean(s.sel);
        s.job = { kind: 'clean', state: 'starting' };
        schedule(700);
      } catch (e) {
        s.startError = e.message;
      }
    }

    const measuredAt = computed(() => {
      if (!s.report || !s.report.generated) return '';
      const d = new Date(s.report.generated);
      return isNaN(d) ? '' : d.toLocaleTimeString();
    });

    return {
      s, logBox, groups, enabled, meta, note, totals, picked, canRun, queueBusy,
      active, scanning, cleaning, lastClean, trimUseful, measuredAt, fmtBytes, fmtNum,
      scan, run,
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
            <span v-else-if="measuredAt" class="mnt-dim">Measured at {{ measuredAt }}</span>
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
              {{ cleaning ? 'Cleaning…' : 'Run' }}
            </button>
          </div>
          <div v-if="picked.length" class="mnt-danger">
            Deletes permanently — nothing goes to the Recycle Bin, and there is no undo.
          </div>

          <!-- The log is the only report there is on a run that takes minutes, so it
               stays on screen after the run finishes rather than vanishing with it. -->
          <div v-if="cleaning || (lastClean && s.log)" class="mnt-logwrap">
            <div class="set-sec">
              {{ cleaning ? 'Running' : 'Last run' }}
              <span v-if="s.job && s.job.flags" class="mnt-dim">— {{ s.job.flags }}</span>
            </div>
            <pre ref="logBox" class="mnt-log">{{ s.log || 'starting…' }}</pre>
            <div v-if="s.job && s.job.state === 'failed'" class="mnt-warn">{{ s.job.error }}</div>
          </div>
        </template>
      </div>
    </div>
  `,
};
