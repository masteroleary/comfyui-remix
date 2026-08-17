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
- Static pages — `index.html`, `inspect.html`, `common.css` — are served straight from disk; just reload the browser, no restart needed.

## Architecture

- **server.js** — Node.js HTTP server (no external dependencies). Serves the SPA, exposes REST APIs for listing/favoriting/deleting media, and proxies ComfyUI (HTTP + WebSocket).
- **index.html** — Single-page application: dark theme, responsive media grid, full-screen viewer, and workflow inspector/re-run.
- **config.json** — Runtime config (ports, paths, API keys). Gitignored; create it by copying `config.example.json`.
- **Media/** — Default media root browsed by the app. Gitignored.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/list` | Directory listing with pagination, search, sort, type filter |
| POST | `/api/favorite` | Move file to `_Favorites` (or archive root if from ComfyUI output) |
| POST | `/api/delete` | Delete file and its thumbnail |
| GET | `/api/metadata` | Extract workflow metadata from PNG/video files |
| GET | `/file/{path}` | Serve media file with range support |
| GET | `/thumb/{path}` | Serve video thumbnail |

## Config

Copy `config.example.json` to `config.json` and fill in your values. Every field is also editable at runtime from the in-app ⚙ Settings panel (hot-reloaded, no restart):

- `port` / `httpsPort` — HTTP (default 8080) / HTTPS (default 8443, needs a cert+key in `certs/`)
- `mediaDir` — path to the media library root
- `comfyDir` — ComfyUI install directory (drives the workflow list)
- `comfyOutput` — path to ComfyUI's output folder
- `comfyUrl` — ComfyUI API address (default `http://127.0.0.1:8188`; used by the run proxy, WS proxy, and status checks)
- `comfyStartCmd` — command that launches ComfyUI (shell string or `[cmd, ...args]` array); if unset, auto-detects `Start ComfyUI.bat` next to `comfyDir`. Used by the Run button's "start it now" offer (`POST /api/comfy/start`). Note: when the app itself runs as a background service, a launched GUI may be invisible (it starts in the service session).
- `civitaiApiKey` — API key (also settable in ⚙ Settings)
- `auth` — optional password gate: `{ "enabled": true, "hash": "scrypt$<salt>$<key>" }`, managed from ⚙ Settings → Security. Only the hash is stored, and the gate stays off unless a hash exists. While on, everything (pages, APIs, `/file`, `/thumb`, the WS proxy) is refused until a session cookie arrives — see below.

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
- The Security tab detects a server with no `security` block in `/api/settings` and refuses to pretend: pre-gate builds answer `ok:true` to a password save and drop it, which looks exactly like success.
- Minimum length is 7, enforced in both `/api/settings` (`AUTH_MIN_LEN`) and the Settings panel, which keeps the enable toggle disabled until a long-enough password exists.

## Remote access hardening (optional)

The app binds `0.0.0.0` but is intended to stay private. To reach it from other devices without exposing it to the LAN or the public internet, put it behind a mesh VPN such as **Tailscale**: block inbound 8080/8443 at the firewall except from **localhost** and your **VPN address ranges**, and enable the VPN's unattended mode so the machine is reachable after a cold reboot before login. Step-by-step client + firewall setup is in the [README](README.md#accessing-it-privately-over-tailscale).

## Prompt sanitizer

The prompt/filename search index runs user prompt text through a sanitizer whose filter terms are **base64-encoded** in server.js (and mirrored in `config.json`'s `nsfwTermsB64`) so no plaintext terms live in source. Preserve that encoding when editing the term list.

---

> Deployment specifics for a particular install (real paths, service/task names, firewall rules) don't belong in this committed file — keep them in a gitignored `CLAUDE.local.md`, which Claude Code also auto-loads.
