// Stop whatever is listening on the configured port, wait for the port to
// actually come free, then start a fresh detached server.
//
// Asking the OS which process owns a port is the one step with no portable
// answer — Windows has netstat + taskkill, POSIX has lsof or ss or fuser and a
// signal, and none of the three POSIX tools is guaranteed to be installed. So
// the port itself is the source of truth: binding it is a portable test that
// needs no external tool, and the lookup only runs once that test says
// something is there.
//
// What matters more than the lookup is that a failed one is not silent. The
// first version swallowed every error into "nothing is listening" and then
// spawned a second server, which died on EADDRINUSE with the old one still
// serving stale code — a restart that reported success and changed nothing.
const { execSync, spawn } = require('child_process');
const net = require('net');
const path = require('path');

// Same resolution as server.js: with COMFYREMIX_CONFIG set, a second instance
// runs on its own port, and reading ./config.json here would probe and kill the
// wrong one — or nothing, and then spawn a doomed server on top of it.
const CONFIG_PATH = process.env.COMFYREMIX_CONFIG || './config.json';
let config = {};
try { config = require(path.resolve(CONFIG_PATH)); } catch { /* no config yet — the default port still applies */ }
const port = parseInt(config.port, 10) || 8080;
const IS_WIN = process.platform === 'win32';

// How long a graceful stop gets before escalating, and how long after a forced
// kill before giving up rather than starting a second server.
const GRACE_MS = 5000, FORCE_MS = 3000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// "Is anything holding this port?" — portable, and no external tool involved.
// It asks twice because neither question answers it alone: a connect finds a
// listener wherever it happens to be bound, and a bind finds one that is up but
// not yet accepting. Binding by itself is what a first cut did, and it is wrong
// exactly where it matters — Windows lets 127.0.0.1 and 0.0.0.0 hold the same
// port at once, so the probe came back "free" with the old server still serving.
function canConnect(host, budget) {
  return new Promise(resolve => {
    const sock = net.connect({ host, port, timeout: Math.max(100, Math.min(1000, budget == null ? 1000 : budget)) });
    const end = v => { sock.destroy(); resolve(v); };
    sock.once('connect', () => end(true));
    sock.once('error', () => end(false));
    sock.once('timeout', () => end(false));
  });
}
// Resolves the error code rather than a boolean, so the caller can tell "someone
// else has it" from "this account may not bind it at all".
function bindErr(host) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', e => resolve(e.code || 'EUNKNOWN'));
    probe.once('listening', () => probe.close(() => resolve(null)));
    probe.listen(port, host);
  });
}
let lastBindErr = null;
async function portBusy(budget) {
  // httpHost matters when it names one interface: a loopback connect misses a
  // server bound only to a LAN or VPN address.
  const hosts = ['127.0.0.1'];
  const h = config.httpHost;
  if (h && h !== '0.0.0.0' && h !== '::' && !hosts.includes(h)) hosts.push(h);
  for (const host of hosts) { if (await canConnect(host, budget)) return true; }
  lastBindErr = await bindErr('0.0.0.0');
  return lastBindErr === 'EADDRINUSE' || lastBindErr === 'EACCES';
}

async function waitFree(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!await portBusy(deadline - Date.now())) return true;
    await sleep(150);
  }
  return false;
}
// The mirror of waitFree, used to confirm the new server actually came up.
async function waitListening(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await portBusy(deadline - Date.now())) return true;
    await sleep(200);
  }
  return false;
}

// Only called once the port is known to be busy, so an empty result means "no
// tool here could tell me who has it" rather than "nobody has it" — the caller
// depends on that distinction to refuse rather than restart blindly.
function listenerPids() {
  const run = cmd => {
    // Bounded: lsof in particular can stall on a dead network mount, and a
    // restart that hangs forever is worse than one that falls through to the
    // next probe.
    try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }); }
    catch (e) { return e && e.stdout ? String(e.stdout) : ''; }   // no match and no such tool both exit non-zero
  };
  const probes = IS_WIN
    ? [() => run('netstat -ano -p TCP')
         .split(/\r?\n/)
         .filter(l => /LISTENING/i.test(l) && new RegExp('[:.]' + port + '\\s').test(l))
         .map(l => l.trim().split(/\s+/).pop())]
    : [
        // -sTCP:LISTEN matters: without it a browser's open connection to the
        // old server counts as a match and we try to kill the browser.
        () => run('lsof -ti tcp:' + port + ' -sTCP:LISTEN').split(/\s+/),
        () => (run('ss -lptnH sport = :' + port).match(/pid=(\d+)/g) || []).map(m => m.slice(4)),
        () => run('fuser -n tcp ' + port).split(/\s+/),
      ];
  for (const probe of probes) {
    let pids = [];
    try { pids = probe(); } catch { continue; }
    pids = [...new Set(pids.map(String).map(s => s.trim()).filter(s => /^\d+$/.test(s) && s !== '0'))];
    if (pids.length) return pids;
  }
  return [];
}

// Returns null on success, or the error — a taskkill "Access is denied" or an
// EPERM is the whole reason the stop failed, and swallowing it leaves only the
// downstream "still held" line with no cause. ESRCH is the benign one: the
// process exited between the lookup and the signal.
function killPid(pid, force) {
  try {
    // /T takes the children with it: a launcher script that spawned node leaves
    // the port held by a process whose pid nobody asked about.
    if (IS_WIN) execSync('taskkill /PID ' + pid + ' /F /T', { stdio: 'ignore' });
    else process.kill(Number(pid), force ? 'SIGKILL' : 'SIGTERM');
    return null;
  } catch (e) { return e; }
}
function reportKill(pid, err) {
  if (!err || err.code === 'ESRCH') return;
  console.error('  could not stop PID ' + pid + ': ' + (err.code ? err.code + ' — ' : '') + err.message);
}

(async () => {
  if (await portBusy()) {
    if (lastBindErr === 'EACCES') {
      console.error('This account cannot bind port ' + port + ' (privileged or OS-reserved), so the server will not start either.');
      console.error('Pick a port above 1024, or run with the privileges the port needs.');
      process.exit(1);
    }
    const pids = listenerPids();
    if (!pids.length) {
      console.error('Port ' + port + ' is in use, but no process on this host could be identified as the owner.');
      console.error(IS_WIN
        ? '  Try: netstat -ano -p TCP | findstr :' + port
        : '  Try: lsof -i tcp:' + port + '   (install lsof, iproute2 or psmisc so this can find it automatically)');
      console.error('Stop it by hand and run this again — starting now would just EADDRINUSE.');
      process.exit(1);
    }
    console.log('Stopping PID ' + pids.join(', ') + ' on port ' + port + '...');
    for (const pid of pids) reportKill(pid, killPid(pid, false));
    if (!await waitFree(GRACE_MS)) {
      // Off Windows this escalates SIGTERM to SIGKILL. On Windows the first pass
      // was already taskkill /F, so this is a retry plus a second wait window.
      for (const pid of pids) reportKill(pid, killPid(pid, true));
      if (!await waitFree(FORCE_MS)) {
        console.error('Port ' + port + ' is still held after killing ' + pids.join(', ') + ' — not starting a second server.');
        process.exit(1);
      }
    }
  }

  console.log('Starting server...');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: __dirname,
    stdio: 'inherit',
    detached: true,
  });
  let died = null;
  child.on('error', e => { died = e; });
  child.on('exit', code => { died = died || new Error('server.js exited with code ' + code); });
  child.unref();

  // Wait for the port to answer rather than exiting on a fixed timer: a server
  // that dies on startup used to leave this reporting success and exiting 0.
  if (await waitListening(10000)) { console.log('Listening on port ' + port + '.'); process.exit(0); }
  console.error(died ? 'Server failed to start: ' + died.message
                     : 'Server did not start listening on port ' + port + ' within 10s.');
  process.exit(1);
})();
