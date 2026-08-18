// ── Server API ─────────────────────────────────────────────────────────────
// Every fetch the app makes goes through here, so the auth gate's 401 has one
// place to be handled: when the password gate is on and a session expires, the
// honest response is to send the browser back for the lock screen rather than let
// views paint half-empty. Callers get plain data or a thrown Error.
const enc = encodeURIComponent;

async function req(path, opts = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...opts });
  if (res.status === 401) {
    // The gate closed under us — reload so the server can render the lock screen.
    location.reload();
    throw new Error('Locked');
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
  if (data && data.error) throw new Error(data.error);
  return data;
}

const post = (path, body) => req(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
});

export const api = {
  // Listing / navigation. The server's param is `dir` and it wants an absolute
  // path — anything else is silently ignored and you get the root back, which
  // looks like "the folder is empty of subfolders" rather than like an error.
  list: params => req('/api/list?' + new URLSearchParams(params).toString()),
  // The two media roots are reported by the listing endpoint itself; /api/dirs is
  // the folder-picker tree, not the roots.
  roots: async () => {
    const d = await req('/api/list?limit=1');
    return { fav: d.favoritesDir || d.root || '', out: d.comfyOutputDir || '' };
  },
  dirs: () => req('/api/dirs'),
  browseDirs: p => req('/api/browse-dirs?path=' + enc(p || '')),
  mkdir: (parent, name) => post('/api/mkdir', { parent, name }),
  move: (paths, target) => post('/api/move', { paths, target }),

  // Curation. The field names are the server's, verified against its handlers —
  // it destructures exactly these, and a wrong name is a 400 at best and a
  // silent no-op at worst, so don't "tidy" them into a common shape.
  favorite: filePath => post('/api/favorite', { filePath }),
  del: filePath => post('/api/delete', { filePath }),
  delFolder: dir => post('/api/delete-folder', { dir }),
  bulkDelete: paths => post('/api/bulk-delete', { paths }),
  mergeFolders: (sources, target) => post('/api/merge-folders', { sources, target }),
  mergeVideos: sources => post('/api/merge-videos', { sources }),
  lastFrame: source => post('/api/tools/last-frame', { source }),

  // Metadata / workflows
  metadata: path => req('/api/metadata?path=' + enc(path)),
  workflows: () => req('/api/workflows'),
  workflowsAll: () => req('/api/workflows/all'),
  // Replaces the whole library in one shot — send every enabled name and label,
  // not a delta, or the ones left out are removed.
  manageWorkflows: body => post('/api/workflows/manage', body),
  fieldConfig: name => req('/api/workflow-field-config?name=' + enc(name)),
  // For a graph with no file behind it — the workflow embedded in a media file.
  fieldConfigForGraph: workflow => post('/api/workflow-field-config', { workflow }),
  // REPLACES the whole edits map for that workflow — merge into the config's
  // own `savedEdits` before sending, or another page's edits go with it.
  saveFieldConfig: (name, edits) => post('/api/workflow-field-config', { name, edits }),
  // Writes the on-screen values back into the workflow's own .json in ComfyUI.
  updateWorkflow: (name, fieldValues) => post('/api/workflows/update', { name, fieldValues }),
  saveShortcut: body => post('/api/shortcuts', body),
  deleteShortcut: name => req('/api/shortcuts?id=' + enc(name), { method: 'DELETE' }),

  nsfwTerms: () => req('/api/nsfw-terms'),
  saveNsfwTerms: terms => post('/api/nsfw-terms', { terms }),

  // App state
  settings: () => req('/api/settings'),
  saveSettings: body => post('/api/settings', body),
  status: () => req('/api/status'),
  authStatus: () => req('/api/auth/status'),
  logout: () => post('/api/auth/logout'),
  recentOutputs: since => req('/api/recent-outputs' + (since ? '?since=' + enc(since) : '')),
  // The word directory honours safe mode server-side; omitting the flag lists
  // NSFW phrases even with safe mode on.
  promptWords: safe => req('/api/prompt-words' + (safe ? '?safe=1' : '')),
};

// Media URLs. Cache-busted by mtime so a regenerated file at the same path shows
// its new content instead of the browser's copy.
export const fileUrl = (path, mtime) => '/file/' + enc(path) + (mtime ? '?v=' + mtime : '');
export const thumbUrl = (path, mtime) => '/thumb/' + enc(path) + (mtime ? '?v=' + mtime : '');
