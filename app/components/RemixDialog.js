// ── Remix ──────────────────────────────────────────────────────────────────
// Pick a workflow, edit the controls it exposes, queue runs against ComfyUI,
// and watch them come back. Ported from the pre-SPA page's <remix-dialog>.
//
// It is a dialog, not a route: it opens over whatever is behind it, so the
// parent mounts it (v-if) and passes the item being remixed; it emits `close`.
//
// Reactivity: the old page kept a plain `S` object with hand-pushed reactive
// mirrors, and every computed that read `S` cached its first value forever.
// None of that survives here — the dialog owns ordinary `reactive`/`ref` state
// and reads the item from a prop, so a computed over either just works.
//
// NOTE FOR THE PORT: the job engine below (IndexedDB store, the ComfyUI socket,
// reconcile, launchJob/cancelJob) is shared infrastructure, not dialog state —
// the Jobs dialog and the top progress bar read the same singletons. It lives
// here only because this is the first component that needed it; it is exported
// so the next one imports rather than re-creates it (two engines in one page
// would fight over the ComfyUI client id). Lift it to app/jobs.js when Jobs lands.
import { store, showToast } from '../store.js';
import { api, fileUrl, thumbUrl } from '../api.js';
import MediaToolsMenu from './MediaToolsMenu.js';
import MediaTile from './MediaTile.js';
import WorkflowFields, { ctype, shortLora, canonLora, loraWords, replaceableText } from './WorkflowFields.js';
import ReplacementRules from './ReplacementRules.js';
import { activeReplacements, applyReplacements, applyReplacementsToNodes, loadReplacements,
  replacementGroups, keptVariations, replacementText } from '../replacements.js';
import { viewTo } from '../router.js';

const { reactive, ref, computed, watch, onMounted, onUnmounted, provide, inject } = window.Vue;
const { useRouter } = window.VueRouter;

const enc = encodeURIComponent;
// Plain fetch for the endpoints app/api.js does not cover yet. Deliberately NOT
// api.js's req(): several of these answer with a body that carries `error` as
// data the caller inspects (a rejected prompt, a taken workflow name), and req()
// turns that into a throw.
const jget = url => fetch(url, { credentials: 'same-origin' }).then(r => r.json());
const jpost = (url, body) => fetch(url, {
  method: 'POST', credentials: 'same-origin',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
}).then(r => r.json());

export const isVideoName = p => /\.(mp4|webm|mkv|mov|m4v)$/i.test(p || '');
export const isAudioName = p => /\.(mp3|m4a|aac|flac|wav|ogg)$/i.test(p || '');
// A job's outputs in the listing's shape, so the tile that renders a browsed file
// renders one you just made. One mapper for every surface that shows them — this
// dialog, the inspect page, and the viewer when it is scoped to a job — because
// three copies is three chances for the same file to open as a different kind of
// thing depending on which grid it was clicked in.
//
// The kind is read off the name here rather than left to the caller: a job record
// holds a path and a name, and isVideo/isAudio/isImage are what a tile and the
// viewer render from. Neither a clip nor a sound is an image, which is what an
// unrecognised output looks like in a grid of them anyway. size/workflow/nsfw are
// absent rather than false — a tile renders what it is given.
export const outputItems = job => ((job && job.results) || []).map(f => {
  const video = isVideoName(f.name);
  const audio = !video && isAudioName(f.name);
  return {
    path: f.path, name: f.name, v: f.v, thumbV: f.thumbV, thumb: !!f.thumbPath,
    isVideo: video, isAudio: audio, isImage: !video && !audio,
  };
});
// Thumbnail for a job's source or output. A video has no still of its own, so it
// needs either the companion PNG the save node wrote (thumbPath, when /api/recent-
// outputs managed to pair one) or /thumb/, the same route the grid uses. Pointing an
// <img> at the .mp4 renders as a broken image.
const THUMB_FALLBACK = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120">'
  + '<rect width="120" height="120" fill="#1c1c1e"/><path d="M50 40l30 20-30 20z" fill="#48484a"/></svg>');
export const jobThumb = (f) => {
  if (!f || !f.path) return THUMB_FALLBACK;
  if (f.thumbPath) return fileUrl(f.thumbPath, f.thumbV);
  return isVideoName(f.name || f.path) ? thumbUrl(f.path, f.thumbV) : fileUrl(f.path, f.v);
};
// /thumb/ 404s when no still was ever generated, and any job old enough may point at
// a file since favorited (moved) or deleted — show a placeholder, not a broken icon.
export const thumbFail = (e) => {
  const el = e.target;
  if (el.dataset.fallback) return;   // the placeholder itself can't fail again
  el.dataset.fallback = '1';
  el.src = THUMB_FALLBACK;
};
// Expand ComfyUI %date:FORMAT% filename tokens (yyyy/MM/dd/HH/mm/ss). Base ComfyUI's
// SaveImage only expands %year%/%month%/…, not the %date:…% form — an embedded
// workflow built elsewhere then writes a literal "%date:yyyy-MM-dd%" folder, which is
// an invalid dir name on Windows (WinError 267). Expanding it here keeps such runs alive.
function expandDateTokens(s) {
  return String(s).replace(/%date:([^%]+)%/g, (_, fmt) => {
    const d = new Date(), p = (n, l = 2) => String(n).padStart(l, '0');
    return fmt.replace(/yyyy/g, d.getFullYear()).replace(/yy/g, p(d.getFullYear() % 100))
      .replace(/MM/g, p(d.getMonth() + 1)).replace(/dd/g, p(d.getDate()))
      .replace(/HH/g, p(d.getHours())).replace(/mm/g, p(d.getMinutes())).replace(/ss/g, p(d.getSeconds()));
  });
}

// The longest plausible positive prompt in a flat API prompt object. A heuristic,
// and treated as one: it seeds a named workflow's prompt field but never Inherit's
// or a shortcut's, where the real values are already known.
function mainPromptNode(promptObj) {
  if (!promptObj || typeof promptObj !== 'object') return { id: '', text: '' };
  const tiers = [[], [], []];
  for (const [id, n] of Object.entries(promptObj)) {
    if (!n || !n.inputs) continue;
    const title = (n._meta && n._meta.title) || '';
    if (/negative|neg\b/i.test(title)) continue;
    let text = '';
    for (const v of Object.values(n.inputs)) if (typeof v === 'string' && v.length > text.length) text = v;
    if (!text.trim()) continue;
    if (/main/i.test(title) && /prompt/i.test(title)) tiers[0].push({ id, text });
    else if (/pos/i.test(title) && /prompt/i.test(title)) tiers[1].push({ id, text });
    else if (text.length > 20) tiers[2].push({ id, text });
  }
  for (const t of tiers) if (t.length) return t.sort((a, b) => b.text.length - a.text.length)[0];
  return { id: '', text: '' };
}
function mainPromptOf(promptObj) { return mainPromptNode(promptObj).text; }

// ── The same prompt, before and after the rules ───────────────────────────
// A file ComfyUI wrote carries two graphs: the `prompt` chunk it executed, and
// the `workflow` chunk the client sent as pnginfo — which is the same graph
// before applyReplacementsToNodes touched it, because the rules only ever
// rewrite the built API prompt. So the text that ran and the text as typed are
// both on disk, and a keyword that resolved to a paragraph is recoverable.
//
// Paired by node id rather than by a second heuristic: the two chunks number
// their nodes the same way, so whichever node mainPromptNode picked out of the
// executed graph can simply be looked up in the visual one. Guessing twice —
// once per format — is how the two halves would end up describing different
// nodes and the switch would offer a prompt from somewhere else entirely.
//
// Null unless there is a real difference to offer. Equal texts mean no rule
// fired, and a switch between two identical prompts is a control that does
// nothing.
export function promptAlternatives(apiPrompt, visualGraph) {
  const ran = mainPromptNode(apiPrompt);
  if (!ran.id || !ran.text.trim() || !visualGraph) return null;
  let node = null;
  const look = (nodes) => { for (const n of nodes || []) if (String(n.id) === String(ran.id)) node = n; };
  look(visualGraph.nodes);
  // Subgraphs keep their own node list, and a workflow built out of them holds
  // its prompt down there rather than at the top level.
  if (!node) for (const sg of (visualGraph.definitions && visualGraph.definitions.subgraphs) || []) look(sg.nodes);
  if (!node) return null;
  let typed = '';
  for (const w of node.widgets_values || []) if (typeof w === 'string' && w.length > typed.length) typed = w;
  if (!typed.trim() || typed.trim() === ran.text.trim()) return null;
  return { keyword: typed, remix: ran.text };
}
function firstVideoFrameBlob(videoUrl) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    let settled = false;
    const finish = (fn, arg) => { if (!settled) { settled = true; v.removeAttribute('src'); v.load(); fn(arg); } };
    v.onerror = () => finish(reject, new Error('could not decode video'));
    v.onloadeddata = () => { try { v.currentTime = 0.001; } catch (e) {} };
    v.onseeked = () => {
      if (settled) return;
      try {
        const c = document.createElement('canvas');
        c.width = v.videoWidth; c.height = v.videoHeight;
        if (!c.width || !c.height) return finish(reject, new Error('video has no dimensions'));
        c.getContext('2d').drawImage(v, 0, 0);
        c.toBlob(b => b ? finish(resolve, b) : finish(reject, new Error('canvas export failed')), 'image/png');
      } catch (e) { finish(reject, e); }
    };
    setTimeout(() => finish(reject, new Error('timed out decoding video')), 20000);
    v.src = videoUrl;
  });
}
// Pixel size of a file in the library, or null if it could not be measured.
// The browser is the only thing here that can answer this without a server
// round trip, and it reads the very URL the tile already loaded — so on a file
// you just picked in the gallery this usually costs a cache hit and nothing
// else. Videos carry their size on the element rather than in a decoded frame,
// so metadata is all that has to arrive.
export function mediaSize(path) {
  if (!path) return Promise.resolve(null);
  const url = fileUrl(path);
  return new Promise(resolve => {
    let settled = false;
    const done = (w, h) => { if (settled) return; settled = true; clearTimeout(t); resolve(w > 0 && h > 0 ? { w, h } : null); };
    // Whatever it was, stop it fetching on the way out: a timed-out element
    // left with a src goes on pulling the file down for nobody.
    let drop = () => {};
    const t = setTimeout(() => { drop(); done(0, 0); }, 15000);
    if (isVideoName(path)) {
      const v = document.createElement('video');
      v.muted = true; v.preload = 'metadata';
      drop = () => { v.removeAttribute('src'); v.load(); };
      v.onloadedmetadata = () => { const w = v.videoWidth, h = v.videoHeight; drop(); done(w, h); };
      v.onerror = () => { drop(); done(0, 0); };
      v.src = url;
    } else {
      const im = new Image();
      drop = () => { im.src = ''; };
      im.onload = () => { const w = im.naturalWidth, h = im.naturalHeight; done(w, h); };
      im.onerror = () => { drop(); done(0, 0); };
      im.src = url;
    }
  });
}
async function uploadBlob(blob, ext) {
  const uploadName = 'app_input_' + Date.now() + '.' + (ext || 'png');
  const fd = new FormData(); fd.append('image', blob, uploadName); fd.append('overwrite', 'true');
  const r = await fetch('/api/comfy/upload/image', { method: 'POST', credentials: 'same-origin', body: fd });
  if (!r.ok) return null;
  const j = await r.json(); return j.name || uploadName;
}
async function uploadImagePath(p) {
  const r = await fetch(fileUrl(p), { credentials: 'same-origin' }); if (!r.ok) return null;
  const blob = await r.blob(); const name = p.split(/[\\/]/).pop();
  return uploadBlob(blob, name.includes('.') ? name.split('.').pop() : 'png');
}

// ── Shared IndexedDB job store (same 'comfyJobs' DB the /jobs page uses) ──
const JobDB = {
  _db: null,
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('comfyJobs', 1);
      req.onupgradeneeded = (e) => { const db = e.target.result; if (!db.objectStoreNames.contains('jobs')) { const st = db.createObjectStore('jobs', { keyPath: 'id' }); st.createIndex('startTime', 'startTime'); } };
      req.onsuccess = () => { this._db = req.result; resolve(this._db); };
      req.onerror = () => reject(req.error);
    });
  },
  async getAll() { const db = await this.open(); return new Promise((res, rej) => { const tx = db.transaction('jobs', 'readonly'); const r = tx.objectStore('jobs').getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error); }); },
  async put(job) { const db = await this.open(); return new Promise((res, rej) => { const tx = db.transaction('jobs', 'readwrite'); tx.objectStore('jobs').put(job); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); },
  async del(id) { const db = await this.open(); return new Promise((res, rej) => { const tx = db.transaction('jobs', 'readwrite'); tx.objectStore('jobs').delete(id); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); },
};
const jobChannel = (() => { try { return new BroadcastChannel('comfy-jobs'); } catch (e) { return null; } })();

// The rules are applied at launch, so they have to be in memory before the
// first run — not merely by the time an editor is opened.
loadReplacements();

// ── Central reactive store: the single source of truth for jobs ──
export const jobs = reactive({ list: [], loaded: false });
const byId = id => jobs.list.find(j => j.id === id);
const isTerminal = j => j.status !== 'running';
export const runningCount = computed(() => jobs.list.filter(j => j.status === 'running').length);
// Lead progress = the % of the actively-executing job (ComfyUI runs one at a
// time, so the max _pct among running jobs is the one currently on the GPU).
export const leadPct = computed(() => { const r = jobs.list.filter(j => j.status === 'running'); return r.length ? Math.max.apply(null, r.map(j => j._pct || 0)) : 0; });
function persist(job) { const c = {}; for (const k in job) if (k[0] !== '_') c[k] = job[k]; JobDB.put(JSON.parse(JSON.stringify(c))).catch(() => {}); }

// ── Link to ComfyUI ──
// ComfyUI addresses execution messages to the client_id that submitted the
// prompt, and when a socket reconnects under that same id it replays the node
// it is currently executing (see its /ws handler). Both only pay off if the id
// outlives the page, so it is persisted rather than minted per run — that is
// what makes a refresh recoverable at all. Every prompt goes out under this one
// id and messages are attributed back to a job by the prompt_id they carry.
const CLIENT_ID = (() => {
  let v = null;
  try { v = localStorage.getItem('comfyRemixClientId'); } catch (e) {}
  if (!v) {
    v = crypto.randomUUID ? crypto.randomUUID() : 'cl-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    try { localStorage.setItem('comfyRemixClientId', v); } catch (e) {}
  }
  return v;
})();
// `up` = we hold the live socket; `comfy` = ComfyUI answered the last poll.
// They are separate because losing the socket is cosmetic while losing ComfyUI
// is not, and the old engine conflated the two into "job failed".
export const link = reactive({ up: false, comfy: true, leader: false });
const TAB_ID = crypto.randomUUID ? crypto.randomUUID() : 'tab-' + Date.now() + '-' + Math.random().toString(36).slice(2);
const TAB_BORN = Date.now();

// One socket per *browser*, not per tab. A second tab connecting under the same
// client id makes ComfyUI evict the first, so unelected tabs would otherwise
// fight each other awake forever. The oldest tab wins and rebroadcasts what it
// hears; every tab still polls, so a dead leader is only a few seconds of lag.
let lastLeadSeen = 0;
const myRank = [TAB_BORN, TAB_ID];
const rankLt = (a, b) => a[0] !== b[0] ? a[0] < b[0] : a[1] < b[1];
function bcast(m) { if (jobChannel) { try { jobChannel.postMessage(Object.assign({ tab: TAB_ID }, m)); } catch (e) {} } }
function electTick() {
  if (link.leader) { bcast({ k: 'lead', rank: myRank }); return; }
  if (Date.now() - lastLeadSeen < 5000) return;
  link.leader = true; bcast({ k: 'lead', rank: myRank }); wsConnect();
}
if (jobChannel) jobChannel.onmessage = (evt) => {
  const m = evt.data || {}; if (!m || m.tab === TAB_ID) return;
  if (m.k === 'who') { if (link.leader) bcast({ k: 'lead', rank: myRank }); return; }
  if (m.k === 'lead') {
    if (!rankLt(m.rank, myRank)) return;         // outranked by us — they will stand down
    lastLeadSeen = Date.now();
    if (link.leader) { link.leader = false; wsClose(); }
    return;
  }
  if (m.k === 'bye') { if (rankLt(m.rank || [0, ''], myRank)) { lastLeadSeen = 0; electTick(); } return; }
  if (m.k === 'ws') applyWsMessage(m.msg);        // follower: leader's feed, applied identically
  if (m.k === 'poke') kickReconcile(300);         // another tab queued something
};
window.addEventListener('pagehide', () => { if (link.leader) bcast({ k: 'bye', rank: myRank }); });

let ws = null, wsTimer = null, wsBackoff = 1000;
function wsClose() { if (wsTimer) { clearTimeout(wsTimer); wsTimer = null; } if (ws) { try { ws.onclose = null; ws.close(); } catch (e) {} ws = null; } link.up = false; }
function wsConnect() {
  if (!link.leader || ws) return;
  try { ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/comfy-ws?clientId=' + CLIENT_ID); ws.binaryType = 'arraybuffer'; }
  catch (e) { ws = null; wsRetry(); return; }
  ws.onopen = () => { link.up = true; wsBackoff = 1000; kickReconcile(200); };
  ws.onclose = () => { ws = null; link.up = false; wsRetry(); };
  ws.onerror = () => {};
  ws.onmessage = (evt) => {
    if (typeof evt.data !== 'string') return;
    let msg; try { msg = JSON.parse(evt.data); } catch (e) { return; }
    applyWsMessage(msg);
    bcast({ k: 'ws', msg });
  };
}
// A dropped socket costs the live view and nothing else — ComfyUI keeps
// rendering and /queue + /history stay authoritative — so this retries forever
// on a capped backoff. The old engine spent a 3-strikes budget here and then
// failed the job, which is how a four-second blip turned a healthy render red.
function wsRetry() { if (wsTimer || !link.leader) return; wsTimer = setTimeout(() => { wsTimer = null; wsConnect(); }, wsBackoff); wsBackoff = Math.min(wsBackoff * 2, 15000); }

// The prompt on the GPU right now, per /queue. A replayed `executing` after a
// reconnect carries only a node id (ComfyUI omits prompt_id there), so this is
// what lets us attribute that first post-reconnect message to the right job.
let execPid = null;
const jobForPid = pid => (pid ? jobs.list.find(j => (j.promptIds || []).includes(pid)) : null);
function applyWsMessage(msg) {
  const d = (msg && msg.data) || {};
  if (!msg || !msg.type) return;
  if (msg.type === 'status') { kickReconcile(400); return; }   // queue changed under us
  const j = jobForPid(d.prompt_id || execPid);
  if (!j) return;
  if (d.prompt_id) execPid = d.prompt_id;
  switch (msg.type) {
    case 'execution_start': j._queued = 0; j._node = 'Running…'; break;
    case 'executing': if (d.node != null) { j._queued = 0; j._node = (j.nodeMap && j.nodeMap[d.node]) || String(d.node); } break;
    case 'progress': if (d.max > 0) { j._queued = 0; j._pct = Math.round(d.value / d.max * 100); j._node = 'Step ' + d.value + '/' + d.max; } break;
    case 'execution_success': case 'execution_error': case 'execution_interrupted': kickReconcile(600); break;
  }
}

// ── Reconcile: ComfyUI's queue + history are the source of truth ──
// Everything the page believes about a running job is re-derived from these two
// endpoints, so a refresh, a dropped socket, or a phone that slept through the
// render costs nothing worse than a few seconds of staleness.
const histCache = new Map();          // prompt_id -> {ok, names[]}; terminal, so safe to keep
const SETTLE_GRACE = 90000;           // a fresh prompt_id can lag /queue briefly
async function histLookup(pid) {
  if (histCache.has(pid)) return histCache.get(pid);
  let entry = null;
  try { const r = await fetch('/api/comfy/api/history/' + pid, { credentials: 'same-origin' }); if (!r.ok) return undefined; const d = await r.json(); entry = d && d[pid]; }
  catch (e) { return undefined; }                                  // undefined = could not tell
  const st = entry && entry.status;
  if (!st) return null;                                            // null = ComfyUI never heard of it
  if (st.status_str === 'error') { const v = { ok: false, names: [] }; histCache.set(pid, v); return v; }
  if (!st.completed) return null;
  const names = [];
  for (const nodeOut of Object.values(entry.outputs || {})) for (const items of Object.values(nodeOut)) if (Array.isArray(items)) for (const it of items) if (it.filename) names.push(it.filename);
  const v = { ok: true, names }; histCache.set(pid, v); return v;
}
// The queue as ComfyUI has it right now, or null if it could not be read. One
// reader, because "what is ComfyUI actually holding" is asked by the reconciler
// on a timer and by cancel at the moment it matters, and the two must not be
// able to disagree about how to ask.
async function queueNow() {
  try { const r = await fetch('/api/comfy/api/queue', { credentials: 'same-origin' }); if (!r.ok) return null; return await r.json(); }
  catch (e) { return null; }
}
// How many of this job's prompts ComfyUI still holds — running or pending.
// null when the queue is unreadable, which is not the same as zero.
async function mineInQueue(job) {
  const q = await queueNow();
  if (!q) return null;
  const mine = new Set((job.promptIds || []).filter(pid => !histCache.has(pid)));
  if (!mine.size) return 0;
  return [...(q.queue_running || []), ...(q.queue_pending || [])].filter(e => mine.has(e[1])).length;
}
// Take back everything of this job's that ComfyUI still has, in the only two
// ways it can be taken back: pending prompts are deleted, and one of ours on the
// GPU is interrupted. Reads the queue rather than trusting execPid — that is
// only as fresh as the last reconcile, so a cancel pressed in the seconds after
// a prompt reached the GPU used to skip the interrupt and let it render out.
async function sweepQueue(job) {
  const q = await queueNow();
  if (!q) return null;
  const mine = new Set((job.promptIds || []).filter(pid => !histCache.has(pid)));
  if (!mine.size) return 0;
  const pending = (q.queue_pending || []).map(e => e[1]).filter(pid => mine.has(pid));
  const running = (q.queue_running || []).map(e => e[1]).filter(pid => mine.has(pid));
  if (pending.length) { try { await jpost('/api/comfy/api/queue', { delete: pending }); } catch (e) {} }
  if (running.length) { try { await fetch('/api/comfy/api/interrupt', { method: 'POST', credentials: 'same-origin' }); } catch (e) {} }
  return pending.length + running.length;
}
let reconciling = false, reconcileSoon = null;
function kickReconcile(ms) { if (reconcileSoon) return; reconcileSoon = setTimeout(() => { reconcileSoon = null; reconcile(); }, ms || 400); }
async function reconcile() {
  if (reconciling) return; reconciling = true;
  try {
    const live = jobs.list.filter(j => j.status === 'running');
    if (!live.length) { execPid = null; return; }
    const q = await queueNow();
    if (!q) {
      // ComfyUI is unreachable. Say so and change nothing: concluding anything
      // from an outage is the bug this replaces — the queue routinely outlives
      // it (a container bounce, a Wi-Fi drop, this app being restarted).
      link.comfy = false;
      for (const j of live) if (!j._pct) j._node = 'ComfyUI unreachable — retrying…';
      return;
    }
    link.comfy = true;
    const onGpu = new Set((q.queue_running || []).map(e => e[1]));
    execPid = (q.queue_running || []).length ? q.queue_running[0][1] : null;
    const pos = new Map();
    (q.queue_pending || []).slice().sort((a, b) => a[0] - b[0]).forEach((e, i) => pos.set(e[1], i + 1));
    for (const j of live) await settleJob(j, onGpu, pos);
  } finally { reconciling = false; }
}
async function settleJob(job, onGpu, pos) {
  const ids = job.promptIds || [];
  if (!ids.length) {
    // Nothing ever reached ComfyUI. Only a wedged submit looks like this, and
    // only once the submit path has had time to succeed or log its own error.
    if (!job._submitting && Date.now() - job.startTime > 300000) { job.status = 'error'; job.endTime = Date.now(); job._node = 'Never queued'; persist(job); }
    return;
  }
  let done = 0, failed = 0, gone = 0, queued = 0, running = false, place = Infinity;
  const names = new Set();
  for (const pid of ids) {
    if (onGpu.has(pid)) { running = true; continue; }
    if (pos.has(pid)) { queued++; place = Math.min(place, pos.get(pid)); continue; }
    const h = await histLookup(pid);
    if (h === undefined) return;                     // history unreadable — leave the job alone
    if (h === null) { gone++; continue; }
    if (h.ok) { done++; h.names.forEach(n => names.add(n)); } else failed++;
  }
  job.runsCompleted = done;
  // On the GPU: hold whatever the socket last reported. If nothing has arrived
  // yet — a reload with no `executing` replay to land on — at least stop saying
  // "Reconnecting…" once /queue has confirmed the prompt really is running.
  if (running) { job._queued = 0; if (!job._pct && (!job._node || job._node === 'Reconnecting…' || job._node.indexOf('Queued') === 0 || job._node.indexOf('ComfyUI unreachable') === 0)) job._node = 'Running…'; }
  else if (queued) { job._queued = place; job._pct = 0; job._node = 'Queued · #' + place + ' in line'; }
  // Mid-flight: attach whatever the finished runs already wrote, so a 3x job
  // fills its grid one thumbnail at a time instead of producing nothing until
  // the last run lands. `names` only holds filenames from prompts that reached
  // history successfully, so this can never claim an output early.
  if ((running || queued) && names.size > job.results.length) {
    if (await collectOnce(job, names)) persist(job);
  }
  if (running || queued) return;                     // still in flight somewhere
  // Prompts in neither the queue nor history are unaccounted for. Give a just-
  // submitted id time to appear before believing it; past that, ComfyUI was
  // restarted or the queue was cleared out from under us.
  if (gone && Date.now() - (job.submittedAt || job.startTime) < SETTLE_GRACE) return;
  if (names.size) await collectOutputs(job, names);
  job.endTime = Date.now(); job._pct = 100; job._queued = 0;
  if (failed) { job.status = 'error'; job._node = 'Failed'; }
  else if (done >= (job.runs || 1)) { job.status = 'done'; job._node = ''; }
  else if (gone) { job.status = 'lost'; job._node = done ? ('Only ' + done + ' of ' + job.runs + ' runs survived') : 'Dropped from ComfyUI’s queue'; }
  else { job.status = 'done'; job._node = ''; }      // fewer prompts queued than runs, all clean
  persist(job);
}

// ── Startup ──
// Nothing about a running job is trusted from storage except its prompt ids;
// the live state is re-derived from ComfyUI on the first reconcile, which is
// why a refresh mid-render now costs a second of "Reconnecting…" rather than
// the rest of the job.
async function hydrate() {
  try {
    const all = await JobDB.getAll(); all.sort((a, b) => b.startTime - a.startTime);
    for (const j of all) {
      if (!Array.isArray(j.results)) j.results = [];
      if (!Array.isArray(j.promptIds)) j.promptIds = [];
      j._pct = isTerminal(j) ? 100 : 0;
      j._node = j.status === 'running' ? 'Reconnecting…' : '';
      j._log = []; j._queued = 0; j._submitting = false;
    }
    jobs.list = all;
  } catch (e) {}
  jobs.loaded = true;
  bcast({ k: 'who' });                       // an existing leader answers within the beat
  setTimeout(electTick, 1200);
  setInterval(electTick, 2000);
  reconcile();
  setInterval(() => { if (jobs.list.some(j => j.status === 'running')) reconcile(); }, 5000);
  // Phones freeze timers in a background tab, so a job can finish while the page
  // is asleep. Re-derive on the way back in rather than waiting out the interval.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { kickReconcile(200); if (link.leader && !ws) wsConnect(); } });
}
hydrate();

// ── Run engine ──
// Submitting is all this does. Once a prompt is in ComfyUI's queue the tab has
// no further role in driving it — progress arrives on the shared socket and the
// outcome is read back from /queue and /history — so nothing here needs to
// survive a reload for the render to finish and its outputs to be picked up.
async function submitPrompt(job, prompt, graph, log) {
  try {
    const payload = { prompt, client_id: CLIENT_ID };
    if (graph) payload.extra_data = { extra_pnginfo: { workflow: graph } };
    const res = await jpost('/api/comfy/api/prompt', payload);
    if (res.error) { log('Error: ' + (res.error.message || JSON.stringify(res.error)), 'err'); return null; }
    if (res.node_errors && Object.keys(res.node_errors).length) {
      log('ComfyUI rejected ' + Object.keys(res.node_errors).length + ' node(s):', 'err');
      for (const [nid, ne] of Object.entries(res.node_errors)) for (const e of (ne.errors || [])) log('  [' + nid + '] ' + e.message, 'err');
      return null;
    }
    job.promptIds.push(res.prompt_id); job.submittedAt = Date.now(); persist(job);
    return res.prompt_id;
  } catch (e) { log('Error: ' + e.message, 'err'); return null; }
}
// ── Outputs landing ────────────────────────────────────────────────────────
// Anything on screen that lists files can ask to hear about a job's outputs as
// they arrive. The browse grid uses it to refresh the folder a run is writing
// into: before this, an image only appeared there if you left the folder and
// came back, which is an odd thing to have to do while watching the run that is
// filling it.
//
// Subscribers are handed the paths that just landed and decide for themselves
// whether they care — the engine has no idea what any view is showing, and this
// stays true whether the run was started from the dialog, the inspect page or
// another tab, because everything goes through the same collector.
const outputWatchers = new Set();
export function onOutputsLanded(fn) { outputWatchers.add(fn); return () => outputWatchers.delete(fn); }
// Attribute outputs to THIS job by the filenames its own prompts reported —
// safe with concurrent jobs, where a time-window diff would grab another's.
// One pass. Split out of collectOutputs so a job still in flight can pick up
// the runs that have already landed without paying the retry ladder each tick.
// Returns whether anything new was attached.
async function collectOnce(job, names) {
  if (!names || !names.size) return false;
  try {
    const files = await jget('/api/recent-outputs?since=' + (job.startTime - 3600000));
    const seen = new Set(job.results.map(o => o.path));
    const landed = [];
    // Carry the mtime keys through: a job's thumbnails are cached like any
    // other media URL, and its outputs are the newest files on disk.
    for (const f of files) if (names.has(f.name) && !seen.has(f.path)) { job.results.push({ path: f.path, name: f.name, thumbPath: f.thumbPath, v: f.v, thumbV: f.thumbV }); seen.add(f.path); landed.push(f.path); }
    // A watcher that throws is a watcher's problem, not a reason to lose the
    // outputs this call just attached.
    if (landed.length) for (const fn of outputWatchers) { try { fn(landed); } catch (e) {} }
    return landed.length > 0;
  } catch (e) { return false; }
}
async function collectOutputs(job, names) {
  if (!names || !names.size) return;
  for (const delay of [0, 1200, 3000]) {
    if (delay) await new Promise(r => setTimeout(r, delay));
    await collectOnce(job, names);
    if (job.results.length >= names.size) break;
  }
  persist(job);
}
// Launch a job into the store and drive it to completion (async, non-blocking).
export function launchJob(p) {
  const id = 'job-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const job = reactive({
    id, workflow: p.workflowLabel, workflowFile: p.workflowFile,
    // Which of the prompt variations this job is, when there is more than one.
    // Persisted: a row that says nothing about it is indistinguishable from its
    // siblings in the Jobs list, which is where they all land.
    variation: p.variationLabel || null,
    prompt: (p.promptText || '').slice(0, 200), fullPrompt: p.promptText || '', loras: p.loras || null,
    // displaySource re-points only the row/thumbnail (a batch job shows the file it
    // feeds in); p.source still drives the upload and the graph.
    sourceFile: (p.displaySource || p.source).name, sourcePath: (p.displaySource || p.source).path,
    sourceImageUrl: fileUrl((p.displaySource || p.source).path),
    status: 'running', runs: 1, runsCompleted: 0, presets: p.preset ? [p.preset] : [],
    startTime: Date.now(), endTime: null, submittedAt: null, promptIds: [], results: [],
    // nodeMap is persisted (unlike the _-prefixed view state) so a reload can
    // still name the node ComfyUI reports instead of showing a bare node id.
    nodeMap: null,
    _pct: 0, _node: 'Preparing…', _log: [], _params: p, _queued: 0, _submitting: true,
    // Set by cancelJob and read by the queueing loop below. Not persisted: a
    // cancelled job is terminal, so there is nothing for a reload to resume.
    _cancelled: false,
  });
  jobs.list.unshift(job); persist(job);
  (async () => {
    const log = (m, cls) => { job._log.push({ m, cls: cls || '' }); if (job._log.length > 200) job._log.shift(); };
    let uploadedName = null;
    try {
      if (p.source.type === 'image') { job._node = 'Uploading image…'; uploadedName = await uploadImagePath(p.source.path); }
      else if (p.source.type === 'video') { job._node = 'Extracting frame…'; const b = await firstVideoFrameBlob(fileUrl(p.source.path)); uploadedName = await uploadBlob(b, 'png'); }
    } catch (e) { log('input upload: ' + e.message, 'err'); }
    if (uploadedName) log('Input uploaded as ' + uploadedName);
    // Upload any gallery-picked image fields so ComfyUI gets an input filename.
    const pickedUploads = new Set();
    for (const mf of (p.mediaFields || [])) {
      try {
        // Same file as the source we just sent up — reuse it instead of a second copy.
        const up = (uploadedName && mf.value === p.source.path) ? uploadedName : await uploadImagePath(mf.value);
        if (up) { p.fieldValues[mf.id] = up; pickedUploads.add(up); log('Picked image uploaded as ' + up); }
      } catch (e) { log('media upload (' + mf.id + '): ' + e.message, 'err'); }
    }
    // Match Input Image. The workflow states a frame size and also takes an
    // image, and the image is the better witness — so the two size fields are
    // overwritten with what the file going in actually measures. Done here
    // rather than in the caller because a batch is N jobs each holding its own
    // file: measuring once up front would size every run to the first one.
    // `from` is the field the form was pointed at; with none set, the media this
    // run was started from is the input, since that is what the upload above
    // just wired into MAIN IMAGE.
    //
    // The fallback is on the measurement failing, not on `from` being absent.
    // An image field can hold a bare ComfyUI input name instead of a library
    // path — one surface filters those out of mediaFields and the other does
    // not — and a name is something /file/ cannot serve, so the measure comes
    // back null with a perfectly good source file sitting right there. Falling
    // back only when nothing was named left that run on the workflow's own size.
    if (p.matchSize) {
      job._node = 'Measuring input…';
      const src = p.source.type ? p.source.path : '';
      const from = p.matchSize.from || src;
      let d = await mediaSize(from);
      if (!d && src && src !== from) d = await mediaSize(src);
      if (d) {
        p.fieldValues[p.matchSize.width] = d.w;
        p.fieldValues[p.matchSize.height] = d.h;
        log('Matched input image · ' + d.w + ' × ' + d.h);
      } else {
        log('Could not measure ' + (from || 'the input image') + ' — keeping the workflow’s own size', 'warn');
      }
    }
    job._node = 'Applying fields…';
    let data;
    try {
      // Inherit runs the image's own embedded graph (posted); otherwise a named APP workflow.
      const wfUrl = p.embeddedWf ? '/api/workflow-prompt' : ('/api/workflow-prompt?name=' + enc(p.workflowFile));
      const wfBody = p.embeddedWf ? { fieldValues: p.fieldValues, workflow: p.embeddedWf } : { fieldValues: p.fieldValues };
      data = await jpost(wfUrl, wfBody);
    }
    catch (e) { log('build prompt: ' + e.message, 'err'); job.status = 'error'; job.endTime = Date.now(); persist(job); return; }
    if (data.error) { log('error: ' + data.error, 'err'); job.status = 'error'; job.endTime = Date.now(); persist(job); return; }
    (data.fieldWarnings || []).forEach(w => log('field: ' + w, 'warn'));
    const graph = data.workflow || null; const prompt = data.prompt || data;
    // Prompt Replacements: rewrite prompt-ish text across the built graph.
    // The rules this job runs. A job is one variation — several enabled rules
    // for the same keyword are alternatives, not a queue — so the list arrives
    // already narrowed to one choice per keyword. Without one (an older record
    // replayed, a caller that has not been taught) every enabled rule runs,
    // which is what used to happen.
    const replRules = p.replacementRules || activeReplacements();
    if (replRules.length) {
      applyReplacementsToNodes(prompt, replRules);
      log('Applied ' + replRules.length + ' prompt replacement(s)' + (p.variationLabel ? ' · ' + p.variationLabel : ''));
    }
    // Danger-zone node edits: apply by node id + key when the built graph has them.
    if (p.nodeEdits) { let n = 0; for (const [nid, kv] of Object.entries(p.nodeEdits)) { const node = prompt[nid]; if (node && node.inputs) for (const [k, val] of Object.entries(kv)) { node.inputs[k] = val; n++; } } if (n) log('Applied ' + n + ' node edit(s)'); }
    // Point the workflow's MAIN IMAGE loader at the source media we just uploaded —
    // but never over an image the user explicitly picked for that field. Those were
    // already applied as field overrides above, and clobbering them is why choosing
    // a different image for a video remix still rendered the video's own frame.
    if (uploadedName) for (const n of Object.values(prompt)) {
      const t = (n._meta && n._meta.title || '').toUpperCase();
      if (t.includes('MAIN IMAGE') && n.inputs && !pickedUploads.has(n.inputs.image)) n.inputs.image = uploadedName;
    }
    for (const n of Object.values(prompt)) { if (n.is_changed) delete n.is_changed; }
    // Expand %date:FORMAT% filename tokens so save nodes from other setups don't
    // write a literal "%date:…%" folder (invalid on Windows).
    for (const n of Object.values(prompt)) { if (n.inputs && typeof n.inputs.filename_prefix === 'string' && n.inputs.filename_prefix.includes('%date:')) n.inputs.filename_prefix = expandDateTokens(n.inputs.filename_prefix); }
    // Node id -> readable title, so progress can say "KSampler" not "37".
    const nodeMap = {}; Object.entries(prompt).forEach(([nid, n]) => nodeMap[nid] = (n._meta && n._meta.title) || n.class_type || nid);
    job.nodeMap = nodeMap;
    // Queue every run up front, each with its own fresh seed unless the seed is
    // pinned. ComfyUI's queue — not this tab — is then what sequences the work,
    // so closing or reloading the page can no longer strand runs 2..N the way
    // the old per-run await loop did.
    const runs = Math.max(1, p.runs || 1);
    job.runs = runs;
    job._node = 'Queueing…';
    for (let i = 0; i < runs; i++) {
      // Cancel can land in the middle of this. Queueing the runs up front is what
      // makes them survive a reload, but it also means Cancel and this loop are
      // two writers to the same queue: cancel swept what was there, and the loop
      // kept adding to it, which is how a cancelled job carried on rendering.
      if (job._cancelled) { log('Cancelled — stopped after queueing ' + i + ' of ' + runs + ' run(s)', 'warn'); break; }
      if (!p.seedPinned) for (const n of Object.values(prompt)) { if (n.inputs) for (const k of Object.keys(n.inputs)) { if (k.includes('seed') && typeof n.inputs[k] === 'number') n.inputs[k] = Math.floor(Math.random() * 2147483647); } }
      const pid = await submitPrompt(job, prompt, graph, log);
      if (!pid) {
        job._submitting = false;
        // Cancelled mid-submit is not a failure to queue, and the record already
        // says what happened. Saying it twice would overwrite "Cancelled" with a
        // wrong reason.
        if (job._cancelled) { persist(job); return; }
        job.status = 'error'; job.endTime = Date.now(); job._node = 'Failed to queue'; persist(job); return;
      }
      log('Queued run ' + (i + 1) + '/' + runs + ' · ' + String(pid).slice(0, 8));
    }
    job._submitting = false;
    // The submit that was already in flight when cancel swept the queue lands
    // after it. This is the one place that knows submitting has finished, so it
    // is the one place that can be sure the sweep has nothing left to catch.
    if (job._cancelled) { await sweepQueue(job); persist(job); return; }
    job._node = 'Queued';
    bcast({ k: 'poke' });
    kickReconcile(300);
  })();
  return id;
}
// Cancel has to reach three things, not the two it used to: the prompt on the
// GPU, whatever else of ours is already queued, and — the one that was missed —
// the loop in launchJob that may still be queueing runs 2..N. Sweeping a queue
// something is still filling leaves the job cancelled here and running there,
// which is exactly what it looks like from ComfyUI's side.
//
// It also verifies rather than assumes. Marking the record "Cancelled" the
// instant the requests go out reads as success whether or not ComfyUI honoured
// them, and a queue that keeps working under a row that says otherwise is worse
// than an error message.
export async function cancelJob(job) {
  if (!job || job.status !== 'running') return;
  job._cancelled = true;              // read by the queueing loop before each submit
  job._node = 'Cancelling…';
  const left = await sweepQueue(job);
  job.status = 'error'; job.endTime = Date.now(); job._pct = 100; job._queued = 0;
  job._node = left === null ? 'Cancelled — ComfyUI unreachable, its queue is unchanged' : 'Cancelled';
  persist(job); bcast({ k: 'poke' });
  // A prompt submitted in the moment between the sweep and the loop noticing is
  // ComfyUI's to run, and an interrupt only ever covers the one on the GPU. The
  // loop sweeps again when it stops, so this is the backstop for the case where
  // it cannot — a dead tab, a submit that never returns — and the only place the
  // user hears that the cancel did not fully take.
  setTimeout(async () => {
    if (await mineInQueue(job)) await sweepQueue(job);
    const still = await mineInQueue(job);
    if (still) {
      job._node = 'Cancelled — ComfyUI still holds ' + still;
      showToast('ComfyUI still holds ' + still + ' prompt(s) from that job. Cancel again, or clear its queue.', 6000);
    }
  }, 2000);
}
// An output that is not there any more — deleted, or favorited out from under
// the run that made it. The list belongs to the job record, so it goes from
// there and the record is written back: in memory alone it returns on the next
// reload as a thumbnail pointing at nothing. Paths are compared loosely because
// a caller may be holding one that has been round-tripped through the URL, where
// Windows separators and case do not survive.
export function forgetOutput(job, path) {
  if (!job || !path) return;
  const key = p => String(p || '').replace(/\\/g, '/').toLowerCase();
  const want = key(path);
  const next = (job.results || []).filter(f => key(f.path) !== want);
  if (next.length === (job.results || []).length) return;
  job.results = next;
  persist(job);
}
// Deleting the row does not delete the work. A running job's prompts belong to
// ComfyUI until something tells it otherwise, and once the record is gone there
// is nothing left that could — no promptIds, so no sweep, and the runs finish
// under a job the app has forgotten. Cancel first, then forget it.
export async function deleteJob(job) {
  if (job && job.status === 'running') { try { await cancelJob(job); } catch (e) {} }
  const i = jobs.list.indexOf(job); if (i >= 0) jobs.list.splice(i, 1);
  try { await JobDB.del(job.id); } catch (e) {}
}

// Grow a textarea to its content instead of scrolling inside a fixed 7 rows.
// Height must go to 'auto' first or scrollHeight only ever reports the height it
// already has, and the box can then grow but never shrink.



// Read the values a media was actually generated with (loras, steps, cfg, size,
// prompt…) out of its embedded litegraph and write them onto the field config.
function prefillFromEmbedded(fields, wfGraph) {
  if (!wfGraph || !Array.isArray(wfGraph.nodes)) return;
  const byNodeId = {}; for (const n of wfGraph.nodes) byNodeId[String(n.id)] = n;
  for (const f of fields) {
    const t = (f.targets || [])[0]; if (!t || (t.path && t.path.length)) continue;
    const node = byNodeId[String(t.nodeId)]; if (!node) continue;
    if (t.class && node.type && node.type !== t.class) continue;   // guard against id collisions
    const wv = node.widgets_values;
    if (f.kind === 'lora_list') {
      if (Array.isArray(wv)) { const rows = []; wv.forEach((item, idx) => { if (item && typeof item === 'object' && 'lora' in item) rows.push({ slot: idx, on: !!item.on, lora: item.lora, strength: item.strength != null ? item.strength : 1, strengthTwo: item.strengthTwo }); }); if (rows.length) f.value = rows; }
      continue;
    }
    let v;
    if (Array.isArray(wv) && typeof t.widgetIndex === 'number' && t.widgetIndex >= 0 && t.widgetIndex < wv.length) v = wv[t.widgetIndex];
    else if (wv && !Array.isArray(wv) && typeof wv === 'object' && t.widget in wv) v = wv[t.widget];
    if (v === undefined || v == null || typeof v === 'object') continue;
    // A seed node records the seed it resolved to, so the embedded graph of a finished
    // run carries a concrete number even where the workflow says -1. Copying that into
    // a field the workflow left on random would present the last run's seed as the next
    // one's. Blank here means the workflow randomises (loadFields cleared -1), so keep
    // it blank and hang the number off the "this file's seed" button.
    if (f.kind === 'seed' && String(f.value).trim() === '') { if (Number(v) >= 0) f._mediaSeed = Number(v); continue; }
    f.value = v;
  }
}

// The style preset is the one control that is not a widget: the workflow states
// it by leaving exactly one coloured group un-muted, so prefillFromEmbedded —
// which reads widgets_values — walks straight past it, and an image plainly made
// with a preset re-opens on "— none —".
//
// Recovering it needs no second detection pass and no copy of rgthree's group
// geometry: the config already names every zone's nodes, and the image's own
// graph says which of those nodes ran. Mode 0 is "runs"; the muter writes 2 on
// each group it turns off, which is also what applyFieldConfigOverrides writes
// when a run picks one.
export function presetFromEmbedded(cfg, wfGraph) {
  const presets = (cfg && cfg.presets) || [];
  if (!presets.length || !wfGraph || !Array.isArray(wfGraph.nodes)) return '';
  const mode = new Map();
  for (const n of wfGraph.nodes) mode.set(String(n.id), n.mode || 0);
  for (const p of presets) {
    const z = (cfg.zones || []).find(z => z.title === p.title);
    if (z && (z.nodes || []).some(id => mode.get(String(id)) === 0)) return p.title;
  }
  return '';
}

// ── The dialog ─────────────────────────────────────────────────────────────
export default {
  name: 'RemixDialog',
  components: { WorkflowFields, MediaTile, ReplacementRules },
  props: {
    // The media being remixed, in the listing's own shape: { path, name,
    // isVideo/isImage/isAudio, v }. `path` is absolute and on Windows arrives
    // with backslashes — it is only ever handed straight back to the server.
    item: { type: Object, required: true },
  },
  emits: ['close'],
  setup(props, { emit }) {
    // The source media. A computed off the prop, so re-pointing the dialog at
    // another file is just a prop change — there is no second copy to keep in
    // step, which is what the pre-SPA `S` object and its mirrors were for.
    const src = computed(() => {
      const it = props.item || {};
      return {
        path: it.path || '',
        name: it.name || String(it.path || '').split(/[\\/]/).pop(),
        type: it.isVideo ? 'video' : (it.isImage ? 'image' : 'audio'),
        v: it.v,
      };
    });

    const workflows = ref([]); const wf = ref('');
    const cfg = reactive({ fields: [], presets: [], loading: true, error: '', promptAlt: null });
    const selectedPreset = ref('');
    const meta = reactive({ prompt: '', seed: null, embedded: null, embeddedWf: null, matchedWf: null, undetected: false, metadataFrom: '', unlistedWf: null, adding: false });
    const startedId = ref(null);
    const saveMsg = ref('');
    // "Save workflow" — import this image's embedded graph into the app so any
    // other image can pick it from the dropdown. Only offered on Inherit.
    const wfSave = reactive({ open: false, name: '', busy: false, msg: '', existing: [] });
    // ── Which prompt survives a workflow switch ─────────────────────────
    // Every workflow carries a prompt of its own, so picking a different one
    // replaces whatever is in the box. That is right when you switched *for*
    // that workflow's prompt and wrong when you had just finished writing one,
    // and neither default is safe to guess at — so the switch asks, showing
    // both so the choice is made by reading rather than by remembering.
    //
    // Only a pick in the dropdown arms it. Every other assignment to `wf` is
    // the app moving the selection itself (opening a file, adding a recognised
    // workflow, saving a shortcut, exporting a graph), and none of those is a
    // user changing their mind about a prompt.
    const promptChoice = reactive({ open: false, current: '', next: '' });
    let pendingPromptAsk = null;
    const promptField = () => (cfg.fields || []).find(f => f.kind === 'prompt' && f.enabled && !f.variant);
    function pickWorkflow(name) {
      if (!name || name === wf.value) return;
      // A shortcut IS a saved set of values — its prompt is the thing that was
      // saved, and the whole point of picking one is to load it. Asking whether
      // to keep the old text would be asking whether to use what was just
      // chosen, so a shortcut replaces the prompt outright.
      // Stamped with the workflow it is about to load. Building the controls
      // takes ten seconds and more (ComfyUI's /object_info), which is long
      // enough to pick again after a misclick — and then two loads are in
      // flight and the first to finish would otherwise raise the second one's
      // question against its own fields, offering a "New Prompt" that is not
      // the one on screen.
      pendingPromptAsk = isShortcut(name) ? null : { prev: promptFieldText.value, forWf: name };
      wf.value = name;   // the watcher below reloads the fields
    }
    // Raised at the end of the load, when the new workflow's prompt is on
    // screen: staying quiet is the same as choosing New, which is what the form
    // already shows. Nothing to choose between means nothing to ask.
    function offerPromptChoice(prev) {
      const before = String(prev == null ? '' : prev);
      const after = promptFieldText.value;
      if (!before.trim() || before.trim() === after.trim() || !promptField()) return;
      promptChoice.current = before; promptChoice.next = after; promptChoice.open = true;
    }
    function resolvePromptChoice(keepCurrent) {
      if (keepCurrent) { const f = promptField(); if (f) f.value = promptChoice.current; }
      promptChoice.open = false;
    }
    // ── Shortcuts ──────────────────────────────────────────────────────
    // A shortcut is this workflow re-opened on a saved set of field values.
    // Grouping is off the label alone ("PARENT : NAME"), so a shortcut sits
    // under its parent without the dropdown needing to know what one is.
    const scSaving = ref(false);
    const scSaved = ref(false);   // brief ✓ on the save button — saving in place changes nothing else on screen
    let scSavedT = null;
    let skipNextFieldLoad = false;
    const isShortcut = n => typeof n === 'string' && n.startsWith('@sc:');
    // Plain list refresh. loadWorkflows() also re-picks the selection and
    // resets meta.undetected/matchedWf, which is wrong when we already know
    // which entry we want selected.
    async function refreshWorkflows() {
      try { workflows.value = await api.workflows(); } catch (e) {}
    }
    const canShortcut = computed(() => !!wf.value && wf.value !== '__inherit__' && !cfg.loading && !cfg.error && cfg.fields.length > 0);
    // Writing back to the workflow's own file needs a real file to write to:
    // not Inherit (nothing on disk) and not a shortcut (it lives in the store,
    // and resolving it would rewrite its parent behind your back).
    const canUpdateWf = computed(() => canShortcut.value && !isShortcut(wf.value));
    const wfUpdating = ref(false);
    const wfUpdated = ref(false);
    async function updateWorkflow() {
      if (!canUpdateWf.value || wfUpdating.value) return;
      wfUpdating.value = true;
      try {
        const r = await api.updateWorkflow(wf.value, collectFieldValues());
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

    // Only the two reachable cases: the button is hidden entirely unless
    // canShortcut, so the old "pick a workflow first" / "save this image's
    // workflow first" branches can no longer be seen by anyone.
    const shortcutHint = computed(() => (isShortcut(wf.value)
      ? 'Update “' + currentWfLabel.value + '” with the settings on screen'
      : 'Save these settings as a shortcut under ' + (currentWfLabel.value || 'this workflow')));
    const currentWfLabel = computed(() => { const w = workflows.value.find(x => x.name === wf.value); return w ? w.label : ''; });
    // Shortcuts are stored as "Parent Workflow : name" and the dropdown already
    // shows them nested under the parent, so a button naming one only needs the
    // half after the separator — same split wfGroups uses.
    const currentWfShort = computed(() => {
      const l = currentWfLabel.value || '';
      const i = l.indexOf(' : ');
      return i > 0 ? l.slice(i + 3) : l;
    });
    const wfGroups = computed(() => {
      const groups = new Map();
      for (const w of workflows.value) {
        const i = w.label.indexOf(' : ');
        const key = i > 0 ? w.label.slice(0, i) : w.label;
        if (!groups.has(key)) groups.set(key, { key, self: null, kids: [] });
        if (i > 0) groups.get(key).kids.push({ name: w.name, short: w.label.slice(i + 3) });
        else groups.get(key).self = w;
      }
      return [...groups.values()];
    });
    async function saveShortcut() {
      if (!canShortcut.value || scSaving.value) return;
      // With a shortcut loaded, save writes back over it: it already has a name,
      // so asking for one again could only ever produce a near-duplicate. Make a
      // new one by picking the parent workflow in the dropdown instead.
      const editing = isShortcut(wf.value);
      let name = '';
      if (!editing) {
        name = (window.prompt('Name this shortcut — it will be saved as\n\n    ' + currentWfLabel.value + ' : <name>', '') || '').trim();
        if (!name) return;
      }
      scSaving.value = true;
      try {
        const r = await api.saveShortcut(editing
          ? { id: wf.value, fieldValues: collectFieldValues() }
          : { parent: wf.value, name, fieldValues: collectFieldValues() });
        scSaved.value = true;
        clearTimeout(scSavedT); scSavedT = setTimeout(() => { scSaved.value = false; }, 1600);
        if (editing) return;   // same entry, same label — nothing on screen changes
        await refreshWorkflows();
        // Select it without the reload its watcher would trigger: the fields on
        // screen already ARE the shortcut's values.
        skipNextFieldLoad = true;
        wf.value = r.name;
      } catch (e) { showToast('Could not save shortcut: ' + e.message, 4000); }
      finally { scSaving.value = false; }
    }
    async function deleteShortcut() {
      if (!isShortcut(wf.value)) return;
      if (!window.confirm('Delete the shortcut "' + currentWfLabel.value + '"?\n\nThe workflow it was saved from is not affected.')) return;
      const parent = (workflows.value.find(x => x.name === wf.value) || {}).parent || '';
      try {
        await api.deleteShortcut(wf.value);
        await refreshWorkflows();
        wf.value = parent || (workflows.value[0] || {}).name || '';
      } catch (e) { showToast(e.message, 4000); }
    }
    const nodeFilter = ref('');
    const tab = ref('workflow');
    const runCount = ref((function () { try { return localStorage.getItem('archiveRunCount') || '1'; } catch (e) { return '1'; } })());
    watch(runCount, v => { try { localStorage.setItem('archiveRunCount', v); } catch (e) {} });
    const job = computed(() => startedId.value ? byId(startedId.value) : null);
    const isVideo = computed(() => src.value.type === 'video');
    const mediaUrl = computed(() => fileUrl(src.value.path, src.value.v));
    // The flyout speaks the grid's item shape, not the Remix dialog's. It used to
    // be a global one page assigned and another read; it is now a shared component
    // both this dialog and the viewer import.
    const toolsMenu = MediaToolsMenu;
    const toolItem = computed(() => ({ path: src.value.path, name: src.value.name, isVideo: src.value.type === 'video' }));

    // ── Load progress ──────────────────────────────────────────────────
    // Building the controls stalls on ComfyUI's /object_info, which takes ~10s
    // (and up to 30) to answer with nothing observable in between. The honest
    // bar is elapsed time against the previous fetch's duration (the server
    // reports both); with no prior measurement it slides instead of inventing
    // a number.
    const prog = reactive({ on: false, pct: 0, exact: false, label: '', detail: '', secs: 0, ownClock: false });
    let progTick = null, progPoll = null, progT0 = 0;
    function progStart(label, pct) {
      prog.on = true; prog.label = label; prog.pct = pct; prog.exact = false; prog.detail = ''; prog.ownClock = false;
      if (!progTick) { progT0 = Date.now(); prog.secs = 0; progTick = setInterval(() => { prog.secs = ((Date.now() - progT0) / 1000).toFixed(1); }, 100); }
    }
    // Poll the server's byte counter while the field-config request is out.
    function progWatch(nodeCount) {
      clearInterval(progPoll);
      progPoll = setInterval(async () => {
        try {
          const p = await jget('/api/objectinfo-progress');
          if (p.active) {
            prog.label = 'Waiting for ComfyUI node definitions…';
            prog.ownClock = true;   // this stage reports its own elapsed time
            const el = (p.elapsedMs / 1000).toFixed(1);
            if (p.lastMs && p.elapsedMs <= p.lastMs) {
              prog.exact = true;
              prog.pct = 30 + Math.round(55 * (p.elapsedMs / p.lastMs));
              prog.detail = el + 's of ~' + (p.lastMs / 1000).toFixed(0) + 's';
            } else if (p.lastMs) {
              // Past the estimate: stop implying a known remainder.
              prog.exact = false;
              prog.detail = el + 's — longer than the usual ~' + (p.lastMs / 1000).toFixed(0) + 's';
            } else { prog.exact = false; prog.detail = el + 's'; }
          } else {
            prog.ownClock = false;
            prog.exact = false; prog.pct = 88;
            prog.label = 'Building controls…';
            prog.detail = nodeCount ? nodeCount + ' nodes' : '';
          }
        } catch (e) {}
      }, 250);
    }
    function progStop() {
      clearInterval(progTick); clearInterval(progPoll); progTick = progPoll = null;
      prog.on = false; prog.pct = 0; prog.exact = false;
    }
    onUnmounted(progStop);

    async function loadMeta() {
      meta.prompt = ''; meta.seed = null; meta.embedded = null; meta.matchedWf = null; meta.undetected = false; meta.metadataFrom = ''; meta.unlistedWf = null; let embeddedWf = null;
      try {
        const md = await api.metadata(src.value.path);
        meta.prompt = mainPromptOf(md && md.prompt); embeddedWf = md && md.workflow; meta.embedded = (md && md.prompt) || null; meta.embeddedWf = embeddedWf || null;
        meta.metadataFrom = (md && md.metadataFrom) ? String(md.metadataFrom).split('/').pop() : '';
        if (md && md.prompt) for (const n of Object.values(md.prompt)) { if (n && n.inputs) for (const [k, v] of Object.entries(n.inputs)) if (/seed/i.test(k) && typeof v === 'number' && v >= 0) meta.seed = v; }
      } catch (e) {}
      return embeddedWf;
    }
    async function loadWorkflows(embeddedWf) {
      try { workflows.value = await api.workflows(); } catch (e) { workflows.value = []; }
      let pick = workflows.value[0] && workflows.value[0].name;
      if (embeddedWf && embeddedWf.nodes) {
        try {
          const m = await jpost('/api/workflow-match', { workflow: embeddedWf });
          // A recognised workflow that isn't enabled can't be selected here (the
          // dropdown only lists enabled ones), so name it and offer to add it rather
          // than falling through to an unrelated workflow. Inherit runs it meanwhile.
          if (m && m.name && m.enabled === false) meta.unlistedWf = { name: m.name, label: m.label || m.name };
          else if (m && m.name) { pick = m.name; meta.matchedWf = m.name; }
        } catch (e) {}
        if (!meta.matchedWf) pick = '__inherit__';   // embedded workflow isn't imported → run it as-is
      } else {
        // No graph in the file, so `pick` is just whatever sorts first in the list —
        // say so instead of presenting it (and its own saved prompt) as this file's.
        meta.undetected = !!pick;
      }
      wf.value = pick || '';
    }
    // Add the recognised-but-unlisted workflow to the dropdown, then select it. Only
    // `enabled` is sent, so the store's labels and mappings are left as they are.
    async function addUnlistedWf() {
      const u = meta.unlistedWf;
      if (!u || meta.adding) return;
      meta.adding = true;
      try {
        const names = workflows.value.map(w => w.name);
        if (!names.includes(u.name)) names.push(u.name);
        const r = await jpost('/api/workflows/manage', { enabled: names });
        if (r && r.error) throw new Error(r.error);
        workflows.value = await api.workflows();
        meta.matchedWf = u.name; meta.unlistedWf = null;
        wf.value = u.name;        // triggers the watch → loadFields()
      } catch (e) { saveMsg.value = 'Could not add it: ' + e.message; }
      meta.adding = false;
    }
    async function loadFields() {
      if (!wf.value) { cfg.fields = []; cfg.loading = false; progStop(); return; }
      cfg.loading = true;
      const nodeCount = (meta.embeddedWf && meta.embeddedWf.nodes) ? meta.embeddedWf.nodes.length : 0;
      progStart('Building controls…', 30);
      if (nodeCount) prog.detail = nodeCount + ' nodes';
      progWatch(nodeCount);
      try {
        // api.fieldConfig covers the by-name GET; Inherit posts this image's own
        // graph, which api.js has no helper for yet. Both answers are inspected
        // for `error` rather than thrown, so the message lands in cfg.error.
        let c;
        try {
          c = wf.value === '__inherit__'
            ? (meta.embeddedWf
                ? await jpost('/api/workflow-field-config', { workflow: meta.embeddedWf })
                : { error: 'This image has no embedded workflow graph to inherit.' })
            : await api.fieldConfig(wf.value);
        } catch (e) { c = { error: String(e.message || e) }; }
        clearInterval(progPoll); progPoll = null;
        prog.exact = true; prog.pct = 96;
        prog.label = 'Rendering controls…';
        prog.detail = Array.isArray(c.fields) ? c.fields.length + ' controls' : '';
        if (c.error || !Array.isArray(c.fields)) { cfg.error = c.error || 'no config'; cfg.fields = []; cfg.presets = []; }
        else {
          cfg.error = ''; cfg.presets = c.presets || [];
          selectedPreset.value = c.selectedPreset || '';   // a shortcut restores the preset it captured
          // ── The seed box says what will be used, or nothing ──────────
          // A number in the box means that number will be the seed. Unpinned it
          // never was: collectFieldValues skips an unpinned seed, and launchJob
          // re-randomises every seed input in the built graph — so the workflow's
          // stored number sat there looking like the seed of the next run while
          // three consecutive runs used three other ones. Blank is what an
          // unpinned seed actually is, and the placeholder already reads
          // "random". The file's own seed is not lost: it goes on _mediaSeed,
          // behind the "↺ this file's seed" button, which only appears once the
          // box is empty and pins what it puts there.
          const scNow = isShortcut(wf.value), inheritNow = wf.value === '__inherit__';
          const hasSeed = f => Number(f.value) >= 0 && String(f.value).trim() !== '';
          for (const f of c.fields) {
            if (f.kind === 'seed') {
              // Inherit's config was built from this file's own graph, so the
              // seed in it is the one that made the file. A named workflow's is
              // whatever the .json was last saved with — the media seed for
              // those arrives below, out of the file's metadata.
              if (inheritNow && hasSeed(f)) f._mediaSeed = Number(f.value);
              // A shortcut carries a seed only if it was pinned when the
              // shortcut was saved, since collectFieldValues drops an unpinned
              // one. So a number here was put there on purpose — keep it, and
              // pin it, rather than blanking what the shortcut was saved for.
              if (scNow && hasSeed(f)) f._pin = true;
              else { f.value = ''; f._pin = false; }
            }
            if (ctype(f) === 'lora_rows' && !Array.isArray(f.value)) f.value = [];
            if (ctype(f) === 'boolean') f.value = !!f.value;
          }
          // A named workflow opens on its stored defaults, so seed it from the
          // image's metadata. Inherit must NOT do that: its config was generated
          // from this image's own graph, so every value is already the one that
          // produced the image — while mainPromptOf()/meta.seed are heuristics
          // over the flat API prompt. In a graph with several CLIPTextEncode
          // nodes (only one wired to the sampler) the heuristic picks whichever
          // text is longest, replacing the real prompt with an unused one.
          // A shortcut is excluded for the same reason Inherit is: every value
          // it carries was captured deliberately, so overwriting the prompt
          // with the source image's — a heuristic over the flat prompt — would
          // throw away the one thing the user saved the shortcut for.
          // Both versions of this file's prompt, for the switch above the field.
          // Offered whichever workflow is selected: Inherit opens on the typed
          // one and this is how you reach what actually ran, a named workflow
          // opens on what ran and this is how you get the keywords back.
          cfg.promptAlt = promptAlternatives(meta.embedded, meta.embeddedWf);
          if (wf.value !== '__inherit__' && !isShortcut(wf.value)) {
            if (meta.prompt) { const pf = c.fields.find(f => f.kind === 'prompt' && !f.variant); if (pf) pf.value = meta.prompt; }
            // The seed the media was actually made with — kept as the value behind
            // the "↺ this file's seed" button and never dropped into the box. In
            // the box it would read as if the re-run were pinned to it, and it
            // isn't: an unpinned seed is re-randomised per run at launch. That is
            // exactly what used to happen whenever the workflow carried a concrete
            // seed of its own, which is most of them.
            if (meta.seed != null && meta.seed >= 0) {
              const sf = c.fields.find(f => f.kind === 'seed');
              if (sf) sf._mediaSeed = meta.seed;
            }
          }
          // When the source media carries this exact workflow, prefill every field
          // (loras, steps, cfg, size…) from the values it was actually generated with.
          if (meta.embeddedWf && wf.value === meta.matchedWf) prefillFromEmbedded(c.fields, meta.embeddedWf);
          // …including the style preset, which lives in the graph's mute state
          // rather than in a widget. Inherit read this image's own graph, so its
          // config already says which preset was on; a named workflow was read
          // off disk, where the group left un-muted is whatever the file was last
          // saved with — not what made the image. A shortcut wins over both: the
          // preset it carries was captured on purpose.
          if (!c.selectedPreset) {
            if (wf.value === '__inherit__') selectedPreset.value = ((c.presets || []).find(p => p.on) || {}).title || '';
            else if (meta.embeddedWf && wf.value === meta.matchedWf) selectedPreset.value = presetFromEmbedded(c, meta.embeddedWf);
          }
          cfg.fields = c.fields;
        }
      } catch (e) { cfg.error = String(e.message || e); }
      cfg.loading = false;
      progStop();
      // Here rather than in the watcher: the prompt to compare against only
      // exists once the new config has been rendered into cfg.fields, and the
      // watcher does not await this. A load that has been overtaken leaves the
      // ask alone for the load that overtook it to answer.
      if (pendingPromptAsk && pendingPromptAsk.forWf === wf.value) {
        const a = pendingPromptAsk; pendingPromptAsk = null; offerPromptChoice(a.prev);
      }
    }
    // ── Save the inherited workflow into the app ───────────────────────
    const wfFileName = n => (n.toLowerCase().endsWith('.json') ? n : n + '.json');
    // Taken names are refused outright — never overwrite an existing workflow.
    // (The server enforces this too; this just says so before the round trip.)
    const wfNameTaken = computed(() => {
      const n = (wfSave.name || '').trim();
      return !!n && wfSave.existing.includes(wfFileName(n).toLowerCase());
    });
    watch(() => wfSave.name, () => { wfSave.msg = ''; });   // editing the name clears a stale error
    async function openWfSave() {
      wfSave.name = (src.value.name || 'workflow').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_');
      wfSave.msg = ''; wfSave.open = true;
      try { wfSave.existing = (await api.workflowsAll()).map(w => w.name.toLowerCase()); }
      catch (e) { wfSave.existing = []; }
    }
    async function saveEmbeddedWf() {
      const name = (wfSave.name || '').trim();
      if (!name || !meta.embeddedWf || wfSave.busy) return;
      if (wfNameTaken.value) { wfSave.msg = '"' + wfFileName(name) + '" already exists — pick another name.'; return; }
      wfSave.busy = true; wfSave.msg = '';
      try {
        const r = await jpost('/api/workflows/save', { name, workflow: meta.embeddedWf, enable: true });
        if (!r.ok) throw new Error(r.error || 'Save failed');
        workflows.value = await api.workflows();
        // This image's graph now IS that saved workflow, so record the match:
        // it keeps the field values coming from the image rather than from the
        // metadata heuristics (see the Inherit note in loadFields).
        meta.matchedWf = r.name;
        wfSave.open = false;
        wf.value = r.name;                       // switches the dropdown (reloads fields)
        saveMsg.value = 'Exported "' + r.name + '"';
        setTimeout(() => { saveMsg.value = ''; }, 2500);
      } catch (e) { wfSave.msg = String(e.message || e); }
      wfSave.busy = false;
    }

    async function init() {
      startedId.value = null; cfg.loading = true;
      progStart('Reading image metadata…', 8);
      const e = await loadMeta();
      progStart('Matching saved workflows…', 20);
      await loadWorkflows(e);
      await loadFields();
    }
    onMounted(init);
    // Re-point at another file without the parent having to key the component.
    // The pre-SPA page keyed the dialog on the path so a new file remounted it;
    // keying still works, but if the parent doesn't, everything that belonged to
    // the previous file has to go — node edits especially, since they are applied
    // by node id at run and would silently follow you to an unrelated graph.
    watch(() => src.value.path, () => {
      for (const k of Object.keys(nodeEdits)) delete nodeEdits[k];
      nodeFilter.value = ''; wfSave.open = false;
      // Another file starts over, so the prompt on screen belongs to the file
      // being left — there is nothing here to carry forward and nothing to ask.
      pendingPromptAsk = null; promptChoice.open = false;
      init();
    });
    watch(wf, () => { startedId.value = null; if (skipNextFieldLoad) { skipNextFieldLoad = false; return; } loadFields(); });

    // The image field holding a multi-file pick, if any. Only one field can drive a
    // batch — fanning out over two of them would multiply into a job matrix nobody
    // asked for, so the first one wins and the others keep their single value.
    const batchField = computed(() => cfg.fields.find(f => f.enabled && f.kind === 'image_input' && Array.isArray(f.values) && f.values.length > 1) || null);
    const batchCount = computed(() => (batchField.value ? batchField.value.values.length : 0));
    function collectFieldValues() {
      const fv = {};
      for (const f of cfg.fields) { if (!f.enabled) continue; const t = ctype(f);
        if (f.kind === 'seed') { if (f._pin && String(f.value).trim() !== '') fv[f.id] = parseInt(f.value, 10); continue; }
        if (t === 'lora_rows') { fv[f.id] = (f.value || []).map(r => ({ slot: r.slot, on: r.on, strength: r.strength, lora: r.lora })); continue; }
        if (t === 'boolean') { fv[f.id] = !!f.value; continue; }
        if (f.value !== '' && f.value != null) fv[f.id] = f.value;
      }
      if (selectedPreset.value) fv.__preset = selectedPreset.value;
      return fv;
    }
    function remix() {
      if (!wf.value) return;
      const pf = cfg.fields.find(f => f.kind === 'prompt' && f.enabled && !f.variant);
      const loras = cfg.fields.filter(f => f.kind === 'lora_list' && f.enabled).flatMap(f => (f.value || [])).filter(l => l.on).map(l => ({ slot: l.slot, on: l.on, strength: l.strength }));
      const seedPinned = cfg.fields.some(f => f.enabled && f.kind === 'seed' && f._pin && String(f.value).trim() !== '');
      const inherit = wf.value === '__inherit__';
      const label = inherit ? 'Inherit' : wf.value.replace(/^APP /, '').replace(/\.json$/, '');
      // Image fields set to a Media path (via the picker) need uploading at run.
      const mediaFields = cfg.fields.filter(f => f.enabled && f.kind === 'image_input' && f.value && /[\\/]/.test(String(f.value))).map(f => ({ id: f.id, value: f.value, type: 'image' }));
      const edits = Object.keys(nodeEdits).length ? JSON.parse(JSON.stringify(nodeEdits)) : null;
      // Match Input Image. WorkflowFields decides whether the tick applies at
      // all (a width/height pair plus at least one image input) and leaves the
      // two field ids on cfg; this only names the file each job measures.
      // mediaFields is already exactly "image fields pointed at a library path",
      // which is also the only kind that can be fetched to be measured — an
      // image field holding a bare ComfyUI input name is not one of them, and
      // leaving `from` empty falls the engine back to the source media, the file
      // it uploads and wires into MAIN IMAGE anyway.
      const matchSizeFor = from => (cfg.matchSize && cfg.matchInput
        ? { width: cfg.matchSize.width, height: cfg.matchSize.height, from: from || '' }
        : null);
      const runs = parseInt(runCount.value, 10) || 1;
      const s = src.value;
      // Several enabled rules for one keyword are alternatives, so the run fans
      // out over them: one job per combination, and with a multi-file pick as
      // well, one per file per combination. Naming each job by the choices it
      // carries is what makes a screen of them tell you anything.
      // Judged against the text this form is actually going to send: rules for a
      // keyword the prompt does not contain are not alternatives, they are N ways
      // of producing the same prompt.
      // Unticked tabs are left out here rather than filtered later: they are not
      // jobs that were queued and cancelled, they are jobs that were never asked
      // for.
      const replText = replaceableText(cfg.fields);
      const variations = keptVariations(replText);
      // Only the keywords with something to choose between get named: a label
      // repeating every rule in the list would be the same on every job.
      const multi = new Set(replacementGroups(replText).filter(g => g.live && g.rules.length > 1).map(g => g.key));
      const labelFor = (v, n) => (variations.length < 2 ? '' :
        '#' + (n + 1) + '/' + variations.length + ' · ' + v
          .filter(r => multi.has(String(r.from).trim().toLowerCase()))
          .map(r => r.from + ' → ' + String(replacementText(r)).replace(/\s+/g, ' ').trim().slice(0, 28))
          .join(' · '));
      const base = { workflowFile: wf.value, workflowLabel: label, embeddedWf: inherit ? meta.embeddedWf : null, source: { path: s.path, name: s.name, type: s.type }, promptText: pf ? applyReplacements(pf.value) : '', loras: loras.length ? loras : null, preset: selectedPreset.value, seedPinned, nodeEdits: edits, runs, matchSize: matchSizeFor(mediaFields[0] && mediaFields[0].value) };
      // The prompt the job record shows is the one that job actually sends, so
      // it is built per variation rather than once from the whole rule list.
      const launch = (extra, v, n) => launchJob(Object.assign({}, base, extra, {
        replacementRules: v,
        variationLabel: labelFor(v, n),
        promptText: pf ? applyReplacements(pf.value, v) : '',
      }));
      // A multi-file pick fans out: one job per file, each doing `runs` runs. The
      // source stays the media this dialog was opened from (it's what the graph is
      // built around); displaySource only re-points the job's row/thumbnail at the
      // file that job actually feeds in, so a batch isn't N identical-looking rows.
      if (batchField.value) {
        const bf = batchField.value;
        let firstId = null;
        for (const file of bf.values) {
          const fv = Object.assign({}, collectFieldValues(), { [bf.id]: file });
          const mf = mediaFields.filter(m => m.id !== bf.id).concat([{ id: bf.id, value: file, type: 'image' }]);
          variations.forEach((v, n) => {
            const id = launch({
              fieldValues: fv, mediaFields: mf, matchSize: matchSizeFor(file),
              displaySource: { path: file, name: String(file).split(/[\\/]/).pop() },
            }, v, n);
            if (!firstId) firstId = id;
          });
        }
        startedId.value = firstId;
        return;
      }
      let firstId = null;
      variations.forEach((v, n) => {
        const id = launch({ fieldValues: collectFieldValues(), mediaFields }, v, n);
        if (!firstId) firstId = id;
      });
      startedId.value = firstId;
    }
    function close() { emit('close'); }
    // An output is a media file like any other, so its tile does what a tile in
    // the browser does: the thumbnail opens the viewer, the info bar reopens
    // Remix on it. Both leave this dialog first — the viewer is a route and
    // would come up underneath, and a second Remix has to be the shell's copy
    // (keyed on path) rather than one dialog stacked on another.
    const router = useRouter();
    // A computed, not a call per render: every tile would otherwise get a freshly
    // built prop object each time the dialog redraws, which during a run is every
    // progress tick.
    const resultTiles = computed(() => outputItems(job.value));
    // Opened from this grid, the viewer's neighbours are the rest of this job —
    // not the thousand older files in the folder they were written to, which is
    // what it used to list and page through. The job travels in the URL, so the
    // arrows keep the scope and a run still landing simply lights the next one up.
    async function openResultFile(t) {
      if (!store.roots.out && !store.roots.fav) { try { store.roots = await api.roots(); } catch (e) {} }
      const to = viewTo(t.path, store.roots, job.value ? { job: job.value.id } : null);
      if (!to) { showToast('That output is outside the media roots — open it from its folder instead'); return; }
      emit('close');
      router.push(to);
    }
    function remixResult(t) {
      emit('close');
      store.ui.remix = t;
    }

    // Waiting cells: one per run still owed, but only while the job is live.
    // A job that ends short (cancelled, or 'lost' with fewer outputs than runs)
    // must not sit there spinning for images that are never coming.
    const pendingSlots = computed(() => {
      const j = job.value;
      if (!j || j.status !== 'running') return 0;
      return Math.max(0, (j.runs || 1) - j.results.length);
    });
    // Esc answers the topmost thing on screen. With the prompt choice up that
    // is the choice, and dismissing it keeps the prompt the form already shows
    // — closing the whole dialog instead would throw away the switch as well.
    const onKey = e => {
      if (e.key !== 'Escape') return;
      if (promptChoice.open) { resolvePromptChoice(false); return; }
      close();
    };
    onMounted(() => { window.addEventListener('keydown', onKey); document.body.classList.add('rmx-noscroll'); });
    onUnmounted(() => { window.removeEventListener('keydown', onKey); document.body.classList.remove('rmx-noscroll'); });

    // Log actions (parity with the classic inspect page).
    const jobLogText = j => (j._log || []).map(l => l.m).join('\n');
    async function saveLog() {
      const j = job.value; if (!j) return;
      saveMsg.value = 'Saving…';
      try {
        const r = await fetch('/api/debug-results', {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ timestamp: new Date().toISOString(), host: location.host, page: location.href, workflow: j.workflowFile, status: j._node || j.status, log: jobLogText(j), promptId: j.promptIds[0] }, null, 2),
        });
        saveMsg.value = r.ok ? 'Saved!' : ('Error ' + r.status);
      } catch (e) { saveMsg.value = e.message; }
      setTimeout(() => { saveMsg.value = ''; }, 2000);
    }

    // Read-only node inspector for the source media's embedded workflow.
    // Danger-zone node edits: nodeId -> {key: value}. Applied to the built prompt
    // at run by matching node id + key (see launchJob).
    const nodeEdits = reactive({});
    const editVal = (id, k, orig) => (nodeEdits[id] && k in nodeEdits[id]) ? nodeEdits[id][k] : orig;
    function setEdit(id, k, orig, val) {
      let v = val;
      if (typeof orig === 'number') { const num = Number(val); if (!Number.isNaN(num) && String(val).trim() !== '') v = Number.isInteger(orig) ? Math.round(num) : num; }
      if (String(v) === String(orig)) { if (nodeEdits[id]) { delete nodeEdits[id][k]; if (!Object.keys(nodeEdits[id]).length) delete nodeEdits[id]; } return; }
      if (!nodeEdits[id]) nodeEdits[id] = {};
      nodeEdits[id][k] = v;
    }
    // Prompt Replacements UI (state + helpers are module-level singletons).

    const nodeEntries = computed(() => meta.embedded ? Object.entries(meta.embedded) : []);
    const filteredNodes = computed(() => {
      const q = nodeFilter.value.trim().toLowerCase();
      const arr = nodeEntries.value.slice().sort((a, b) => { const at = ((a[1]._meta && a[1]._meta.title) || '').toUpperCase().startsWith('MAIN') ? 0 : 1; const bt = ((b[1]._meta && b[1]._meta.title) || '').toUpperCase().startsWith('MAIN') ? 0 : 1; return at - bt || (parseInt(a[0]) - parseInt(b[0])); });
      return q ? arr.filter(([id, n]) => (id + ' ' + (n.class_type || '') + ' ' + ((n._meta && n._meta.title) || '')).toLowerCase().includes(q)) : arr;
    });
    const nodeInputs = n => Object.entries(n.inputs || {}).map(([k, v]) => {
      if (Array.isArray(v)) return [k, { editable: false, disp: '← [' + v[0] + ']' }];
      const editable = typeof v === 'string' || typeof v === 'number';
      return [k, { editable, raw: v, num: typeof v === 'number', disp: typeof v === 'string' ? v : JSON.stringify(v) }];
    });


    // ── Workflow library: enable any workflow already in the ComfyUI folder ──
    // The Inherit → save flow only covers graphs embedded in a media file; this is
    // the equivalent for the install's own workflow files (the old /inspect page's
    // ⚙ manager, which the SPA conversion left behind).
    const wfLib = reactive({ open: false, busy: false, msg: '', q: '', items: [] });
    async function openWfLib() {
      wfLib.open = true; wfLib.msg = ''; wfLib.busy = true; wfLib.q = '';
      try {
        const all = await api.workflowsAll();
        // Keep the server's label, but remember it so we only send back real edits.
        wfLib.items = all.map(w => ({ name: w.name, label: w.label || '', enabled: !!w.enabled, mapping: w.mapping || null, _label0: w.label || '', _on0: !!w.enabled }));
      } catch (e) { wfLib.msg = 'Could not list workflows: ' + e.message; wfLib.items = []; }
      wfLib.busy = false;
    }
    const wfLibShown = computed(() => {
      const q = wfLib.q.trim().toLowerCase();
      const list = q ? wfLib.items.filter(w => (w.name + ' ' + w.label).toLowerCase().includes(q)) : wfLib.items.slice();
      // Enabled first so the current selection is always visible, then by label.
      return list.sort((a, b) => (b.enabled - a.enabled) || a.label.toLowerCase().localeCompare(b.label.toLowerCase()));
    });
    const wfLibCount = computed(() => wfLib.items.filter(w => w.enabled).length);
    // Two enabled workflows can share a default label ("APP VIDEO CLIP SFW" and
    // "APP VIDEO CLIP" both reduce to "VIDEO CLIP") — flag it, the dropdown would
    // otherwise show two identical entries.
    const wfLibDupes = computed(() => {
      const seen = {}, dupes = new Set();
      for (const w of wfLib.items) {
        if (!w.enabled) continue;
        const k = (w.label || w.name).trim().toLowerCase();
        if (seen[k]) dupes.add(k); else seen[k] = 1;
      }
      return dupes;
    });
    async function saveWfLib() {
      if (wfLib.busy) return;
      wfLib.busy = true; wfLib.msg = '';
      // /api/workflows/manage replaces the whole store, so send every enabled name
      // and every label/mapping we know about — not just the rows just touched.
      const payload = { enabled: [], labels: {}, mappings: {} };
      for (const w of wfLib.items) {
        if (w.enabled) payload.enabled.push(w.name);
        const lbl = (w.label || '').trim();
        if (lbl && lbl !== w.name) payload.labels[w.name] = lbl;
        if (w.mapping && Object.keys(w.mapping).length) payload.mappings[w.name] = w.mapping;
      }
      try {
        const r = await jpost('/api/workflows/manage', payload);
        if (r.error) throw new Error(r.error);
        workflows.value = await api.workflows();
        // A workflow that just got switched off can't stay selected.
        if (wf.value && wf.value !== '__inherit__' && !workflows.value.some(w => w.name === wf.value)) {
          wf.value = workflows.value.length ? workflows.value[0].name : '';
        }
        wfLib.open = false;
      } catch (e) { wfLib.msg = 'Save failed: ' + e.message; }
      wfLib.busy = false;
    }

    // Every text field this run will rewrite. The rules panel is judged against
    // the same string, or its tabs are not the jobs the button queues.
    const replScope = computed(() => replaceableText(cfg.fields));
    // How many prompts this run fans out to, for the counts beside the button.
    // The statement of it lives in the replacement panel's own summary now — it
    // is one line there, on the control that decides it, where a red block here
    // was repeating what the tabs directly below it already show.
    //
    // Counted the way remix() fans out: the ticked combinations, judged against
    // the text this form holds now. A count built from the rule list alone said
    // ×6 for a workflow whose prompt mentions none of the keywords, and the run
    // agreed with it: six identical jobs.
    const runVariations = computed(() => keptVariations(replScope.value).length);
    // The other half of the same question — rules that are set and cannot fire
    // — is stated by the replacements panel itself, as "N ignored" beside the
    // count of the ones that can. It was a paragraph here, above the Remix
    // button, which put it on the Run tab of one host while the panel on the
    // line below carried on counting those same rules as active. One number
    // beside the number it corrects beats two lines disagreeing.

    // The prompt the rules will rewrite, for the editor to preview.
    const promptFieldText = computed(() => {
      const f = (cfg.fields || []).find(x => x.kind === 'prompt' && x.enabled && !x.variant);
      return f && f.value != null ? String(f.value) : '';
    });
    return { promptFieldText, replScope, promptChoice, pickWorkflow, resolvePromptChoice, runVariations,
      store, src, tab, runCount, batchCount, workflows, wf, wfGroups, cfg, selectedPreset, scSaving, scSaved, canShortcut, shortcutHint, saveShortcut, deleteShortcut, isShortcut, currentWfLabel, currentWfShort,
      canUpdateWf, wfUpdating, wfUpdated, updateWorkflow, meta, job, isVideo, mediaUrl, toolsMenu, toolItem, remix, cancelJob, close, saveMsg, nodeFilter, saveLog, filteredNodes, nodeInputs,
      nodeEdits, editVal, setEdit,
      resultTiles, openResultFile, remixResult, pendingSlots, prog, wfSave, wfNameTaken, openWfSave, saveEmbeddedWf,
      wfLib, wfLibShown, wfLibCount, wfLibDupes, openWfLib, saveWfLib, addUnlistedWf, fileUrl };
  },
  template: `
    <div class="rmx-overlay" data-backdrop @click.self="close">
      <div class="rmx-dialog">
        <!-- Two rows: the filename shared row 1 with three tabs and a close
             button, which on a phone left it ellipsised down to a few
             characters. It gets its own line, where the full width is available. -->
        <div class="rmx-head rmx-head-stack">
          <div class="rmx-head-row">
            <b class="rmx-title">Remix</b>
            <div class="rmx-tabs">
              <button :class="{on: tab==='workflow'}" @click="tab='workflow'">Workflow</button>
              <button :class="{on: tab==='run'}" @click="tab='run'">Run</button>
              <button :class="{on: tab==='preview'}" @click="tab='preview'">Preview</button>
            </div>
            <button class="rmx-x" @click="close" title="Close (Esc)">✕</button>
          </div>
          <div class="rmx-head-file" :title="src.name">{{ src.name }}</div>
        </div>
        <div class="rmx-body">
          <div class="rmx-preview" v-show="tab==='preview'">
            <div v-if="toolsMenu" class="rmx-tools"><component :is="toolsMenu" :item="toolItem"></component></div>
            <div class="rmx-media"><video v-if="isVideo" :src="mediaUrl" controls loop muted></video><img v-else :src="mediaUrl"></div>
          </div>
          <div class="rmx-form" v-show="tab==='workflow'">
            <div class="rmx-run" style="margin-bottom:8px">
              <label class="rmx-lbl" style="margin:0;flex:none">Workflow</label>
              <select class="rmx-inp" :value="wf" @change="pickWorkflow($event.target.value)" style="flex:1;min-width:0" title="Workflow"><option v-if="meta.embeddedWf" value="__inherit__">⤷ Inherit (this image)</option><template v-for="g in wfGroups" :key="g.key"><option v-if="g.self" :value="g.self.name">{{ g.self.label }}</option><optgroup v-if="g.kids.length" :label="g.key"><option v-for="w in g.kids" :key="w.name" :value="w.name">{{ w.short }}</option></optgroup></template></select>
            </div>
            <!-- Own row, and every one of them says what it does. As bare icons
                 these read alike while acting on three different things: which
                 workflows are listed, the field values on screen, and the graph
                 embedded in this file. Two of them were both a disk. -->
            <div class="rmx-run rmx-wf-acts" style="margin-bottom:12px">
              <!-- Adding is the reason people come here, so the label leads with
                   it; the panel also removes and renames, which the tooltip
                   covers. Named for the library it opens so the button and the
                   panel heading line up. -->
              <button class="rmx-btn2" @click="openWfLib" title="Choose which of your ComfyUI workflows appear in the list above, and what they are called">📚 Add to Workflow Library</button>
              <!-- Hidden rather than disabled: the states it was greyed out for
                   (no workflow picked, fields still loading, Inherit selected)
                   are all "not applicable yet" rather than "blocked", and a
                   greyed button in a row of live ones only invites a click that
                   does nothing. -->
              <button v-if="canShortcut" class="rmx-btn2" :disabled="scSaving" @click="saveShortcut" :title="shortcutHint">{{ scSaving ? 'Saving…' : (scSaved ? '✓ Saved' : (isShortcut(wf) ? '💾 Update workflow shortcut' : '💾 Save as workflow shortcut')) }}</button>
              <!-- Overwrites the workflow's own .json in ComfyUI with what is on
                   screen. Distinct from the shortcut buttons, which keep the
                   file untouched and store the values beside it. -->
              <button v-if="canUpdateWf" class="rmx-btn2" :disabled="wfUpdating" @click="updateWorkflow"
                      :title="'Overwrite ' + currentWfLabel + ' in your ComfyUI folder with the fields on screen'">{{ wfUpdating ? 'Updating…' : (wfUpdated ? '✓ Updated' : '✏️ Update workflow') }}</button>
              <button v-if="isShortcut(wf)" class="rmx-btn2 rmx-del-sc" @click="deleteShortcut" :title="'Delete the shortcut ' + currentWfLabel">🗑 Delete {{ currentWfShort }}</button>
              <!-- "Export", not "Save": this one leaves the app. It writes the
                   graph embedded in this file out to your ComfyUI workflows
                   folder as a new .json. The neighbouring button also said Save
                   while doing something entirely different. -->
              <button v-if="wf==='__inherit__' && meta.embeddedWf && !wfSave.open" class="rmx-btn2" @click="openWfSave" title="Write this image's embedded workflow out to your ComfyUI workflows folder, so any image can select it">💾 Export workflow to ComfyUI</button>
            </div>
            <div v-if="meta.undetected" class="rmx-warn">⚠ No workflow metadata in this file — the selection above is only the first workflow in your list, not what generated this. Pick the right one.</div>
            <div v-else-if="meta.unlistedWf" class="rmx-warn">This was made with <b>{{ meta.unlistedWf.label }}</b>, which isn't in your dropdown — running ⤷ Inherit until you add it. <button class="rmx-btn2" style="margin-left:6px" :disabled="meta.adding" @click="addUnlistedWf">{{ meta.adding ? 'Adding…' : 'Add it' }}</button></div>
            <div v-else-if="meta.metadataFrom" class="rmx-mut" style="margin:-6px 0 12px;font-size:11.5px">Workflow read from the companion still <b>{{ meta.metadataFrom }}</b> — the clip itself carries no metadata.</div>
            <div v-if="wfSave.open" class="rmx-run" style="margin:-6px 0 12px">
              <input class="rmx-inp" :class="{taken: wfNameTaken}" style="flex:1;min-width:0" v-model="wfSave.name" placeholder="Workflow name" spellcheck="false" @keyup.enter="saveEmbeddedWf" @keyup.esc="wfSave.open=false">
              <button class="rmx-btn2" :disabled="wfSave.busy || !wfSave.name.trim() || wfNameTaken" @click="saveEmbeddedWf">{{ wfSave.busy ? 'Exporting…' : 'Export' }}</button>
              <button class="rmx-btn2" @click="wfSave.open=false">Cancel</button>
            </div>
            <div v-if="wfSave.open && wfNameTaken" class="rmx-mut" style="margin:-6px 0 10px;font-size:12px;color:#e06c6c">⚠ "{{ wfSave.name.trim() }}" already exists — pick another name.</div>
            <div v-else-if="wfSave.msg" class="rmx-mut" style="margin:-6px 0 10px;font-size:12px">⚠ {{ wfSave.msg }}</div>
            <div v-if="saveMsg && !job" class="rmx-mut" style="margin:-6px 0 10px;font-size:12px">✓ {{ saveMsg }}</div>
            <div v-if="cfg.loading" class="rmx-prog">
              <div class="rmx-prog-top">
                <span>{{ prog.label || 'Loading fields…' }}</span>
                <span class="rmx-prog-sub">{{ prog.detail }}<template v-if="!prog.ownClock"><template v-if="prog.detail"> · </template>{{ prog.secs }}s</template></span>
              </div>
              <div class="rmx-prog-bar" :class="{indet: !prog.exact}"><div class="rmx-prog-fill" :style="{width: prog.pct + '%'}"></div></div>
            </div>
            <div v-else-if="cfg.error" class="rmx-mut">Couldn’t load fields: {{ cfg.error }}</div>
            <div v-else>
              <!-- The form has no slot to fill any more. The replacement rules
                   sit at the foot of the Run tab, here and on the inspect page
                   both — that page kept them above the prompt long after it
                   grew a Run tab of its own, which is exactly the drift this
                   shared component exists to prevent. -->
              <workflow-fields :cfg="cfg" :preset="selectedPreset" @update:preset="selectedPreset = $event"></workflow-fields>
            </div>
            <details class="rmx-hidden" v-if="meta.embedded" style="margin-top:12px">
              <summary>Source workflow · {{ Object.keys(meta.embedded).length }} nodes</summary>
              <div style="padding:6px 12px 12px">
                <input class="rmx-inp" style="width:100%;margin-bottom:8px" placeholder="Filter nodes…" v-model="nodeFilter">
                <div class="rmx-mut" style="font-size:11px;margin-bottom:6px">Edit a value to override it on the next run (applied when the node is in the built graph). ⚠ can break the workflow.</div>
                <details v-for="[id,n] in filteredNodes" :key="id" class="rmx-node" :class="{edited: nodeEdits[id]}">
                  <summary>[{{id}}] {{ n.class_type }}<span v-if="n._meta&&n._meta.title" class="rmx-mut"> · {{ n._meta.title }}</span></summary>
                  <div class="rmx-node-body"><div v-for="[k,v] in nodeInputs(n)" :key="k" class="rmx-node-inp">
                    <span class="rmx-node-k">{{k}}</span>
                    <input v-if="v.editable" class="rmx-inp rmx-node-edit" :class="{edited: nodeEdits[id] && k in nodeEdits[id]}" :type="v.num ? 'number' : 'text'" :step="v.num ? 'any' : null" :value="editVal(id,k,v.raw)" @change="setEdit(id,k,v.raw,$event.target.value)" :title="'node '+id+' · '+k">
                    <span v-else class="rmx-node-v">{{ v.disp }}</span>
                  </div></div>
                </details>
                <details class="rmx-node"><summary>Raw prompt JSON</summary><pre class="rmx-raw">{{ JSON.stringify(meta.embedded, null, 2) }}</pre></details>
                <details v-if="meta.embeddedWf" class="rmx-node"><summary>Raw workflow JSON</summary><pre class="rmx-raw">{{ JSON.stringify(meta.embeddedWf, null, 2) }}</pre></details>
              </div>
            </details>
          </div>
          <!-- Run tab: run count, remix, status, log, output thumbnails, and the
               replacement rules under all of it -->
          <div class="rmx-runsec" v-show="tab==='run'">
            <div class="rmx-run">
              <select class="rmx-inp" v-model="runCount" style="width:70px" title="Number of runs"><option value="1">1×</option><option value="2">2×</option><option value="3">3×</option><option value="5">5×</option><option value="10">10×</option><option value="20">20×</option></select>
              <button v-if="!job || job.status!=='running'" class="rmx-btn go" @click="remix" :disabled="!wf">▶ Remix</button>
              <button v-else class="rmx-btn cancel" @click="cancelJob(job)">■ Cancel</button>
              <span v-if="batchCount" class="rmx-mut" style="font-size:12px" :title="batchCount + ' selected files × ' + runCount + ' runs'">{{ batchCount }} files → {{ batchCount * runVariations }} jobs, {{ batchCount * runVariations * (parseInt(runCount,10)||1) }} runs total</span>
              <span class="rmx-status" v-if="job">{{ job.status==='running' ? (job._node||'…') : (job._node || job.status) }}</span>
              <span class="rmx-status" v-else>close this anytime — runs keep going in Jobs</span>
            </div>
            <div v-if="job && (job.status==='running' || job._pct>0)" class="rmx-jobbar"><div class="rmx-jobbar-fill" :class="{wait: job.status==='running' && !!job._queued}" :style="(job.status==='running' && job._queued) ? null : {width: job._pct + '%'}"></div></div>
            <div v-if="job && job._log.length" class="rmx-log"><div v-for="(l,i) in job._log" :key="i" :class="'ll-'+l.cls">{{ l.m }}</div></div>
            <div v-if="job && job._log.length" style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">
              <button class="rmx-btn2" @click="saveLog">{{ saveMsg || '💾 Save log' }}</button>
            </div>
            <!-- The grid appears as soon as the job starts, one waiting cell per
                 queued run, and each becomes a thumbnail as that run lands. The
                 whole point is that a 3x job shows three slots immediately
                 rather than an empty space until the last one finishes. -->
            <div v-if="job && (job.results.length || pendingSlots > 0)" class="rmx-outgrid" :class="{ 'blur-on': store.blurOn }">
              <MediaTile v-for="t in resultTiles" :key="t.path" :item="t"
                         @open="openResultFile(t)" @remix="remixResult(t)" />
              <div v-for="n in pendingSlots" :key="'wait'+n" class="rmx-out rmx-out-wait" :title="'Run ' + (job.results.length + n) + ' of ' + (job.runs || 1)"><span class="spinner"></span></div>
            </div>
            <!-- Last, under everything the tab has to show. It is folded shut,
                 and its summary states what the button above is about to queue —
                 which is the line worth having in reach, not the twelve tabs
                 behind it. Above the button it pushed the button itself down the
                 page; below the outputs it is where you go when the count on the
                 summary is not the one you wanted. -->
            <replacement-rules :prompt="promptFieldText" :scope="replScope"></replacement-rules>
          </div>
        </div>
      </div>
    </div>
    </div>
    <div v-if="promptChoice.open" class="rmx-picker-overlay" data-backdrop @click.self="resolvePromptChoice(false)">
      <div class="rmx-picker rmx-pchoice">
        <div class="rmx-picker-head"><b>Which prompt?</b><span class="rmx-mut" style="text-transform:none">{{ currentWfLabel || 'This workflow' }} brought a prompt of its own</span></div>
        <div class="rmx-pchoice-body">
          <button type="button" class="rmx-pchoice-opt" @click="resolvePromptChoice(true)">
            <span class="rmx-pchoice-t">Current Prompt<span>keep what you had on screen</span></span>
            <span class="rmx-pchoice-p" :class="{empty: !promptChoice.current.trim()}">{{ promptChoice.current.trim() || '— empty —' }}</span>
          </button>
          <button type="button" class="rmx-pchoice-opt" @click="resolvePromptChoice(false)">
            <span class="rmx-pchoice-t">New Prompt<span>use the one this workflow carries</span></span>
            <span class="rmx-pchoice-p" :class="{empty: !promptChoice.next.trim()}">{{ promptChoice.next.trim() || '— empty —' }}</span>
          </button>
        </div>
        <div class="rmx-picker-head" style="border-top:1px solid #2c2c2e;border-bottom:none">
          <span class="rmx-mut" style="text-transform:none">Esc, or clicking away, keeps the new one — it is already in the box.</span>
        </div>
      </div>
    </div>
    <div v-if="wfLib.open" class="rmx-picker-overlay" data-backdrop @click.self="wfLib.open=false">
      <div class="rmx-picker" style="max-width:720px">
        <div class="rmx-picker-head"><b>Workflow library</b><span class="rmx-mut" style="text-transform:none">{{ wfLibCount }} of {{ wfLib.items.length }} in the dropdown</span><button class="rmx-x" style="margin-left:auto" @click="wfLib.open=false">✕</button></div>
        <div class="mb-toolbar"><input class="rmx-inp mb-search" v-model="wfLib.q" placeholder="Search workflows…"></div>
        <div style="overflow:auto;flex:1;min-height:0;padding:8px 12px">
          <div v-if="wfLib.busy && !wfLib.items.length" class="rmx-mut" style="padding:16px">Loading…</div>
          <div v-else-if="!wfLibShown.length" class="rmx-mut" style="padding:16px">No workflows match.</div>
          <div v-for="w in wfLibShown" :key="w.name" class="rmx-lib-row">
            <input type="checkbox" class="rmx-tgl" v-model="w.enabled" :title="w.enabled ? 'Remove from the dropdown' : 'Add to the dropdown'">
            <input class="rmx-inp" v-model="w.label" placeholder="label" title="Shown in the Workflow dropdown">
            <span class="rmx-mut rmx-lib-name" :title="w.name">{{ w.name }}</span>
            <span v-if="w.enabled && wfLibDupes.has((w.label||w.name).trim().toLowerCase())" class="rmx-lib-warn"
                  title="Another enabled workflow uses this same label — rename one so you can tell them apart">⚠</span>
          </div>
        </div>
        <div class="rmx-picker-head" style="border-top:1px solid #2c2c2e;border-bottom:none">
          <span v-if="wfLib.msg" style="color:#ff9d9d;text-transform:none">{{ wfLib.msg }}</span>
          <span v-else class="rmx-mut" style="text-transform:none">Tick a workflow to add it to the Workflow dropdown.</span>
          <button class="rmx-btn2" style="margin-left:auto" @click="wfLib.open=false">Cancel</button>
          <button class="rmx-btn2" :disabled="wfLib.busy" @click="saveWfLib">{{ wfLib.busy ? 'Saving…' : 'Save' }}</button>
        </div>
      </div>
    </div>
  `,
};
