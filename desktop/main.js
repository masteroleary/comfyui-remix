'use strict';
// ComfyRemix desktop shell: the Electron main process.
//
// The app is still the web app — server.js and the SPA under app/ are unchanged
// underneath. What this file adds is a window that is the *only* thing the server
// will answer. The user does not want this running in Edge, Chrome or Safari, whose
// telemetry they do not trust, so the server is started here with a token minted per
// launch, the window's session stamps that token onto every request to its own
// origin, and the server refuses anything without it (see "Desktop shell" at the top
// of server.js). An ordinary browser pointed at the port gets a page saying where the
// app is, not the app.
//
// Everything else here follows from that: the window must never navigate somewhere
// that would then receive the token, never hand one of our own pages to the system
// browser (which would see only the refusal), and never let anything attach a
// debugger that could read what the window can.

const { app, BrowserWindow, Menu, Notification, dialog, screen, session, shell, utilityProcess } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');

// server.js, index.html and app/ sit one level up — in the repo and, identically,
// inside the packaged asar, which is what lets one path serve both.
const ROOT = path.join(__dirname, '..');
const APP_ID = 'com.masteroleary.comfyremix';
const PRODUCT_NAME = 'ComfyRemix';
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
// "Is this the installed app?" — asked of where this file was loaded from, not only of
// app.isPackaged, which only looks at the executable's name: copy the installed exe to
// electron.exe and isPackaged turns false, and with it the debugging refusal and the
// DevTools lock. The onlyLoadAppFromAsar fuse means an installed copy always runs from
// inside app.asar, whatever its exe is called.
const PACKAGED = app.isPackaged || /[\\/]app\.asar[\\/]/.test(__dirname);

// ── Data directory ─────────────────────────────────────────────────────────
// Pinned by name rather than left to Electron's default, which derives it from
// package.json and would move the user's config, prompts and library index the day a
// name field changed. It has to happen before anything reads the path — the
// single-instance lock below is keyed on it, so two builds disagreeing about it would
// both believe they were the only copy running.
//
// On Windows it is the *local* app-data folder, not Electron's default roaming one: a
// roaming profile is copied to the domain's servers at every sign-out, and this folder
// holds the config (API keys, password hashes), every prompt the job list kept and, by
// default, the media library itself.
app.setPath('userData', path.join(IS_WIN && process.env.LOCALAPPDATA ? process.env.LOCALAPPDATA : app.getPath('appData'), PRODUCT_NAME));
const DATA_DIR = app.getPath('userData');
const LOG_DIR = path.join(DATA_DIR, 'logs');
const MAIN_LOG = path.join(LOG_DIR, 'main.log');
const SERVER_LOG = path.join(LOG_DIR, 'server.log');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}

// ── Logging ────────────────────────────────────────────────────────────────
// DevTools are off in the installed app, so main.log is the only place a front-end
// error can be seen at all — the renderer's warnings and errors are forwarded here
// (see watchContents). Appended synchronously, one line at a time: a line buffered in
// a stream is exactly the line lost when the process ends abruptly, and the lines
// written just before an abrupt end are the ones worth having.
function log(level, message) {
  const line = `${new Date().toISOString()} [${level}] ${message}\n`;
  try { fs.appendFileSync(MAIN_LOG, line); } catch {}
  // A packaged Windows build has no console, and writing to a stdout that is not
  // there can throw; in development this is the terminal `npm run desktop` ran in.
  if (!PACKAGED) { try { process.stdout.write(line); } catch {} }
}

// Nothing prunes these otherwise, and they live in a folder nobody opens. One previous
// generation is kept, so the log from the run before a bad one survives the restart
// that follows it.
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
function rotateLog(file) {
  try { if (fs.statSync(file).size > LOG_ROTATE_BYTES) fs.renameSync(file, file + '.1'); } catch {}
}

// ── Debugging switches ─────────────────────────────────────────────────────
// Chromium's remote debugging would let any local process attach DevTools to the
// window and read everything it can — the token included. Electron's fuses switch off
// the Node inspector flags in the packaged binary, but not this, so the installed app
// refuses to start with any of them rather than trusting that nobody passes one. The
// inspector flags are on the list too, though the fuses remain the real defence there:
// --inspect-brk stops before this file has run a line.
//
// Both sources are checked because they disagree about spelling. app.commandLine is
// Chromium's own parse, which on Windows also accepts `-x` and `/x` and ignores case —
// exactly the forms a check of process.argv for `--x` alone would wave through. argv
// is then held to the allowlist below, which is what catches everything this list
// has never heard of.
const DEBUG_SWITCHES = [
  'remote-debugging-port', 'remote-debugging-pipe', 'remote-debugging-address',
  'inspect', 'inspect-brk', 'inspect-port', 'inspect-wait', 'inspect-publish-uid', 'js-flags',
];
// And beyond those, an allowlist: the installed app refuses *every* switch it was not
// built to receive. A denylist is one flag behind by construction — --proxy-server with
// a loopback bypass hands every request, token included, to someone else's proxy;
// --log-net-log writes them all to disk; --host-resolver-rules re-points 127.0.0.1 —
// and nothing a person clicks ever launches this app with switches of its own. These
// are the ones that do arrive: the Windows installer relaunching after an update,
// older macOS Finder launches, and the one flag some Linux desktops need to start
// Chromium at all (Ubuntu 24.04's AppArmor rules refuse its sandbox otherwise).
const ALLOWED_ARGS = [
  /^--updated$/,
  /^-psn_\d+_\d+$/,
  ...(process.platform === 'linux' ? [/^--no-sandbox$/] : []),
];
function refusedSwitch() {
  for (const name of DEBUG_SWITCHES) {
    if (app.commandLine.hasSwitch(name)) return name;
  }
  const prefix = IS_WIN ? /^(?:--|-|\/)/ : /^--?/;
  for (const arg of process.argv.slice(1)) {
    const a = String(arg);
    if (!prefix.test(a)) continue;          // a plain argument, not a switch
    if (ALLOWED_ARGS.some(re => re.test(a))) continue;
    return a.replace(prefix, '').split('=')[0].slice(0, 60) || a.slice(0, 60);
  }
  return null;
}

// ── Our origin ─────────────────────────────────────────────────────────────
// One question asked in four places — which requests carry the token, which
// navigations stay in the window, which popups become app windows, which pages may
// hold a permission — and it has to get one answer, so it is asked here. Both loopback
// spellings count as ours: `localhost` is the same server, and a link written that way
// must stay in the window rather than end up in a browser that can only be refused.
let port = null;
const PAGE_PROTOCOLS = ['http:'];
const SHELL_PROTOCOLS = ['http:', 'ws:'];   // the WebSocket proxy (/comfy-ws) is ours too
function isOwnUrl(raw, protocols) {
  if (!port) return false;
  let u;
  try { u = new URL(String(raw)); } catch { return false; }
  return protocols.includes(u.protocol)
    && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')
    && u.port === String(port);
}
// Narrower, for the token alone: 127.0.0.1 by number. The server binds only that, so
// `localhost` — which resolves to ::1 first on most systems — reaches whatever else is
// listening on [::1] at our port, and that must not be handed the token.
function isTokenUrl(raw) {
  if (!port) return false;
  let u;
  try { u = new URL(String(raw)); } catch { return false; }
  return (u.protocol === 'http:' || u.protocol === 'ws:') && u.hostname === '127.0.0.1' && u.port === String(port);
}
// What a log line may say about a URL: our route's first segment, or someone else's
// origin. Never the rest — /view/<root>/<path> and /inspect?path= are media paths, and
// the log is a file that outlives the media it would name.
function where(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return '(unparsable url)'; }
  if (isOwnUrl(u.href, SHELL_PROTOCOLS)) return '/' + (u.pathname.split('/')[1] || '');
  return u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'ws:' ? u.origin : u.protocol;
}
const ownOrigin = () => `http://127.0.0.1:${port}`;

// Anything the window will not show itself. Only http(s) goes to the system browser:
// a file:, javascript: or custom-scheme URL handed to the OS is a way to launch
// programs, and nothing in this app has a reason to produce one.
function openOutside(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    log('warn', `blocked a link to ${u.protocol}`);
    return;
  }
  log('info', `opening in the system browser: ${u.origin}`);
  shell.openExternal(u.href).catch(e => log('warn', `openExternal failed: ${e.message}`));
}

// ── The server ─────────────────────────────────────────────────────────────
// Run as a utility process rather than a child node: the installed app ships no
// node.exe, and a utility process is Electron's own Node in a process of its own, with
// a message port back to here and torn down with the app. The token lives in this
// process's memory and the child's environment, never on disk, so every launch of the
// app mints a new one and no file can hand it out. (Anything already running as this
// user can read another process's environment — but that could read the window's
// memory as well, and the token was never a defence against it.)
//
// A fresh token for every server started, not one per launch. Whatever squats the port
// in the gap while a server restarts receives the window's next request, token and all;
// a token that dies with the server it was minted for is worth nothing to it. The proof
// is the other direction — the server stamps it on every response and the window
// cancels any response from its port without it — so a squatter is also never believed.
let token = '';
let proof = '';
const SHELL_HEADER = 'x-comfyremix-shell';
const PROOF_HEADER = 'x-comfyremix-proof';
const READY_TIMEOUT_MS = 30 * 1000;
const CRASH_WINDOW_MS = 60 * 1000;
const CRASH_LIMIT = 5;

let server = null;            // the live UtilityProcess, if any
let serverLog = null;         // one append stream shared by every fork
let quitting = false;         // once set, an exiting server is not replaced
let mainWindow = null;
const crashes = [];           // times of the exits that were not a requested restart

let everListening = false;
let resolveFirstListening;
const firstListening = new Promise(resolve => { resolveFirstListening = resolve; });

// The port is the page's origin, and the origin is what the page's storage belongs to:
// the job list (IndexedDB), the ComfyUI client id that lets a running job's progress
// find its way back, and every remembered preference. A new port per launch was a new,
// empty app per launch — with the last one's prompts left behind in a folder nothing
// could reach. So the port is remembered, and a fresh one is taken only when the old
// one is no longer free (the storage then waits under the old origin until it is).
// Kept for the whole launch as well: the page polls the port it was loaded from while
// the server restarts. Probing leaves a gap before the server binds it — a server that
// loses that race exits and is re-forked like any other failure, and whatever won the
// race gets a token that dies with the fork and is never believed (see `proof`).
const PORT_FILE = path.join(DATA_DIR, 'desktop-port.json');
function tryPort(wanted) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', () => resolve(null));
    probe.listen(wanted, '127.0.0.1', () => {
      const got = probe.address().port;
      probe.close(() => resolve(got));
    });
  });
}
async function pickPort() {
  let saved = 0;
  try { saved = Number(JSON.parse(fs.readFileSync(PORT_FILE, 'utf8')).port) || 0; } catch {}
  if (saved >= 1024 && saved <= 65535) {
    const got = await tryPort(saved);
    if (got) return got;
    log('warn', `port ${saved} is taken; this launch uses another, so the job list and preferences from earlier launches are not visible until it is free again`);
  }
  const fresh = await tryPort(0);
  if (!fresh) throw new Error('no free loopback port');
  try { fs.writeFileSync(PORT_FILE, JSON.stringify({ port: fresh }) + '\n'); } catch (e) {
    log('warn', `could not remember the port: ${e.message}`);
  }
  return fresh;
}

// Only what the server needs from this launch's environment, never an inherited
// COMFYREMIX_* — a shell left with COMFYREMIX_CONFIG pointing at a test instance would
// otherwise have the app read and rewrite that file.
function serverEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^COMFYREMIX_/i.test(k)) delete env[k];
  return {
    ...env,
    COMFYREMIX_DATA_DIR: DATA_DIR,
    COMFYREMIX_SHELL_TOKEN: token,
    COMFYREMIX_SHELL_PROOF: proof,
    COMFYREMIX_PORT: String(port),
  };
}

function startServer() {
  if (!serverLog) {
    serverLog = fs.createWriteStream(SERVER_LOG, { flags: 'a' });
    serverLog.on('error', e => log('error', `cannot write ${SERVER_LOG}: ${e.message}`));
  }
  serverLog.write(`\n──── ${new Date().toISOString()} starting server on 127.0.0.1:${port} ────\n`);

  token = crypto.randomBytes(32).toString('hex');
  // The proof, by contrast, is once per launch. A squatter only ever receives requests,
  // never a response of ours, so it cannot learn the proof whether or not it rotates —
  // and one that rotated would fail every response Chromium replays from its cache
  // after a restart, with the headers the previous server sent.
  if (!proof) proof = crypto.randomBytes(32).toString('hex');
  const child = utilityProcess.fork(path.join(ROOT, 'server.js'), [], {
    serviceName: `${PRODUCT_NAME} server`,
    stdio: 'pipe',
    cwd: DATA_DIR,
    env: serverEnv(),
  });
  server = child;
  let listening = false;

  // end:false, because the file outlives this child — every re-fork appends to it.
  if (child.stdout) child.stdout.pipe(serverLog, { end: false });
  if (child.stderr) child.stderr.pipe(serverLog, { end: false });

  // A server that never says it is listening is a window that never loads. Waiting on
  // it forever would leave nothing on screen and no process to blame, so it gets a
  // deadline, and the dialog names the file that says why.
  const readyTimer = setTimeout(() => {
    if (!listening && server === child) {
      fatal('ComfyRemix could not start.',
        `Its built-in server did not report that it was listening within ${READY_TIMEOUT_MS / 1000} seconds.`);
    }
  }, READY_TIMEOUT_MS);

  child.on('spawn', () => log('info', `server started, pid ${child.pid}`));
  child.on('message', msg => {
    if (!msg || msg.type !== 'listening') return;
    listening = true;
    clearTimeout(readyTimer);
    if (msg.port !== port) log('warn', `server reports port ${msg.port}, expected ${port}`);
    log('info', `server listening on 127.0.0.1:${port}`);
    everListening = true;
    resolveFirstListening();
  });
  child.on('error', (type, location) => log('error', `server fatal error (${type}) at ${location}`));
  child.on('exit', code => {
    clearTimeout(readyTimer);
    if (server === child) server = null;
    if (quitting) return;

    // "Restart server" in Settings is the server exiting 0 on purpose, and it is the
    // only exit that is not a failure. Anything else — a crash, or even a clean exit
    // from a server that never got as far as listening — counts towards the limit,
    // since a loop of those is a server that cannot start and re-forking it for ever
    // would only hide that.
    const requested = code === 0 && listening;
    if (requested) {
      log('info', 'server exited for a requested restart; starting it again');
      restartServer(100);
      return;
    }
    const now = Date.now();
    crashes.push(now);
    while (crashes.length && now - crashes[0] > CRASH_WINDOW_MS) crashes.shift();
    log('error', `server exited unexpectedly (code ${code}); ${crashes.length} in the last minute`);
    if (crashes.length > CRASH_LIMIT) {
      fatal('ComfyRemix stopped working.',
        `Its built-in server stopped ${crashes.length} times in a minute, so it is no longer being restarted.`);
      return;
    }
    // A beat before trying again, so a port still being released or a file still
    // being written has a moment to settle. The window is left alone throughout: the
    // page notices the server is gone and reconnects to it by itself.
    restartServer(1000);
  });
}

// The fork is from a timer here, where a throw would land in the uncaught handler and
// leave the app running with no server behind its window — so it is caught and said.
function restartServer(delayMs) {
  setTimeout(() => {
    if (quitting) return;
    try { startServer(); } catch (e) {
      fatal('ComfyRemix stopped working.', `Its built-in server could not be restarted: ${e.message}`);
    }
  }, delayMs);
}

// Taking the server down never waits for it. kill() is a signal, not a join, which is
// what keeps it out of the way of the updater's quit-and-install: that path quits the
// app on its own schedule, and anything here that held the quit open would be holding
// the installer.
function killServer() {
  const child = server;
  server = null;
  if (child) { try { child.kill(); } catch {} }
}

// Once, however many things fail at the same moment. Re-forks stop first, so the dialog
// is not describing a server that is already starting again behind it.
let fatalShown = false;
function fatal(message, detail) {
  if (fatalShown) return;
  fatalShown = true;
  quitting = true;
  log('error', `${message} ${detail}`);
  killServer();
  const opts = {
    type: 'error',
    title: PRODUCT_NAME,
    message,
    detail: `${detail}\n\nWhat the server printed is in:\n${SERVER_LOG}`,
    buttons: ['Quit', 'Show log file'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const parent = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() ? mainWindow : null;
  (parent ? dialog.showMessageBox(parent, opts) : dialog.showMessageBox(opts))
    .then(({ response }) => { if (response === 1) shell.showItemInFolder(SERVER_LOG); })
    .catch(() => {})
    .finally(() => app.quit());
}

// ── Windows ────────────────────────────────────────────────────────────────
// One set of preferences for every window, popups included — a popup that quietly
// inherited something looser is how a hardened app stops being one.
// spellcheck is off because Chromium fetches its dictionaries from Google.
function webPreferences() {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    devTools: !PACKAGED,
    spellcheck: false,
    navigateOnDragDrop: false,
  };
}

function windowOptions() {
  // 1440x920 where there is room for it, and never larger than the screen: a window
  // opened bigger than a laptop's work area lands with its title bar off the top.
  let width = 1440;
  let height = 920;
  try {
    const area = screen.getPrimaryDisplay().workAreaSize;
    width = Math.min(width, area.width);
    height = Math.min(height, area.height);
  } catch {}
  const opts = {
    width,
    height,
    minWidth: 800,
    minHeight: 600,
    title: PRODUCT_NAME,
    backgroundColor: '#0d0d0d',
    autoHideMenuBar: !IS_MAC,
    webPreferences: webPreferences(),
  };
  // Windows and macOS take the window icon from the executable. Linux takes it from
  // the window, and without one most desktops show a generic placeholder.
  if (process.platform === 'linux') {
    const icon = path.join(ROOT, 'apple-touch-icon.png');
    if (fs.existsSync(icon)) opts.icon = icon;
  }
  return opts;
}

function createWindow() {
  const win = new BrowserWindow({ ...windowOptions(), show: false });
  mainWindow = win;
  // Shown on first paint, over the same dark background the page uses, so launching
  // it does not flash a white rectangle first. The timer is for the case where no
  // paint ever comes: a window that exists but was never shown is an app that looks
  // like it did not start.
  win.once('ready-to-show', () => win.show());
  setTimeout(() => { if (!win.isDestroyed() && !win.isVisible()) win.show(); }, 8000);
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  win.loadURL(ownOrigin() + '/').catch(e => log('error', `window failed to load: ${e.message}`));
  return win;
}

function focusWindow() {
  const win = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    return;
  }
  // Only once there is a server to load from; before that, startup opens the window
  // itself when it gets there.
  if (everListening && !quitting) createWindow();
}

// ── Every page, every window ───────────────────────────────────────────────
// Hooked on web-contents-created rather than on the windows this file makes, so a
// popup, or anything else that grows a webContents later, gets the same rules
// without having to remember to ask for them.
function isDevToolsChord(input) {
  if (input.type !== 'keyDown') return false;
  if (input.code === 'F12') return true;
  if (!['KeyI', 'KeyJ', 'KeyC'].includes(input.code)) return false;
  return IS_MAC ? (input.meta && input.alt) : (input.control && input.shift);
}

function watchContents(contents) {
  // Navigation. A page may move around its own origin freely; anything else is either
  // somewhere the token must not follow or somewhere our own page cannot load, so it
  // leaves the window, and only as far as the system browser. A subframe redirected
  // elsewhere is stopped but not opened: nobody clicked it, and a browser window
  // appearing for something a page loaded in the background is worse than an empty frame.
  const guardNavigation = (event, url) => {
    if (isOwnUrl(url, PAGE_PROTOCOLS)) return;
    event.preventDefault();
    log('info', `kept a navigation out of the window: ${where(url)}`);
    if (event.isMainFrame !== false) openOutside(url);
  };
  contents.on('will-navigate', event => guardNavigation(event, event.url));
  contents.on('will-redirect', event => guardNavigation(event, event.url));
  // will-navigate only sees the top frame. An iframe from somewhere else would sit in
  // our page with every request it made to our origin carrying the token, since the
  // header goes by the address a request is sent to and not by who sent it. The app
  // embeds nothing, so a foreign frame is simply not loaded (and not opened outside
  // either: nobody clicked it).
  contents.on('will-frame-navigate', details => {
    if (details.isMainFrame) return;
    const url = String(details.url || '');
    if (isOwnUrl(url, PAGE_PROTOCOLS) || /^about:(blank|srcdoc)$/.test(url)) return;
    details.preventDefault();
    log('warn', `blocked a frame loading ${where(url)}`);
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (isOwnUrl(url, PAGE_PROTOCOLS)) {
      return { action: 'allow', overrideBrowserWindowOptions: windowOptions() };
    }
    openOutside(url);
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', event => event.preventDefault());

  // Electron has no context menu at all until one is built, which leaves a text field
  // with no Paste. Only the editing verbs, and nothing on foreign pages or DevTools.
  contents.on('context-menu', (event, params) => {
    if (!isOwnUrl(contents.getURL(), PAGE_PROTOCOLS)) return;
    const items = [];
    if (params.isEditable) {
      const f = params.editFlags || {};
      items.push(
        { role: 'cut', enabled: !!f.canCut },
        { role: 'copy', enabled: !!f.canCopy },
        { role: 'paste', enabled: !!f.canPaste },
        { type: 'separator' },
        { role: 'selectAll', enabled: !!f.canSelectAll },
      );
    } else if (params.selectionText && params.selectionText.trim()) {
      items.push({ role: 'copy' });
    }
    if (!items.length) return;
    const win = BrowserWindow.fromWebContents(contents);
    Menu.buildFromTemplate(items).popup(win ? { window: win } : {});
  });

  // DevTools. devTools:false already makes opening them a no-op in the installed app;
  // the shortcuts are swallowed too so the page never sees a keystroke meant for a
  // tool that is not there, and anything that opens them anyway closes them again.
  // From source, the same keys toggle them, since that copy has no menu item for it.
  contents.on('before-input-event', (event, input) => {
    if (!isDevToolsChord(input)) return;
    event.preventDefault();
    if (!PACKAGED && (input.code === 'F12' || input.code === 'KeyI')) contents.toggleDevTools();
  });
  if (PACKAGED) contents.on('devtools-opened', () => contents.closeDevTools());

  // The front end's own diagnostics. With DevTools gone this is where they surface,
  // and it is what the integration test reads to know the page came up clean.
  // One parameter on purpose: Electron warns once per run about any listener declared
  // with the old positional arguments, and everything they carried is on the event.
  contents.on('console-message', details => {
    const { level } = details;
    if (level !== 'warning' && level !== 'error') return;
    const message = String(details.message).replace(/\n/g, '\n    ');
    log(level === 'error' ? 'error' : 'warn',
      `[renderer] ${message.slice(0, 600)} (${where(details.sourceId || '')}:${details.lineNumber || 0}) on ${where(contents.getURL())}`);
  });
  contents.on('render-process-gone', (event, details) => {
    log('error', `[renderer] process gone: ${details.reason} (exit ${details.exitCode}) on ${where(contents.getURL())}`);
  });
  // -3 is ERR_ABORTED: a navigation stopped on purpose, by the guard above or by a newer
  // one replacing it. Logged, but not as a failure, or every link sent to the system
  // browser would read as a broken page.
  contents.on('did-fail-load', (event, code, description, url, isMainFrame) => {
    log(code === -3 ? 'info' : 'error',
      `[renderer] failed to load ${where(url)} (${code} ${description})${isMainFrame ? '' : ' in a subframe'}`);
  });
  contents.on('did-finish-load', () => {
    log('info', `[renderer] loaded "${contents.getTitle()}" at ${where(contents.getURL())}`);
  });
}

// ── Session ────────────────────────────────────────────────────────────────
// Only what the page actually uses, and only for our own pages: fullscreen (a video's
// own fullscreen button goes through it) and writing to the clipboard. Nothing in the
// front end reads the clipboard, opens the microphone or raises a web notification —
// the update notifications come from this process, which needs no permission — so
// those are refused along with location, USB, MIDI, screen capture and the rest,
// without a prompt, because there is nobody to prompt who would know why.
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen']);

// Requests the window may make at all. Our own server, and the schemes a page builds in
// memory. The CSP says the same from inside the page; this says it from outside, where
// nothing the page runs can reach — the second answer to "can this window send anything
// off the machine?".
const INTERNAL_SCHEMES = new Set(['data:', 'blob:', 'devtools:']);
function requestAllowed(raw) {
  if (isOwnUrl(raw, SHELL_PROTOCOLS)) return true;
  try { return INTERNAL_SCHEMES.has(new URL(String(raw)).protocol); } catch { return false; }
}

function headerValue(headers, name) {
  for (const k of Object.keys(headers || {})) {
    if (k.toLowerCase() === name) return [].concat(headers[k])[0];
  }
  return undefined;
}

async function setupSession() {
  const ses = session.defaultSession;

  // Top-level navigations elsewhere never get this far (watchContents turns them into
  // the system browser first). Anything else that tries — an image, a fetch, a redirect
  // hop to another host — is cancelled and said in the log, by origin only.
  ses.webRequest.onBeforeRequest((details, callback) => {
    if (requestAllowed(details.url)) { callback({}); return; }
    log('warn', `blocked a request off the machine: ${where(details.url)} (${details.resourceType || 'request'})`);
    callback({ cancel: true });
  });

  // The token. Stamped by destination — 127.0.0.1, our port — and removed from everything
  // else. Removed, not merely left off: Chromium keeps a request's headers across a
  // redirect, so a hop from our origin to another host would otherwise carry the header
  // added on the first leg. The page never sees it: it is added below the page, after
  // anything the page could read.
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const requestHeaders = { ...details.requestHeaders };
    for (const k of Object.keys(requestHeaders)) if (k.toLowerCase() === SHELL_HEADER) delete requestHeaders[k];
    if (isTokenUrl(details.url)) requestHeaders[SHELL_HEADER] = token;
    callback({ requestHeaders });
  });

  // A Content-Security-Policy on everything our server sends, added here rather than in
  // server.js so the server install is untouched. What it buys is the privacy promise in
  // enforceable form: the window may load and connect to its own server and nothing
  // else — no image, script, font or fetch can reach off the machine, whatever ends up
  // in a prompt, a filename or a page. It is deliberately loose about *scripts*:
  // 'unsafe-eval' because Vue's global build compiles its templates at runtime, and
  // 'unsafe-inline' because the lock screen server.js serves is one self-contained page.
  // The front end loads nothing from elsewhere (CivitAI and ComfyUI are reached by the
  // server, not the page), so none of this refuses anything the app does today.
  //
  // The same hook checks the proof first: a response from our port that does not carry
  // the current server's proof did not come from our server, and is cancelled before
  // the page sees a byte of it. (One onHeadersReceived per session — Electron keeps
  // only the last one registered — which is why the two share it.)
  ses.webRequest.onHeadersReceived((details, callback) => {
    if (!isOwnUrl(details.url, SHELL_PROTOCOLS)) { callback({}); return; }
    if (headerValue(details.responseHeaders, PROOF_HEADER) !== proof) {
      log('warn', `cancelled a response on our port that did not come from our server (${where(details.url)})`);
      callback({ cancel: true });
      return;
    }
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' data: blob:",
      "font-src 'self' data:",
      `connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}`,
      "worker-src 'self' blob:",
      "frame-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ');
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
  });

  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const from = (details && details.requestingUrl) || (contents && contents.getURL()) || '';
    const ok = ALLOWED_PERMISSIONS.has(permission) && isOwnUrl(from, PAGE_PROTOCOLS);
    if (!ok) log('info', `permission refused: ${permission} for ${where(from)}`);
    callback(ok);
  });
  ses.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    const from = requestingOrigin
      || (details && (details.requestingUrl || details.securityOrigin))
      || (contents && contents.getURL()) || '';
    return ALLOWED_PERMISSIONS.has(permission) && isOwnUrl(from, PAGE_PROTOCOLS);
  });

  // The per-page preference stops the checking; this stops the session fetching the
  // dictionaries in the first place, which it does at startup whether a page asks or not.
  try { ses.setSpellCheckerEnabled(false); } catch {}

  // Media the server marks no-store still passes through Chromium's cache on the way to
  // the page, and whatever a previous run left there is emptied before this one shows
  // anything. At startup rather than at quit, deliberately: the quit path belongs to
  // the updater's quit-and-install, and an await there is an install that waits on it.
  try { await ses.clearCache(); } catch (e) { log('warn', `could not clear the HTTP cache: ${e.message}`); }
}

// ── Updates ────────────────────────────────────────────────────────────────
// electron-updater, and only in the installed app: a copy run from source has no
// release feed to compare itself with and no installer to hand over to.
//
// A failed check is silent, on purpose. No network, a release feed not published yet,
// a proxy in the way — none of that is anything the person using the app can act on,
// and a dialog every four hours saying so would train them to dismiss dialogs. The log
// keeps it, and a check asked for from the menu reports it.
const FIRST_CHECK_MS = 10 * 1000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
let updater = null;
let updaterError = null;
let announcedVersion = null;  // "downloading" is said once per version…
let readyVersion = null;      // …and so is "ready", though every later check re-reports it
let readyDialogOpen = false;
let manualCheck = false;
let lastNotification = null;

function notify(title, body) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body });
    n.on('click', focusWindow);
    n.show();
    // Held on purpose: a notification that is garbage-collected loses its click
    // handler, and on Windows the toast outlives the object by minutes.
    lastNotification = n;
  } catch (e) { log('warn', `notification failed: ${e.message}`); }
}

function messageBox(opts) {
  const parent = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() ? mainWindow : null;
  const full = { title: PRODUCT_NAME, noLink: true, ...opts };
  return parent ? dialog.showMessageBox(parent, full) : dialog.showMessageBox(full);
}

function showReadyDialog(version) {
  if (readyDialogOpen) return;
  readyDialogOpen = true;
  messageBox({
    type: 'info',
    message: `${PRODUCT_NAME} ${version} is ready`,
    detail: 'Restart now to install it, or carry on — it installs by itself the next time you quit.\n\n'
      + 'Runs already queued in ComfyUI keep going either way: ComfyUI is a separate program, '
      + 'and the job list picks them back up when the window reopens.',
    buttons: ['Restart now', 'Later'],
    defaultId: 0,
    cancelId: 1,
  }).then(({ response }) => {
    readyDialogOpen = false;
    if (response !== 0) return;
    log('info', `installing ${version} now`);
    // No `quitting` here. It used to be raised first, but quitAndInstall does not throw
    // when it cannot install — it returns, emits an error, and leaves the app running —
    // and a raised flag then meant a server that was never restarted and a window that
    // could not be reopened. The updater's own quit raises it on the way out
    // (before-quit-for-update, before-quit), which is only ever a quit that is happening.
    try { updater.quitAndInstall(); } catch (e) {
      log('error', `[updater] could not install: ${e.message}`);
    }
  }).catch(e => {
    readyDialogOpen = false;
    log('error', `update dialog failed: ${e.message}`);
  });
}

// A download that fails rejects its promise as well as emitting 'error', and a
// rejection nobody catches is a crash report in the log for something already logged.
function quietly(result) {
  if (result && result.downloadPromise) result.downloadPromise.catch(() => {});
  return result;
}

function backgroundCheck() {
  if (!updater) return;
  try {
    updater.checkForUpdates().then(quietly).catch(() => {});
  } catch (e) { log('error', `[updater] check failed: ${e.message}`); }
}

// Can this copy install an update over itself? Everywhere but macOS, yes. On macOS
// Squirrel refuses anything without a Developer ID signature — and electron-updater
// reports the download as ready before Squirrel has said so, so an unsigned build would
// offer "Restart now" and then never restart. Asked of the bundle's own signature at
// runtime (codesign ships with macOS), so there is nothing to keep in step at build time.
let canSelfInstall = !IS_MAC;
function checkMacSignature() {
  return new Promise(resolve => {
    const bundle = path.resolve(process.execPath, '..', '..', '..');
    require('child_process').execFile('/usr/bin/codesign', ['-dv', '--verbose=2', bundle], { timeout: 10000 }, (err, stdout, stderr) => {
      resolve(!err && /Authority=Developer ID Application/.test(String(stderr) + String(stdout)));
    });
  });
}

// Where a copy that cannot install updates sends people instead: the feed this build
// was made with, read from the app-update.yml electron-builder put beside the archive.
function releasesPage() {
  try {
    const yml = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8');
    const get = k => ((yml.match(new RegExp('^' + k + ':\\s*(.+)$', 'm')) || [])[1] || '').trim().replace(/^['"]|['"]$/g, '');
    if (get('provider') === 'github' && get('owner') && get('repo')) {
      return `https://github.com/${get('owner')}/${get('repo')}/releases/latest`;
    }
    return get('url') || null;
  } catch { return null; }
}

function offerDownload(version) {
  const page = releasesPage();
  messageBox({
    type: 'info',
    message: `${PRODUCT_NAME} ${version} is available`,
    detail: 'This copy cannot install updates by itself (it is not signed with an Apple Developer ID). '
      + 'Download the new version and replace this one.',
    buttons: page ? ['Open download page', 'Later'] : ['OK'],
    defaultId: 0,
    cancelId: page ? 1 : 0,
  }).then(({ response }) => { if (page && response === 0) openOutside(page); }).catch(() => {});
}

async function setupUpdater() {
  if (!PACKAGED) return;
  try {
    updater = require('electron-updater').autoUpdater;
  } catch (e) {
    updaterError = e;
    log('error', `[updater] unavailable: ${e.message}`);
    return;
  }
  updater.logger = {
    info: m => log('info', `[updater] ${m}`),
    warn: m => log('warn', `[updater] ${m}`),
    error: m => log('error', `[updater] ${m}`),
  };
  if (IS_MAC) {
    canSelfInstall = await checkMacSignature();
    if (!canSelfInstall) log('info', '[updater] not Developer ID signed: will announce updates, not install them');
  }
  // Nothing is downloaded that cannot be installed.
  updater.autoDownload = canSelfInstall;
  updater.autoInstallOnAppQuit = canSelfInstall;
  // The full installer is what gets published and downloaded; a web installer would be
  // a second, smaller program that fetches the app itself — nothing here builds one.
  updater.disableWebInstaller = true;

  updater.on('update-available', info => {
    if (!info || info.version === announcedVersion || info.version === readyVersion) return;
    announcedVersion = info.version;
    // A check asked for from the menu answers for itself, once, below.
    if (manualCheck) return;
    if (!canSelfInstall) {
      notify('Update available', `${PRODUCT_NAME} ${info.version} is out — download it to update.`);
      offerDownload(info.version);
      return;
    }
    notify('Update available', `Downloading ${PRODUCT_NAME} ${info.version}…`);
  });
  updater.on('update-downloaded', info => {
    const version = (info && info.version) || 'An update';
    if (version === readyVersion) return;
    readyVersion = version;
    notify('Update ready', `${PRODUCT_NAME} ${version} is ready — restart to install it.`);
    showReadyDialog(version);
  });
  updater.on('error', err => log('error', `[updater] ${err && err.message ? err.message : err}`));

  // The app's own quitting flag has to be up before the updater's quit reaches the
  // server, whichever path asked for it. Electron's autoUpdater carries this event on
  // every platform electron-updater supports, native or not.
  try {
    require('electron').autoUpdater.on('before-quit-for-update', () => { quitting = true; });
  } catch {}

  setTimeout(backgroundCheck, FIRST_CHECK_MS);
  setInterval(backgroundCheck, CHECK_EVERY_MS);
}

async function checkForUpdatesManually() {
  if (!PACKAGED) {
    messageBox({
      type: 'info',
      message: 'Updates work in the installed app',
      detail: `This copy of ${PRODUCT_NAME} is running from source, so there is no installed version for an update to replace. Install a release build to get automatic updates.`,
    });
    return;
  }
  if (!updater) {
    messageBox({
      type: 'error',
      message: 'The updater could not be loaded',
      detail: updaterError ? updaterError.message : 'No reason was given.',
    });
    return;
  }
  // Already downloaded: the useful answer is the offer to install it, not a second
  // download of the same file.
  if (readyVersion) { showReadyDialog(readyVersion); return; }
  manualCheck = true;
  try {
    const result = quietly(await updater.checkForUpdates());
    if (result && result.isUpdateAvailable && !canSelfInstall) {
      offerDownload(result.updateInfo.version);
    } else if (result && result.isUpdateAvailable) {
      messageBox({
        type: 'info',
        message: `Downloading ${PRODUCT_NAME} ${result.updateInfo.version}…`,
        detail: 'You will be asked to restart once it has downloaded. Nothing stops in the meantime.',
      });
    } else {
      messageBox({
        type: 'info',
        message: `${PRODUCT_NAME} is up to date`,
        detail: `You have version ${app.getVersion()}, which is the latest.`,
      });
    }
  } catch (e) {
    messageBox({
      type: 'error',
      message: 'Could not check for updates',
      detail: String((e && e.message) || e).slice(0, 600),
    });
  } finally {
    manualCheck = false;
  }
}

// ── Menu ───────────────────────────────────────────────────────────────────
// Nothing that opens DevTools, in either build. The Edit menu is not decoration on
// macOS: that is where Cmd+C and Cmd+V come from, and without it they do nothing in a
// text field. On Windows and Linux the bar is hidden until Alt is pressed.
function buildMenu() {
  const checkItem = { label: 'Check for Updates…', click: () => { checkForUpdatesManually(); } };
  const view = {
    label: 'View',
    submenu: [
      { role: 'reload' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  };
  const template = IS_MAC
    ? [
      {
        label: PRODUCT_NAME,
        submenu: [
          { role: 'about' },
          checkItem,
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
      view,
      { role: 'windowMenu' },
    ]
    : [
      { label: 'File', submenu: [checkItem, { type: 'separator' }, { role: 'quit' }] },
      { role: 'editMenu' },
      view,
    ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Startup ────────────────────────────────────────────────────────────────
async function start() {
  // The session is armed before the first request can leave, and the port is known
  // before the header hook can be asked about it.
  port = await pickPort();
  await setupSession();
  buildMenu();

  log('info', `${PRODUCT_NAME} ${app.getVersion()} · Electron ${process.versions.electron} · `
    + `${PACKAGED ? 'packaged' : 'from source'} · ${process.platform}-${process.arch} · `
    + `data ${DATA_DIR} · port ${port}`);

  try { fs.mkdirSync(path.join(DATA_DIR, 'Media'), { recursive: true }); } catch (e) {
    log('warn', `could not create the media folder: ${e.message}`);
  }

  startServer();
  await firstListening;
  if (quitting) return;
  createWindow();
  setupUpdater().catch(e => log('error', `[updater] setup failed: ${(e && e.message) || e}`));
}

function boot() {
  if (IS_WIN) app.setAppUserModelId(APP_ID);
  // Every renderer sandboxed, not only the windows built here with sandbox:true — a
  // backstop for any webContents created by a path this file did not anticipate.
  app.enableSandbox();

  app.on('second-instance', () => {
    log('info', 'a second launch was handed to this one');
    focusWindow();
  });
  app.on('web-contents-created', (event, contents) => watchContents(contents));

  // macOS keeps an app running with no windows, and the server with it, so reopening
  // from the Dock is instant. Everywhere else, closing the window is quitting.
  app.on('window-all-closed', () => { if (!IS_MAC) app.quit(); });
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) focusWindow(); });

  // before-quit only raises the flag; will-quit, which fires once the quit can no
  // longer be cancelled, is where the server goes. Neither waits on anything.
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', killServer);
  process.on('exit', killServer);

  app.on('child-process-gone', (event, details) => {
    if (details.type === 'Utility') return;   // the server's exits are logged where they are handled
    log('warn', `${details.type} process gone: ${details.reason} (exit ${details.exitCode})`);
  });
  process.on('uncaughtException', e => log('error', `uncaught: ${(e && e.stack) || e}`));
  process.on('unhandledRejection', e => log('error', `unhandled rejection: ${(e && e.stack) || e}`));

  app.whenReady().then(start).catch(e => {
    fatal('ComfyRemix could not start.', `Startup failed: ${(e && e.message) || e}`);
  });
}

// ── Entry ──────────────────────────────────────────────────────────────────
// In this order: the debugging refusal first, before the lock, so a refused launch
// never reaches the running copy as a "second instance" either.
const refused = PACKAGED ? refusedSwitch() : null;
if (refused) {
  log('error', `refusing to start: launched with --${refused}`);
  app.exit(1);
} else if (!app.requestSingleInstanceLock()) {
  // The copy already running has been told (second-instance, above) and will come to
  // the front; this one has nothing to do.
  app.quit();
} else {
  // Rotated only here, by the copy that holds the lock — a second launch rotating the
  // log out from under the running one would split one session across two files.
  rotateLog(MAIN_LOG);
  rotateLog(SERVER_LOG);
  boot();
}
