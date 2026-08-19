// ── Jobs ───────────────────────────────────────────────────────────────────
// The run list: every generation started from Remix, live and historical.
//
// Ported from the pre-SPA JobsDialog (index.html at 8ea9e99, before the SPA
// rewrite dropped it). The run *engine* survived that rewrite inside
// RemixDialog.js — the store, the leader-elected socket, the IndexedDB
// persistence and the reconciler are all still there and still running, because
// AppShell imports that module eagerly. Only the view was lost, so this file is
// a view and nothing else: it owns no job state and mutates nothing directly.
//
// Two changes from the original. Thumbnails open through the router rather than
// a global window.openFileViewer, and Re-run raises the Remix dialog through
// store.ui instead of window.openRemix. Everything else — the markup, the class
// names, the sort order, the copy — is the original, and every rule it needs is
// already in app/styles/remix.css.
import { store } from '../store.js';
import { fileUrl } from '../api.js';
import { viewTo } from '../router.js';
import {
  jobs, link, cancelJob, deleteJob, launchJob, jobThumb, thumbFail, isVideoName,
} from './RemixDialog.js';

const { ref, computed, onMounted, onUnmounted } = window.Vue;
const { useRouter } = window.VueRouter;

// 'complete' is the legacy spelling. Records predating the rename still sit in
// the shared comfyJobs IndexedDB, so both have to count as finished or Clear
// Done silently skips them.
const isDone = j => j.status === 'done' || j.status === 'complete';

export default {
  name: 'JobsDialog',
  setup() {
    const router = useRouter();
    const clearing = ref(false);

    // timeAgo reads the clock, which Vue cannot track. Without a ticker every
    // row would freeze at the age it had when the dialog opened.
    const now = ref(Date.now());
    let timer = null;

    const timeAgo = (ts) => {
      const s = Math.floor((now.value - ts) / 1000);
      if (s < 60) return Math.max(s, 0) + 's ago';
      if (s < 3600) return Math.floor(s / 60) + 'm ago';
      if (s < 86400) return Math.floor(s / 3600) + 'h ago';
      return Math.floor(s / 86400) + 'd ago';
    };

    // Running first, then newest. Anything in flight stays at the top of a long
    // history without the user scrolling for it.
    const list = computed(() => jobs.list.slice().sort((a, b) =>
      (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1) || b.startTime - a.startTime));

    const doneCount = computed(() => jobs.list.filter(isDone).length);

    // A queued job is waiting on the GPU, not stalled: it gets a still dot and a
    // striped bar, where a pulsing dot at 0% read as "frozen".
    const dotOf = j => (j.status === 'running' && j._queued ? 'queued' : j.status);

    const close = () => { store.ui.jobs = false; };

    async function clearDone() {
      if (clearing.value) return;
      clearing.value = true;
      // Snapshot before deleting — deleteJob splices the array being iterated.
      try { for (const j of jobs.list.filter(isDone)) await deleteJob(j); }
      finally { clearing.value = false; }
    }

    function rerun(j) {
      // _params is the live launch payload, so a job started this session can go
      // again in one click. After a reload it is gone (only non-_ keys persist),
      // and the honest fallback is to reopen Remix on the same source.
      if (j._params) { launchJob({ ...j._params }); return; }
      close();
      store.ui.remix = {
        path: j.sourcePath, name: j.sourceFile,
        isVideo: isVideoName(j.sourceFile), isImage: !isVideoName(j.sourceFile),
      };
    }

    // Plain left-click opens in the app; modified clicks keep the <a href> so
    // "open in new tab" still works on the raw file.
    // jobId is given for an output and left off for the source file: the source is
    // what went in, so its neighbours are its own folder's, not this run's.
    function thumbClick(e, path, jobId) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      const to = viewTo(path, store.roots, jobId ? { job: jobId } : null);
      if (to) { close(); router.push(to); }
    }

    function onKey(e) { if (e.key === 'Escape') close(); }
    onMounted(() => {
      window.addEventListener('keydown', onKey);
      timer = setInterval(() => { now.value = Date.now(); }, 30000);
    });
    onUnmounted(() => {
      window.removeEventListener('keydown', onKey);
      if (timer) clearInterval(timer);
    });

    return {
      store, jobs, link, list, doneCount, clearing, dotOf, timeAgo,
      close, clearDone, rerun, thumbClick, cancelJob, deleteJob,
      jobThumb, thumbFail, fileUrl,
    };
  },
  template: `
    <div class="rmx-overlay" data-backdrop @click.self="close">
      <div class="rmx-dialog" style="max-width:820px">
        <div class="rmx-head">
          <b class="rmx-title">Jobs</b>
          <button v-if="jobs.list.length" class="rmx-mini rmx-clear" :disabled="!doneCount || clearing"
                  :title="doneCount ? 'Remove the ' + doneCount + ' finished job(s) from this list — the output files stay in the library' : 'Nothing finished to clear (running and errored jobs are kept)'"
                  @click="clearDone">🧹 Clear Done<span v-if="doneCount"> ({{ doneCount }})</span></button>
          <button class="rmx-x" title="Close (Esc)" @click="close">✕</button>
        </div>

        <div class="rmx-jobs">
          <!-- Losing ComfyUI is not the same as a job failing: say so, because the
               old engine conflated the two and reported a dead socket as a crash. -->
          <div v-if="!link.comfy" class="rmx-link">⚠ ComfyUI is unreachable — running jobs are held, not failed. Reconnecting…</div>
          <div v-if="!jobs.loaded" class="rmx-mut">Loading…</div>
          <div v-else-if="!list.length" class="rmx-mut">No jobs yet. Remix an image to start one.</div>

          <div v-for="j in list" :key="j.id" class="rmx-job">
            <a class="rmx-job-src" :href="fileUrl(j.sourcePath)" target="_blank" rel="noopener"
               @click="thumbClick($event, j.sourcePath)">
              <img v-if="j.sourcePath" :src="jobThumb({ path: j.sourcePath, name: j.sourceFile })" @error="thumbFail">
            </a>

            <div class="rmx-job-main">
              <div class="rmx-job-title">
                <span class="rmx-dot" :class="dotOf(j)"></span>
                {{ j.workflow }}
                <span class="rmx-mut">· {{ timeAgo(j.startTime) }}</span>
                <span v-if="j.runs > 1" class="rmx-mut">· {{ j.runsCompleted || 0 }}/{{ j.runs }} runs</span>
              </div>

              <div v-if="j.prompt" class="rmx-job-prompt">{{ j.prompt }}</div>

              <div v-if="j.status === 'running'" class="rmx-jobbar">
                <!-- Queued: no inline width, or it would override the stripe. -->
                <div class="rmx-jobbar-fill" :class="{ wait: !!j._queued }"
                     :style="j._queued ? null : { width: j._pct + '%' }"></div>
              </div>

              <div v-if="j.status === 'running'" class="rmx-mut" style="font-size:11px">
                {{ j._queued ? (j._node || 'waiting…') : (j._pct + '% — ' + (j._node || 'waiting…')) }}
              </div>
              <div v-else-if="j.status === 'lost'" style="font-size:11px;color:#ff9f0a">
                {{ j._node || 'Dropped from ComfyUI’s queue' }}
              </div>
              <!-- The original showed a bare red dot and no reason at all here. -->
              <div v-else-if="j.status === 'error'" style="font-size:11px;color:#ff453a">
                {{ j._node || 'Failed' }}
              </div>

              <div v-if="j.results.length" class="rmx-outgrid" style="margin-top:6px">
                <a v-for="f in j.results" :key="f.path" class="rmx-out" :href="fileUrl(f.path, f.v)"
                   target="_blank" rel="noopener" @click="thumbClick($event, f.path, j.id)">
                  <img :src="jobThumb(f)" loading="lazy" @error="thumbFail">
                </a>
              </div>
            </div>

            <div class="rmx-job-acts">
              <button v-if="j.status === 'running'" class="rmx-mini" title="Cancel" @click="cancelJob(j)">■</button>
              <button v-else class="rmx-mini" title="Re-run" @click="rerun(j)">♻</button>
              <button class="rmx-mini" title="Delete" @click="deleteJob(j)">🗑</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
};
