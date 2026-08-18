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
- **app/** — the SPA, as native ES modules with no build step. `router.js` (routes), `store.js` (shared reactive state), `views/` (one per route), `components/` (the chrome and the dialogs). Vue 3 is the global build, vendored under `vendor/`.
- **config.json** — Runtime config (ports, paths, API keys). Gitignored; create it by copying `config.example.json`.
- **Media/** — Default media root browsed by the app. Gitignored.

Static serving is an **explicit allowlist**, not a directory mount: a new asset at
the repo root is a 404 until it is named in server.js. `app/` and `vendor/` are
allowlisted by shape (`.js`/`.css`, one directory deep).

### Routes

`/` home · `/browse/:root/:path*` grid · `/view/:root/:path+` viewer ·
`/inspect` metadata · `/settings` and `/settings/:tab` (config | privacy | security).

Settings is **routed pages, not a modal** — each section is linkable and survives a
reload. `SettingsPanel.js` renders either shape: as a dialog it keeps the overlay
and tab strip, and with `page`/`only` props it drops both and renders one section.

### Jobs

The run engine lives in **`components/RemixDialog.js`**, not in anything named
after jobs: it owns the reactive `jobs` store, IndexedDB persistence, the
leader-elected ComfyUI socket and the reconciler, and it runs because `AppShell`
imports it eagerly. **`components/JobsDialog.js` is a view only** and owns no
state. The progress hairline and the `⚡ N` badge live in `AppShell`, since a job
outlives both the dialog that started it and the route it started from.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/list` | Directory listing with pagination, search, sort, type filter |
| POST | `/api/favorite` | Move file to `_Favorites` (or archive root if from ComfyUI output) |
| POST | `/api/delete` | Delete file and its thumbnail |
| GET | `/api/metadata` | Extract workflow metadata from PNG/video files |
| GET | `/file/{path}` | Serve media file with range support |
| GET | `/thumb/{path}` | Serve video thumbnail |
| GET | `/api/workflow-field-config` | The controls the Remix dialog builds for a workflow |
| POST | `/api/workflows/manage` | Replace the set of workflows shown in the dropdown |
| POST | `/api/workflows/save` | Write an image's embedded graph out as a new workflow |
| POST | `/api/workflows/update` | Overwrite a workflow's own `.json` with the fields on screen |
| GET/POST | `/api/settings` | Read (keys masked) / merge into config.json and hot-reload |

`/api/workflows/update` and the run path share `applyFieldConfigOverrides`, so a
value can only ever land where a run would have put it; the rest of the graph is
left alone rather than re-serialised. It refuses `__inherit__` (no file) and
`@sc:` shortcuts (they live in the store, and resolving one would rewrite its
parent), and drops a one-time `.bak` beside the file before the first overwrite.

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
