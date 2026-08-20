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

### Routes

`/` home · `/browse/:root/:path*` grid · `/view/:root/:path+` viewer ·
`/inspect` a file **or** a workflow · `/workflows` the library ·
`/prompts` the reusable text · `/jobs` the run list ·
`/settings` and `/settings/:tab` (config | privacy | security).

`/inspect` takes either `?path=…` (a file) or `?wf=<name>` (a workflow with no
file behind it, opened from the Workflows page). With no file it drops the
Preview tab and the metadata half and locks the workflow dropdown — the URL says
which workflow it is, so changing it there would leave the two disagreeing.

Settings is **routed pages, not a modal** — each section is linkable and survives a
reload. `SettingsPanel.js` renders either shape: as a dialog it keeps the overlay
and tab strip, and with `page`/`only` props it drops both and renders one section.

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

**Everything that runs goes through `launchJob`** — the inspect page included.
It used to run its own socket, uploader and output poller inside a component,
which meant a run died whenever the page unmounted: opening one of its own
outputs in the viewer was enough. The prompt-replacement rules are exported from
the same module for the same reason — two copies meant a rule typed on one
surface did nothing to a run started from it.

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
- `comfyStartCmd` — command that launches ComfyUI (shell string or `[cmd, ...args]` array); if unset, auto-detects `Start ComfyUI.bat` next to `comfyDir`. Used by the Run button's "start it now" offer (`POST /api/comfy/start`). Note: when the app itself runs as a background service, a launched GUI may be invisible (it starts in the service session).
- `civitaiApiKey` — API key (also settable in Settings → Config)
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
