# ComfyRemix

A local, zero-dependency web app for browsing, curating, and remixing AI-generated media (images, video, audio) from ComfyUI and other tools. A single Node.js process serves the single-page front end plus a small REST/SSE API.

## Running

```bash
npm start                          # serve using config.json (HTTP 8080; HTTPS 8443 if certs/ present)
npm run restart                    # kill the running instance and restart (use after editing server.js)
node server.js 8081                # override the port
node server.js 8080 /path/to/media # override port and media root
```

- After editing **server.js**, restart the server (`npm run restart`) for changes to take effect.
- Everything under `app/`, plus `index.html`, `inspect.html` and the stylesheets, is served straight from disk; just reload the browser, no restart needed.

## Architecture

- **server.js** — Node.js HTTP server (no external dependencies). Serves the front end, exposes REST APIs for listing/favoriting/deleting media, and proxies ComfyUI (HTTP + WebSocket).
- **index.html** — a small shell only: the stylesheet/script tags and the mount point. The application lives in `app/`.
- **app/** — the SPA, as native ES modules with no build step. `router.js` (routes), `store.js` (shared reactive state), `views/` (one per route), `components/` (the chrome, the dialogs and the shared pieces below). Vue 3 is the global build, vendored under `vendor/`.
- **config.json** — Runtime config (ports, paths, API keys). Gitignored; create it by copying `config.example.json`.
- **Media/** — Default media root browsed by the app. Gitignored.

Static serving is an **explicit allowlist**, not a directory mount: a new asset at
the repo root is a 404 until it is named in server.js. `app/` and `vendor/` are
allowlisted by shape (`.js`/`.css`, one directory deep).

The tab icon is three files at that root — `favicon.svg` (the source, and what
anything modern uses), `favicon.ico` (16/32/48/64, for everything else and for
the bare `/favicon.ico` browsers request unprompted) and `apple-touch-icon.png`
(180px, square and opaque, since iOS masks its own corners onto it). The raster
pair is generated from the SVG, so edit the SVG and re-render rather than
touching them. The lock screen carries a fourth copy inlined as a data URI:
with the gate on the files are behind it, and a link would 401 into a blank
tab.

### Routes

`/` home · `/browse/:root/:path*` grid · `/view/:root/:path+` viewer ·
`/inspect` a file **or** a workflow · `/workflows` the library ·
`/prompts` the reusable text · `/jobs` the run list ·
`/settings` and `/settings/:tab` (config | privacy | security | clean).

`/inspect` takes either `?path=…` (a file) or `?wf=<name>` (a workflow with no
file behind it, opened from the Workflows page). With no file it drops the
Preview tab and the metadata half and locks the workflow dropdown — the URL says
which workflow it is, so changing it there would leave the two disagreeing.

Settings is **routed pages, not a modal** — each section is linkable and survives a
reload. `SettingsPanel.js` renders either shape: as a dialog it keeps the overlay
and tab strip, and with `page`/`only` props it drops both and renders one section.
**Clean** is the exception: it has nothing to save, so it is not a SettingsPanel section
under the shared Save button but its own `MaintenancePanel.js` behind the same routed
tile (see *Cleaning up* below).

### Shared components

The dialog and the inspect page are two hosts of the same parts, not two
implementations. Anything that behaves differently in one of them is a bug, and
usually the same bug: something the host provided instead of the component.

- **`components/WorkflowFields.js`** — the form a workflow declares, built from
  `/api/workflow-field-config`: the controls, the node grouping, the LoRA
  columns, the family filter, the preset dropdown, the hidden-field list. It
  owns the media picker and the LoRA library it needs (that is why an image
  field has 🖼 Browse wherever it is mounted), and it owns no state: `cfg.fields`
  are reactive objects the controls write straight into, and the host reads them
  back when it builds a run. The host contributes only its own extras, through
  the slot — the replacement rules, in both cases.
  It also owns **Match Input Image**: a workflow with a width/height pair *and*
  an image input is stating its frame size twice, so the tick appears under the
  size fields, starts on, and greys them out. The tick and the two field ids it
  governs go on `cfg` (`matchInput`, `matchSize`) rather than staying here,
  because the host is what has to read them at run — and a tick that worked in
  the dialog and did nothing on the inspect page is precisely the drift this
  component exists to prevent. It is re-armed per form, keyed on the fields
  array itself, so a workflow switch turns it back on but toggling a field
  inside the same form leaves it where it was put.
- **`components/MediaBrowser.js`** — the gallery a media field opens.
- **`components/MediaTile.js`** — one card: square thumbnail flush to the tile,
  info bar under it. The thumbnail opens the viewer, the bar raises Remix. Used
  by the browse grid and by the run outputs in both hosts, so a file you just
  generated opens exactly where any other file opens.

### Jobs

The run engine lives in **`components/RemixDialog.js`**, not in anything named
after jobs: it owns the reactive `jobs` store, IndexedDB persistence, the
leader-elected ComfyUI socket and the reconciler, and it runs because `AppShell`
imports it eagerly. **`views/JobsView.js` is a view only** and owns no state. The
progress hairline and the `⚡ N` badge live in `AppShell`, since a job outlives
both the dialog that started it and the route it started from.

The run list is **the `/jobs` route, not a dialog**. It was a dialog until
opening one of a job's outputs proved the difference: the viewer is a route, so
raising it tore the dialog down, and closing the viewer landed on whatever route
was underneath with the list gone and its scroll position with it. As a route
the trip is ordinary history — `/jobs` → `/view/…` → back — and the router's
`scrollBehavior` hands the saved position back. Which is also why the page lets
the *page* scroll (`app.css` unsets `.rmx-jobs`'s inner scroller): a position
inside a fixed-height box is one the router can neither save nor restore.

**Cancel has to reach the queueing loop, not just the queue.** A job's runs are
all submitted up front, so Cancel and `launchJob` are two writers to the same
ComfyUI queue: sweeping it while the loop is still filling it left the job
cancelled here and rendering there. `cancelJob` sets `_cancelled` first (the
loop checks it before each submit and sweeps once more when it stops), reads
`/queue` for what is actually running rather than trusting `execPid`, and then
*verifies* — a row that says "Cancelled" over a queue that is still working is
worse than an error. Deleting a running job cancels it first, for the same
reason: once the record is gone, nothing holds the prompt ids that could.

**Match Input Image is applied in `launchJob`, not in the caller.** A batch is N
jobs each holding its own file, so measuring once up front would size every run
to the first one; `launchJob` measures `matchSize.from` (the browser reads the
`/file` URL the tile already loaded) and overwrites the two size fields just
before the graph is built. A value with no path separator in it is a ComfyUI
input name rather than a library file, so it cannot be fetched to be measured —
that falls back to the source media, which is what the upload wires into MAIN
IMAGE anyway.

**Switching workflow asks which prompt survives.** Every workflow carries a
prompt, so picking another one replaces what is in the box — right when you
switched *for* that prompt, wrong when you had just written one. The dropdown
goes through `pickWorkflow` rather than `v-model` for exactly this: it is the
only assignment to `wf` that is a user changing their mind, where the other six
(opening a file, adding a recognised workflow, saving a shortcut, exporting a
graph, the library panel, deleting a shortcut) are the app moving the selection
itself. A **shortcut** never asks — its prompt *is* what was saved, so picking
one loads it outright.

**Everything that runs goes through `launchJob`** — the inspect page included.
It used to run its own socket, uploader and output poller inside a component,
which meant a run died whenever the page unmounted: opening one of its own
outputs in the viewer was enough. The prompt-replacement rules are exported from
the same module for the same reason — two copies meant a rule typed on one
surface did nothing to a run started from it.

### Prompt replacements

The rules are a shared list in `app/replacements.js`; `ReplacementRules.js` is
the editor both hosts mount through the form's slot. Three things about it are
load-bearing:

- **The preview is painted by a second walk of the pipeline, and it checks
  itself.** `paintReplacements` returns `[{text, rule}]` so each replacement's
  text can carry its rule's colour. Attribution cannot come from diffing before
  against after — a diff cannot say which of two rules produced a stretch of
  text — so it re-walks, which makes it a second implementation of the thing
  this module exists to keep single. It therefore compares its own result
  against `applyReplacements` and returns `null` on any disagreement; the editor
  then shows the plain string. The tidy-up steps live in one `STRIP_STEPS` table
  both walks read, for the same reason.
- **Several enabled rules for one keyword are variations, not a queue.** The
  first used to win and the rest silently did nothing — by the time the second
  looked, the token had already been replaced. Now `replacementVariations()`
  returns every combination as a complete rule list, and a run queues one job
  per combination (times the files in a multi-file pick). Order inside a list
  stays the order the rules were typed, because a free-text rule can rewrite
  what an earlier one produced. The Run tab states the multiplication in red
  before the button, since finding it out at job 48 is the failure that warning
  exists to prevent.
- **Only the keywords this run can actually reach multiply it.** Rules for a
  keyword the prompt never mentions replace nothing, so fanning out over them
  queues N identical jobs — which is what switching to a workflow whose prompt
  has no `[keyword]` in it used to do, at the old count, in red. `reachableRules`
  decides it, and `replacementGroups(text)` marks each group `live` or not;
  a group that is not live still rides along in every rule list (the run applies
  it and it finds nothing) but contributes no multiplication. It is reachability
  rather than a scan, since one rule's replacement can carry another's keyword —
  `[female]` → "…, `[hair]`, …" makes `[hair]` live in a prompt that never said
  it — and it errs towards live, because counting a variation that changes
  nothing is cheaper than dropping one that would have. The text it judges
  against is `replaceableText(cfg.fields)` in WorkflowFields: every text field
  the form holds, hidden ones included (they still carry their value into the
  graph) and everything `applyReplacementsToNodes` skips left out, through the
  same exported `SKIP_KEY`. Rules that are set and cannot fire get a quiet line
  under the red one rather than silence, or the multiplication that stopped
  appearing has nowhere to say why.
- **The list is sorted for reading, never for running.** Rows render through a
  sorted view carrying each rule's real index; the stored array keeps the order
  it was typed in, which is the order it executes in. Alphabetical puts a
  keyword's variations next to each other, and a row with nothing typed yet
  sorts last so a new one does not jump away from the button that made it.
- **The `2/3` tag is the control that grows its own group.** It is the one cell
  that already knows what the group is, so clicking it adds another rule for the
  same find, holding the next prompt off that keyword's shelf that no sibling —
  switched off ones included — has taken. A row with no group yet shows a `＋`
  in the same cell, since the second rule is what *makes* a group and having to
  know that in advance is what this saves; a row with nothing to find keeps the
  empty cell. The new rule is appended, never spliced in: the tag's number is
  its place in the stored list, so inserting one would renumber its neighbours
  and shift every colour after it. What moves is the display order, which places
  it just after the last of its siblings rather than at the bottom of the list,
  out of sight of the tag that made it. It inherits the source row's switch, so
  adding to a group that is off does not quietly start it running.
- **The find box offers the keywords rather than asking you to remember them** —
  the ones this prompt actually contains first, since only a rule for one of
  those changes this run, then the library's categories and any keyword another
  rule names, marked as not present.
- **`loadReplacements` only believes an answer shaped like a list.** It seeds
  from localStorage so the editor is never blank, then adopts the server's copy;
  if the server has none and this browser does, it pushes its own up. That push
  is the module's only unprompted write, and an unreadable reply used to reach it
  — a 200 with a truncated body read as "the server has no rules" and posted a
  stale cache over the real ones.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/list` | Directory listing with pagination, search, sort, type filter |
| POST | `/api/favorite` | Move file to `_Favorites` (or archive root if from ComfyUI output) |
| POST | `/api/delete` | Delete file and its thumbnail |
| GET | `/api/metadata` | Extract workflow metadata from PNG/video files |
| GET | `/file/{path}` | Serve media file with range support |
| GET | `/thumb/{path}` | Serve video thumbnail |
| GET/POST | `/api/workflow-field-config` | Read a workflow's form (merged with saved edits) / save those edits |
| GET | `/api/workflows/all` | Every workflow on disk, with label, enabled flag and mapping |
| POST | `/api/workflows/manage` | Replace the set of workflows in the library |
| POST | `/api/workflows/save` | Write an image's embedded graph out as a new workflow |
| POST | `/api/workflows/update` | Overwrite a workflow's own `.json` with the fields on screen |
| GET/POST | `/api/settings` | Read (keys masked) / merge into config.json and hot-reload |
| GET | `/api/maintenance/state` | Clean: the option list, the remembered ticks, the last measurement, the job and its log |
| POST | `/api/maintenance/scan` | Clean: measure every target (deletes nothing) |
| POST | `/api/maintenance/clean` | Clean: run the ticked selection — takes `confirm: true` as well as the selection |

`/api/workflows/update` and the run path share `applyFieldConfigOverrides`, so a
value can only ever land where a run would have put it; the rest of the graph is
left alone rather than re-serialised. It refuses `__inherit__` (no file) and
`@sc:` shortcuts (they live in the store, and resolving one would rewrite its
parent), and drops a one-time `.bak` beside the file before the first overwrite.

### The workflow form, and the three ways to make a change stick

Detection builds the form; nothing else does. The "classic" controls and
everything that served them are gone: `/api/workflow-config`,
`/api/workflow-nodes`, the prompt/steps/seed **node mapping**
(`resolvePromptNode` and friends, `workflowCandidates`) and the legacy override
branches of `/api/workflow-prompt`, which now takes `fieldValues` and nothing
else. `store.mappings` is still accepted and ignored by `/api/workflows/manage`,
and an existing one is left in the store — going back to an older build should
find what it left.

What a change does depends on which control saved it:

| Control | Writes | Where |
|---|---|---|
| ✏️ **Update workflow** (dialog + inspect) | the **values** | the workflow's own `.json` — ComfyUI sees them too |
| **Save field setup** (inspect) | which fields **show**, and their labels | `fieldConfigs[name].edits` in the app store |
| **⚙ roles** (Workflows page) | which field is prompt / seed / steps / cfg | the same `edits`, as a `kind` override |

Anything typed and not saved lives until the visit ends: a trip to the viewer to
look at an output is a round trip and keeps it, while Home, Back or another
workflow starts again from the file. `buildFieldConfig` merges the saved edits
over every detection run and returns them as `savedEdits`, because the POST
replaces the whole map — a client that sent only its own keys would drop the
other surface's.

## Config

Copy `config.example.json` to `config.json` and fill in your values. Every field is also editable at runtime from **Settings** in the app (hot-reloaded, no restart):

- `port` / `httpsPort` — HTTP (default 8080) / HTTPS (default 8443, needs a cert+key in `certs/`)
- `mediaDir` — path to the media library root
- `comfyDir` — ComfyUI install directory (drives the workflow list)
- `comfyOutput` — path to ComfyUI's output folder
- `comfyUrl` — ComfyUI API address (default `http://127.0.0.1:8188`; used by the run proxy, WS proxy, and status checks)
- `comfyStartCmd` — command that launches ComfyUI (shell string or `[cmd, ...args]` array). If unset, auto-detects: a launcher script first (`Start ComfyUI.bat` / `run_*.bat` on Windows, `start-comfyui.sh` / `start.sh` / `run.sh` elsewhere), then `main.py` run from `comfyDir` with the venv interpreter beside it if there is one. A source checkout ships no launcher, which is the usual case off Windows — that is what the `main.py` branch is for. Used by the Run button's "start it now" offer (`POST /api/comfy/start`). Note: when the app itself runs as a background service, a launched GUI may be invisible (it starts in the service session).
- `civitaiApiKey` — API key (also settable in Settings → Config)
- `maintenanceScript` — the cleanup script Settings → Clean drives. Defaults to
  `tools/maintenance/wipe_media.ps1`, which ships with the repo. It must accept `-Report`.
- `maintenanceDir` — where the request/status/report/log files for that run live
  (default `C:\ProgramData\ComfyRemix`). **Changing this needs the task re-registered**:
  the directory is baked into the task's action at registration while the server reads
  the key per request, so the two silently stop agreeing and every run then reports the
  "has not reported back" stall.
- `comfyTemp` — ComfyUI's preview/render cache, the one location the obvious cleanup
  misses. ComfyUI writes it beside its own code, and on a Docker install that is a
  different tree from the bind-mounted `input`/`output` pair — so nothing under
  `comfyDir` points at it and the app never lists it. Unset means a Clean run skips it
  and says so; it is never guessed at.
- `dockerContainer` — name of the ComfyUI container, if there is one. Used only to
  verify a wipe from inside the container as well as from the host; unset skips that.
- `maintenanceExtraTargets` — what `-Scope Extended` covers. **Empty by default**, and
  deliberately so: these are source or training material that is ComfyUI-adjacent but
  not generated, so nothing here is regenerable and nothing is assumed. Each entry is
  either a path string or `{ path, label, childSubfolder }`, where `childSubfolder`
  sweeps one level down and takes that subfolder of each child (how a training-set root
  is laid out). Not settable from Settings, for the same reason `maintenanceScript` is
  not: these name what gets deleted, and a value arriving over HTTP could redirect the
  wipe.
- `maintenanceSelection` — the remembered ticks. Written by the Clean page on Run; not
  meant to be edited by hand.
- `mediaCachePolicy` — how long the browser may keep media: `nostore` (default), `validate`, or `day`. Whitelisted server-side before it reaches a `Cache-Control` header. Note that **no header deletes files at a deadline** — `max-age` governs reuse, not retention — so only `nostore` keeps media out of the cache at all. Logout also sends `Clear-Site-Data`, which Safari ignores.
- `nsfwTermsB64` — the content-filter word list safe mode matches on (see below)
- `auth` — optional password gate: `{ "enabled": true, "hash": "scrypt$<salt>$<key>" }`, managed from Settings → Security. Only the hash is stored, and the gate stays off unless a hash exists. While on, everything (pages, APIs, `/file`, `/thumb`, the WS proxy) is refused until a session cookie arrives — see below.

## Running headless / at startup

The server is a plain `node server.js` process, so any service manager can keep it alive at boot:

- **Windows** — a Scheduled Task running `node server.js` from the app directory. Run it as **SYSTEM at startup** to have the app reachable before anyone logs in (headless / remote), or **at logon** for a per-user setup. Copy-paste setup is in the [README](README.md#run-at-startup-windows).
- **Linux / macOS** — a `systemd` user unit or `launchd` plist invoking `node server.js` in the app directory.

Caveats when running under a service account (e.g. Windows SYSTEM) or otherwise headless:

- Service accounts don't inherit your per-user `PATH`, so `ffmpeg` / `ffprobe` may not resolve by name. server.js locates them and stores absolute paths at startup (`findFfBin`; override with `ffmpegDir` in config). A bare `ffprobe` invocation fails silently under a service account and video metadata comes back `null`.
- Use **one** autostart mechanism only — two instances collide on port 8080 (`EADDRINUSE`).

## Cleaning up (Settings → Clean)

`/settings/clean` is the console questions of the cleanup script as checkboxes:
Explorer's thumbnail cache, the browser caches, the Windows breadcrumb layer, the
generated-media folders, the Recycle Bin, the shadow copies, and a closing ReTrim. Every
row carries the file count and size the script measured, because a question answered
without knowing the cost is the one that deletes the wrong thing. There is no Save button
— the ticks are remembered **on Run**, since the selection that ran is the one worth
coming back to.

**The server does none of the work, deliberately.** It runs as SYSTEM here, and SYSTEM is
the wrong account for this even though it is the privileged one: every per-user store the
script clears is found through `%LOCALAPPDATA%` / `%APPDATA%`, which under SYSTEM point
at an empty system profile — the pass would clear nothing and report success. Its
thumbnail pass also restarts `explorer.exe`, and an explorer started from session 0 comes
back in session 0, leaving the signed-in desktop with no shell. So the endpoints write a
request file and poke an on-demand scheduled task that runs **as the signed-in user with
`RunLevel Highest`** — already elevated, so no UAC prompt is ever raised, which is the
whole reason the button works from a phone. The cost is that it needs somebody signed in;
the page says so rather than reporting a run that never happened.

- **Nothing from the browser reaches a command line.** `maintParams` in server.js is the
  only place a tick becomes a flag, and the wrapper checks every name it is handed against
  its own allowlist before binding them as real parameters. The request's `kind` decides
  the mode, so a scan cannot be talked into deleting.
- **`-Only` or `-SkipMedia`, never neither.** Without one of the two the script wipes all
  four core media targets, so an empty selection must never be able to read as "no filter".
- **The measurements come from the script, not from the page.** Its `-Report` mode walks
  the same target list the run does and writes it as JSON. A second target list on the
  app's side is exactly how the easily-missed target got missed in the first place — which
  is also why the LoRA datasets are one row: `-Only` takes one token per key, so the page
  offers one checkbox per flag it can actually send.
- **A busy ComfyUI queue is a warning before the button, not a surprise in the log.** A
  non-interactive run refuses the media targets outright while the queue is working
  (deleting temp mid-job yanks the previews out from under it), so the scan carries the
  queue state back and the page says so up front.

The wrapper and the one-time registration script live in `scripts/`, which is gitignored
on this install — see `CLAUDE.local.md` for the task name and the setup command.

## Same-origin guard

Every response carries `Access-Control-Allow-Origin: *`, which means a page on any
site the user has open may POST here — and no endpoint asks who called. That was
enough to fire `/api/maintenance/clean` or `/api/bulk-delete` at `127.0.0.1` with
no click involved. The firewall, Tailscale and the client certificates all sit
*upstream* of this: the request starts inside the machine, in a browser that is
already past every one of them.

`sameOriginOk` in server.js is therefore checked before every route, alongside the
password gate, and refuses `POST`/`PUT`/`PATCH`/`DELETE` with a 403 unless the
request is same-origin. Three things about it are load-bearing:

- It compares `Origin` against the **`Host` of the same request**, not against a
  list of approved hostnames. The app answers on the tailnet name, the Tailscale
  IP, the LAN IP and localhost, over two ports; a list would be wrong the first
  time a device or a port changed, while "the page was served by whoever it is now
  talking to" is true for all of them at once — and stays true for a device added
  later.
- **`Origin`, not `Sec-Fetch-Site`.** Safari only sends `Sec-Fetch-*` from 16.4, so
  keying on it would lock an older iPhone out of its own app. `Origin` has ridden
  on every cross-origin POST for well over a decade.
- **A missing `Origin` is allowed; `null` is not.** Nothing sends no header except
  a non-browser client (curl, the PowerShell tooling), and a browser cannot be made
  to omit it on a POST — so the absent case is not a way in. `null` is what a
  sandboxed iframe sends, and folding the two together hands the hole straight back.

GETs are deliberately untouched: they change nothing, and the media, thumbnails and
the WebSocket proxy all have to keep working.

Note the wildcard CORS header itself is still `*`, so a cross-origin page can still
*read* a GET response (a listing, prompt text). That is a separate call from this
one and has not been made.

## Password gate

Optional, off by default (`config.auth`). Implemented entirely in server.js as a check placed **before every route** in the request handler, so a new endpoint is protected by existing:

- Reachable while locked: `GET /api/auth/status`, `POST /api/auth/login`, `POST /api/auth/logout`. Everything else gets the server-rendered lock screen (any non-`/api/` navigation, so a deep link still lands where it meant to) or a bare `401`. The WS upgrade handler checks the same predicate.
- The lock screen is a self-contained HTML string in server.js (`LOGIN_PAGE`) — with the gate on, `common.css` and the vendored Vue are behind it too, so it can't reference them. It submits on keyup (debounced) and reloads on success.
- Sessions are a signed expiry (`<exp>.<hmac>`), not a session table: restarts don't sign anyone out. The HMAC key derives from the password hash, so changing or clearing the password invalidates every outstanding session — which is why `/api/settings` re-issues a cookie to the browser that just saved.
- The front end contributes only a logout button: each page carries a `#logoutBtn` that `auth-ui.js` reveals — by toggling `.auth-on` on `<html>` (rule in common.css), with a delegated click handler — when `/api/auth/status` says a password is in use. Neither half may hold a reference to the button or set an inline style on it: index.html's copy is inside a Vue in-DOM template, and Vue discards that node on mount and builds a fresh one.
- The Security page detects a server with no `security` block in `/api/settings` and refuses to pretend: pre-gate builds answer `ok:true` to a password save and drop it, which looks exactly like success.
- Minimum length is 7, enforced in both `/api/settings` (`AUTH_MIN_LEN`) and the Security page, which keeps the enable toggle disabled until a long-enough password exists.

## Remote access hardening (optional)

The app binds `0.0.0.0` but is intended to stay private. To reach it from other devices without exposing it to the LAN or the public internet, put it behind a mesh VPN such as **Tailscale**: block inbound 8080/8443 at the firewall except from **localhost** and your **VPN address ranges**, and enable the VPN's unattended mode so the machine is reachable after a cold reboot before login. Step-by-step client + firewall setup is in the [README](README.md#accessing-it-privately-over-tailscale).

## Content filter (safe mode)

Optional. Indexed prompt text is matched against a word list; a file that matches
is flagged, and safe mode (`?safe=1`) omits it from listings and from the
prompt-word directory entirely.

- The list is **base64-encoded** in server.js and mirrored in `config.json`'s
  `nsfwTermsB64`, so no plaintext terms live in source. **Preserve that encoding
  when editing it** — a diff that decodes it to plaintext is a bug, not a
  cleanup.
- The shipped default is four generic starters (`nsfw`, `explicit`, `nude`,
  `gore`). It is a starting point, not a vocabulary: the list is meant to be
  filled in per install from Settings → Privacy, and the default is only ever
  seeded when the config key is **absent**, so editing it does nothing to an
  existing install.
- Matching folds **leetspeak** before comparing — digits and symbols back to
  letters, camelCase split — because model and LoRA filenames disguise
  themselves on purpose and a plain `\bterm\b` pass walks straight past them.
  Terms of 6+ letters also match as substrings, since folding can weld a term to
  a trailing version suffix; shorter ones keep word boundaries, or a
  three-letter term fires inside an innocent longer word.
- The literal pass runs first and the folded pass second, so folding can never
  *lose* a hit that plain matching would have found.

---

> Deployment specifics for a particular install (real paths, service/task names, firewall rules) don't belong in this committed file — keep them in a gitignored `CLAUDE.local.md`, which Claude Code also auto-loads.
