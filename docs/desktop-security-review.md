# Desktop build — security review

**Reviewed:** 2026-09-30, branch `feat/desktop-app` (the Electron build).
**Verdict of the review:** fail → **14 of 15 findings fixed**, 1 open (a decision, H5).

The review was done by a separate agent reading the code with no access to the
author's reasoning, against the two promises the desktop build exists to keep:

1. **It never runs in an ordinary browser.** Only its own window may use the server;
   Edge, Chrome, Safari, other local processes and web pages open in a browser get
   nothing.
2. **The installer does not hand over the source.**

Plus Electron hardening, the auto-update path, the privacy-first promise (no traffic
off the machine beyond the update check), and regressions in the plain
`node server.js` install.

## Findings

| ID | Severity | Finding | Status |
|----|----------|---------|--------|
| H1 | High | New port every launch → new origin → job list, ComfyUI client id and preferences lost each time, old prompts orphaned on disk | Fixed |
| H2 | High (critical on a machine running both installs) | Clean and the purge password in the desktop app drive the *server install's* scheduled task and wipe the wrong library | Fixed |
| H3 | High | "Restart now" raised the quitting flag before the install was known to happen; an update that did not install left the app unable to restart its server or reopen its window (always, on an unsigned Mac) | Fixed |
| H4 | High | A malformed `Host` crashed the server before the token was checked; another local account could then squat the port during the restart and collect the token | Fixed |
| H5 | High | Updates come from the source repository, which is public — the obfuscation hides nothing that GitHub does not already show | **Open — decision** |
| M1 | Medium | The token survived a cross-origin redirect (Chromium keeps request headers across hops); `localhost` also received it though the server does not listen on `::1` | Fixed |
| M2 | Medium | Every process the server spawns (ffmpeg, the ComfyUI launcher and so ComfyUI) inherited the token | Fixed |
| M3 | Medium | The build's derived "no comment survived" check chose its phrases against the output it then checked — it could never fail | Fixed |
| M4 | Medium | The debug-switch refusal was a denylist (`--proxy-server`, `--log-net-log`, `--host-resolver-rules` got through) and keyed on the exe's name | Fixed |
| L1 | Low | Permissions granted that the app never uses (microphone, clipboard read, web notifications) | Fixed |
| L2 | Low | No outbound allowlist on the window's session | Fixed |
| L3 | Low | CI exposed the release token and signing secrets to every build tool | Fixed |
| L4 | Low | An inherited `COMFYREMIX_CONFIG` redirected the desktop app to another config | Fixed |
| L5 | Low | `main.log` recorded page URLs, which carry media paths | Fixed |
| L6 | Low | All data in the Windows *roaming* profile (synced to domain servers) | Fixed |

A further item raised during testing, not by the review: cacheable vendor scripts were
replayed from Chromium's cache with an earlier launch's proof header and would have
been cancelled (a blank window) had the startup cache clear ever failed. Fixed.

## What changed

**H1 — stable origin.** `desktop/main.js` remembers the port in `desktop-port.json` in
the data folder and reuses it; a fresh one is taken only when it is busy.

**H2 — Clean is off in the desktop app.** In desktop mode `maintTaskInfo` reports
unavailable, `/api/maintenance/scan|clean` answer 403, `startPurge` ignores the purge
password, `purgeSupported` is false, and `/api/maintenance/state` no longer reads the
other install's log and report files.

**H3 — updates that can be installed, and only those.** The quitting flag is raised by
the updater's own quit (`before-quit-for-update`, `before-quit`), never before
`quitAndInstall`. On macOS the app reads its own signature (`codesign`); without a
Developer ID it does not download updates — it announces them and opens the release
page instead.

**H4 — no pre-token crash, and a squatter is neither paid nor believed.**
- The WebSocket upgrade checks the token before reading anything, and both URL
  parses are guarded (400 / socket closed instead of a crash).
- The token is minted per server start, so one captured during a restart dies with
  that server.
- A second secret, the *proof*, goes the other way: the server stamps it on every
  response (the WebSocket 101 included) and the window cancels any response from its
  port without it. It is independent of the token because a squatter has the token.

**M1.** The header is removed from every request that is not `127.0.0.1:<port>` —
removed, not just left off, because of redirects — and only `127.0.0.1` receives it.

**M2 / L4.** The server deletes the token, proof and port from `process.env` once read,
and ignores `COMFYREMIX_CONFIG` in desktop mode; the shell also strips inherited
`COMFYREMIX_*` from the child's environment.

**M3.** Derived canaries are chosen against an independently comment-stripped copy of
the source, then looked for in the staged file; the fixed canaries read the staged file
off disk. A file shipped unobfuscated now fails the build. `desktop/main.js` gained a
fixed canary.

**M4.** The installed app refuses **every** command-line switch except `--updated` (the
installer's relaunch), macOS `-psn_…` and, on Linux, `--no-sandbox`. "Installed" is
judged by running from `app.asar`, which the `onlyLoadAppFromAsar` fuse guarantees,
not by the exe's name.

**L1.** Permissions: fullscreen and clipboard-write only.

**L2.** `onBeforeRequest` cancels anything that is not the app's own server or
`data:`/`blob:`, alongside a Content-Security-Policy saying the same from inside the
page. (electron-updater uses its own session and is unaffected — verified.)

**L3.** The workflow stages in a step with no credentials; `GH_TOKEN` and each
platform's own signing variables exist only in the packaging step, and `npx --no`
refuses to fetch a builder from the registry into a process holding them.

**L5.** Log lines name a route (`/view`, `/inspect`) or a foreign origin, never a path
or query.

**L6.** Windows data lives in `%LOCALAPPDATA%\ComfyRemix`.

## Open: H5 — the source is public

Obfuscation, the sealed archive and the fuses make the *installer* useless as a copy of
the source. They cannot help while the repository itself is public. The options:

- **Accept it.** The repository is the source; the installer's protection is about
  tampering, not secrecy.
- **Make the repository private** and publish updates from a separate **public,
  releases-only** repository. A private feed is not an option: every install would
  have to carry a token that can read the source. The workflow supports this without
  code changes: set the repository variable `COMFYREMIX_RELEASE_REPO` and the secret
  `COMFYREMIX_RELEASES_TOKEN` (a fine-grained token with Contents read/write on that
  repository only). Installs already out keep the feed they were built with, so the
  first release made that way must also be published where they look.

## Checked and found sound

- `shellOk` runs first in the request handler — ahead of CORS, OPTIONS, the password
  gate, SSE, range requests and the SPA fallback — with a constant-time comparison.
- Desktop mode binds `127.0.0.1` only: no IPv6 listener, no HTTPS listener.
- The server sets no `Location` of its own and its ComfyUI proxies forward named
  headers only, so the token is not relayed to ComfyUI.
- Window hardening: context isolation, sandbox (and `app.enableSandbox()`), no Node, no
  preload, navigation/redirect/frame guards, webviews blocked, popups to other origins
  sent to the system browser (http/https only), DevTools off when installed.
- Fuses: RunAsNode, `NODE_OPTIONS` and `--inspect` off; load only from the archive;
  archive integrity checked at startup (not enforced by Electron on Linux); cookie
  encryption on.
- Packaging: `files` maps only `dist/stage`, so electron-builder adds no default
  `**/*` of the project; no extra resources, nothing unpacked beside the archive; the
  after-pack check handles Windows path separators and cannot pass vacuously.
- CI: tag must equal `v` + `package.json` version; one draft created up front; publish
  only after every platform's feed and the files it names are attached; values reach
  scripts through `env:` only; `persist-credentials: false`.
- The plain server install is unchanged outside desktop mode.

## Testing behind the fixes

All from a fresh export of the branch (tracked files only), installed with `npm ci`,
against a local ComfyUI instance kept for testing:

- **Route crawl** of the obfuscated build in a hidden window, same token/proof/CSP as
  the app: 13 routes (home, all three media roots, Workflows, Prompts, Jobs, every
  Settings page, Inspect on a workflow) — no errors; 501 responses per run, none
  without the proof, including across two runs sharing a cache; Clean reports itself
  unavailable.
- **Packaged Windows app:** starts, loads, connects to ComfyUI; no-token requests get
  403; the port is the same across a relaunch; `--updated` is accepted while
  `--proxy-server`, `--log-net-log` and `--remote-debugging-port` exit with code 1
  before anything starts; `ELECTRON_RUN_AS_NODE=1` does not turn it into Node; a
  graceful close leaves no process and frees the port.
- **Fuses** read back from the built exe exactly as configured; the after-pack check
  passes (312 files, 12 canaries absent) and was shown to fail on a planted
  `config.json`.
- **Auto-update**, end to end against a local feed: check → found → differential
  attempt → full download → checksum → notification and prompt; on an earlier run the
  prompt was accepted and the update installed per-user and relaunched as the new
  version.

## Not verified

- macOS and Linux builds (they first build in CI), including the ad-hoc-signed Mac
  launch and Ubuntu 24.04's sandbox restrictions.
- The GitHub publish path itself (draft → publish) — it runs only on a tag push.
- Differential updates from GitHub (the local test feed did not serve multi-range
  requests, so it fell back to a full download, as designed).
