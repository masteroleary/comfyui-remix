// Brings the server back after POST /api/restart.
//
// A process cannot restart itself: whatever does the starting has to outlive the thing
// being stopped. So the server spawns this detached, replies, and exits; this waits for
// the port to come free, starts a fresh instance, and confirms it answers.
//
// HOW it starts one is config, not a guess. `restartCmd` exists because the naive answer
// -- respawn `node server.js` -- silently breaks a supervised install: under a Windows
// scheduled task the new process would no longer belong to the task, so Stop-ScheduledTask
// would not control it and the next boot would start a second one alongside. There the
// right move is to let the old process exit (which completes the task instance) and then
// ask the scheduler for a fresh one:
//     "restartCmd": ["schtasks", "/run", "/tn", "ComfyRemixAutoStart"]
// With no restartCmd it falls back to `node server.js` here, which is correct for a plain
// `npm start`.
//
// Everything is logged to restart.log beside this file, because the one moment you need
// to know why a restart failed is the moment the app is not there to tell you.
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = process.env.COMFYREMIX_CONFIG || './config.json';
let config = {};
try { config = require(path.resolve(CONFIG_PATH)); } catch { /* default port still applies */ }
const port = parseInt(config.port, 10) || 8080;

const LOG = path.join(__dirname, 'restart.log');
function log(msg) {
  const line = new Date().toISOString() + '  ' + msg + '\n';
  try { fs.appendFileSync(LOG, line); } catch {}
  process.stdout.write(line);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Same two-question probe as restart.js: a connect finds a listener wherever it is bound,
// a bind catches one that is up but not yet accepting. Binding alone is wrong on Windows,
// where 127.0.0.1 and 0.0.0.0 can hold the same port at once.
function canConnect(host) {
  return new Promise(resolve => {
    const sock = net.connect({ host, port, timeout: 1000 });
    const end = v => { sock.destroy(); resolve(v); };
    sock.once('connect', () => end(true));
    sock.once('error', () => end(false));
    sock.once('timeout', () => end(false));
  });
}
function bindBusy(host) {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.once('error', e => resolve(e.code === 'EADDRINUSE' || e.code === 'EACCES'));
    probe.once('listening', () => probe.close(() => resolve(false)));
    probe.listen(port, host);
  });
}
async function portBusy() {
  const hosts = ['127.0.0.1'];
  const h = config.httpHost;
  if (h && h !== '0.0.0.0' && h !== '::' && !hosts.includes(h)) hosts.push(h);
  for (const host of hosts) { if (await canConnect(host)) return true; }
  return bindBusy('0.0.0.0');
}
async function waitFor(want, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await portBusy() === want) return true;
    await sleep(200);
  }
  return false;
}

function startServer() {
  const cmd = config.restartCmd;
  const opts = { detached: true, stdio: 'ignore', windowsHide: true, cwd: __dirname };
  let proc;
  try {
    if (Array.isArray(cmd) && cmd.length) { log('starting via restartCmd: ' + cmd.join(' ')); proc = spawn(cmd[0], cmd.slice(1), opts); }
    else if (typeof cmd === 'string' && cmd.trim()) { log('starting via restartCmd: ' + cmd); proc = spawn(cmd, Object.assign({ shell: true }, opts)); }
    else { log('starting via: node server.js'); proc = spawn(process.execPath, ['server.js'], opts); }
  } catch (e) { log('spawn threw: ' + e.message); return; }
  // A failed exec arrives as an async event, not a throw -- the same trap that once took
  // the whole server down from /api/comfy/start.
  proc.on('error', e => log('spawn failed: ' + e.message));
  proc.unref();
}

(async () => {
  log('--- restart requested (port ' + port + ') ---');

  // The server replies before exiting, so it is still listening for a moment.
  if (!await waitFor(false, 20000)) {
    log('ABORT: port ' + port + ' never came free -- the old server is still holding it. '
      + 'Not starting a second one.');
    process.exit(1);
  }
  log('port free');

  startServer();
  if (await waitFor(true, 40000)) { log('OK -- listening again'); process.exit(0); }

  // One retry. A restart that fails leaves the app unreachable, which for a remote user
  // means no way to fix it -- worth a second attempt before giving up.
  log('did not come back within 40s; retrying once');
  startServer();
  if (await waitFor(true, 40000)) { log('OK -- listening after retry'); process.exit(0); }

  log('FAILED: the server did not come back. Start it by hand on the machine.');
  process.exit(1);
})();
