# Project-specific review checklist

Signals that recur in this codebase. Subagents read this when running `/code-review`.

Line numbers are omitted on purpose — `server.js` and `index.html` shift constantly. Find the symbol, don't trust a remembered line.

---

## Server (`server.js`, Node builtins only)

### Path safety
- **Every endpoint that accepts a path must resolve it and prove containment** before reading, writing, moving, or deleting. The established idiom:

  ```js
  const n = s => String(s).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const abs = path.resolve(userSupplied);
  if (!n(abs).startsWith(n(ROOT)) && !n(abs).startsWith(n(COMFY_OUTPUT))) { jsonRes(res, { error: 'Access denied' }, 403); return; }
  ```

  Compare any new handler against `/api/dirs`, `/api/move`, and `/api/mkdir`; the workflow-dir equivalent is the `path.resolve(wfPath).startsWith(path.resolve(WORKFLOWS_DIR))` check in `/api/workflow-field-config` and `/api/workflow-nodes`. A path-taking endpoint with no containment check is **Critical**.
- **Known gaps — do not treat these as reference implementations.** `/api/delete` unlinks the caller's `filePath` outright, and `/api/favorite` moves it, with **no containment check on either**. They predate the pattern above. When a diff touches them, or adds an endpoint modelled on them, that's a finding in its own right rather than a precedent to follow.
- **Boundary-blind prefix checks.** `startsWith(root)` with no trailing separator also matches siblings: with a root of `C:/path/to/Media`, a path under `C:/path/to/Media2` passes. The safe form is `p === root || p.startsWith(root + '/')`. Flag new checks that copy the loose form, and note existing ones when the diff touches them.
- **Case sensitivity is inconsistent across the file.** Only the checks built on the local `n = s => …toLowerCase()` helper (`/api/dirs`, `/api/mkdir`, `/api/move`) normalize case; the `WORKFLOWS_DIR` checks and the `ROOT`/`COMFY_OUTPUT` check in `/api/image/embed-workflow` compare case-sensitively. On Windows that means the same path can pass one check and fail another. Don't assume a containment check is case-normalized — read it.
- **Destination collisions.** `/api/move` and `/api/merge-folders` pick a free stem (`name (2)`) before moving, so a same-named file never overwrites an existing one and a video keeps its sidecar thumbnail on the same stem. `/api/favorite` does **not** — it joins `path.basename()` onto the destination and calls `moveFile`, so favoriting two files that share a basename destroys the first. Any new move/rename endpoint that skips the collision-suffix step is **Critical** (silent data loss), not a nit.
- **Name validation** for anything that becomes a file or directory name: reject separators, `..`, leading dots, trailing dots/spaces, over-long names, and Windows device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`). `/api/mkdir` is the reference implementation — an allowlist regex, not a denylist.
- **Case-insensitive collision checks.** `fs.existsSync` is case-insensitive on Windows and case-sensitive elsewhere; where duplicate names matter, scan the directory and compare lowercased.

### Serving files
- **Static assets are an explicit allowlist** (`/common.css`, `/key-prompt.js`, `/ui-guards.js`, plus the `/vendor/` branch with its `^[a-z0-9._-]+\.js$` guard and resolve check). "Serve anything under `__dirname`" is a **Critical** finding.
- **A new static file is a two-part change**: the file itself *and* its allowlist entry. Missing the second half 404s in production while working in any test that read the file from disk. It also needs a server restart to take effect, unlike the HTML pages.
- Media is served through the `/file/` and `/thumb/` handlers with range support — new media paths should reuse them rather than opening streams inline.

### Secrets
- API keys (`anthropicApiKey`, `xaiApiKey`, `civitaiApiKey`) live in the gitignored `config.json`. The established outbound pattern is the `mask()` helper in `GET /api/settings`: `{ set: true, hint: '••••' + last4 }`. **Never** return a raw key, embed one in a served page, write one to `debug-results.json` or a log line, or forward one to an unrelated upstream.
- Keys are injected into child-process environments (the Claude CLI). Flag any change that puts them on a command line instead — argv is visible to other processes.
- The prompt sanitizer's term list is **base64-encoded in source on purpose** (CLAUDE.md, mirrored in `config.json`'s `nsfwTermsB64`). A diff that decodes it to plaintext is a finding.

### Child processes & upstreams
- Spawn points: the ComfyUI starter (`comfyStartCmd`), the Claude CLI, and `ffmpeg`/`ffprobe` (resolved to absolute paths by `findFfBin` because a service account has no user `PATH` — a bare `execFile('ffprobe', …)` fails silently and metadata comes back `null`).
- Flag user-controlled data interpolated into a shell string, `shell: true` where an argv array would do, and any new binary invoked by bare name rather than a resolved path.
- **Killing a spawned process does not kill its children on Windows** — there are no process groups, so `.kill()` reaches only the immediate child. The Claude CLI is spawned with Bash tool access and can have a tool call in flight when Stop is pressed, which orphans the grandchild. Flag any new spawn/kill pair that assumes `.kill()` is enough.
- The ComfyUI proxy must target the configured `COMFY_URL`. A caller-chosen upstream host or URL is a finding — and so is a caller-supplied value spliced into the upstream request line: the WS proxy concatenates `clientId` straight into the upstream path with no encoding or allowlist.

### Concurrency & the event loop
- One process serves the SPA, the REST API, SSE streams, and the ComfyUI WebSocket proxy. **Sync fs stalls all of it** — including an in-flight generation's progress stream. `readdirSync` / `statSync` / `readFileSync` / `existsSync` over the media tree is a real finding whether it sits in a request handler *or* in a background timer: `buildPromptIndex` runs on a 10-minute `setInterval` and walks both roots synchronously, and the event loop doesn't care which one blocked it.
- **The prompt index is only as fresh as that cycle.** New files are listable immediately (`/api/list` reads the directory live) but not prompt-searchable until the next rebuild or a manual `POST /api/prompt-index`. Destructive endpoints keep it in step via the `promptIndexMove` / `promptIndexRemove` hooks — flag a new path that creates, moves, or deletes media without calling them, and any UI that presents search results as current.
- `getObjectInfo()` caches ComfyUI's `/object_info` with a 10-minute TTL and serves the cached copy immediately while refreshing in the background. That upstream can take 10–30s to first byte, so it is *time to first byte*, not transfer, that hurts. Flag code that bypasses the cache, refetches per field, or blocks a response on a cold fetch without a timeout.
- Whole-file JSON stores (`app-workflows.json`, `app-prompt-index.json`, …) are read and rewritten wholesale. Flag a read-modify-write on a request path that can interleave with another request's write, and any per-request rewrite of a large index.

### Endpoint shape
- The idiom is: match `pn` + method → collect the body → `JSON.parse` inside `try` → validate → `jsonRes(res, payload)` or `jsonRes(res, { error }, 4xx)` → `return`. A new endpoint that invents its own response shape, forgets the `return` (falling through to later matches), or answers with plain text instead of JSON breaks clients that parse every response as JSON.
- **HTTPS is a boot-time clone, not a mirror.** The HTTPS listener is created from `server.listeners('request')[0]`, captured once at startup, and the cert/key are read once from `certs/` — they are not part of the hot-reloaded config. A second `server.on('request', …)` added later would serve HTTP only, and a rotated cert needs a restart. Flag changes that assume otherwise.
- Client-side, `moveApi()` in `index.html` treats a non-JSON 404 as "the server is out of date — restart it". That only works if handlers keep answering JSON.

---

## Front end (static HTML, Vue 3 global build, no build step)

### Reactivity
- **`S` (index.html, near the top of the main script) is a plain object, not reactive.** `gridState` and `modalState` are the `Vue.reactive` mirrors. A computed that reads `S` caches a stale value and never re-evaluates — it must read the mirror. This has bitten before; treat any new computed reading `S` as a real finding.
- Vue is the **global build**, and templates are runtime-compiled strings. No SFCs, no JSX, no build step. Template identifiers resolve against the component instance, so a template calling a module-scope helper is a bug — expose it through `setup()`/`methods` instead.
- Keep `v-for` keys stable; the media grid and job lists re-render on every page change.

### Dialogs
- A backdrop that closes on outside click **must carry `data-backdrop`** — `ui-guards.js` uses it to ignore a click whose press started elsewhere, which is what stops a drag-selection from closing the dialog. A new overlay with `@click.self="close"` and no `data-backdrop` reintroduces that bug.
- Escape/Enter handling is done with document-level capture listeners. A new dialog must not swallow keys belonging to an already-open one; when a nested prompt is open it should own Enter/Escape and `stopPropagation`.
- Reuse the existing sheet/overlay CSS families (`.confirm-overlay`, `.confirm-sheet`, `.tree-*`, `.rmx-*`) and the CSS variables (`--surface`, `--surface2`, `--text2`, `--accent`, `--r`, `--r-sm`, `--safe-b`). Inline styles or new one-off colors that duplicate a token are a Low finding; a new component family that forks an existing one is Medium.

### Silent UX failures
- A `fetch` whose rejection produces no toast, inline message, or error state — the user gets a button that just stops responding.
- A `busy` / `loading` / `saving` flag set but not cleared in a `finally`.
- A background job or SSE stream whose failure only reaches `console.error`.

### Lifecycle
- `addEventListener`, `setInterval`, `EventSource`, `WebSocket`, and `BroadcastChannel` created without a matching teardown. The SPA never reloads between views, so leaks accumulate for the life of the tab.

---

## Workflow / field-config subsystem

The most bug-prone area in the app, because it writes into someone else's graph format.

- **Field ids are the persistence key.** Saved user edits in `app-workflows.json` are keyed by field id (`width_124`, `image_main`, …). Changing how an id is generated silently orphans every saved edit for that workflow. Flag id-scheme changes and say what happens to existing saved state.
- **Saved edits are a snapshot and they rot.** They are merged over freshly detected fields, so a stale entry can disable a control the workflow now depends on, or enable one whose node has since been orphaned. The runtime repairs both cases (an unreachable field can't be enabled by a stale edit; width/height re-enable when the merge leaves none live) — flag changes that weaken those repairs.
- **Writing a widget only works when the widget is free.** A widget converted to an input takes its value from the link at run time, so writing `widgets_values` does nothing. Detection already skips linked widgets (`widgetFree` in the generator); the *apply* path has no such check today, so a field whose widget got linked after detection writes successfully and changes nothing. Requiring a warning there is a valid finding — don't cite it as existing behavior.
- **Unreachable nodes.** A field whose targets don't feed an output node does nothing at run time. Writing to one must produce a warning the run log surfaces, never a silent no-op.
- **`widgets_values` is positional.** Index-based writes depend on the node's widget order; verify the order against the actual workflow JSON or `/object_info`, never from memory.
- **Image→video workflows have no `EmptyLatentImage`** — the resize node's width/height decide the clip's aspect, and the sampler takes its dimensions from that node's outputs. Size findings must trace to whichever node actually feeds the sampler.
- Verify node types and widget names against the real workflow files under the configured `comfyDir` (`user/default/workflows`) or `/object_info`. Do not invent ComfyUI node names.

---

## Project constraints & deploy

- **Zero runtime dependencies.** `package.json` has no `dependencies` block. A new entry there, or a `require()` of a non-builtin, is **Critical**; the full forbidden-recommendation list lives in `.claude/agents/code-reviewer.md` — follow it there rather than a copy here.
- **`vendor/*.js` are pinned, minified third-party builds** (the Vue global build and Vue Router), served through the `/vendor/` allowlist branch. Never propose hand-editing one. The fix belongs in the calling code, or in a deliberate, called-out vendor swap.
- **Restart discipline.** `server.js` changes need a restart; the static pages are served from disk and need only a browser reload. Flag a change whose correctness depends on a restart that the author may not have done, and remember that a new static asset needs both an allowlist entry and a restart.
- **Config is hot-reloaded** from the ⚙ Settings panel. New config keys should be readable at request time rather than captured once at boot, unless there's a reason — and that reason belongs in a comment.
- **Docs discipline.** Machine-specific paths, scheduled-task names, and firewall rules belong in the gitignored `CLAUDE.local.md`. Absolute local paths, hostnames, or secrets landing in `CLAUDE.md`, `README.md`, or any committed doc are a finding.
- **The working tree often holds several unrelated in-flight features.** Don't assume a diff is one change; if it spans unrelated work, say so rather than reviewing it as a unit.

---

## Output reminders

- Every finding cites `file:line`, verified by actually reading that line.
- Every finding has a **Fix:** line — what to change, not just what's wrong.
- TL;DR is the most impactful items across all specialties, ordered by severity, then by blast radius.
- "Files referenced (consolidated)" goes at the bottom — one deduped list, split Server / Front-end / Docs.
