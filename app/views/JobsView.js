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
// A route, not a dialog — that is the one structural change since the port.
// Opening one of a job's outputs proved the difference: the viewer is a route,
// so raising it tore the dialog down, and closing the viewer came back to
// whatever route was underneath with no Jobs and no scroll position. As a route
// the trip is ordinary history — /jobs → /view/… → back — and router.js's
// scrollBehavior hands back the saved position, so you land on the job you left
// from.
//
// The rest is the original: thumbnails open through the router rather than a
// global window.openFileViewer, Re-run raises the Remix dialog through store.ui
// instead of window.openRemix, and the markup, class names, sort order and copy
// are unchanged — every rule the rows need is already in app/styles/remix.css,
// and the page frame around them is the Workflows one (.wf-page/.wf-head).
import { store, showToast } from '../store.js';
import { api, fileUrl } from '../api.js';
import { viewTo } from '../router.js';
import {
  jobs, link, cancelJob, deleteJob, launchJob, jobThumb, thumbFail, isVideoName,
} from '../components/RemixDialog.js';

const { ref, computed, onMounted, onUnmounted } = window.Vue;
const { useRouter } = window.VueRouter;

// 'complete' is the legacy spelling. Records predating the rename still sit in
// the shared comfyJobs IndexedDB, so both have to count as finished or Clear
// Done silently skips them.
const isDone = j => j.status === 'done' || j.status === 'complete';

export default {
  name: 'JobsView',
  setup() {
    const router = useRouter();
    const clearing = ref(false);

    // timeAgo reads the clock, which Vue cannot track. Without a ticker every
    // row would freeze at the age it had when the page opened.
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

    // ← and Esc unwind history where there is any, so the ⚡ badge on a browse
    // grid is a round trip back to that grid rather than a one-way door to Home.
    // Opened cold from a bookmark there is nothing to unwind and Home is the
    // honest destination — the same rule the viewer's ✕ follows.
    function back() {
      if (window.history.state && window.history.state.back) router.back();
      else router.push('/');
    }

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
      // The Remix dialog lives in the shell and overlays this page, so there is
      // nothing to dismiss first — closing it leaves you back in the list.
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
      // push, not replace: the viewer's ✕ is a router.back(), and it has to have
      // this page to come back to.
      const to = viewTo(path, store.roots, jobId ? { job: jobId } : null);
      // Null means the file sits under neither media root — an old job pointing at
      // something since moved, most often. Say so rather than eating the click.
      if (to) router.push(to);
      else showToast('That file is outside the media library — nothing to open here.');
    }

    // Esc leaves the page, but not out from under a dialog raised on top of it:
    // ♻ opens Remix over this list, and its own Esc closes it — without this
    // guard the one keypress did both, closing the dialog and the page with it.
    // As a dialog Jobs could never be in that position; Remix replaced it.
    function onKey(e) {
      if (e.key !== 'Escape') return;
      if (store.ui.remix || store.ui.move || store.ui.merge) return;
      back();
    }
    onMounted(async () => {
      window.addEventListener('keydown', onKey);
      timer = setInterval(() => { now.value = Date.now(); }, 30000);
      // A page can be the first thing loaded, where the dialog could only ever be
      // opened from a view that had already fetched the roots. Without them
      // viewTo answers null for every path and each thumbnail is a dead click.
      if (!store.roots.out && !store.roots.fav) { try { store.roots = await api.roots(); } catch (e) {} }
    });
    onUnmounted(() => {
      window.removeEventListener('keydown', onKey);
      if (timer) clearInterval(timer);
    });

    return {
      store, jobs, link, list, doneCount, clearing, dotOf, timeAgo,
      back, clearDone, rerun, thumbClick, cancelJob, deleteJob,
      jobThumb, thumbFail, fileUrl,
    };
  },
  template: `
    <div class="wf-page jobs-page">
      <div class="wf-head">
        <button class="wf-back" title="Back (Esc)" @click="back">←</button>
        <h1 class="wf-title">Jobs</h1>
        <button v-if="jobs.list.length" class="rmx-mini rmx-clear" :disabled="!doneCount || clearing"
                :title="doneCount ? 'Remove the ' + doneCount + ' finished job(s) from this list — the output files stay in the library' : 'Nothing finished to clear (running and errored jobs are kept)'"
                @click="clearDone">🧹 Clear Done<span v-if="doneCount"> ({{ doneCount }})</span></button>
      </div>
      <div class="wf-blurb">Every run Remix has started, live and finished. Opening an output leaves this page where it is — closing the viewer comes back to it.</div>

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
  `,
};
