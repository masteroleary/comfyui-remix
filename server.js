const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

// Import-time "field config" generator (docs/field-config): scans a workflow and
// emits the user-facing fields the generate form should offer. Prototype/design
// lives under docs/field-config/; required here as the runtime module.
let fieldConfigGen = null;
try { fieldConfigGen = require('./docs/field-config/gen_field_config.js'); }
catch (e) { console.log('[FieldConfig] generator unavailable:', e.message); }

// Load config
// COMFYREMIX_CONFIG lets a second instance run against its own config file. Without
// it, a test instance shares — and rewrites — the live one, which is a good way to
// destroy settings the running server is still holding in memory.
const CONFIG_PATH = process.env.COMFYREMIX_CONFIG || path.join(__dirname, 'config.json');
// Strip a BOM before parsing: PowerShell's Out-File/Set-Content write UTF-8 *with*
// one by default, and JSON.parse chokes on it — an edit from a shell would
// otherwise leave the server unable to start at all (workflow files get the same
// treatment where they're read).
const readConfigFile = () => JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8').replace(/^﻿/, ''));
const config = fs.existsSync(CONFIG_PATH) ? readConfigFile() : {};

const PORT = parseInt(process.argv[2], 10) || config.port || 8080;
const ROOT = process.argv[3] ? path.resolve(process.argv[3]) : (config.mediaDir || path.join(__dirname, 'Media'));
// The media root IS the Favorites collection — favoriting moves files here and
// the app exposes it as the single "Favorites" tab (no separate Archive tab).
const FAVORITES_DIR = ROOT;

let COMFY_OUTPUT = config.comfyOutput || 'D:\\ComfyUI-Easy-Install\\ComfyUI\\output';
let COMFY_DIR = config.comfyDir || 'D:\\ComfyUI-Easy-Install\\ComfyUI';
// Mutable so the Settings panel can hot-reload them without a server restart.
let COMFY_URL = config.comfyUrl || 'http://127.0.0.1:8188';

// Host/port of the ComfyUI API for the raw HTTP/WS proxies
function comfyHostPort() {
  try {
    const u = new URL(COMFY_URL);
    return { hostname: u.hostname, port: parseInt(u.port, 10) || (u.protocol === 'https:' ? 443 : 80) };
  } catch { return { hostname: '127.0.0.1', port: 8188 }; }
}
let CIVITAI_API_KEY = config.civitaiApiKey || '';

// Re-read config.json and refresh the live key/URL values (called after Settings save)
function reloadConfig() {
  let fresh = {};
  try { fresh = readConfigFile(); } catch { return false; }
  Object.assign(config, fresh);
  COMFY_URL = config.comfyUrl || 'http://127.0.0.1:8188';
  CIVITAI_API_KEY = config.civitaiApiKey || '';
  if (config.comfyDir) { COMFY_DIR = config.comfyDir; WORKFLOWS_DIR = path.join(COMFY_DIR, 'user', 'default', 'workflows'); }
  if (config.comfyOutput) COMFY_OUTPUT = config.comfyOutput;
  if (typeof buildNsfwRe === 'function') NSFW_RE = buildNsfwRe(); // list may have changed
  return true;
}
// ── Password gate (optional) ───────────────────────────────────────────────
// config.auth = { enabled: bool, hash: "scrypt$<salt>$<key>" }. Only the hash is
// stored — never the password — and the gate stays OFF unless a hash exists, so a
// half-finished setup can't lock the app with no way back in.
//
// A session is a signed expiry rather than a row in a session table: nothing to
// persist, so a server restart (frequent here — every server.js edit) doesn't log
// everyone out. The signing key is derived from the password hash, which means
// changing or clearing the password invalidates every outstanding session for free.
const AUTH_COOKIE = 'crx_auth';
const AUTH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AUTH_WINDOW_MS = 5 * 60 * 1000;
const AUTH_MAX_FAILS = 60;    // the login box checks per keystroke, so this is generous by design
const AUTH_MIN_LEN = 7;       // mirrored in the Settings panel, which won't arm the gate below it
function authState() {
  const a = (config.auth && typeof config.auth === 'object') ? config.auth : {};
  const hash = typeof a.hash === 'string' ? a.hash : '';
  return { enabled: !!a.enabled && !!hash, hasPassword: !!hash, hash };
}
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return 'scrypt$' + salt + '$' + crypto.scryptSync(String(pw), salt, 32).toString('hex');
}
// Async on purpose: scrypt is deliberately slow (~80ms), and the login box submits
// on keyup — doing this synchronously would stall the whole server per keystroke.
function verifyPassword(pw, stored, cb) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') { cb(false); return; }
  let want; try { want = Buffer.from(parts[2], 'hex'); } catch { cb(false); return; }
  if (!want.length) { cb(false); return; }
  crypto.scrypt(String(pw), parts[1], want.length, (err, dk) =>
    cb(!err && dk.length === want.length && crypto.timingSafeEqual(dk, want)));
}
const sessionSig = (exp, hash) =>
  crypto.createHmac('sha256', 'ComfyRemix/session/' + hash).update(String(exp)).digest('hex').slice(0, 32);
const makeSession = (hash, ttlMs) => { const exp = Date.now() + (ttlMs || AUTH_TTL_MS); return exp + '.' + sessionSig(exp, hash); };
function validSession(tok, hash) {
  const [expStr, sig] = String(tok || '').split('.');
  const exp = parseInt(expStr, 10);
  // Shape-check the signature before comparing: timingSafeEqual throws on a length
  // mismatch, and a cookie is attacker-controlled — a non-hex one would decode to a
  // differently-sized buffer and take the server down with it.
  if (!exp || exp <= Date.now() || !/^[0-9a-f]{32}$/.test(sig || '')) return false;
  return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(sessionSig(exp, hash), 'hex'));
}
function cookieVal(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}
function setSessionCookie(req, res, tok) {
  // Secure only over TLS — the HTTP listener is loopback/LAN, where a Secure
  // cookie would simply never be stored and login would appear to do nothing.
  const secure = (req.socket && req.socket.encrypted) ? '; Secure' : '';
  res.setHeader('Set-Cookie', AUTH_COOKIE + '=' + (tok || '') + '; Path=/; HttpOnly; SameSite=Lax; Max-Age='
    + (tok ? Math.floor(AUTH_TTL_MS / 1000) : 0) + secure);
}
function isAuthed(req) {
  const st = authState();
  return !st.enabled || validSession(cookieVal(req, AUTH_COOKIE), st.hash);
}
// Failed-attempt throttle, keyed by peer address. Brute force is already priced out
// by scrypt; this caps the damage a script can do while leaving room for a human
// typing (and re-typing) a password with per-keystroke checking.
const authFails = new Map();
const clientIp = req => (req.socket && req.socket.remoteAddress) || '?';
function throttleWait(ip) {
  const rec = authFails.get(ip);
  if (!rec) return 0;
  const age = Date.now() - rec.first;
  if (age > AUTH_WINDOW_MS) { authFails.delete(ip); return 0; }
  return rec.n >= AUTH_MAX_FAILS ? Math.ceil((AUTH_WINDOW_MS - age) / 1000) : 0;
}
function noteAuthAttempt(ip) {
  const now = Date.now();
  // Own-entry expiry is handled above; this sweeps the ones nobody asks about
  // again, so a spray from many addresses can't grow the map without bound in a
  // process that stays up for weeks.
  if (authFails.size > 200) for (const [k, v] of authFails) if (now - v.first > AUTH_WINDOW_MS) authFails.delete(k);
  const rec = authFails.get(ip);
  if (!rec || now - rec.first > AUTH_WINDOW_MS) authFails.set(ip, { n: 1, first: now });
  else rec.n++;
}
// scrypt is ~16MB and ~80ms per call by design, so unbounded concurrent logins are
// a way to exhaust memory and the libuv pool. Attempts past this are refused
// outright rather than queued — a human types one at a time.
let authInFlight = 0;
const AUTH_MAX_INFLIGHT = 4;
// The lock screen. Self-contained by necessity: with the gate on, every other
// asset (common.css, the vendored Vue, even the favicon) is behind it too.
const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>ComfyRemix</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{background:#0d0d0d;color:#f2f2f7;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;
  display:flex;align-items:center;justify-content:center;padding:24px}
.box{width:100%;max-width:300px;text-align:center}
.lock{font-size:30px;opacity:.5;margin-bottom:18px;transition:opacity .2s}
input{width:100%;background:#1c1c1e;color:#f2f2f7;border:1px solid #38383a;border-radius:10px;
  padding:14px 16px;font-size:16px;text-align:center;outline:none;transition:border-color .15s}
input:focus{border-color:#0a84ff}
body.bad input{border-color:#ff453a}
#msg{min-height:18px;margin-top:12px;font-size:12px;color:#ff453a}
@keyframes shake{10%,90%{transform:translateX(-2px)}30%,70%{transform:translateX(4px)}50%{transform:translateX(-4px)}}
body.bad .box{animation:shake .3s}
</style></head><body>
<div class="box">
  <div class="lock">&#128274;</div>
  <!-- autocomplete=off, and no <form> or username field: with either of those the
       browser puts its own save/fill credential UI over the single box. -->
  <input id="pw" type="password" autocomplete="off" autofocus
    autocorrect="off" autocapitalize="off" spellcheck="false" aria-label="Password">
  <div id="msg"></div>
</div>
<script>
(function(){
  var inp=document.getElementById('pw'),msg=document.getElementById('msg'),t=null,busy=false,sent='';
  function check(){
    var v=inp.value;
    if(busy||!v||v===sent)return;
    busy=true;sent=v;
    fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
      credentials:'same-origin',body:JSON.stringify({password:v})})
      .then(function(r){return r.json().then(function(d){return{s:r.status,d:d||{}};},function(){return{s:r.status,d:{}};});})
      .then(function(o){
        busy=false;
        if(o.d.ok){document.querySelector('.lock').innerHTML='&#128275;';location.reload();return;}
        if(o.s===429){msg.textContent=o.d.error||'Too many attempts';document.body.classList.add('bad');
          setTimeout(function(){document.body.classList.remove('bad');},400);return;}
        msg.textContent='';
        if(inp.value!==sent)check();          // kept typing while that one was in flight
      })
      .catch(function(){busy=false;msg.textContent='Server unreachable';});
  }
  function queue(){clearTimeout(t);t=setTimeout(check,220);}   // debounced so one word isn't 20 requests
  inp.addEventListener('keyup',function(e){
    if(e.key==='Enter'){clearTimeout(t);sent='';check();}else queue();
  });
  inp.addEventListener('input',queue);       // paste / password-manager autofill
  inp.focus();
})();
</script></body></html>`;

// Detect whether an Imagine error looks like a content-moderation rejection
function isModerationError(msg) {
  if (!msg || typeof msg !== 'string') return false;
  const m = msg.toLowerCase();
  // Avoid false-positive on SSL/network errors that happen to contain "content"
  if (isTransientNetworkError(msg)) return false;
  return m.includes('moderat') || m.includes('policy') || m.includes('safety') || m.includes('blocked') || m.includes('rejected') || m.includes('flagged') || m.includes('filter') || m.includes('violat');
}

// Detect transient network/SSL errors so we can retry without sanitizing
function isTransientNetworkError(msg) {
  if (!msg || typeof msg !== 'string') return false;
  const m = msg.toLowerCase();
  return m.includes('ssl') || m.includes('tls') || m.includes('econn') || m.includes('epipe') || m.includes('etimedout') || m.includes('socket hang up') || m.includes('timeout') || m.includes('fetch failed') || m.includes('network') || m.includes('bad record mac') || m.includes('ehostunreach');
}

// Rewrite a prompt to dodge moderation: add tasteful-framing hints + strip risky words.
// Rewrites a rejected image prompt toward the platform's content policy
// (adds covering, tones down wording, forces adult-only terms) for one retry.
// Filter terms are stored base64-encoded: each rule is { t: [terms to match], r: replacement }.
const B64D = s => Buffer.from(s, 'base64').toString('utf8');
const SANITIZE_RULES = [
  { t: ['bnVkZQ==', 'bmFrZWQ='], r: 'd2VhcmluZyBhIHNtYWxsIHRob25n' },
  { t: ['ZXhwbGljaXQ=', 'Z3JhcGhpYw==', 'cG9ybm9ncmFwaGlj'], r: 'c3VnZ2VzdGl2ZSBidXQgdGFzdGVmdWw=' },
  { t: ['eW91bmc=', 'dGVlbg==', 'dW5kZXJhZ2U=', 'bWlub3I=', 'Y2hpbGQ=', 'Z2lybA==', 'Ym95'], r: 'YWR1bHQ=' },
];
function sanitizePromptForRetry(prompt) {
  let p = String(prompt || '');
  for (const rule of SANITIZE_RULES) {
    const re = new RegExp('\\b(' + rule.t.map(B64D).join('|') + ')\\b', 'gi');
    p = p.replace(re, B64D(rule.r));
  }
  if (!/tasteful|implied|r-rated/i.test(p)) {
    p += ', tasteful composition, cinematic framing, within R-rated movie bounds';
  }
  return p;
}


// Extract metadata from PNG tEXt chunks (no dependencies)
function extractPngMetadata(filePath, cb) {
  fs.open(filePath, 'r', (err, fd) => {
    if (err) return cb(err);
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;
    // Read up to 10MB for metadata (some workflows are huge)
    const maxRead = Math.min(fileSize, 10 * 1024 * 1024);
    const buf = Buffer.alloc(maxRead);
    fs.read(fd, buf, 0, maxRead, 0, (err2) => {
      fs.close(fd, () => {});
      if (err2) return cb(err2);

      // Verify PNG signature
      const sig = buf.slice(0, 8);
      if (sig.toString('hex') !== '89504e470d0a1a0a') return cb(null, { prompt: null, workflow: null });

      const meta = {};
      let offset = 8;
      while (offset + 8 < maxRead) {
        const len = buf.readUInt32BE(offset);
        const type = buf.slice(offset + 4, offset + 8).toString('ascii');
        if (offset + 12 + len > maxRead) break;

        if (type === 'tEXt') {
          const data = buf.slice(offset + 8, offset + 8 + len);
          const nullIdx = data.indexOf(0);
          if (nullIdx >= 0) {
            const key = data.slice(0, nullIdx).toString('ascii');
            const val = data.slice(nullIdx + 1).toString('utf8');
            if (key === 'prompt' || key === 'workflow') {
              try { meta[key] = JSON.parse(val); } catch { meta[key] = val; }
            }
          }
        } else if (type === 'iTXt') {
          const data = buf.slice(offset + 8, offset + 8 + len);
          const nullIdx = data.indexOf(0);
          if (nullIdx >= 0) {
            const key = data.slice(0, nullIdx).toString('ascii');
            // iTXt: keyword \0 compression_flag \0 compression_method \0 language \0 translated_keyword \0 text
            if (key === 'prompt' || key === 'workflow') {
              let pos = nullIdx + 1;
              // skip compression flag, method
              pos += 2;
              // skip language tag (null-terminated)
              const langEnd = data.indexOf(0, pos);
              pos = langEnd + 1;
              // skip translated keyword (null-terminated)
              const transEnd = data.indexOf(0, pos);
              pos = transEnd + 1;
              const val = data.slice(pos).toString('utf8');
              try { meta[key] = JSON.parse(val); } catch { meta[key] = val; }
            }
          }
        }
        // IEND — stop
        if (type === 'IEND') break;
        offset += 12 + len; // 4 len + 4 type + data + 4 crc
      }
      cb(null, { prompt: meta.prompt || null, workflow: meta.workflow || null });
    });
  });
}

// ── ffmpeg/ffprobe resolution ───────────────────────────────────────────
// A service account gets a minimal PATH on every platform — Windows SYSTEM does
// not see per-user WinGet Links, and systemd/launchd units do not see Homebrew
// or /usr/local — so resolve to an absolute path at startup (config `ffmpegDir`
// overrides), falling back to the bare name for a normal PATH lookup.
const IS_WIN = process.platform === 'win32';
const FF_INSTALL_HINT = IS_WIN ? 'winget install Gyan.FFmpeg'
  : process.platform === 'darwin' ? 'brew install ffmpeg'
  : 'apt install ffmpeg';
function findFfBin(name) {
  const exe = IS_WIN ? name + '.exe' : name;
  if (config.ffmpegDir) {
    const p = path.join(config.ffmpegDir, exe);
    if (fs.existsSync(p)) return p;
  }
  const candidates = [];
  if (IS_WIN) {
    try {
      for (const u of fs.readdirSync('C:\\Users')) {
        candidates.push(path.join('C:\\Users', u, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', exe));
      }
    } catch {}
    candidates.push('C:\\ProgramData\\chocolatey\\bin\\' + exe);
  } else {
    for (const d of ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/snap/bin', '/var/lib/flatpak/exports/bin']) {
      candidates.push(path.join(d, exe));
    }
  }
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch {} }
  return name;
}
const FFPROBE_BIN = findFfBin('ffprobe');
const FFMPEG_BIN = findFfBin('ffmpeg');

// Resolving a path is not the same as having a working binary: findFfBin falls
// back to the bare name, which "resolves" fine and then fails at spawn time
// under a service account that has no user PATH -- the exact failure that makes
// video metadata come back null with nothing logged. So actually run each one.
// Successes are cached (they cannot change without a restart); failures are
// re-probed shortly after, so installing ffmpeg does not need an app restart.
let ffCheck = null, ffCheckTs = 0;
function ffBinVersion(bin) {
  return new Promise(resolve => {
    try {
      execFile(bin, ['-version'], { timeout: 5000, windowsHide: true }, (err, stdout) => {
        if (err) return resolve(null);
        const m = String(stdout || '').match(/version\s+(\S+)/i);
        resolve(m ? m[1] : 'installed');
      });
    } catch { resolve(null); }
  });
}
async function checkFfmpeg() {
  const ttl = ffCheck && ffCheck.ok ? 300000 : 15000;
  if (ffCheck && Date.now() - ffCheckTs < ttl) return ffCheck;
  const [ffmpeg, ffprobe] = await Promise.all([ffBinVersion(FFMPEG_BIN), ffBinVersion(FFPROBE_BIN)]);
  ffCheck = { ok: !!(ffmpeg && ffprobe), ffmpeg, ffprobe, ffmpegPath: FFMPEG_BIN, ffprobePath: FFPROBE_BIN };
  ffCheckTs = Date.now();
  return ffCheck;
}

// Full stream + format probe as a promise. `-v quiet` means a failure leaves
// stderr empty, so the caller gets a named error rather than a blank one.
function ffprobeMedia(file) {
  return new Promise((resolve, reject) => {
    execFile(FFPROBE_BIN, ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', file],
      { timeout: 20000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        if (err) { reject(new Error('Could not read ' + path.basename(file) + ' (is ffprobe installed?)')); return; }
        let data = null;
        try { data = JSON.parse(stdout); } catch {}
        if (!data || !data.streams) { reject(new Error('No stream info for ' + path.basename(file))); return; }
        resolve(data);
      });
  });
}

// spawn (not execFile) so a long encode isn't bounded by a stdout buffer, and
// so a wedged ffmpeg can be killed. Only the tail of stderr is kept — enough to
// report why it failed without holding a whole encode log in memory.
function runFfmpeg(args, timeoutMs = 30 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, args, { windowsHide: true });
    let tail = '', timedOut = false;
    proc.stderr.on('data', d => { tail = (tail + d).slice(-4000); });
    const timer = setTimeout(() => { timedOut = true; try { proc.kill('SIGKILL'); } catch {} }, timeoutMs);
    proc.on('error', e => { clearTimeout(timer); reject(new Error('ffmpeg could not start: ' + e.message)); });
    proc.on('close', code => {
      clearTimeout(timer);
      if (timedOut) { reject(new Error('ffmpeg timed out after ' + Math.round(timeoutMs / 60000) + ' min')); return; }
      if (code === 0) { resolve(tail); return; }
      const why = tail.trim().split('\n').filter(Boolean).slice(-2).join(' | ');
      reject(new Error('ffmpeg failed (exit ' + code + ')' + (why ? ': ' + why : '')));
    });
  });
}

// ── PNG text-chunk writing (no dependencies) ────────────────────────────
// Used to write a fixed workflow back into a generated image's metadata.
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.slice(4, 8 + data.length)), 8 + data.length);
  return out;
}

// tEXt for pure-ASCII payloads (what ComfyUI writes normally), iTXt (UTF-8,
// uncompressed) when the JSON contains non-ASCII — both are read back by
// extractPngMetadata and by PIL/ComfyUI.
function pngTextChunk(keyword, text) {
  const kw = Buffer.from(keyword, 'latin1');
  if (!/[^\x00-\x7f]/.test(text)) {
    return pngChunk('tEXt', Buffer.concat([kw, Buffer.from([0]), Buffer.from(text, 'latin1')]));
  }
  // iTXt: keyword \0 compFlag(0) compMethod(0) lang \0 translated \0 utf8-text
  return pngChunk('iTXt', Buffer.concat([kw, Buffer.from([0, 0, 0, 0, 0]), Buffer.from(text, 'utf8')]));
}

// Replace/insert text chunks (by keyword) in a PNG, atomically via tmp+rename.
function embedPngText(filePath, textMap, cb) {
  fs.readFile(filePath, (err, buf) => {
    if (err) return cb(err);
    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    if (buf.length < 8 || !buf.slice(0, 8).equals(sig)) return cb(new Error('Not a valid PNG'));
    const drop = new Set(Object.keys(textMap));
    const keep = [];
    let offset = 8, sawEnd = false;
    while (offset + 12 <= buf.length) {
      const len = buf.readUInt32BE(offset);
      const type = buf.toString('ascii', offset + 4, offset + 8);
      const end = offset + 12 + len;
      if (end > buf.length) return cb(new Error('Corrupt PNG (truncated chunk)'));
      let dropIt = false;
      if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
        const data = buf.slice(offset + 8, offset + 8 + len);
        const nul = data.indexOf(0);
        if (nul !== -1 && drop.has(data.toString('latin1', 0, nul))) dropIt = true;
      }
      if (!dropIt) keep.push(buf.slice(offset, end));
      offset = end;
      if (type === 'IEND') { sawEnd = true; break; }
    }
    if (!sawEnd || !keep.length || keep[0].toString('ascii', 4, 8) !== 'IHDR') {
      return cb(new Error('Corrupt PNG (missing IHDR/IEND)'));
    }
    const inserted = Object.entries(textMap).map(([k, v]) => pngTextChunk(k, v));
    const out = Buffer.concat([sig, keep[0], ...inserted, ...keep.slice(1)]);
    const tmp = filePath + '.tmp_embed';
    fs.writeFile(tmp, out, err2 => {
      if (err2) return cb(err2);
      fs.rename(tmp, filePath, cb);
    });
  });
}

// Write workflow metadata into a video's container 'comment' tag (the same
// place extractVideoMetadata reads it from) via an ffmpeg stream-copy remux.
// The JSON goes through an FFMETADATA file — it's far too big for a command line.
function ffmetaEscape(s) {
  return s.replace(/[\\=;#\n]/g, m => '\\' + m);
}
function embedVideoText(filePath, comment, cb) {
  const ext = path.extname(filePath);
  const tmpOut = filePath + '.tmp_embed' + ext;
  const metaFile = filePath + '.tmp_ffmeta.txt';
  fs.writeFile(metaFile, ';FFMETADATA1\ncomment=' + ffmetaEscape(comment) + '\n', (werr) => {
    if (werr) return cb(werr);
    execFile(FFMPEG_BIN, ['-v', 'error', '-y', '-i', filePath, '-i', metaFile, '-map', '0', '-map_metadata', '1', '-c', 'copy', tmpOut],
      { timeout: 120000 }, (err, stdout, stderr) => {
      fs.unlink(metaFile, () => {});
      if (err) { fs.unlink(tmpOut, () => {}); return cb(new Error('ffmpeg failed: ' + (String(stderr || err.message).trim().slice(0, 300)))); }
      fs.rename(tmpOut, filePath, cb);
    });
  });
}

// Extract metadata from video files using ffprobe
// ── Prompt search index ─────────────────────────────────────────────────
// Maps PNG path -> embedded prompt text so /api/list search can match prompt
// words, not just file names. Incremental by mtime, persisted across restarts.
const PROMPT_INDEX_PATH = path.join(__dirname, 'app-prompt-index.json');
const PROMPT_INDEX_VERSION = 5; // bump to force a full re-extract after extractor changes (v5: ffprobe was unresolvable under SYSTEM, so all videos indexed empty)

// Content filter: indexed prompt text is matched against a term list (stored
// base64-encoded — same repo-hygiene pattern as SANITIZE_RULES). An entry that
// matches gets n:1 and is omitted entirely when the client requests safe=1.
//
// These four are a starting point, not a vocabulary. The list is meant to be
// yours: add the words your own library actually uses, in Settings > Privacy.
// Shipping an exhaustive glossary here would put a catalogue of explicit terms
// in a public repo to solve a problem each user solves differently anyway, and
// this set is only ever seeded into config.json on first run — an existing
// install keeps whatever it already has.
const DEFAULT_NSFW_TERMS_B64 = ["bnNmdw==", "ZXhwbGljaXQ=", "bnVkZQ==", "Z29yZQ=="];
// Seed the config on first run so the list is persisted and editable.
if (!Array.isArray(config.nsfwTermsB64)) {
  config.nsfwTermsB64 = DEFAULT_NSFW_TERMS_B64.slice();
  try {
    let cur = {}; try { cur = readConfigFile(); } catch {}
    cur.nsfwTermsB64 = config.nsfwTermsB64;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cur, null, 2));
  } catch (e) { console.log('[NSFW] could not seed default terms:', e.message); }
}
function nsfwTermsDecoded() {
  return (config.nsfwTermsB64 || []).map(s => { try { return Buffer.from(s, 'base64').toString('utf8'); } catch { return ''; } }).filter(Boolean);
}
// Leetspeak folding. Model and LoRA filenames in the wild disguise themselves
// on purpose — digits for letters, and camelCase run together — and a plain
// \bterm\b pass sails straight past every one of them. Fold digits/symbols back
// to letters, split camelCase, and reduce everything else to spaces.
const NSFW_LEET = { '4':'a', '@':'a', '3':'e', '1':'i', '!':'i', '|':'i', '0':'o',
                    '5':'s', '$':'s', '7':'t', '+':'t', '8':'b', '6':'g', '9':'g', '2':'z' };
function nsfwNormalize(s) {
  return String(s == null ? '' : s)
    .replace(/([a-z])([A-Z])/g, '$1 $2')          // fooBar -> foo Bar
    .toLowerCase()
    .replace(/[0-9@!|$+]/g, c => NSFW_LEET[c] || ' ')
    .replace(/[^a-z]+/g, ' ')
    .trim();
}
// Returns { test(text) }. Kept behind a .test() shape so call sites read the
// same as when this was a bare RegExp.
function buildNsfwRe() {
  const terms = nsfwTermsDecoded();
  if (!terms.length) return { test: () => false };
  const esc = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Pass 1: the original literal match, so folding can never lose a hit.
  const raw = new RegExp('\\b(' + terms.map(esc).join('|') + ')\\b', 'i');
  // Pass 2: the same terms against folded text. Folding can weld a term to a
  // trailing version suffix (a digit becomes a letter and joins the word), so
  // terms of 6+ letters match as substrings; shorter ones keep word boundaries,
  // or a three-letter term fires inside an innocent longer word — "teen" inside
  // "canteen" being the tame example.
  const folded = [...new Set(terms.map(nsfwNormalize).filter(Boolean))];
  const long = folded.filter(t => t.replace(/ /g, '').length >= 6).map(esc);
  const short = folded.filter(t => t.replace(/ /g, '').length < 6).map(esc);
  const longRe = long.length ? new RegExp('(' + long.join('|') + ')') : null;
  const shortRe = short.length ? new RegExp('\\b(' + short.join('|') + ')\\b') : null;
  return {
    test(text) {
      const s = String(text == null ? '' : text);
      if (raw.test(s)) return true;
      const n = nsfwNormalize(s);
      if (!n) return false;
      return !!((longRe && longRe.test(n)) || (shortRe && shortRe.test(n)));
    }
  };
}
let NSFW_RE = buildNsfwRe();
let promptIndex = { v: PROMPT_INDEX_VERSION, files: {} };
let promptIndexing = false;
try {
  const loaded = JSON.parse(fs.readFileSync(PROMPT_INDEX_PATH, 'utf8'));
  if (loaded && loaded.v === PROMPT_INDEX_VERSION && loaded.files) promptIndex = loaded;
} catch {}

// Flatten the searchable text out of an embedded API prompt: every string input
// on every node, skipping model/file references.
// Only inputs whose key looks like prompt text — skips sampler names, file
// patterns, format strings and other widget noise.
const PROMPT_KEY_RE = /text|prompt|caption|wildcard|positive|negative|string|value/i;
const NOISE_KEY_RE = /sampler|scheduler|format|prefix|path|filename|extension|method|delimiter|widget_name|node_title/i;
function promptTextFromMeta(meta) {
  const parts = [];
  try {
    const p = typeof meta.prompt === 'string' ? JSON.parse(meta.prompt) : meta.prompt;
    if (p && typeof p === 'object') {
      for (const node of Object.values(p)) {
        // Skip negative-prompt nodes entirely ("Negative Prompt", "Neg Real", …)
        const title = (node && node._meta && node._meta.title) || '';
        if (/negative|\bneg\b/i.test(title)) continue;
        for (const [key, v] of Object.entries((node && node.inputs) || {})) {
          if (typeof v !== 'string' || v.length < 3 || v.length > 5000) continue;
          if (!PROMPT_KEY_RE.test(key) || NOISE_KEY_RE.test(key)) continue;
          if (/negative/i.test(key)) continue;
          if (/\.(safetensors|ckpt|pt|pth|gguf|png|jpg|jpeg|webp|mp4|webm)$/i.test(v)) continue;
          parts.push(v);
        }
      }
    }
  } catch {}
  return parts.join(' \n ').toLowerCase();
}

let promptIndexLastError = null;
let promptIndexLastRun = null;
async function buildPromptIndex() {
  if (promptIndexing) return;
  promptIndexing = true;
  const t0 = Date.now();
  const seen = new Set();
  let added = 0, checked = 0, errors = 0;
  try {
    for (const root of [ROOT, COMFY_OUTPUT]) {
      const stack = [root];
      while (stack.length) {
        const dir = stack.pop();
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
          try {
            if (e.name.startsWith('.')) continue;
            const fp = path.join(dir, e.name);
            if (e.isDirectory()) { stack.push(fp); continue; }
            const lower = e.name.toLowerCase();
            const isPng = lower.endsWith('.png');
            const isVid = /\.(mp4|webm|mov)$/.test(lower);
            if (!isPng && !isVid) continue;
            const key = fp.replace(/\\/g, '/');
            seen.add(key);
            checked++;
            const st = fs.statSync(fp);
            const rec = promptIndex.files[key];
            if (rec && rec.m === st.mtimeMs) continue;
            const meta = await new Promise(r => {
              try { (isPng ? extractPngMetadata : extractVideoMetadata)(fp, (err, m) => r(err ? null : m)); } catch { r(null); }
            });
            const text = meta ? promptTextFromMeta(meta) : '';
            promptIndex.files[key] = {
              m: st.mtimeMs, t: text,
              w: (meta && (meta.prompt || meta.workflow)) ? 1 : 0,
              n: NSFW_RE.test(text) ? 1 : 0,
            };
            added++;
            if (added % 25 === 0) await new Promise(r => setImmediate(r)); // stay responsive
          } catch (fileErr) {
            errors++;
            promptIndexLastError = e.name + ': ' + fileErr.message;
          }
        }
      }
    }
    let removed = 0;
    for (const k of Object.keys(promptIndex.files)) if (!seen.has(k)) { delete promptIndex.files[k]; removed++; }
    // Persist on removals too, not just additions. A sweep that only deletes
    // files left `added` at 0, so the pruning above never reached disk and the
    // next boot reloaded every phrase belonging to a file that no longer exists.
    // In-memory was always right, which is what made this easy to miss.
    if (added > 0 || removed > 0) savePromptIndex();
  } catch (e) { promptIndexLastError = e.message; }
  promptIndexLastRun = { checked, added, errors, ms: Date.now() - t0, at: new Date().toISOString() };
  console.log('[PromptIndex]', JSON.stringify(promptIndexLastRun), promptIndexLastError ? ('lastError: ' + promptIndexLastError) : '');
  promptIndexing = false;
}

// Debounced persist so rapid updates (bulk delete) write once
let promptIndexSaveTimer = null;
function savePromptIndex() {
  clearTimeout(promptIndexSaveTimer);
  promptIndexSaveTimer = setTimeout(() => {
    try { fs.writeFileSync(PROMPT_INDEX_PATH, JSON.stringify(promptIndex)); } catch {}
  }, 1500);
}

// Recompute the NSFW n-flag for every already-indexed file against the current
// NSFW_RE — cheap (no re-extraction), used after the tag list is edited.
function retagNsfw() {
  let changed = 0;
  for (const k in promptIndex.files) {
    const rec = promptIndex.files[k];
    if (!rec || typeof rec.t !== 'string') continue;
    const n = NSFW_RE.test(rec.t) ? 1 : 0;
    if (rec.n !== n) { rec.n = n; changed++; }
  }
  if (changed) savePromptIndex();
  return changed;
}

// Immediate index updates on delete / move so search never shows ghosts
function promptIndexRemove(p) {
  const key = String(p || '').replace(/\\/g, '/');
  if (promptIndex.files[key]) { delete promptIndex.files[key]; savePromptIndex(); }
}
function promptIndexMove(src, dest) {
  const s = String(src || '').replace(/\\/g, '/');
  const d = String(dest || '').replace(/\\/g, '/');
  if (promptIndex.files[s]) { promptIndex.files[d] = promptIndex.files[s]; delete promptIndex.files[s]; savePromptIndex(); }
}
// Same, but `src` may be a whole folder: re-key everything indexed beneath it.
function promptIndexMovePath(src, dest) {
  const s = String(src || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const d = String(dest || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (promptIndex.files[s]) { promptIndexMove(s, d); return; }
  const pre = s + '/';
  let hit = false;
  for (const k of Object.keys(promptIndex.files)) {
    if (!k.startsWith(pre)) continue;
    promptIndex.files[d + k.slice(s.length)] = promptIndex.files[k];
    delete promptIndex.files[k];
    hit = true;
  }
  if (hit) savePromptIndex();
}
setTimeout(buildPromptIndex, 5000);                  // initial build shortly after boot
setInterval(buildPromptIndex, 10 * 60 * 1000);       // pick up new generations

// Aggregate the indexed prompt text into a phrase directory: prompts are
// comma-separated tag phrases, so split on commas/newlines/BREAK, strip
// weighting syntax, and count each phrase once per file.
const PHRASE_STOPLIST = new Set(['enable', 'disable', 'default', 'simple', 'normal', 'fixed', 'true', 'false',
  'none', 'auto', 'randomize', 'increment', 'decrement', 'png', 'jpg', 'jpeg', 'webp', 'and', 'the', 'with', 'a', 'an',
  // widget/junk values that live under prompt-ish input keys
  'object object', 'select the wildcard to add to the text', 'select the lora to add to the text',
  // sampler/scheduler names that ride through generic "value" primitives
  'euler', 'euler a', 'euler_ancestral', 'dpmpp_2m', 'dpmpp_2m_sde', 'dpmpp_sde', 'dpmpp_3m_sde', 'ddim', 'uni_pc',
  'lcm', 'karras', 'exponential', 'sgm_uniform', 'beta', 'ays sdxl', 'ays', 'res_multistep',
  // quality/negative boilerplate present in nearly every prompt — noise in a browse list
  'best quality', 'masterpiece', 'amazing quality', 'ultra-detailed', 'ultra detailed', 'highly detailed',
  'realistic', 'photorealistic', 'anime', '3d', 'cgi', 'artifacts', 'watermark', 'blurry',
  'worst quality', 'low quality', 'normal quality', 'high quality', 'bad quality', 'lowres', 'low resolution',
  'high resolution', 'absurdres', 'incredibly absurdres', 'very aesthetic', 'newest', '4k', '8k',
  'jpeg artifacts', 'bad anatomy', 'bad hands', 'deformed', 'ugly', 'poorly drawn', 'text', 'logo', 'signature']);
function promptPhraseCounts(safeMode) {
  const counts = new Map();
  for (const rec of Object.values(promptIndex.files)) {
    if (!rec.t) continue;
    if (safeMode && rec.n) continue; // safe mode: NSFW-tagged files contribute nothing
    const seenInFile = new Set();
    for (let part of rec.t.split(/[,\n.]|\bbreak\b/g)) {
      part = part.replace(/[()\[\]{}<>]/g, '').replace(/:\s*\d+(\.\d+)?/g, '').replace(/\s+/g, ' ').trim();
      if (part.length < 2 || part.length > 60) continue;
      if (/^[\d\s.:-]+$/.test(part)) continue;          // pure numbers/punctuation
      if (/^\d+x\d+/.test(part)) continue;               // resolutions
      if (/%[a-z]/i.test(part)) continue;                // filename pattern placeholders
      if (/embedding:|lora:/i.test(part)) continue;      // resource references
      if (PHRASE_STOPLIST.has(part)) continue;
      if (safeMode && NSFW_RE.test(part)) continue;      // belt & braces: no NSFW phrases either
      if (seenInFile.has(part)) continue;
      seenInFile.add(part);
      counts.set(part, (counts.get(part) || 0) + 1);
    }
  }
  return [...counts.entries()].map(([t, n]) => ({ t, n }))
    .sort((a, b) => b.n - a.n || a.t.localeCompare(b.t))
    .slice(0, 3000);
}

// True if every whitespace-separated word of `search` appears in the file's
// indexed prompt text.
function promptIndexMatches(fullPath, search) {
  const rec = promptIndex.files[fullPath.replace(/\\/g, '/')];
  if (!rec || !rec.t) return false;
  return search.split(/\s+/).filter(Boolean).every(w => rec.t.includes(w));
}

function extractVideoMetadata(filePath, cb) {
  execFile(FFPROBE_BIN, ['-v', 'quiet', '-show_entries', 'format_tags', '-of', 'json', filePath], { timeout: 10000 }, (err, stdout) => {
    if (err) return cb(null, { prompt: null, workflow: null });
    try {
      const data = JSON.parse(stdout);
      const tags = (data.format && data.format.tags) || {};
      let prompt = null, workflow = null;

      // Video metadata is in 'comment' tag as JSON with escaped inner JSON
      const raw = tags.comment || tags.prompt || '';
      if (raw) {
        try {
          let parsed = JSON.parse(raw);
          // VHS writes the mp4 'prompt' tag double-encoded (a JSON string containing JSON)
          if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch {} }
          if (parsed.prompt) {
            prompt = typeof parsed.prompt === 'string' ? JSON.parse(parsed.prompt) : parsed.prompt;
          }
          if (parsed.workflow) {
            workflow = typeof parsed.workflow === 'string' ? JSON.parse(parsed.workflow) : parsed.workflow;
          }
          // If the parsed object itself looks like a prompt (has node IDs)
          if (!prompt && !parsed.prompt && !parsed.workflow) {
            prompt = parsed;
          }
        } catch {
          prompt = raw;
        }
      }
      if (tags.workflow) {
        try { workflow = JSON.parse(tags.workflow); } catch { workflow = tags.workflow; }
      }
      cb(null, { prompt, workflow });
    } catch (e) {
      cb(null, { prompt: null, workflow: null });
    }
  });
}



// Cache for ComfyUI object_info. The upstream call costs 10-30s (see the TTFB
// note below), so it is served stale-while-revalidate: any cached copy answers
// instantly and a refresh runs behind the request once it ages past the TTL.
// Only a call with nothing cached at all can block, and the boot prefetch below
// normally gets there first. Stale data only means a newly-installed model is
// briefly missing from a dropdown; it never affects running a workflow.
const OBJECT_INFO_TTL_MS = 10 * 60 * 1000;
let objectInfoCache = null;
let objectInfoFetchTime = 0;
let objectInfoInflight = null;   // shared promise, so concurrent callers never stack up fetches
// Progress of an in-flight /object_info fetch, polled by the Remix dialog so it
// can show a real bar instead of a static "Loading…". Measured on this box:
// ComfyUI takes ~10s to *begin* answering and then ships the whole 8MB body in
// ~30ms — the wait is time-to-first-byte, so there are no bytes to count.
// What is measurable is elapsed time against how long the previous fetch took.
let objectInfoProgress = { active: false, startedAt: 0, lastMs: 0 };

function fetchObjectInfo() {
  if (objectInfoInflight) return objectInfoInflight;   // one fetch at a time; everyone shares it
  objectInfoInflight = new Promise((resolve, reject) => {
    const ch = comfyHostPort();
    const opts = {
      hostname: ch.hostname, port: ch.port,
      path: '/object_info', method: 'GET',
      headers: { 'Accept': 'application/json' },
    };
    // Mark active before sending: the whole wait happens before the response
    // callback fires, so flagging it in there would report nothing at all.
    const startedAt = Date.now();
    objectInfoProgress = { active: true, startedAt, lastMs: objectInfoProgress.lastMs };
    const req = http.request(opts, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        objectInfoProgress = { active: false, startedAt: 0, lastMs: Date.now() - startedAt };
        objectInfoInflight = null;
        try {
          objectInfoCache = JSON.parse(body);
          objectInfoFetchTime = Date.now();
          resolve(objectInfoCache);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', e => {
      objectInfoProgress = { active: false, startedAt: 0, lastMs: objectInfoProgress.lastMs };
      objectInfoInflight = null;
      reject(e);
    });
    req.end();
  });
  return objectInfoInflight;
}

function getObjectInfo() {
  if (objectInfoCache) {
    // Answer from cache immediately; if it has aged out, refresh behind the caller.
    if (Date.now() - objectInfoFetchTime >= OBJECT_INFO_TTL_MS) fetchObjectInfo().catch(() => {});
    return Promise.resolve(objectInfoCache);
  }
  return fetchObjectInfo();
}

// Warm the cache at boot so the first Remix dialog of the session doesn't pay
// for it. ComfyUI is often not up yet (or not running at all), so retry quietly
// for up to an hour, then leave it to the first real request.
function warmObjectInfo(attempt = 0) {
  fetchObjectInfo().catch(() => {
    if (attempt < 60) setTimeout(() => warmObjectInfo(attempt + 1), 60000);
  });
}
setTimeout(warmObjectInfo, 3000);

// ── Subgraph flattening ──────────────────────────────────────────────────────
// A workflow node whose `type` is a UUID listed in `definitions.subgraphs` is a
// *subgraph instance*: ComfyUI's frontend inlines its interior at queue time and
// nothing in object_info describes it. Without this pass the instance is dropped
// (its entire interior never runs) and links out of it hit the unknown-node
// pass-through in resolveBypass, which silently rewires consumers to the
// subgraph's FIRST input — ComfyUI then rejects them with a type mismatch.
// Interior ids are namespaced `<instance>:<inner>` (ComfyUI's own convention).
// Muted (mode 2) / bypassed (mode 4) instances are left unexpanded on purpose:
// resolveBypass already gives them the correct dead / type-matched pass-through.
function flattenSubgraphs(wf) {
  // Normalize both link encodings: top-level uses arrays, definitions use objects.
  const toArr = (l) => Array.isArray(l)
    ? [l[0], String(l[1]), l[2], String(l[3]), l[4], l[5]]
    : [l.id, String(l.origin_id), l.origin_slot, String(l.target_id), l.target_slot, l.type];
  const nodes = (wf.nodes || []).slice();
  const links = (wf.links || []).map(toArr);
  const defs = new Map();
  for (const d of (wf.definitions && wf.definitions.subgraphs) || []) defs.set(String(d.id), d);
  if (!defs.size) return { nodes, links };

  let nextLink = 1;
  for (const l of links) { const n = Number(l[0]); if (Number.isFinite(n) && n >= nextLink) nextLink = n + 1; }

  // One instance per pass; interiors may hold further instances (nested subgraphs),
  // so keep going until none are left. The cap is a cycle guard.
  for (let pass = 0; pass < 500; pass++) {
    const idx = nodes.findIndex(n => defs.has(String(n.type)) && n.mode !== 2 && n.mode !== 4);
    if (idx < 0) break;
    const inst = nodes[idx];
    const def = defs.get(String(inst.type));
    const pfx = String(inst.id) + ':';
    nodes.splice(idx, 1);

    const instInputs = inst.inputs || [];
    // Promoted widgets: every widget-flagged socket consumes one widgets_values
    // slot in order (linked ones included — the stale value stays behind), but
    // only an UNLINKED one actually carries a value into the interior.
    const promoted = {};
    let wIdx = 0;
    const wv = Array.isArray(inst.widgets_values) ? inst.widgets_values : [];
    for (const inp of instInputs) {
      if (!inp || !inp.widget) continue;
      if (inp.link == null && wIdx < wv.length) promoted[inp.name] = wv[wIdx];
      wIdx++;
    }
    // Match the instance's sockets to the definition's inputs by name — a
    // definition can declare an input the instance doesn't show (and vice versa),
    // so positional matching would misalign the rest.
    const feed = (def.inputs || []).map((di, i) => {
      const inp = instInputs.find(x => x && x.name === di.name) || instInputs[i];
      return { link: inp && inp.link != null ? inp.link : null, value: promoted[di.name] };
    });

    const inner = (def.nodes || []).map(n => Object.assign({}, n, {
      id: pfx + n.id,
      inputs: (n.inputs || []).map(i => Object.assign({}, i, { link: null })),
    }));
    const innerById = new Map(inner.map(n => [String(n.id), n]));
    const outProducer = [];
    const newLinks = [];
    for (const raw of def.links || []) {
      const [, from, fromSlot, to, toSlot, type] = toArr(raw);
      if (to === '-20') { outProducer[toSlot] = { node: pfx + from, slot: fromSlot }; continue; }
      const tgt = innerById.get(pfx + to);
      const tgtInp = tgt && tgt.inputs[toSlot];
      if (from === '-10') {
        const f = feed[fromSlot];
        if (!tgtInp || !f) continue;
        // Reuse the OUTER link id so resolveBypass still walks reroutes/bypassed
        // nodes upstream of the subgraph exactly as it does for a plain link.
        if (f.link != null) tgtInp.link = f.link;
        else if (f.value !== undefined) tgt.__promoted = Object.assign(tgt.__promoted || {}, { [tgtInp.name]: f.value });
        continue;
      }
      const id = nextLink++;
      if (tgtInp) tgtInp.link = id;
      newLinks.push([id, pfx + from, fromSlot, pfx + to, toSlot, type]);
    }
    // Consumers keep their link ids; the link's ORIGIN moves from the instance to
    // the interior node that actually produces that output slot. An unconnected
    // subgraph output leaves the link dangling, which the prune pass cleans up.
    for (const l of links) {
      if (l[1] !== String(inst.id)) continue;
      const p = outProducer[l[2]];
      l[1] = p ? p.node : '__subgraph_unconnected__';
      if (p) l[2] = p.slot;
    }
    nodes.push(...inner);
    links.push(...newLinks);
  }
  return { nodes, links };
}

// V3 dynamic combos (COMFY_DYNAMICCOMBO_V3): the selected option reveals extra
// REQUIRED inputs whose ids are dotted ("format.bit_depth"). ComfyUI expands them
// server-side from the chosen key, so they never appear in object_info's required
// map — emit them here or validation fails with a bare "Required input is
// missing". Their values follow the selector in widgets_values.
function expandDynamicCombo(inputs, name, def, selectedKey, widgetValues, widgetIdx) {
  const opt = (((def && def[1]) || {}).options || []).find(o => o.key === selectedKey);
  if (!opt || !opt.inputs) return widgetIdx;
  for (const cat of ['required', 'optional']) {
    for (const [sub, subDef] of Object.entries(opt.inputs[cat] || {})) {
      const id = name + '.' + sub;
      const subType = Array.isArray(subDef) ? (Array.isArray(subDef[0]) ? 'COMBO' : String(subDef[0])) : String(subDef);
      const subOpts = (Array.isArray(subDef) && subDef[1]) || {};
      let val;
      while (widgetIdx < widgetValues.length) {
        let v = widgetValues[widgetIdx++];
        if (Array.isArray(v) && v.length === 2 && Array.isArray(v[1])) v = v[0];
        const typeOk =
          subType === 'BOOLEAN' ? (typeof v === 'boolean' || v === 0 || v === 1)
          : (subType === 'INT' || subType === 'FLOAT') ? typeof v === 'number'
          : (v === null || typeof v !== 'object');
        if (typeOk) { val = v; break; }
      }
      const choices = Array.isArray(subOpts.options) ? subOpts.options : (Array.isArray(subDef[0]) ? subDef[0] : null);
      if (choices && choices.length && !choices.includes(val)) val = choices.includes(subOpts.default) ? subOpts.default : choices[0];
      if (val === undefined) val = subOpts.default;
      if (val !== undefined) inputs[id] = val;
      if (subType === 'COMFY_DYNAMICCOMBO_V3') widgetIdx = expandDynamicCombo(inputs, id, subDef, val, widgetValues, widgetIdx);
    }
  }
  return widgetIdx;
}

// V3 dynamic *container* inputs. Their value never travels in widgets_values —
// ComfyUI expands them server-side into dotted member ids (AUTOGROW's "branches"
// becomes branches.item0, branches.item1, …) and, unlike DynamicCombo, purposely
// does NOT keep the container itself as an input. Emitting one would both invent a
// bogus value and shift every widget after it.
const DYNAMIC_CONTAINER_TYPES = new Set(['COMFY_AUTOGROW_V3', 'COMFY_DYNAMICSLOT_V3', 'COMFY_MULTITYPED_V3', 'COMFY_MATCHTYPE_V3']);

// Frontend-only node types: absent from object_info by design (they carry no work,
// they drive the editor), so their absence is never worth warning about. rgthree's
// muters/bypassers/labels live here; its real nodes (Power Lora Loader, Seed, …) are
// in object_info when installed and so never reach this check.
const UI_ONLY_NODE_TYPES = new Set([
  'Reroute', 'PrimitiveNode', 'Note', 'MarkdownNote', 'GetNode', 'SetNode', 'easy getNode', 'easy setNode',
]);
const UI_ONLY_NODE_PATTERNS = [
  /^(Anything Everywhere|Prompts Everywhere|Seed Everywhere)/,
  /^(Label|Bookmark|Note Plus|Reroute|Fast Muter|Fast Bypasser|Fast Groups Muter|Fast Groups Bypasser|Fast Actions Button|Mute \/ Bypass (Repeater|Relay)) \(rgthree\)$/,
];
const isUiOnlyNode = (t) => UI_ONLY_NODE_TYPES.has(t) || UI_ONLY_NODE_PATTERNS.some(re => re.test(t));

// Every type any installed node can emit from an output — i.e. everything that can
// legitimately arrive over a link. Used to tell a socket from a custom widget type.
let linkTypeCache = null, linkTypeCacheSrc = null;
function getLinkTypes(objectInfo) {
  if (linkTypeCacheSrc === objectInfo && linkTypeCache) return linkTypeCache;
  const s = new Set();
  for (const inf of Object.values(objectInfo || {})) {
    for (const o of (inf && inf.output) || []) {
      if (typeof o === 'string') for (const t of o.split(',')) s.add(t.trim());
    }
  }
  linkTypeCache = s; linkTypeCacheSrc = objectInfo;
  return s;
}

// Convert visual workflow JSON (LiteGraph format) to API/prompt format
async function workflowToPrompt(wf) {
  const flat = flattenSubgraphs(wf);
  const nodes = flat.nodes;
  const links = flat.links;
  let objectInfo;
  try { objectInfo = await getObjectInfo(); } catch { objectInfo = {}; }
  const linkTypes = getLinkTypes(objectInfo);

  // Build link lookup: linkId -> {fromNode, fromSlot}
  const linkMap = {};
  for (const link of links) {
    linkMap[link[0]] = { fromNode: String(link[1]), fromSlot: link[2] };
  }

  const nodeById = {};
  for (const node of nodes) { nodeById[String(node.id)] = node; }

  // Resolve SetNode/GetNode pairs: GetNode outputs map to SetNode inputs by name
  const setNodeMap = {}; // name -> {fromNode, fromSlot}
  for (const node of nodes) {
    if (node.type === 'SetNode' && node.widgets_values && node.widgets_values[0]) {
      const name = node.widgets_values[0];
      const inp = (node.inputs || [])[0];
      if (inp && inp.link != null && linkMap[inp.link]) {
        setNodeMap[name] = linkMap[inp.link];
      }
    }
  }

  function resolveBypass(nodeId, slotIdx, depth) {
    if ((depth || 0) > 50) return null;
    const node = nodeById[nodeId];
    if (!node) return null;
    // Muted (mode 2) nodes are excluded from the prompt entirely — a link that
    // resolves to one is dead. Returning it would leave a dangling reference,
    // which crashes ComfyUI's prompt worker at graph-build time (NodeNotFoundError).
    if (node.mode === 2) return null;
    if (node.type === 'Reroute') {
      const firstInput = (node.inputs || [])[0];
      if (firstInput && firstInput.link != null && linkMap[firstInput.link]) {
        const upstream = linkMap[firstInput.link];
        return resolveBypass(upstream.fromNode, upstream.fromSlot, (depth || 0) + 1);
      }
      return null;
    }
    if (node.type === 'GetNode') {
      const getName = (node.widgets_values || [])[0];
      if (getName && setNodeMap[getName]) {
        const src = setNodeMap[getName];
        return resolveBypass(src.fromNode, src.fromSlot, (depth || 0) + 1);
      }
      return null;
    }
    if (node.type === 'SetNode') {
      // SetNode passes through — treat like reroute
      const firstInput = (node.inputs || [])[0];
      if (firstInput && firstInput.link != null && linkMap[firstInput.link]) {
        const upstream = linkMap[firstInput.link];
        return resolveBypass(upstream.fromNode, upstream.fromSlot, (depth || 0) + 1);
      }
      return null;
    }
    // Unknown node (not in object_info) — either a UI-only pass-through (rgthree
    // labels and friends) or a custom node that isn't installed. Only pass through
    // when the requested output has a TYPE-COMPATIBLE input to pass through TO:
    // blindly taking input 0 hands the consumer whatever that node happens to be
    // fed first (a MODEL where an IMAGE was wanted), and ComfyUI then rejects the
    // consumer with a baffling type mismatch instead of the branch simply dropping.
    if (!objectInfo[node.type] && node.mode !== 4) {
      const outT = String((((node.outputs || [])[slotIdx]) || {}).type || '').toUpperCase();
      const cands = (node.inputs || []).filter(i => i && i.link != null && linkMap[i.link]);
      const match = cands.find(i => {
        const t = String(i.type || '').toUpperCase();
        return !outT || !t || outT === '*' || t === '*' || outT === t;
      });
      if (match) {
        const upstream = linkMap[match.link];
        return resolveBypass(upstream.fromNode, upstream.fromSlot, (depth || 0) + 1);
      }
      return null;
    }
    if (node.mode !== 4) return { fromNode: nodeId, fromSlot: slotIdx };
    // Bypassed multi-output node: match output slot type to corresponding input by type
    const outputs = node.outputs || [];
    if (slotIdx >= outputs.length) return null;
    const outType = (outputs[slotIdx].type || '').toUpperCase();
    const inputs = node.inputs || [];
    // Count how many outputs of this type come before slotIdx
    let typeCount = 0;
    for (let i = 0; i < slotIdx; i++) {
      if ((outputs[i].type || '').toUpperCase() === outType) typeCount++;
    }
    // Find the Nth input of matching type
    let matchCount = 0;
    for (const inp of inputs) {
      if ((inp.type || '').toUpperCase() === outType) {
        if (matchCount === typeCount) {
          if (inp.link != null && linkMap[inp.link]) {
            const upstream = linkMap[inp.link];
            return resolveBypass(upstream.fromNode, upstream.fromSlot, (depth || 0) + 1);
          }
          return null;
        }
        matchCount++;
      }
    }
    return null;
  }

  const prompt = {};

  for (const node of nodes) {
    if (node.mode === 2 || node.mode === 4) continue;
    if (!node.type || node.type === 'Reroute' || node.type === 'PrimitiveNode' || node.type === 'Note' || node.type === 'MarkdownNote') continue;
    // cg-use-everywhere broadcasters are frontend-only; their links are resolved
    // into consumer inputs after this loop (see UE resolution below).
    if (/^(Anything Everywhere|Prompts Everywhere|Seed Everywhere)/.test(node.type)) continue;

    const nodeId = String(node.id);
    const info = objectInfo[node.type];
    // Skip UI-only nodes that don't exist in ComfyUI's object_info (e.g. rgthree Labels, Bookmarks, Fast Bypasser)
    if (!info) continue;

    const inputs = {};
    const nodeInputs = node.inputs || [];
    const widgetValues = node.widgets_values || [];

    // Handle dict-style widgets_values (e.g. VHS_VideoCombine stores {frame_rate: 35, ...})
    const widgetValuesIsDict = widgetValues && !Array.isArray(widgetValues) && typeof widgetValues === 'object';

    // Build set of linked input names, resolving bypassed nodes
    const linkedInputs = new Set();
    for (const inp of nodeInputs) {
      if (inp.link != null && linkMap[inp.link]) {
        const lk = linkMap[inp.link];
        const resolved = resolveBypass(lk.fromNode, lk.fromSlot);
        if (resolved) {
          inputs[inp.name] = [resolved.fromNode, resolved.fromSlot];
          linkedInputs.add(inp.name);
        } else if (!inp.widget && info.input && info.input.required && (inp.name in info.input.required)) {
          // A required SOCKET input is wired in the editor but its chain dead-ends
          // in a muted/bypassed branch — this node can't run. Mark it dead so the
          // prune pass removes it (mirrors ComfyUI, which never submits dead branches).
          // Widget inputs are exempt: their value lives in widgets_values (e.g. a
          // PrimitiveNode feeding wildcard_text) and substitutes for the dead link.
          inputs.__dead = true;
        }
      }
    }

    // Handle dict-style widgets_values — directly map keys to inputs
    if (widgetValuesIsDict) {
      for (const [key, val] of Object.entries(widgetValues)) {
        if (!linkedInputs.has(key) && val !== undefined) {
          // Skip complex sub-objects like videopreview
          if (val !== null && typeof val === 'object' && !Array.isArray(val)) continue;
          inputs[key] = val;
        }
      }
    }

    // Handle Power Lora Loader (rgthree) — map lora slot objects to lora_1, lora_2, etc.
    if (node.type === 'Power Lora Loader (rgthree)' && Array.isArray(widgetValues)) {
      inputs['PowerLoraLoaderHeaderWidget'] = { type: 'PowerLoraLoaderHeaderWidget' };
      let loraIdx = 1;
      for (const wv of widgetValues) {
        if (wv && typeof wv === 'object' && wv.lora) {
          inputs['lora_' + loraIdx] = { on: wv.on, lora: wv.lora, strength: wv.strength };
          loraIdx++;
        }
      }
      inputs['\u2795 Add Lora'] = '';
    }

    // Map widget values using object_info to get proper input names and order
    if (widgetValuesIsDict) {
      // Already handled above
    } else if (info && info.input) {
      const allInputDefs = [];
      // Collect required + optional inputs in order
      if (info.input_order) {
        for (const cat of ['required', 'optional']) {
          const names = info.input_order[cat] || [];
          const defs = info.input[cat] || {};
          for (const name of names) {
            if (defs[name]) allInputDefs.push({ name, def: defs[name], cat });
          }
        }
      } else {
        for (const cat of ['required', 'optional']) {
          const defs = info.input[cat] || {};
          for (const [name, def] of Object.entries(defs)) {
            allInputDefs.push({ name, def, cat });
          }
        }
      }

      let widgetIdx = 0;
      for (const { name, def } of allInputDefs) {
        if (linkedInputs.has(name)) {
          // Already set via link - but some widget inputs that are linked still consume a widget_values slot
          const nodeInp = nodeInputs.find(i => i.name === name);
          if (nodeInp && nodeInp.widget) {
            widgetIdx++;
            // Also skip control_after_generate for linked INT seed inputs
            const linkedTypeName = Array.isArray(def) ? (Array.isArray(def[0]) ? 'COMBO' : String(def[0])) : String(def);
            if (linkedTypeName === 'INT' && widgetIdx < widgetValues.length) {
              const next = widgetValues[widgetIdx];
              if (next === null || next === 'fixed' || next === 'increment' || next === 'decrement' || next === 'randomize') {
                widgetIdx++;
              }
            }
          }
          continue;
        }
        const typeName = Array.isArray(def) ? (Array.isArray(def[0]) ? 'COMBO' : String(def[0])) : String(def);
        // Check if this is a widget type (not a pure connection type). Custom widget
        // types (e.g. LoraManager's AUTOCOMPLETE_TEXT_LORAS) aren't in the scalar
        // list, but the visual node marks them widget:true — honor that.
        const visualInp = nodeInputs.find(i => i.name === name);
        const isWidget = ['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO', 'COMFY_DYNAMICCOMBO_V3'].includes(typeName)
          || Array.isArray(def[0])
          || !!(visualInp && visualInp.widget);
        // A PURE widget (never convertible to a socket, e.g. LoraManager's
        // AUTOCOMPLETE_TEXT_LORAS text box) has no entry in the visual node's inputs
        // array at all — modern saves list every socket, wired or not. So "absent from
        // inputs, and no part of its type can arrive over a link" means widget-only.
        // Without this its value is never emitted and ComfyUI rejects the node for a
        // missing required input. Deliberately conservative: unions like "MODEL,CLIP"
        // and one-off socket types stay sockets.
        const speculativeWidget = !isWidget && !visualInp
          && !DYNAMIC_CONTAINER_TYPES.has(typeName)
          && !typeName.split(',').some(t => linkTypes.has(t.trim()));
        // Also check forceInput flag
        const opts = def[1] || {};
        if (opts.forceInput) continue; // Pure socket, no widget

        if (isWidget || speculativeWidget) {
          // Scan forward past values that can't belong to this widget type — some
          // custom nodes (e.g. LoraManager toggles) append extra array/object state
          // into widgets_values, which would otherwise shift every later widget.
          let assigned = false;
          let scanIdx = widgetIdx;
          // Custom nodes inject UI-only entries into widgets_values, which shifts every
          // field after them. For a COMBO we can recognise one: an empty/null candidate
          // that is not itself a valid option can never be a real selection, so it's
          // filler — skip it. Anything else stays positional even when it matches no
          // installed option (a model filename absent from disk, a project that no
          // longer exists): searching further ahead would cheerfully steal the NEXT
          // field's value, which is how a stale lora name eats its own strength value.
          const choices = typeName === 'COMBO'
            ? (Array.isArray(def[0]) ? def[0] : (Array.isArray(opts.options) ? opts.options : null))
            : null;
          let fillerSkips = 0;
          while (scanIdx < widgetValues.length) {
            let val = widgetValues[scanIdx];
            // Handle [value, [config]] for booleans
            if (Array.isArray(val) && val.length === 2 && Array.isArray(val[1])) {
              val = val[0];
            }
            const typeOk =
              typeName === 'BOOLEAN' ? (typeof val === 'boolean' || val === 0 || val === 1)
              : (typeName === 'INT' || typeName === 'FLOAT') ? typeof val === 'number'
              : (val === null || typeof val !== 'object'); // STRING/COMBO/custom accept any scalar
            if (typeOk) {
              if (choices && choices.length && !choices.includes(val)) {
                // Single-choice combos are UI placeholders whose label text drifts
                // between node-pack versions ("Select Wildcard 🟢 Full Cache" vs the
                // installed pack's label) — coerce to the installed value.
                if (choices.length === 1 && typeof val === 'string') {
                  val = choices[0];
                } else if ((val === '' || val === null) && fillerSkips++ < 2) {
                  scanIdx++; continue; // UI-only filler entry
                }
              }
              inputs[name] = val; widgetIdx = scanIdx + 1; assigned = true; break;
            }
            scanIdx++; // junk entry — skip it
          }
          if (!assigned) {
            // A speculative widget that found no value was probably a socket after
            // all — don't consume a slot, or every later widget shifts.
            if (!speculativeWidget) widgetIdx++;
            if (opts.default !== undefined) inputs[name] = opts.default;
            else if (typeName === 'COMFY_DYNAMICCOMBO_V3' && (opts.options || []).length) inputs[name] = opts.options[0].key;
          }
          // Clamp numerics into the schema's declared range. An out-of-range value
          // (a -1 "random" seed against min 0) is a hard ComfyUI rejection, so the
          // clamped value is the only one that can run.
          if (assigned && (typeName === 'INT' || typeName === 'FLOAT') && typeof inputs[name] === 'number') {
            if (typeof opts.min === 'number' && inputs[name] < opts.min) inputs[name] = opts.min;
            if (typeof opts.max === 'number' && inputs[name] > opts.max) inputs[name] = opts.max;
          }
          if (typeName === 'COMFY_DYNAMICCOMBO_V3') {
            widgetIdx = expandDynamicCombo(inputs, name, def, inputs[name], widgetValues, widgetIdx);
          }
          // Skip extra control_after_generate widget that follows seed INT inputs
          if (typeName === 'INT' && widgetIdx < widgetValues.length) {
            const next = widgetValues[widgetIdx];
            if (next === null || next === 'fixed' || next === 'increment' || next === 'decrement' || next === 'randomize') {
              widgetIdx++;
            }
          }
        }
      }
    } else {
      // Fallback: use inputs array with widget sub-objects
      let widgetIdx = 0;
      for (const inp of nodeInputs) {
        if (inp.widget) {
          if (!linkedInputs.has(inp.name) && widgetIdx < widgetValues.length) {
            let val = widgetValues[widgetIdx];
            if (Array.isArray(val) && val.length === 2 && Array.isArray(val[1])) val = val[0];
            inputs[inp.name] = val;
          }
          widgetIdx++;
        }
      }
    }

    // A value set on a subgraph instance's promoted widget belongs to whichever
    // interior input that subgraph socket feeds (see flattenSubgraphs).
    if (node.__promoted) {
      for (const [k, v] of Object.entries(node.__promoted)) if (!linkedInputs.has(k)) inputs[k] = v;
    }

    prompt[nodeId] = {
      class_type: node.type,
      inputs,
      _meta: { title: node.title || node.type },
    };
  }

  // ── Resolve "Anything Everywhere" (cg-use-everywhere) broadcast links ──
  // These frontend-only nodes invisibly feed any matching unconnected input by
  // type; ComfyUI's web UI resolves them at queue time, so we must do the same
  // or consumers (model/clip/vae...) arrive with missing inputs and ComfyUI
  // silently drops the whole subtree at validation.
  const ueSources = [];
  for (const node of nodes) {
    if (!/^(Anything Everywhere|Prompts Everywhere|Seed Everywhere)/.test(node.type || '')) continue;
    if (node.mode === 2 || node.mode === 4) continue;
    const props = (node.properties && node.properties.ue_properties) || node.properties || {};
    for (const inp of node.inputs || []) {
      if (inp.link == null || !linkMap[inp.link]) continue;
      const resolved = resolveBypass(linkMap[inp.link].fromNode, linkMap[inp.link].fromSlot);
      if (!resolved) continue;
      let titleRegex = null, inputRegex = null;
      try { if (props.title_regex) titleRegex = new RegExp(props.title_regex); } catch {}
      try { if (props.input_regex) inputRegex = new RegExp(props.input_regex); } catch {}
      ueSources.push({ type: (inp.type || '').toUpperCase(), from: [resolved.fromNode, resolved.fromSlot], titleRegex, inputRegex });
    }
  }
  if (ueSources.length) {
    for (const node of nodes) {
      const pn = prompt[String(node.id)];
      if (!pn) continue;
      for (const inp of node.inputs || []) {
        if (inp.widget) continue;                          // widget sockets aren't UE targets
        if (pn.inputs[inp.name] !== undefined) continue;   // already wired or has a value
        const t = (inp.type || '').toUpperCase();
        if (!t || t === '*') continue;
        const src = ueSources.find(s => s.type === t
          && (!s.titleRegex || s.titleRegex.test(node.title || ''))
          && (!s.inputRegex || s.inputRegex.test(inp.name)));
        if (src) pn.inputs[inp.name] = src.from;
      }
    }
  }

  // ── Prune dead branches (mirrors ComfyUI, which builds prompts backward from
  // output nodes and never submits disabled branches) ──
  // 1) Nodes whose required editor-wired input dead-ended in a muted/bypassed
  //    chain (__dead marker) can't run.
  const isRef = v => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string';
  for (const [id, n] of Object.entries(prompt)) {
    if (n.inputs.__dead) delete prompt[id];
  }
  // 2) Cascade: a dangling ref on a REQUIRED input kills the node; a dangling
  //    ref on an optional input just drops that input (ComfyUI's semantics).
  let prunedSomething = true;
  while (prunedSomething) {
    prunedSomething = false;
    for (const [id, n] of Object.entries(prompt)) {
      const inf = objectInfo[n.class_type];
      const required = (inf && inf.input && inf.input.required) || {};
      for (const [key, v] of Object.entries(n.inputs)) {
        if (!isRef(v) || prompt[v[0]]) continue;
        if (key in required) { delete prompt[id]; prunedSomething = true; break; }
        delete n.inputs[key];
      }
    }
  }
  // 3) Keep only nodes that feed an output node (SaveImage etc.) — active nodes
  //    orphaned by a bypassed branch would otherwise fail ComfyUI validation.
  const outputIds = Object.entries(prompt)
    .filter(([, n]) => { const inf = objectInfo[n.class_type]; return inf && inf.output_node === true; })
    .map(([id]) => id);
  if (outputIds.length) {
    const keep = new Set();
    const stack = [...outputIds];
    while (stack.length) {
      const id = stack.pop();
      if (keep.has(id)) continue;
      keep.add(id);
      for (const v of Object.values(prompt[id].inputs)) {
        if (isRef(v) && prompt[v[0]]) stack.push(v[0]);
      }
    }
    for (const id of Object.keys(prompt)) if (!keep.has(id)) delete prompt[id];
  }
  for (const n of Object.values(prompt)) delete n.inputs.__dead;

  return prompt;
}

// ── Style/quality preset groups (rgthree "Fast Groups Muter", max-one) ──
// The workflow toggles mutually-exclusive preset groups (Realism, Anime, etc.)
// by muting/un-muting all nodes inside a colored group. We replicate rgthree's
// geometric group membership so we can activate exactly one preset server-side.
const RGTHREE_GROUP_COLORS = { purple: '#a1309b' };

function nodeInGroup(node, group) {
  if (!node.pos || !group.bounding) return false;
  const [gx, gy, gw, gh] = group.bounding;
  const [nx, ny] = node.pos;
  return nx >= gx - 2 && ny >= gy - 2 && nx <= gx + gw && ny <= gy + gh;
}

// Return [{ title, on, memberIds: [] }] for the preset groups a max-one Groups
// Muter governs (matched by group color). Empty if the workflow has no such muter.
function detectPresetGroups(wf) {
  const nodes = wf.nodes || [];
  const groups = wf.groups || [];
  const muter = nodes.find(n => (n.type || '').includes('Fast Groups Muter')
    && n.properties && (n.properties.matchColors || '') !== ''
    && n.properties.toggleRestriction === 'max one');
  if (!muter) return [];
  const presetColor = RGTHREE_GROUP_COLORS[(muter.properties.matchColors || '').toLowerCase()];
  if (!presetColor) return [];
  return groups
    .filter(g => (g.color || '').toLowerCase() === presetColor)
    .map(g => {
      const members = nodes.filter(n => nodeInGroup(n, g));
      return {
        title: g.title,
        on: members.some(n => (n.mode || 0) === 0),
        memberIds: members.map(n => n.id),
      };
    });
}

// ── App workflow registry ──────────────────────────────────────────────
// Which install-dir workflows are exposed in the app, plus per-workflow node
// mappings (which node is the prompt/steps/seed) so we never have to rename or
// mutate the original .json. Convention-based auto-detect is the fallback.
let WORKFLOWS_DIR = path.join(COMFY_DIR, 'user', 'default', 'workflows');
const WF_STORE_PATH = path.join(__dirname, 'app-workflows.json');

function loadWfStore() {
  let store = { enabled: [], mappings: {}, labels: {}, fieldConfigs: {}, shortcuts: {} };
  try { store = Object.assign(store, JSON.parse(fs.readFileSync(WF_STORE_PATH, 'utf8'))); } catch {}
  if (!store.fieldConfigs) store.fieldConfigs = {};
  if (!store.shortcuts) store.shortcuts = {};
  // First-run migration: seed the allowlist from legacy "APP *.json" files.
  if (!store._migrated) {
    try {
      const legacy = fs.readdirSync(WORKFLOWS_DIR).filter(n => n.startsWith('APP ') && n.endsWith('.json'));
      for (const n of legacy) if (!store.enabled.includes(n)) store.enabled.push(n);
    } catch {}
    store._migrated = true;
    saveWfStore(store);
  }
  return store;
}
function saveWfStore(store) {
  try { fs.writeFileSync(WF_STORE_PATH, JSON.stringify(store, null, 2)); return true; } catch { return false; }
}

// Field-config runtime (build + apply). Extracted to field-config-runtime.js so
// the logic is unit-testable without the HTTP server; deps injected here.
const fieldConfigRuntime = require('./field-config-runtime.js')({
  generator: fieldConfigGen,
  loadStore: loadWfStore,
  detectPresetGroups: (wf) => detectPresetGroups(wf),
});
const buildFieldConfig = fieldConfigRuntime.buildFieldConfig;
const applyFieldConfigOverrides = fieldConfigRuntime.applyFieldConfigOverrides;

// ── LoRA vocabulary index ────────────────────────────────────────────────
// Which words in a lora filename actually identify it? The Remix dialog uses
// this to surface a disabled lora when the prompt mentions what it does, and
// that needs to know which words are meaningful — `deepthroat` yes, `high` and
// `wan22` no. Reading the answer off the library beats a hand-kept stop list,
// which is stale the moment a new model family lands: tokenise every filename
// and treat whatever recurs across a large share of the library as boilerplate.
//
// Deliberately permissive. A word can only produce a false match if it appears
// in BOTH a filename and a prompt, so the technical debris (`lightx2v`, `rank64`,
// `bf16`) is harmless whether or not it survives — nobody types it. The cost of
// cutting too deep is much higher: on this library `deepthroat` occurs in 6
// loras and 58% of prompts, so any prompt-frequency rule would delete the single
// most useful match. Only cross-library recurrence is used, nothing else.
const LORA_TOKEN_MIN = 4;          // shorter words match everything
const LORA_BOILERPLATE_SHARE = 0.06;
function loraTokens(name) {
  const out = new Set();
  const base = String(name == null ? '' : name).split(/[\\/]/).pop().replace(/\.(safetensors|ckpt|pt|pth|bin|gguf)$/i, '');
  for (let w of base.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < LORA_TOKEN_MIN || /^\d+$/.test(w)) continue;
    if (w.length > LORA_TOKEN_MIN && w.endsWith('s')) w = w.slice(0, -1);   // crude plural fold; the client folds identically
    out.add(w);
  }
  return out;
}
// terms maps word -> how many loras carry it, so the client can lead with the
// rarest (most specific) match when several words hit at once.
function buildLoraIndex(names) {
  const df = new Map();
  for (const n of names || []) for (const w of loraTokens(n)) df.set(w, (df.get(w) || 0) + 1);
  const cutoff = Math.max(4, Math.ceil((names || []).length * LORA_BOILERPLATE_SHARE));
  const terms = {};
  for (const [w, c] of df) if (c <= cutoff) terms[w] = c;
  return { terms, cutoff, loras: (names || []).length, words: df.size, kept: Object.keys(terms).length };
}
// Optional `loraDir` — a folder of model files readable by this process. Left
// unset the names come from ComfyUI's lora list instead, which is ComfyUI
// enumerating the same directory; the Remix dialog already cannot build a field
// config without object_info, so that source costs nothing extra. Set this only
// when the models are on a path this process can actually reach (they are not,
// when ComfyUI runs in a container with its own model mount).
function loraNamesFromDisk() {
  const dir = config.loraDir;
  if (!dir) return [];
  const out = [];
  const walk = (d, prefix) => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) { walk(path.join(d, e.name), prefix + e.name + '/'); continue; }
      if (/\.(safetensors|ckpt|pt|pth|bin|gguf)$/i.test(e.name)) out.push(prefix + e.name);
    }
  };
  walk(dir, '');
  return out;
}
if (config.loraDir) {
  const n = loraNamesFromDisk();
  const ix = buildLoraIndex(n);
  console.log(n.length
    ? `[LoRA] indexed ${n.length} loras from ${config.loraDir} — ${ix.kept}/${ix.words} words kept (boilerplate above ${ix.cutoff} loras)`
    : `[LoRA] loraDir "${config.loraDir}" is empty or unreadable — falling back to ComfyUI's lora list`);
}

// First-run bootstrap: copy the bundled starter workflows (default-workflows/)
// into the ComfyUI install and enable them, so a fresh clone has working
// examples. Files already present are never overwritten.
function seedDefaultWorkflows() {
  const srcDir = path.join(__dirname, 'default-workflows');
  try {
    if (!fs.existsSync(srcDir) || !fs.existsSync(WORKFLOWS_DIR)) return;
    const seeded = [];
    for (const f of fs.readdirSync(srcDir).filter(n => n.endsWith('.json'))) {
      const dest = path.join(WORKFLOWS_DIR, f);
      if (!fs.existsSync(dest)) { fs.copyFileSync(path.join(srcDir, f), dest); seeded.push(f); }
    }
    if (seeded.length) {
      const store = loadWfStore();
      let changed = false;
      for (const f of seeded) if (!store.enabled.includes(f)) { store.enabled.push(f); changed = true; }
      if (changed) saveWfStore(store);
      console.log('[Workflows] Seeded starter workflows:', seeded.join(', '));
    }
  } catch (e) { console.log('[Workflows] seeding failed:', e.message); }
}
seedDefaultWorkflows();

// Recursively list every workflow .json under the install workflows dir.
// Returns names relative to WORKFLOWS_DIR using forward slashes.
function listAllWorkflows() {
  const out = [];
  function walk(dir, prefix) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const rel = prefix ? prefix + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), rel);
      else if (e.name.endsWith('.json')) out.push(rel);
    }
  }
  walk(WORKFLOWS_DIR, '');
  return out.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

function defaultLabel(name) {
  return name.replace(/^APP /, '').replace(/\.json$/, '').replace(/^.*\//, '');
}

// ── Shortcuts ──────────────────────────────────────────────────────────────
// A shortcut is a saved set of field values against an existing workflow, NOT a
// copy of its graph: copying would duplicate megabytes per shortcut and fork it
// from the parent, so later edits to the workflow would silently stop reaching
// its shortcuts. Everywhere a workflow filename is accepted, "@sc:<id>" is too,
// and resolves to the parent file plus the values to pre-apply.
const SHORTCUT_PREFIX = '@sc:';
const isShortcutName = n => typeof n === 'string' && n.startsWith(SHORTCUT_PREFIX);
// Label shown in the dropdown. The " : " delimiter is what groups a shortcut
// under its parent on the client, so it must not appear in a shortcut's own name.
const shortcutLabel = (store, sc) => (store.labels[sc.parent] || defaultLabel(sc.parent)) + ' : ' + sc.name;
function resolveWfName(name) {
  if (!isShortcutName(name)) return { file: name, shortcut: null };
  const sc = loadWfStore().shortcuts[name.slice(SHORTCUT_PREFIX.length)];
  return sc ? { file: sc.parent, shortcut: sc } : { file: null, shortcut: null };
}

// Resolve which node holds the prompt/steps/seed, honoring an explicit mapping
// first, then falling back to naming/type conventions.
const UI_ONLY_TYPES = new Set(['Reroute', 'PrimitiveNode', 'Note', 'MarkdownNote', 'Label (rgthree)', 'Bookmark (rgthree)']);
function nodeById(wf, id) { return (wf.nodes || []).find(n => String(n.id) === String(id)); }

function resolvePromptNode(wf, mapping) {
  if (mapping && mapping.promptNodeId != null) { const n = nodeById(wf, mapping.promptNodeId); if (n) return n; }
  for (const n of wf.nodes || []) {
    const t = (n.title || '').toUpperCase();
    if (t.includes('MAIN') && t.includes('PROMPT')) return n;
  }
  // Best-effort guess: a titled "Positive Prompt" text node outside detailer groups,
  // else the longest string-bearing node.
  let best = null, bestLen = -1;
  for (const n of wf.nodes || []) {
    if (UI_ONLY_TYPES.has(n.type)) continue;
    const wv = n.widgets_values;
    const txt = Array.isArray(wv) && typeof wv[0] === 'string' ? wv[0] : '';
    if (!txt) continue;
    const t = (n.title || '').toUpperCase();
    const score = (t.includes('POS') && t.includes('PROMPT') ? 100000 : 0) + txt.length;
    if (score > bestLen) { bestLen = score; best = n; }
  }
  return best;
}
function resolveStepsNode(wf, mapping) {
  if (mapping && mapping.stepsNodeId != null) { const n = nodeById(wf, mapping.stepsNodeId); if (n) return n; }
  return (wf.nodes || []).find(n => (n.title || '').toUpperCase() === 'STEPS' && n.type === 'mxSlider') || null;
}
// Wan-style dual-sampler workflows: two active KSamplerAdvanced nodes where the
// high-noise pass starts at step 0 and hands off to the low-noise pass.
// widgets_values: [add_noise, noise_seed, control, steps, cfg, sampler, scheduler,
//                  start_at_step, end_at_step, return_with_leftover_noise]
function findHighLowSamplers(wf) {
  const ks = (wf.nodes || []).filter(n => n.type === 'KSamplerAdvanced'
    && Array.isArray(n.widgets_values) && n.widgets_values.length >= 9
    && n.mode !== 2 && n.mode !== 4);
  if (ks.length !== 2) return null;
  const high = ks.find(n => Number(n.widgets_values[7]) === 0);
  const low = ks.find(n => Number(n.widgets_values[7]) > 0);
  return (high && low) ? { high, low } : null;
}

function resolveSeedNode(wf, mapping) {
  if (mapping && mapping.seedNodeId != null) { const n = nodeById(wf, mapping.seedNodeId); if (n) return n; }
  return (wf.nodes || []).find(n => n.type === 'Seed (rgthree)' && (n.mode || 0) === 0) || null;
}

// Read the enabled LoRA slots from a Power Lora Loader node's widgets_values.
function extractLoras(node) {
  const out = [];
  const wv = (node && node.widgets_values) || [];
  for (let i = 0; i < wv.length; i++) {
    const v = wv[i];
    if (v && typeof v === 'object' && v.lora) out.push({ slot: i, on: !!v.on, strength: v.strength || 1, lora: v.lora });
  }
  return out;
}

// Write on/strength overrides back onto a loader node by slot.
function applyLoraOverrides(node, ovs) {
  if (!node || !Array.isArray(ovs)) return;
  const wv = node.widgets_values || [];
  for (const o of ovs) {
    if (o.slot != null && wv[o.slot] && typeof wv[o.slot] === 'object' && wv[o.slot].lora) {
      if (o.on !== undefined) wv[o.slot].on = o.on;
      if (o.strength !== undefined) wv[o.slot].strength = o.strength;
    }
  }
}

// Wan-style dual-sampler workflows carry two Power Lora Loaders — one per
// (high/low)-noise pass. Map each to its pass by tracing the sampler's model
// input back through the graph to a loader. Returns { high, low } or null.
function findHighLowLoraLoaders(wf) {
  const hl = findHighLowSamplers(wf);
  if (!hl) return null;
  const loaders = (wf.nodes || []).filter(n => (n.type || '').includes('Power Lora Loader') && n.mode !== 2 && n.mode !== 4);
  if (loaders.length !== 2) return null;
  const linkById = {};
  for (const l of (wf.links || [])) if (Array.isArray(l)) linkById[l[0]] = l; // [id, from, fromSlot, to, toSlot, type]
  const byId = {};
  for (const n of (wf.nodes || [])) byId[String(n.id)] = n;
  const loaderFeeding = (nodeId, depth) => {
    if (depth > 16) return null;
    const node = byId[String(nodeId)];
    if (!node) return null;
    if ((node.type || '').includes('Power Lora Loader')) return node;
    const inp = (node.inputs || []).find(i => /model/i.test(i.name || ''));
    if (!inp || inp.link == null) return null;
    const link = linkById[inp.link];
    return link ? loaderFeeding(link[1], depth + 1) : null;
  };
  const high = loaderFeeding(hl.high.id, 0), low = loaderFeeding(hl.low.id, 0);
  if (!high || !low || String(high.id) === String(low.id)) return null;
  return { high, low };
}

// CFG: an mxSlider titled "CFG" by convention, else the active KSampler-family
// nodes (cfg widget index 3 on KSampler, 4 on KSamplerAdvanced). When multiple
// samplers are active they must agree on the value — otherwise the workflow
// intends different CFGs per pass and we don't expose a single control that
// would clobber that. Returns { get, set } or null.
function resolveCfg(wf) {
  const slider = (wf.nodes || []).find(n => (n.title || '').toUpperCase() === 'CFG'
    && (n.type === 'mxSlider' || n.type === 'mxSliderF') && Array.isArray(n.widgets_values));
  if (slider) {
    const wv = slider.widgets_values;
    return {
      get: () => typeof wv[0] === 'number' ? wv[0] : (typeof wv[1] === 'number' ? wv[1] : null),
      set: (v) => { if (typeof wv[0] === 'number') wv[0] = v; if (typeof wv[1] === 'number') wv[1] = v; },
    };
  }
  const cfgIdx = n => n.type === 'KSamplerAdvanced' ? 4 : 3;
  const samplers = (wf.nodes || []).filter(n =>
    (n.type === 'KSampler' || n.type === 'KSamplerAdvanced')
    && n.mode !== 2 && n.mode !== 4
    && Array.isArray(n.widgets_values) && typeof n.widgets_values[cfgIdx(n)] === 'number');
  if (!samplers.length) return null;
  const first = samplers[0].widgets_values[cfgIdx(samplers[0])];
  if (!samplers.every(n => n.widgets_values[cfgIdx(n)] === first)) return null;
  return {
    get: () => samplers[0].widgets_values[cfgIdx(samplers[0])],
    set: (v) => { for (const n of samplers) n.widgets_values[cfgIdx(n)] = v; },
  };
}

// Candidate nodes for the mapping editor dropdowns.
function workflowCandidates(wf) {
  const strNodes = [], intNodes = [], seedNodes = [];
  for (const n of wf.nodes || []) {
    if (UI_ONLY_TYPES.has(n.type)) continue;
    const wv = Array.isArray(n.widgets_values) ? n.widgets_values : [];
    const snippet = (s) => String(s).replace(/\s+/g, ' ').slice(0, 60);
    const base = { id: n.id, type: n.type, title: n.title || '' };
    if (typeof wv[0] === 'string' && wv[0].length > 0) strNodes.push({ ...base, sample: snippet(wv[0]) });
    if (typeof wv[0] === 'number' && Number.isInteger(wv[0])) intNodes.push({ ...base, sample: String(wv[0]) });
    if (n.type === 'Seed (rgthree)' || /seed/i.test(n.title || '')) seedNodes.push({ ...base, sample: String(wv[0]) });
  }
  return { prompt: strNodes, steps: intNodes, seed: seedNodes };
}

// Cross-drive move: rename if same drive, copy+delete otherwise
function moveFile(src, dest, cb) {
  fs.rename(src, dest, (err) => {
    if (!err) return cb(null);
    // Cross-device fallback
    const rs = fs.createReadStream(src);
    const ws = fs.createWriteStream(dest);
    rs.on('error', cb);
    ws.on('error', cb);
    ws.on('close', () => fs.unlink(src, cb));
    rs.pipe(ws);
  });
}

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.m4v': 'video/mp4',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.flac': 'audio/flac', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json',
};

const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg']);
const THUMB_EXT = ['.jpg', '.jpeg', '.png', '.webp'];

// Same lookup, but keeps the mtime so callers can version the URL. A thumbnail
// is written beside its video under a derived name, and ComfyUI reuses output
// filenames whenever its counter resets -- so the path alone is NOT a stable
// identity, and a browser holding the old bytes (max-age=3600) will happily put
// a previous generation's still on a brand new clip. statSync costs the same as
// the existsSync it replaces.
function getThumbInfo(filePath) {
  const base = filePath.replace(/\.[^.]+$/, '');
  for (const ext of THUMB_EXT) {
    const t = base + ext;
    try { const st = fs.statSync(t); return { path: t, v: Math.floor(st.mtimeMs) }; } catch {}
  }
  return null;
}
function getThumbPath(filePath) { const i = getThumbInfo(filePath); return i ? i.path : null; }

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

// How the browser is allowed to keep media. Chosen in Settings > Privacy.
//
// `private` throughout, never `public`: every one of these responses sits behind
// the session cookie, and `public` would license a shared cache to keep an
// authenticated body.
//
// Note what none of these can do — there is no header that erases bytes at a
// deadline. max-age governs how long a copy may be REUSED without asking, not
// how long it is kept, so a cached file can outlive its max-age on disk
// indefinitely. Only 'nostore' actually keeps media off the disk, which is why
// it is the default.
const MEDIA_CACHE = {
  nostore:  'private, no-store, must-revalidate',
  validate: 'private, no-cache',
  day:      'private, max-age=86400',
};
function mediaCacheHeader() {
  return MEDIA_CACHE[config.mediaCachePolicy] || MEDIA_CACHE.nostore;
}

function serveFile(filePath, req, res) {
  fs.stat(filePath, (err, stat) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }

    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    const size = stat.size;
    const range = req.headers.range;
    // Preserve Cache-Control if already set (e.g. no-cache for SPA)
    const cc = res.getHeader('Cache-Control') || 'public, max-age=3600';

    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = parseInt(startStr, 10);
      const end = endStr ? parseInt(endStr, 10) : size - 1;
      const chunk = end - start + 1;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunk,
        'Content-Type': mime,
        'Cache-Control': cc,
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': size,
        'Content-Type': mime,
        'Accept-Ranges': 'bytes',
        'Cache-Control': cc,
      });
      fs.createReadStream(filePath).pipe(res);
    }
  });
}

function jsonRes(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(data));
}

// A dropped connection must never be fatal. This server proxies ComfyUI over both
// HTTP and WebSocket, streams SSE to browsers, and serves range requests for large
// video — all of which produce socket errors as normal traffic when a client
// navigates away or the ComfyUI container restarts. Narrow on purpose: only
// connection-level errors are swallowed, and everything is logged. Anything else
// still crashes, because a real bug should be loud.
process.on('uncaughtException', err => {
  const code = err && err.code;
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ECONNABORTED' || code === 'ERR_STREAM_DESTROYED') {
    console.log('[Recovered] ' + code + ': ' + err.message);
    return;
  }
  console.error('[Fatal]', err);
  process.exit(1);
});

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, DELETE', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end(); return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pn = url.pathname;

  // ── Password gate ────────────────────────────────────────────────────────
  // These three are the only routes reachable while locked. /status is public on
  // purpose: it says whether a password is required, nothing about what it is.
  if (pn === '/api/auth/status' && req.method === 'GET') {
    jsonRes(res, { enabled: authState().enabled, authed: isAuthed(req) });
    return;
  }
  if (pn === '/api/auth/logout' && req.method === 'POST') {
    setSessionCookie(req, res, '');
    // Clearing the cookie ends the session but leaves every thumbnail and full
    // frame already on disk in the browser cache. This asks for those bytes to
    // go too. Chrome, Edge and Firefox honour it; Safari does not implement
    // Clear-Site-Data at all, so on iOS this is a no-op and the cache outlives
    // the logout — a real gap, not a covered one.
    res.setHeader('Clear-Site-Data', '"cache"');
    jsonRes(res, { ok: true });
    return;
  }
  if (pn === '/api/auth/login' && req.method === 'POST') {
    const st = authState();
    if (!st.enabled) { jsonRes(res, { ok: true }); return; }     // nothing to log into
    const ip = clientIp(req);
    const wait = throttleWait(ip);
    if (wait) { jsonRes(res, { error: 'Too many attempts — wait ' + wait + 's', retryAfter: wait }, 429); return; }
    let bodyStr = '';
    req.on('data', c => { bodyStr += c; if (bodyStr.length > 4096) req.destroy(); });
    req.on('end', () => {
      let body; try { body = JSON.parse(bodyStr); } catch { jsonRes(res, { error: 'Bad JSON' }, 400); return; }
      if (authInFlight >= AUTH_MAX_INFLIGHT) { jsonRes(res, { error: 'Busy — try again', retryAfter: 1 }, 429); return; }
      // Counted before the check, not after: counting only failures lets a
      // concurrent burst through the throttle entirely. A success clears it.
      noteAuthAttempt(ip);
      authInFlight++;
      verifyPassword(String(body.password || ''), st.hash, ok => {
        authInFlight--;
        if (!ok) { jsonRes(res, { ok: false }, 401); return; }
        authFails.delete(ip);
        setSessionCookie(req, res, makeSession(st.hash));
        jsonRes(res, { ok: true });
      });
    });
    return;
  }
  // Everything else — pages, APIs, media, thumbnails — is sealed. A request that
  // wanted a page gets the lock screen in place of it (any route, so a deep link
  // still lands where it meant to after login); anything else gets a bare 401.
  if (!isAuthed(req)) {
    // An API answers 401 whatever it says it accepts — only a navigation gets a page.
    if ((req.method === 'GET' || req.method === 'HEAD') && !pn.startsWith('/api/')
        && String(req.headers.accept || '').includes('text/html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, must-revalidate' });
      res.end(req.method === 'HEAD' ? '' : LOGIN_PAGE);
    } else {
      jsonRes(res, { error: 'Locked' }, 401);
    }
    return;
  }

  // Serve SPA (no cache for dev)
  if (pn === '/' || pn === '/index.html') {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    serveFile(path.join(__dirname, 'index.html'), req, res); return;
  }
  // Serve jobs page
  // Shared static assets (explicit allowlist — no generic file serving)
  if ((pn === '/common.css' || pn === '/app.css' || pn === '/ui-guards.js' || pn === '/auth-ui.js'
       || pn === '/logo-home.jpg') && req.method === 'GET') {
    res.setHeader('Cache-Control', 'no-cache');
    serveFile(path.join(__dirname, pn.slice(1)), req, res); return;
  }

  // Front-end source, served as native ES modules — no build step, so the app is
  // split into real files instead of one enormous page. Same allowlist shape as
  // /vendor/ but one directory deep (app/views/, app/components/, app/styles/).
  if (pn.startsWith('/app/') && req.method === 'GET') {
    const rel = pn.slice('/app/'.length);
    const dir = path.join(__dirname, 'app');
    const fp = path.join(dir, rel);
    if (/^(?:[a-z0-9._-]+\/)?[a-z0-9._-]+\.(?:js|css)$/i.test(rel) && path.resolve(fp).startsWith(path.resolve(dir))) {
      res.setHeader('Cache-Control', 'no-cache');
      serveFile(fp, req, res); return;
    }
    res.writeHead(404); res.end('Not found'); return;
  }

  // Vendored front-end libs (Vue, Vue Router). Allowlisted .js only, path-safe.
  if (pn.startsWith('/vendor/') && req.method === 'GET') {
    const rel = pn.slice('/vendor/'.length);
    const dir = path.join(__dirname, 'vendor');
    const fp = path.join(dir, rel);
    if (/^[a-z0-9._-]+\.js$/i.test(rel) && path.resolve(fp).startsWith(path.resolve(dir))) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
      serveFile(fp, req, res); return;
    }
    res.writeHead(404); res.end('Not found'); return;
  }

  // Serve metadata viewer page
  if (pn === '/inspect-page') {
    // Static page — reads path/name/type from its own query params
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    serveFile(path.join(__dirname, 'inspect.html'), req, res); return;
  }

  // API: Save debug results
  if (pn === '/api/debug-results' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      fs.writeFileSync(path.join(__dirname, 'debug-results.json'), body, 'utf8');
      jsonRes(res, { ok: true });
    });
    return;
  }

  // Debug page — tests core functionality
  if (pn === '/debug') {
    const BUILD_ID = '2026-03-13T20:22';
    const debugHtml = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Debug — ComfyRemix</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0d0d0d;color:#f2f2f7;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;padding:20px;max-width:700px;margin:0 auto}
h1{font-size:20px;margin-bottom:16px}
.build{color:#86868b;font-size:13px;margin-bottom:20px}
.test{background:#1c1c1e;border:1px solid #38383a;border-radius:8px;padding:12px 16px;margin-bottom:10px}
.test-hdr{display:flex;justify-content:space-between;align-items:center;font-size:14px;font-weight:600}
.test-detail{font-size:12px;color:#86868b;margin-top:6px;word-break:break-all;white-space:pre-wrap}
.badge{font-size:12px;padding:2px 8px;border-radius:10px;font-weight:600}
.pass{background:#1b3a1b;color:#34c759}.fail{background:#3a1b1b;color:#ff453a}.wait{background:#3a3520;color:#ffd60a}
button{background:#2c2c2e;color:#f2f2f7;border:1px solid #48484a;border-radius:6px;padding:8px 16px;font-size:14px;cursor:pointer;margin-top:16px}
button:active{background:#48484a}
</style>
</head><body>
<h1>ComfyRemix Debug</h1>
<div class="build">Build: ${BUILD_ID} | Host: <span id="hostInfo"></span></div>
<div id="tests"></div>
<button onclick="runTests()">Re-run Tests</button>
<button id="saveBtn" onclick="saveResults()" disabled>Save Results</button>
<span id="saveStatus" style="font-size:12px;color:#86868b;margin-left:8px"></span>
<script>
const tests = document.getElementById('tests');
const saveBtn = document.getElementById('saveBtn');
const saveStatus = document.getElementById('saveStatus');
document.getElementById('hostInfo').textContent = location.host + ' (' + location.protocol + ')';
const results = [];

function addTest(name) {
  const div = document.createElement('div');
  div.className = 'test';
  div.innerHTML = '<div class="test-hdr"><span>' + name + '</span><span class="badge wait" id="b-' + name + '">...</span></div><div class="test-detail" id="d-' + name + '"></div>';
  tests.appendChild(div);
  return {
    pass(msg) { document.getElementById('b-' + name).className = 'badge pass'; document.getElementById('b-' + name).textContent = 'PASS'; document.getElementById('d-' + name).textContent = msg || ''; results.push({test: name, status: 'PASS', detail: msg || ''}); },
    fail(msg) { document.getElementById('b-' + name).className = 'badge fail'; document.getElementById('b-' + name).textContent = 'FAIL'; document.getElementById('d-' + name).textContent = msg || ''; results.push({test: name, status: 'FAIL', detail: msg || ''}); }
  };
}

async function saveResults() {
  const payload = {
    build: '${BUILD_ID}',
    timestamp: new Date().toISOString(),
    host: location.host,
    protocol: location.protocol,
    userAgent: navigator.userAgent,
    results: results
  };
  try {
    const r = await fetch('/api/debug-results', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload, null, 2) });
    if (r.ok) { saveStatus.textContent = 'Saved!'; saveStatus.style.color = '#34c759'; }
    else { saveStatus.textContent = 'Error ' + r.status; saveStatus.style.color = '#ff453a'; }
  } catch(e) { saveStatus.textContent = e.message; saveStatus.style.color = '#ff453a'; }
}

async function runTests() {
  tests.innerHTML = '';
  results.length = 0;
  saveBtn.disabled = true;
  saveStatus.textContent = '';

  // 1. Fetch API
  const t1 = addTest('Fetch API');
  try {
    const r = await fetch('/api/list?limit=2');
    const d = await r.json();
    if (d.items) t1.pass(d.items.length + ' items returned, root: ' + (d.root || 'n/a'));
    else t1.fail('Unexpected response: ' + JSON.stringify(d).substring(0, 200));
  } catch(e) { t1.fail(e.message); }

  // 2. File serving
  const t2 = addTest('File Serve');
  try {
    const r = await fetch('/api/list?limit=5');
    const d = await r.json();
    const file = d.items.find(i => !i.isDir && (i.isImage || i.isVideo));
    if (!file) { t2.fail('No media files found to test'); }
    else {
      const fr = await fetch('/file/' + encodeURIComponent(file.path), { method: 'HEAD' });
      if (fr.ok) t2.pass(fr.status + ' ' + file.name + ' (' + fr.headers.get('content-type') + ')');
      else t2.fail(fr.status + ' for ' + file.name);
    }
  } catch(e) { t2.fail(e.message); }

  // 3. Metadata extraction
  const t3 = addTest('Metadata API');
  try {
    const r = await fetch('/api/list?limit=50');
    const d = await r.json();
    const png = d.items.find(i => i.isImage && i.name.endsWith('.png'));
    if (!png) { t3.fail('No PNG found to test metadata extraction'); }
    else {
      const mr = await fetch('/api/metadata?path=' + encodeURIComponent(png.path));
      const md = await mr.json();
      if (mr.ok && (md.prompt || md.workflow)) t3.pass('Got metadata from ' + png.name + ' (prompt: ' + !!md.prompt + ', workflow: ' + !!md.workflow + ')');
      else if (mr.ok) t3.pass('No metadata in ' + png.name + ' (file has no ComfyUI data)');
      else t3.fail(mr.status + ': ' + JSON.stringify(md));
    }
  } catch(e) { t3.fail(e.message); }

  // 4. WebSocket (ComfyUI proxy)
  const t4 = addTest('WebSocket Proxy');
  try {
    await new Promise((resolve) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(proto + '//' + location.host + '/comfy-ws?clientId=debug-' + Date.now());
      const timer = setTimeout(() => { ws.close(); t4.fail('Timeout after 5s — no message received'); resolve(); }, 5000);
      ws.onmessage = (e) => {
        clearTimeout(timer);
        let preview = typeof e.data === 'string' ? e.data.substring(0, 150) : '(binary ' + e.data.size + ' bytes)';
        t4.pass('Message received: ' + preview);
        ws.close();
        resolve();
      };
      ws.onerror = () => { clearTimeout(timer); t4.fail('WebSocket connection error'); resolve(); };
      ws.onclose = (e) => { if (!e.wasClean) { clearTimeout(timer); t4.fail('Connection closed (code ' + e.code + ')'); resolve(); } };
    });
  } catch(e) { t4.fail(e.message); }

  // 5. ComfyUI HTTP proxy
  const t5 = addTest('ComfyUI HTTP Proxy');
  try {
    const r = await fetch('/api/comfy/system_stats');
    if (r.ok) {
      const d = await r.json();
      const gpu = d.devices && d.devices[0] ? d.devices[0].name : 'unknown';
      t5.pass('ComfyUI online — ' + gpu + ', VRAM: ' + (d.devices && d.devices[0] ? Math.round(d.devices[0].vram_total / 1073741824) + 'GB' : '?'));
    } else t5.fail('HTTP ' + r.status);
  } catch(e) { t5.fail(e.message); }

  // 6. Meta page generation
  const t6 = addTest('Meta Page Route');
  try {
    const r = await fetch('/meta?path=test.png&name=test.png&type=image');
    if (r.ok) {
      const html = await r.text();
      const hasAccordion = html.includes('accordion');
      const hasSummary = html.includes('summary-section');
      const hasTabs = html.includes('tab-workflow');
      t6.pass('HTML served (' + html.length + ' bytes) — accordions: ' + hasAccordion + ', summary: ' + hasSummary + ', tabs: ' + hasTabs);
    } else t6.fail('HTTP ' + r.status);
  } catch(e) { t6.fail(e.message); }

  // 7. Cache headers
  const t7 = addTest('Cache Headers');
  try {
    const r = await fetch('/');
    const cc = r.headers.get('cache-control') || '';
    if (cc.includes('no-cache')) t7.pass('SPA: ' + cc);
    else t7.fail('SPA missing no-cache: "' + cc + '"');
  } catch(e) { t7.fail(e.message); }

  saveBtn.disabled = false;
}

runTests();
</script>
</body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
    res.end(debugHtml);
    return;
  }

  // API: find files in ComfyUI output newer than a timestamp
  if (pn === '/api/recent-outputs' && req.method === 'GET') {
    const since = parseInt(url.searchParams.get('since') || '0', 10);
    const sinceDate = new Date(since);
    const results = [];
    function scanDir(dir) {
      let entries;
      try { entries = fs.readdirSync(dir); } catch { return; }
      for (const name of entries) {
        if (name.startsWith('.')) continue;
        const full = path.join(dir, name);
        let stat;
        try { stat = fs.statSync(full); } catch { continue; }
        if (stat.isDirectory()) { scanDir(full); continue; }
        if (stat.mtime >= sinceDate) {
          const ext = path.extname(name).toLowerCase();
          if (['.png','.jpg','.jpeg','.webp','.gif','.mp4','.webm','.mov'].includes(ext)) {
            results.push({ path: full.replace(/\\/g, '/'), name, modified: stat.mtime.toISOString(), v: Math.floor(stat.mtimeMs) });
          }
        }
      }
    }
    scanDir(COMFY_OUTPUT);
    results.sort((a, b) => new Date(a.modified) - new Date(b.modified));
    // Filter out companion PNG thumbnails that match a video file (e.g. Wan480_00034.png for Wan480_00034.mp4)
    const videoBasenames = new Set();
    for (const r of results) {
      const ext = path.extname(r.name).toLowerCase();
      if (['.mp4','.webm','.mov'].includes(ext)) {
        videoBasenames.add(r.name.replace(/\.[^.]+$/, ''));
      }
    }
    const filtered = [];
    for (const r of results) {
      const ext = path.extname(r.name).toLowerCase();
      const base = r.name.replace(/\.[^.]+$/, '');
      // Skip PNGs that are companion thumbnails for a video
      if (ext === '.png' && videoBasenames.has(base)) {
        // Store the png path on the video entry as its thumbnail
        const vidEntry = results.find(v => v.name.replace(/\.[^.]+$/, '') === base && v !== r);
        if (vidEntry) { vidEntry.thumbPath = r.path; vidEntry.thumbV = r.v; }
        continue;
      }
      filtered.push(r);
    }
    jsonRes(res, filtered);
    return;
  }

  // API: list directory
  if (pn === '/api/list' && req.method === 'GET') {
    const rawDir = url.searchParams.get('dir');
    const dir = (rawDir && rawDir.trim()) ? path.resolve(decodeURIComponent(rawDir)) : ROOT;
    // scope=all searches across BOTH media roots at once (ComfyUI output + the
    // media/favorites tree) — used by the Files & Media search box, which spans
    // all three tabs. Plain browsing stays scoped to a single dir.
    const scopeAll = url.searchParams.get('scope') === 'all';
    const normRoot = ROOT.replace(/\\/g, '/').toLowerCase();
    const normComfy = COMFY_OUTPUT.replace(/\\/g, '/').toLowerCase();
    if (!scopeAll) {
      // Prevent navigating outside allowed directories (normalize slashes for Windows)
      const normDir = dir.replace(/\\/g, '/').toLowerCase();
      if (!normDir.startsWith(normRoot) && !normDir.startsWith(normComfy)) { jsonRes(res, { error: 'Access denied' }, 403); return; }
    }
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '48', 10)));
    const search = (url.searchParams.get('search') || '').toLowerCase().trim();
    const sort = url.searchParams.get('sort') || 'name';
    const asc = url.searchParams.get('asc') !== 'false';
    const typeFilter = url.searchParams.get('type') || 'all'; // all | video | image | audio | folder
    const safeMode = url.searchParams.get('safe') === '1'; // omit NSFW-tagged items entirely
    // flatten=1 walks the whole subtree under `dir` and returns every media file
    // (no folder cards, unpaginated) so the SPA can show one long grouped-by-folder view.
    const flatten = url.searchParams.get('flatten') === '1';

    // A search, scope=all, or flatten spans the whole subtree; plain browsing lists one directory.
    const deep = !!search || scopeAll || flatten;
    const items = [];
    // scope=all seeds both roots (skipping ComfyUI output if it nests under ROOT).
    const scanQueue = scopeAll
      ? (normComfy.startsWith(normRoot) ? [ROOT] : [ROOT, COMFY_OUTPUT])
      : [dir];
    let first = true;
    while (scanQueue.length) {
      const d = scanQueue.shift();
      let names;
      try { names = fs.readdirSync(d); } catch (e) {
        if (first) { jsonRes(res, { error: e.message }, 500); return; }
        continue;
      }
      first = false;
      for (const name of names) {
        if (name.startsWith('.') || name === 'desktop.ini' || name === 'Thumbs.db') continue;

        const fullPath = path.join(d, name);
        let stat;
        try { stat = fs.statSync(fullPath); } catch { continue; }
        const isDir = stat.isDirectory();
        if (deep && isDir) {
          scanQueue.push(fullPath);
          if (flatten) continue; // flatten: recurse into it, but never emit a folder card
          // A folder whose *name* matches still shows up (as a navigable chip)
          if (!name.toLowerCase().includes(search)) continue;
        }
        // Match by file name OR by prompt words embedded in the image (indexed)
        if (search && !isDir && !name.toLowerCase().includes(search) && !promptIndexMatches(fullPath, search)) continue;

        const ext = path.extname(name).toLowerCase();
        const isVideo = VIDEO_EXT.has(ext);
        const isImage = IMAGE_EXT.has(ext);
        const isAudio = AUDIO_EXT.has(ext);

        // Flatten shows media thumbnails only — drop stray non-media files.
        if (flatten && !isVideo && !isImage && !isAudio) continue;

        // Type filter
        if (typeFilter === 'video' && !isVideo) continue;
        if (typeFilter === 'image' && !isImage) continue;
        if (typeFilter === 'audio' && !isAudio) continue;
        if (typeFilter === 'folder' && !isDir) continue;

        // Skip standalone thumbnail files that belong to a video
        if (isImage && !isDir) {
          const base = fullPath.replace(/\.[^.]+$/, '');
          const hasMatchingVideo = [...VIDEO_EXT].some(ve => fs.existsSync(base + ve));
          if (hasMatchingVideo) continue;
        }

        // Prompt-index flags: embedded workflow present + NSFW word match
        const idxRec = isDir ? null : promptIndex.files[fullPath.replace(/\\/g, '/')];
        if (safeMode && idxRec && idxRec.n) continue;

        const thumbInfo = isVideo ? getThumbInfo(fullPath) : null;

        items.push({
          name,
          path: fullPath,
          parentDir: d.replace(/\\/g, '/'),
          isDir, isVideo, isImage, isAudio,
          size: isDir ? null : fmtSize(stat.size),
          sizeBytes: isDir ? 0 : stat.size,
          modified: stat.mtime.toISOString(),
          // Cache-busting keys: `v` for the file itself, `thumbV` for its still.
          v: isDir ? null : Math.floor(stat.mtimeMs),
          thumbV: thumbInfo ? thumbInfo.v : null,
          thumb: !!thumbInfo,
          workflow: !!(idxRec && idxRec.w),
          nsfw: !!(idxRec && idxRec.n),
        });
      }
    }
    {

      // Sort
      items.sort((a, b) => {
        if (a.isDir && !b.isDir) return -1;
        if (!a.isDir && b.isDir) return 1;
        let cmp = 0;
        if (sort === 'size') cmp = a.sizeBytes - b.sizeBytes;
        else if (sort === 'date') cmp = new Date(a.modified) - new Date(b.modified);
        else cmp = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        return asc ? cmp : -cmp;
      });

      const total = items.length;
      const start = (page - 1) * limit;
      // flatten returns the whole subtree in one shot; the SPA lazy-loads thumbs on scroll.
      const pageItems = flatten ? items : items.slice(start, start + limit);
      const parentDir = path.dirname(dir);
      const isRoot = scopeAll || dir === ROOT || dir === parentDir;

      jsonRes(res, {
        dir: scopeAll ? ROOT : dir, root: ROOT, parent: isRoot ? null : parentDir,
        page, limit, total, pages: flatten ? 1 : (Math.ceil(total / limit) || 1),
        items: pageItems,
        favoritesDir: FAVORITES_DIR,
        comfyOutputDir: COMFY_OUTPUT,
      });
    }
    return;
  }

  // API: favorite (move file to _Favorites, or to archive root if from ComfyUI output)
  if (pn === '/api/favorite' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { filePath } = JSON.parse(body);
        if (!filePath) { jsonRes(res, { error: 'Missing filePath' }, 400); return; }

        // Always move to Favorites
        const destDir = FAVORITES_DIR;

        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

        const dest = path.join(destDir, path.basename(filePath));

        moveFile(filePath, dest, (err) => {
          if (err) { jsonRes(res, { error: err.message }, 500); return; }

          // Also move matching thumbnail if exists
          const thumbSrc = getThumbPath(filePath);
          if (thumbSrc) {
            const thumbDest = path.join(destDir, path.basename(thumbSrc));
            moveFile(thumbSrc, thumbDest, () => {});
          }
          promptIndexMove(filePath, dest); // keep prompt search pointing at the new location

          jsonRes(res, { ok: true, dest });
        });
      } catch (e) { jsonRes(res, { error: e.message }, 400); }
    });
    return;
  }

  // API: delete file
  if (pn === '/api/delete' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { filePath } = JSON.parse(body);
        if (!filePath) { jsonRes(res, { error: 'Missing filePath' }, 400); return; }

        fs.unlink(filePath, (err) => {
          if (err) { jsonRes(res, { error: err.message }, 500); return; }

          // Also delete matching thumbnail if exists
          const thumb = getThumbPath(filePath);
          if (thumb) fs.unlink(thumb, () => {});
          promptIndexRemove(filePath); // keep prompt search in sync immediately

          jsonRes(res, { ok: true });
        });
      } catch (e) { jsonRes(res, { error: e.message }, 400); }
    });
    return;
  }

  // API: delete an (effectively) empty folder. Refuses roots and any folder that
  // still holds real content — only ignorable leftovers (desktop.ini, Thumbs.db,
  // dotfiles) are allowed, and those are cleaned up with the folder.
  if (pn === '/api/delete-folder' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { dir } = JSON.parse(body);
        if (!dir) { jsonRes(res, { error: 'Missing dir' }, 400); return; }
        const abs = path.resolve(dir);
        const n = s => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        const na = n(abs), nr = n(ROOT), nc = n(COMFY_OUTPUT);
        if (!na.startsWith(nr) && !na.startsWith(nc)) { jsonRes(res, { error: 'Access denied' }, 403); return; }
        if (na === nr || na === nc) { jsonRes(res, { error: 'Cannot delete a root folder' }, 400); return; }
        let st; try { st = fs.statSync(abs); } catch { jsonRes(res, { error: 'Folder not found' }, 404); return; }
        if (!st.isDirectory()) { jsonRes(res, { error: 'Not a folder' }, 400); return; }
        const ignorable = n => n.startsWith('.') || n === 'desktop.ini' || n === 'Thumbs.db';
        const leftovers = fs.readdirSync(abs).filter(name => !ignorable(name));
        if (leftovers.length) { jsonRes(res, { error: 'Folder is not empty' }, 400); return; }
        fs.rmSync(abs, { recursive: true, force: true }); // clears ignorable files + the dir
        jsonRes(res, { ok: true });
      } catch (e) { jsonRes(res, { error: e.message }, 400); }
    });
    return;
  }

  // Bulk delete (files and directories)
  if (pn === '/api/bulk-delete' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { paths } = JSON.parse(body);
        if (!Array.isArray(paths) || paths.length === 0) { jsonRes(res, { error: 'Missing paths array' }, 400); return; }
        const results = [];
        for (const p of paths) {
          try {
            const stat = await fs.promises.stat(p);
            if (stat.isDirectory()) {
              await fs.promises.rm(p, { recursive: true, force: true });
              // drop every indexed file that lived under this folder
              const prefix = p.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
              for (const k of Object.keys(promptIndex.files)) if (k.startsWith(prefix)) promptIndexRemove(k);
            } else {
              await fs.promises.unlink(p);
              const thumb = getThumbPath(p);
              if (thumb) try { await fs.promises.unlink(thumb); } catch {}
              promptIndexRemove(p);
            }
            results.push({ path: p, ok: true });
          } catch (e) {
            results.push({ path: p, ok: false, error: e.message });
          }
        }
        jsonRes(res, { results });
      } catch (e) { jsonRes(res, { error: e.message }, 400); }
    });
    return;
  }

  // API: merge folders — move every entry of `sources` into `target`, then drop
  // the emptied source folders. Colliding names get a " (n)" suffix chosen per
  // basename, so a media file and its sidecar thumbnail stay paired.
  if (pn === '/api/merge-folders' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { sources, target } = JSON.parse(body);
        if (!Array.isArray(sources) || !sources.length || !target) { jsonRes(res, { error: 'Missing sources/target' }, 400); return; }
        const n = s => String(s).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        const nr = n(ROOT), nc = n(COMFY_OUTPUT);
        const inRoot = p => n(p).startsWith(nr) || n(p).startsWith(nc);
        const isRoot = p => n(p) === nr || n(p) === nc;

        const tgt = path.resolve(target);
        if (!inRoot(tgt)) { jsonRes(res, { error: 'Access denied' }, 403); return; }
        let ts; try { ts = fs.statSync(tgt); } catch { jsonRes(res, { error: 'Target folder not found' }, 404); return; }
        if (!ts.isDirectory()) { jsonRes(res, { error: 'Target is not a folder' }, 400); return; }

        const srcs = [];
        for (const s of sources) {
          const abs = path.resolve(s);
          if (n(abs) === n(tgt)) continue;                  // target may ride along in the selection
          if (!inRoot(abs)) { jsonRes(res, { error: 'Access denied: ' + s }, 403); return; }
          if (isRoot(abs)) { jsonRes(res, { error: 'Cannot merge a root folder' }, 400); return; }
          // Merging a folder into one of its own descendants would move the target into itself.
          if (n(tgt).startsWith(n(abs) + '/')) { jsonRes(res, { error: 'Cannot merge a folder into its own subfolder' }, 400); return; }
          let st; try { st = fs.statSync(abs); } catch { jsonRes(res, { error: 'Folder not found: ' + s }, 404); return; }
          if (!st.isDirectory()) { jsonRes(res, { error: 'Not a folder: ' + s }, 400); return; }
          srcs.push(abs);
        }
        if (!srcs.length) { jsonRes(res, { error: 'Nothing to merge' }, 400); return; }

        // "a.png" and "a.jpg" share the stem "a" — track stems, not full names,
        // so a renamed file drags its thumbnail along to the same new stem.
        const stemOf = name => { const e = path.extname(name); return e ? name.slice(0, -e.length) : name; };
        const taken = new Set(fs.readdirSync(tgt).map(x => stemOf(x).toLowerCase()));

        let moved = 0, removed = 0;
        const errors = [];
        for (const src of srcs) {
          let entries;
          try { entries = fs.readdirSync(src); } catch (e) { errors.push({ path: src, error: e.message }); continue; }
          const stems = new Map();   // original stem (lc) -> stem to use in the target
          for (const name of entries) {
            const ext = path.extname(name), stem = stemOf(name);
            let use = stems.get(stem.toLowerCase());
            if (use === undefined) {
              use = stem;
              for (let i = 2; taken.has(use.toLowerCase()); i++) use = `${stem} (${i})`;
              stems.set(stem.toLowerCase(), use);
              taken.add(use.toLowerCase());
            }
            const from = path.join(src, name), to = path.join(tgt, use + ext);
            try {
              try { await fs.promises.rename(from, to); }
              catch (e) {
                if (e.code !== 'EXDEV') throw e;              // different volume: copy then drop
                await fs.promises.cp(from, to, { recursive: true });
                await fs.promises.rm(from, { recursive: true, force: true });
              }
              promptIndexMovePath(from, to);
              moved++;
            } catch (e) { errors.push({ path: from, error: e.message }); }
          }
          try {
            if (fs.readdirSync(src).length) errors.push({ path: src, error: 'Not empty after merge — folder left in place' });
            else { fs.rmdirSync(src); removed++; }
          } catch (e) { errors.push({ path: src, error: e.message }); }
        }
        jsonRes(res, { ok: true, moved, removed, target: tgt, errors });
      } catch (e) { jsonRes(res, { error: e.message }, 400); }
    });
    return;
  }

  // API: merge videos — concatenate `sources` (in the order given) into one new
  // file beside the first source. Clips that already agree on codec, geometry
  // and audio layout — the normal case for a batch out of one workflow — are
  // stream-copied, which is lossless and near-instant. Anything mismatched goes
  // through the concat filter instead, letterboxed onto the largest frame size
  // present, because concat refuses inputs whose streams don't line up.
  if (pn === '/api/merge-videos' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      let listFile = null, tmpOut = null;
      try {
        const { sources } = JSON.parse(body);
        if (!Array.isArray(sources) || sources.length < 2) { jsonRes(res, { error: 'Pick at least 2 videos' }, 400); return; }
        if (sources.length > 50) { jsonRes(res, { error: 'Too many clips — 50 at most' }, 400); return; }

        const n = s => String(s).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        const nr = n(ROOT), nc = n(COMFY_OUTPUT);
        const inRoot = p => n(p).startsWith(nr) || n(p).startsWith(nc);

        const srcs = [];
        for (const s of sources) {
          const abs = path.resolve(s);
          if (!inRoot(abs)) { jsonRes(res, { error: 'Access denied: ' + s }, 403); return; }
          if (!VIDEO_EXT.has(path.extname(abs).toLowerCase())) { jsonRes(res, { error: 'Not a video: ' + path.basename(abs) }, 400); return; }
          let st; try { st = fs.statSync(abs); } catch { jsonRes(res, { error: 'File not found: ' + path.basename(abs) }, 404); return; }
          if (!st.isFile()) { jsonRes(res, { error: 'Not a file: ' + path.basename(abs) }, 400); return; }
          srcs.push(abs);
        }

        // Probe everything up front: the answers pick the strategy *and* supply
        // the durations the silent-audio filler needs below.
        const infos = [];
        for (const f of srcs) {
          const p = await ffprobeMedia(f);
          const v = p.streams.find(s => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
          if (!v) throw new Error('No video track in ' + path.basename(f));
          infos.push({ file: f, v, a: p.streams.find(s => s.codec_type === 'audio'), dur: parseFloat((p.format || {}).duration) || 0 });
        }

        // Container included: the concat demuxer can copy across formats, but
        // the result would inherit only the first one's muxer quirks.
        const vsig = i => [i.v.codec_name, i.v.width, i.v.height, i.v.pix_fmt, i.v.r_frame_rate,
          i.v.sample_aspect_ratio || '', path.extname(i.file).toLowerCase()].join('|');
        const asig = i => i.a ? [i.a.codec_name, i.a.sample_rate, i.a.channels, i.a.channel_layout || ''].join('|') : 'none';
        const canCopy = infos.every(i => vsig(i) === vsig(infos[0]) && asig(i) === asig(infos[0]));

        const stemOf = name => { const e = path.extname(name); return e ? name.slice(0, -e.length) : name; };
        const dir = path.dirname(srcs[0]);
        const outExt = canCopy ? path.extname(srcs[0]).toLowerCase() : '.mp4';
        const baseStem = stemOf(path.basename(srcs[0])).slice(0, 80) + ' merged';
        let stem = baseStem;
        for (let i = 2; fs.existsSync(path.join(dir, stem + outExt)); i++) stem = `${baseStem} (${i})`;
        const outPath = path.join(dir, stem + outExt);
        // Encode to a dotfile first (the listing skips those) so a half-written
        // video never shows up in the grid, then rename it into place.
        tmpOut = path.join(dir, '.' + stem + '.merging' + outExt);

        const t0 = Date.now();
        if (canCopy) {
          // Forward slashes sidestep the concat demuxer's backslash escaping on
          // Windows; a literal quote in a name still has to be escaped.
          listFile = path.join(dir, '.merge-' + process.pid + '-' + t0 + '.txt');
          fs.writeFileSync(listFile, srcs.map(f => "file '" + f.replace(/\\/g, '/').replace(/'/g, "'\\''") + "'").join('\n') + '\n', 'utf8');
          const args = ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy'];
          if (outExt === '.mp4' || outExt === '.m4v' || outExt === '.mov') args.push('-movflags', '+faststart');
          args.push(tmpOut);
          await runFfmpeg(args);
        } else {
          let W = Math.max(...infos.map(i => i.v.width || 0));
          let H = Math.max(...infos.map(i => i.v.height || 0));
          W -= W % 2; H -= H % 2;                        // h264 + yuv420p needs even dimensions
          if (!W || !H) throw new Error('Could not read a frame size from the clips');
          const rate = s => { const [a, b] = String(s.avg_frame_rate || s.r_frame_rate || '0/1').split('/').map(Number); return b ? a / b : 0; };
          const R = Math.min(120, Math.max(1, Math.round(Math.max(...infos.map(i => rate(i.v))) || 30)));
          // concat wants the same stream count on every segment, so a clip with
          // no audio gets silence of its own length rather than dropping audio
          // from the whole merge.
          const withAudio = infos.some(i => i.a);
          const args = ['-v', 'error', '-y'];
          for (const i of infos) args.push('-i', i.file);
          const silent = new Map();
          if (withAudio) {
            infos.forEach((i, k) => {
              if (i.a) return;
              silent.set(k, infos.length + silent.size);
              args.push('-f', 'lavfi', '-t', String(Math.max(0.04, i.dur)), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
            });
          }
          let chain = '';
          const legs = [];
          infos.forEach((i, k) => {
            chain += `[${k}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,`
                   + `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${R},format=yuv420p[v${k}];`;
            legs.push(`[v${k}]`);
            if (withAudio) {
              chain += `[${i.a ? k : silent.get(k)}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a${k}];`;
              legs.push(`[a${k}]`);
            }
          });
          chain += `${legs.join('')}concat=n=${infos.length}:v=1:a=${withAudio ? 1 : 0}[vout]${withAudio ? '[aout]' : ''}`;
          args.push('-filter_complex', chain, '-map', '[vout]');
          if (withAudio) args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '192k');
          args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', tmpOut);
          await runFfmpeg(args);
        }
        fs.renameSync(tmpOut, outPath);
        tmpOut = null;

        // Sidecar poster frame, so the merged clip shows a thumbnail in the grid
        // like the ComfyUI-written ones do. Non-fatal: a miss just means a 🎬 tile.
        try {
          await runFfmpeg(['-v', 'error', '-y', '-i', outPath, '-frames:v', '1', '-vf', 'scale=480:-2',
            path.join(dir, stem + '.jpg')], 60000);
        } catch (e) { console.log('[merge-videos] no thumbnail:', e.message); }

        console.log(`[merge-videos] ${srcs.length} clips → ${path.basename(outPath)} (${canCopy ? 'copy' : 'encode'}, ${Date.now() - t0}ms)`);
        jsonRes(res, { ok: true, path: outPath, name: path.basename(outPath), dir, mode: canCopy ? 'copy' : 'encode', ms: Date.now() - t0 });
      } catch (e) {
        if (tmpOut) { try { fs.unlinkSync(tmpOut); } catch {} }
        jsonRes(res, { error: e.message }, 400);
      } finally {
        if (listFile) { try { fs.unlinkSync(listFile); } catch {} }
      }
    });
    return;
  }

  // API: pull the last frame out of a video and drop it in the clips folder —
  // the ffmpeg equivalent of the GetImageRangeFromBatch(-1,1) → SaveImageAdvanced
  // tail of the APP VIDEO CLIP workflow, for videos that never ran through it.
  // Same destination and naming as that workflow's save node, so both land in
  // one pile: <comfyOutput>/clips/YYYY-MM-DD/last-frame_00001.png
  if (pn === '/api/tools/last-frame' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      let tmpOut = null;
      try {
        const { source } = JSON.parse(body);
        if (!source) { jsonRes(res, { error: 'No video given' }, 400); return; }

        const n = s => String(s).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        const nr = n(ROOT), nc = n(COMFY_OUTPUT);
        const abs = path.resolve(source);
        if (!(n(abs).startsWith(nr) || n(abs).startsWith(nc))) { jsonRes(res, { error: 'Access denied' }, 403); return; }
        if (!VIDEO_EXT.has(path.extname(abs).toLowerCase())) { jsonRes(res, { error: 'Not a video: ' + path.basename(abs) }, 400); return; }
        let st; try { st = fs.statSync(abs); } catch { jsonRes(res, { error: 'File not found' }, 404); return; }
        if (!st.isFile()) { jsonRes(res, { error: 'Not a file' }, 400); return; }

        // Duration decides the seek: -sseof rewinds from the end, but asking for
        // more than the clip holds makes ffmpeg fall back to a full decode (slow
        // on a long video, and on some containers it lands nowhere at all).
        let dur = 0;
        try { dur = parseFloat((await ffprobeMedia(abs)).format.duration) || 0; } catch {}

        const d = new Date();
        const pad = v => String(v).padStart(2, '0');
        const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        const dir = path.join(COMFY_OUTPUT, 'clips', day);
        fs.mkdirSync(dir, { recursive: true });

        // Continue ComfyUI's counter rather than restarting at 1, so a tool run
        // never collides with a save node writing into the same day folder.
        let next = 1;
        try {
          for (const f of fs.readdirSync(dir)) {
            const m = /^last-frame_(\d+)\.png$/i.exec(f);
            if (m) next = Math.max(next, parseInt(m[1], 10) + 1);
          }
        } catch {}
        const name = 'last-frame_' + String(next).padStart(5, '0') + '.png';
        const outPath = path.join(dir, name);
        // pid in the temp name: two runs racing on the same day folder pick the
        // same `next`, and sharing one temp file would have them overwrite each
        // other mid-encode. Losing the rename is fine; a corrupt PNG is not.
        tmpOut = path.join(dir, '.last-frame-' + process.pid + '-' + Date.now() + '.png');

        // -update 1 rewrites the same file for every frame decoded, so whatever
        // ffmpeg wrote last IS the last frame. Pairing it with -frames:v 1 would
        // give the *first* frame after the seek instead — the opposite of this.
        const t0 = Date.now();
        const tailArgs = seek => {
          const a = ['-v', 'error', '-y'];
          if (seek) a.push('-sseof', '-' + seek);
          return a.concat(['-i', abs, '-an', '-update', '1', tmpOut]);
        };
        const seek = dur > 1 ? Math.min(3, Math.max(0.5, dur / 2)).toFixed(3) : 0;
        try { await runFfmpeg(tailArgs(seek), 5 * 60 * 1000); }
        catch (e) { await runFfmpeg(tailArgs(0), 10 * 60 * 1000); }   // unseekable: decode it all
        if (!fs.existsSync(tmpOut) || !fs.statSync(tmpOut).size) throw new Error('ffmpeg decoded no frame');

        fs.renameSync(tmpOut, outPath);
        tmpOut = null;
        console.log(`[last-frame] ${path.basename(abs)} → clips/${day}/${name} (${Date.now() - t0}ms)`);
        jsonRes(res, { ok: true, path: outPath, name, dir, rel: 'clips/' + day + '/' + name, ms: Date.now() - t0 });
      } catch (e) {
        if (tmpOut) { try { fs.unlinkSync(tmpOut); } catch {} }
        jsonRes(res, { error: e.message }, 400);
      }
    });
    return;
  }

  // API: folder tree — immediate subfolders of `dir`, or the media roots when
  // `dir` is omitted. Feeds the Move dialog's lazily-expanded destination tree.
  if (pn === '/api/dirs' && req.method === 'GET') {
    try {
      const n = s => String(s).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
      const skip = name => name.startsWith('.') || name === 'desktop.ini' || name === 'Thumbs.db';
      // Drives the disclosure caret; a failed read just renders as a leaf.
      const hasSubdir = p => {
        try { return fs.readdirSync(p, { withFileTypes: true }).some(d => d.isDirectory() && !skip(d.name)); }
        catch { return false; }
      };
      const raw = url.searchParams.get('dir');
      if (!raw || !raw.trim()) {
        const roots = [{ name: path.basename(ROOT) || ROOT, path: ROOT }];
        // Skip the ComfyUI output root when it already nests under the media root.
        if (!n(COMFY_OUTPUT).startsWith(n(ROOT)) && fs.existsSync(COMFY_OUTPUT)) roots.push({ name: 'ComfyUI Output', path: COMFY_OUTPUT });
        jsonRes(res, { dirs: roots.map(r => ({ ...r, hasChildren: hasSubdir(r.path) })) });
        return;
      }
      const dir = path.resolve(decodeURIComponent(raw));
      if (!n(dir).startsWith(n(ROOT)) && !n(dir).startsWith(n(COMFY_OUTPUT))) { jsonRes(res, { error: 'Access denied' }, 403); return; }
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { jsonRes(res, { error: e.message }, 404); return; }
      const dirs = ents.filter(d => d.isDirectory() && !skip(d.name))
        .map(d => ({ name: d.name, path: path.join(dir, d.name) }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
        .map(d => ({ ...d, hasChildren: hasSubdir(d.path) }));
      jsonRes(res, { dirs });
    } catch (e) { jsonRes(res, { error: e.message }, 400); }
    return;
  }

  // API: mkdir — create one subfolder inside `parent`. Feeds the Move dialog's
  // "New Folder" button. Names are deliberately restricted to letters, digits,
  // spaces and dashes: no separators, no dot-prefix, no traversal to sanitize.
  if (pn === '/api/mkdir' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { parent, name } = JSON.parse(body);
        if (!parent || typeof name !== 'string') { jsonRes(res, { error: 'Missing parent/name' }, 400); return; }
        const n = s => String(s).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        const clean = name.trim();
        if (!clean) { jsonRes(res, { error: 'Folder name is required' }, 400); return; }
        if (clean.length > 64) { jsonRes(res, { error: 'Folder name is too long (64 characters max)' }, 400); return; }
        if (!/^[A-Za-z0-9][A-Za-z0-9 -]*$/.test(clean)) {
          jsonRes(res, { error: 'Use letters, numbers, spaces and dashes only (must start with a letter or number)' }, 400); return;
        }
        // Windows device names are unusable as folder names and fail obscurely.
        if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(clean)) { jsonRes(res, { error: `"${clean}" is a reserved Windows name` }, 400); return; }

        const par = path.resolve(parent);
        if (!n(par).startsWith(n(ROOT)) && !n(par).startsWith(n(COMFY_OUTPUT))) { jsonRes(res, { error: 'Access denied' }, 403); return; }
        let ps; try { ps = fs.statSync(par); } catch { jsonRes(res, { error: 'Parent folder not found' }, 404); return; }
        if (!ps.isDirectory()) { jsonRes(res, { error: 'Parent is not a folder' }, 400); return; }
        // Explicit case-insensitive check: bare existsSync would let "Art" and
        // "art" coexist on Linux and confuse the picker.
        const lc = clean.toLowerCase();
        if (fs.readdirSync(par).some(x => x.toLowerCase() === lc)) { jsonRes(res, { error: `"${clean}" already exists here` }, 409); return; }

        const dir = path.join(par, clean);
        fs.mkdirSync(dir);
        jsonRes(res, { ok: true, name: clean, path: dir, parent: par });
      } catch (e) { jsonRes(res, { error: e.message }, 400); }
    });
    return;
  }

  // API: move — relocate the selected files/folders into `target`. Colliding
  // names get a " (n)" suffix chosen per stem (as in merge-folders), so a video
  // and its sidecar thumbnail land on the same new stem and stay paired.
  if (pn === '/api/move' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { paths, target } = JSON.parse(body);
        if (!Array.isArray(paths) || !paths.length || !target) { jsonRes(res, { error: 'Missing paths/target' }, 400); return; }
        const n = s => String(s).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        const nr = n(ROOT), nc = n(COMFY_OUTPUT);
        const inRoot = p => n(p).startsWith(nr) || n(p).startsWith(nc);
        const isRoot = p => n(p) === nr || n(p) === nc;

        const tgt = path.resolve(target);
        if (!inRoot(tgt)) { jsonRes(res, { error: 'Access denied' }, 403); return; }
        let ts; try { ts = fs.statSync(tgt); } catch { jsonRes(res, { error: 'Target folder not found' }, 404); return; }
        if (!ts.isDirectory()) { jsonRes(res, { error: 'Target is not a folder' }, 400); return; }

        const stemOf = name => { const e = path.extname(name); return e ? name.slice(0, -e.length) : name; };
        const taken = new Set(fs.readdirSync(tgt).map(x => stemOf(x).toLowerCase()));
        const stems = new Map();   // original stem (lc) -> stem to use in the target
        const pickStem = stem => {
          let use = stems.get(stem.toLowerCase());
          if (use === undefined) {
            use = stem;
            for (let i = 2; taken.has(use.toLowerCase()); i++) use = `${stem} (${i})`;
            stems.set(stem.toLowerCase(), use);
            taken.add(use.toLowerCase());
          }
          return use;
        };
        const relocate = async (from, to) => {
          try { await fs.promises.rename(from, to); }
          catch (e) {
            if (e.code !== 'EXDEV') throw e;               // different volume: copy then drop
            await fs.promises.cp(from, to, { recursive: true });
            await fs.promises.rm(from, { recursive: true, force: true });
          }
          promptIndexMovePath(from, to);
        };

        let moved = 0, skipped = 0;
        const errors = [];
        const done = new Set();          // a sidecar may also be selected outright
        for (const p of paths) {
          const abs = path.resolve(p);
          if (done.has(n(abs))) continue;
          if (!inRoot(abs)) { errors.push({ path: p, error: 'Access denied' }); continue; }
          if (isRoot(abs)) { errors.push({ path: p, error: 'Cannot move a root folder' }); continue; }
          let st; try { st = fs.statSync(abs); } catch { errors.push({ path: p, error: 'Not found' }); continue; }
          if (n(path.dirname(abs)) === n(tgt)) { done.add(n(abs)); skipped++; continue; }   // already there
          if (st.isDirectory() && (n(tgt) === n(abs) || n(tgt).startsWith(n(abs) + '/'))) {
            errors.push({ path: p, error: 'Cannot move a folder into itself' }); continue;
          }
          const name = path.basename(abs), ext = path.extname(name);
          // Videos keep a same-stem sidecar thumbnail — resolve it before the move.
          const thumb = (!st.isDirectory() && VIDEO_EXT.has(ext.toLowerCase())) ? getThumbPath(abs) : null;
          const use = pickStem(stemOf(name));
          try { await relocate(abs, path.join(tgt, use + ext)); done.add(n(abs)); moved++; }
          catch (e) { errors.push({ path: p, error: e.message }); continue; }
          if (thumb && !done.has(n(thumb))) {
            try { await relocate(thumb, path.join(tgt, use + path.extname(thumb))); done.add(n(thumb)); } catch {}
          }
        }
        jsonRes(res, { ok: true, moved, skipped, target: tgt, errors });
      } catch (e) { jsonRes(res, { error: e.message }, 400); }
    });
    return;
  }

  // Serve file (with range support)
  if (pn.startsWith('/file/')) {
    const filePath = decodeURIComponent(pn.slice(6));
    // Set before serveFile, which only supplies its own default when nothing
    // has been set yet.
    res.setHeader('Cache-Control', mediaCacheHeader());
    serveFile(filePath, req, res); return;
  }

  // Serve thumbnail
  if (pn.startsWith('/thumb/')) {
    const filePath = decodeURIComponent(pn.slice(7));
    const thumbPath = getThumbPath(filePath);
    res.setHeader('Cache-Control', mediaCacheHeader());
    if (thumbPath) { serveFile(thumbPath, req, res); }
    else { res.writeHead(404); res.end('No thumbnail'); }
    return;
  }

  // API: Extract metadata from media file
  if (pn === '/api/metadata' && req.method === 'GET') {
    const filePath = decodeURIComponent(url.searchParams.get('path') || '');
    if (!filePath) { jsonRes(res, { error: 'Missing path' }, 400); return; }

    const ext = path.extname(filePath).toLowerCase();
    if (['.png'].includes(ext)) {
      extractPngMetadata(filePath, (err, meta) => {
        if (err) { jsonRes(res, { error: err.message }, 500); return; }
        jsonRes(res, meta);
      });
    } else if (['.mp4', '.webm', '.mkv', '.mov'].includes(ext)) {
      extractVideoMetadata(filePath, (err, meta) => {
        if (err) { jsonRes(res, { error: err.message }, 500); return; }
        // Most video save nodes (VHS_VideoCombine among them) write the graph only into
        // the companion still they save alongside the clip, never into the container —
        // ffprobe on such an .mp4 reports nothing but `encoder`. Without this fallback a
        // clip looks like it has no workflow at all, and the Remix dialog then silently
        // offers whichever workflow sorts first. Same sibling lookup as the thumbnails.
        if (meta && !meta.prompt && !meta.workflow) {
          const still = getThumbPath(filePath);
          if (still && path.extname(still).toLowerCase() === '.png') {
            extractPngMetadata(still, (e2, m2) => {
              if (!e2 && m2 && (m2.prompt || m2.workflow)) jsonRes(res, Object.assign({}, m2, { metadataFrom: still.replace(/\\/g, '/') }));
              else jsonRes(res, meta);
            });
            return;
          }
        }
        jsonRes(res, meta);
      });
    } else {
      jsonRes(res, { error: 'Unsupported file type' }, 400);
    }
    return;
  }

  // API: Settings — read (masked keys) / write (merge into config.json + hot-reload)
  if (pn === '/api/settings' && req.method === 'GET') {
    const mask = v => v ? { set: true, hint: '••••' + String(v).slice(-4) } : { set: false, hint: '' };
    jsonRes(res, {
      keys: {
        civitaiApiKey: mask(CIVITAI_API_KEY),
      },
      urls: { comfyUrl: COMFY_URL },
      paths: {
        comfyDir: { value: COMFY_DIR, exists: fs.existsSync(COMFY_DIR), hasWorkflows: fs.existsSync(WORKFLOWS_DIR) },
        comfyOutput: { value: COMFY_OUTPUT, exists: fs.existsSync(COMFY_OUTPUT) },
      },
      info: {
        port: PORT,
        httpsPort: parseInt(config.httpsPort, 10) || 8443,
        mediaDir: ROOT,
      },
      setup: { done: !!config.setupDone, features: Array.isArray(config.features) ? config.features : null },
      privacy: { mediaCachePolicy: MEDIA_CACHE[config.mediaCachePolicy] ? config.mediaCachePolicy : 'nostore' },
      // The hash itself never leaves the server — only whether one exists.
      security: { enabled: authState().enabled, hasPassword: authState().hasPassword },
    });
    return;
  }
  if (pn === '/api/settings' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', c => bodyStr += c);
    req.on('end', () => {
      let body;
      try { body = JSON.parse(bodyStr); } catch { jsonRes(res, { error: 'Bad JSON' }, 400); return; }
      let current = {};
      try { current = readConfigFile(); } catch {}
      // Secret keys: null clears, non-empty string sets, '' / undefined leaves unchanged.
      for (const k of ['civitaiApiKey']) {
        if (!(k in body)) continue;
        if (body[k] === null) current[k] = '';
        else if (typeof body[k] === 'string' && body[k].trim() !== '') current[k] = body[k].trim();
      }
      // Media cache policy. Whitelisted, never echoed straight into a header:
      // this value ends up in Cache-Control, so an unchecked string would be a
      // header-injection hole.
      if (typeof body.mediaCachePolicy === 'string' && MEDIA_CACHE[body.mediaCachePolicy]) {
        current.mediaCachePolicy = body.mediaCachePolicy;
      }
      // URLs: any provided string is applied (empty falls back to default on reload).
      for (const k of ['comfyUrl']) {
        if (typeof body[k] === 'string') current[k] = body[k].trim();
      }
      // Paths: must exist on disk. comfyDir additionally warns (not blocks) if it
      // doesn't look like a ComfyUI install (no user/default/workflows inside).
      let warning = null;
      for (const k of ['comfyDir', 'comfyOutput']) {
        if (typeof body[k] !== 'string' || body[k].trim() === '') continue;
        const p = path.resolve(body[k].trim());
        let st = null;
        try { st = fs.statSync(p); } catch {}
        if (!st || !st.isDirectory()) { jsonRes(res, { error: k + ': folder does not exist: ' + p }, 400); return; }
        if (k === 'comfyDir' && !fs.existsSync(path.join(p, 'user', 'default', 'workflows'))) {
          warning = 'comfyDir has no user/default/workflows inside — workflow features will find nothing until ComfyUI creates it.';
        }
        current[k] = p;
      }
      // Password gate. Only the scrypt hash is ever written. Saving a password
      // re-keys every session (the signing key derives from the hash), so the
      // caller is handed a fresh cookie in this same response — otherwise turning
      // protection on would immediately lock out the browser that turned it on.
      let newSession = null;
      if ('authPassword' in body || 'authEnabled' in body) {
        const auth = (current.auth && typeof current.auth === 'object') ? Object.assign({}, current.auth) : {};
        if ('authPassword' in body) {
          if (body.authPassword === null) { auth.hash = ''; auth.enabled = false; }   // clearing it also unlocks the app
          else if (typeof body.authPassword === 'string' && body.authPassword !== '') {
            if (body.authPassword.length < AUTH_MIN_LEN) { jsonRes(res, { error: 'Password must be at least ' + AUTH_MIN_LEN + ' characters' }, 400); return; }
            auth.hash = hashPassword(body.authPassword);
          }
        }
        if ('authEnabled' in body) {
          if (body.authEnabled && !auth.hash) { jsonRes(res, { error: 'Set a password before turning on password protection' }, 400); return; }
          auth.enabled = !!body.authEnabled;
        }
        current.auth = auth;
        if (auth.enabled && auth.hash) newSession = makeSession(auth.hash);
      }
      // Setup wizard state: completion flag + which features the user opted into.
      if ('setupDone' in body) current.setupDone = !!body.setupDone;
      if (Array.isArray(body.features)) {
        const known = ['media', 'comfy'];
        current.features = body.features.filter(f => known.includes(f));
      }
      try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2)); }
      catch (e) { jsonRes(res, { error: 'Write failed: ' + e.message }, 500); return; }
      reloadConfig();
      if (newSession) setSessionCookie(req, res, newSession);
      jsonRes(res, warning ? { ok: true, warning } : { ok: true });
    });
    return;
  }

  // API: NSFW tag list — read (decoded for display) / write (encoded to config).
  if (pn === '/api/nsfw-terms' && req.method === 'GET') {
    jsonRes(res, { terms: nsfwTermsDecoded() });
    return;
  }
  if (pn === '/api/nsfw-terms' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', c => bodyStr += c);
    req.on('end', () => {
      let body;
      try { body = JSON.parse(bodyStr); } catch { jsonRes(res, { error: 'Bad JSON' }, 400); return; }
      if (!Array.isArray(body.terms)) { jsonRes(res, { error: 'terms must be an array' }, 400); return; }
      // Normalize: trim, lowercase, drop empties, dedupe — then store base64-encoded.
      const seen = new Set(), clean = [];
      for (const t of body.terms) {
        if (typeof t !== 'string') continue;
        const w = t.trim().toLowerCase();
        if (!w || seen.has(w)) continue;
        seen.add(w); clean.push(w);
      }
      const b64 = clean.map(w => Buffer.from(w, 'utf8').toString('base64'));
      let cur = {};
      try { cur = readConfigFile(); } catch {}
      cur.nsfwTermsB64 = b64;
      try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cur, null, 2)); }
      catch (e) { jsonRes(res, { error: 'Write failed: ' + e.message }, 500); return; }
      config.nsfwTermsB64 = b64;
      NSFW_RE = buildNsfwRe();
      const retagged = retagNsfw();  // recompute the n-flag on already-indexed files
      jsonRes(res, { ok: true, count: clean.length, retagged });
    });
    return;
  }

  // API: aggregated service status for the Status / Setup page
  if (pn === '/api/status' && req.method === 'GET') {
    const probe = (urlStr, timeoutMs) => new Promise(resolve => {
      try {
        const u = new URL(urlStr);
        const pr = http.get({ hostname: u.hostname, port: u.port || 80, path: u.pathname, timeout: timeoutMs || 1500 }, r => {
          r.resume(); resolve(r.statusCode >= 200 && r.statusCode < 500);
        });
        pr.on('timeout', () => { pr.destroy(); resolve(false); });
        pr.on('error', () => resolve(false));
      } catch { resolve(false); }
    });
    (async () => {
      const [comfy, ff] = await Promise.all([
        probe(COMFY_URL + '/system_stats'),
        checkFfmpeg(),
      ]);
      // Name the binary that is actually missing, and say where we looked --
      // "ffmpeg is broken" is not actionable, "ffprobe not found at <path>" is.
      const ffMissing = [!ff.ffmpeg && 'ffmpeg', !ff.ffprobe && 'ffprobe'].filter(Boolean);
      const bare = b => !/[\\/]/.test(b);        // unresolved: relying on PATH
      const ffDetail = ff.ok
        ? ('ffmpeg ' + ff.ffmpeg + ' · ffprobe ' + ff.ffprobe
           + (bare(ff.ffmpegPath) ? ' — resolved via PATH (set ffmpegDir in Settings to pin absolute paths when running as a service)' : ' — ' + path.dirname(ff.ffmpegPath)))
        : (ffMissing.join(' and ') + ' would not run'
           + (ffMissing.some(n => bare(n === 'ffmpeg' ? ff.ffmpegPath : ff.ffprobePath))
              ? ' (no absolute path found, and not on this process\'s PATH)'
              : ' (tried ' + (ff.ffmpeg ? ff.ffprobePath : ff.ffmpegPath) + ')')
           + ' — install it (' + FF_INSTALL_HINT + ') or set ffmpegDir in Settings');
      let wfCount = 0;
      try { wfCount = loadWfStore().enabled.filter(n => fs.existsSync(path.join(WORKFLOWS_DIR, n))).length; } catch {}
      const comfyDirOk = fs.existsSync(COMFY_DIR);
      jsonRes(res, {
        setupDone: !!config.setupDone,
        features: Array.isArray(config.features) ? config.features : null,
        services: [
        { id: 'comfy', name: 'ComfyUI', configured: comfyDirOk, running: comfy,
          detail: comfy ? ('Running at ' + COMFY_URL) : (comfyDirOk ? ('Installed but NOT running — not reachable at ' + COMFY_URL) : 'Install folder not found — set it in Settings'),
          affects: 'Running workflows / generating images' },
        { id: 'workflows', name: 'App workflows', configured: fs.existsSync(WORKFLOWS_DIR), running: wfCount > 0,
          detail: fs.existsSync(WORKFLOWS_DIR) ? (wfCount + ' workflow(s) enabled') : 'Workflows folder missing under the ComfyUI dir',
          affects: 'Workflow dropdown on media pages' },
        { id: 'civitai', name: 'Civitai API key', configured: !!CIVITAI_API_KEY, running: !!CIVITAI_API_KEY,
          detail: CIVITAI_API_KEY ? 'Key configured' : 'No key — only needed for gated model downloads',
          affects: 'Model downloads' },
        { id: 'ffmpeg', name: 'ffmpeg / ffprobe', configured: !!(ff.ffmpeg || ff.ffprobe), running: ff.ok,
          detail: ffDetail,
          affects: 'Video thumbnails, video metadata + prompt search, merging clips, last-frame extraction' },
        { id: 'media', name: 'Media folder', configured: fs.existsSync(ROOT), running: fs.existsSync(ROOT),
          detail: ROOT, affects: 'Library browsing / favorites' },
        { id: 'index', name: 'Prompt search index', configured: true, running: !promptIndexLastError,
          detail: Object.keys(promptIndex.files).length + ' images indexed' + (promptIndexing ? ' (indexing…)' : '') + (promptIndexLastError ? (' — last error: ' + promptIndexLastError) : ''),
          affects: 'Prompt search and the word directory' },
      ]});
    })();
    return;
  }

  // API: Prompt phrase directory (word/phrase -> number of images containing it)
  if (pn === '/api/prompt-words' && req.method === 'GET') {
    const safeMode = url.searchParams.get('safe') === '1';
    jsonRes(res, { words: promptPhraseCounts(safeMode), files: Object.keys(promptIndex.files).length });
    return;
  }

  // API: Prompt index status / manual rebuild
  if (pn === '/api/prompt-index' && req.method === 'GET') {
    jsonRes(res, { files: Object.keys(promptIndex.files).length, indexing: promptIndexing, lastRun: promptIndexLastRun, lastError: promptIndexLastError });
    return;
  }
  if (pn === '/api/prompt-index' && req.method === 'POST') {
    buildPromptIndex();
    jsonRes(res, { ok: true, started: !promptIndexing });
    return;
  }

  // API: Browse server folders (for the Settings path picker). Directory names
  // only — no files. path="" lists the available drive roots.
  if (pn === '/api/browse-dirs' && req.method === 'GET') {
    const reqPath = (url.searchParams.get('path') || '').trim();
    if (!reqPath) {
      const drives = [];
      for (let c = 65; c <= 90; c++) {
        const d = String.fromCharCode(c) + ':\\';
        try { if (fs.existsSync(d)) drives.push(d); } catch {}
      }
      jsonRes(res, { path: '', parent: null, dirs: drives });
      return;
    }
    const p = path.resolve(reqPath);
    let entries = [];
    try {
      entries = fs.readdirSync(p, { withFileTypes: true })
        .filter(e => { try { return e.isDirectory(); } catch { return false; } })
        .map(e => e.name)
        .filter(n => !n.startsWith('$') && n !== 'System Volume Information')
        .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    } catch (e) { jsonRes(res, { error: e.message }, 400); return; }
    const parentDir = path.dirname(p);
    jsonRes(res, { path: p, parent: parentDir === p ? '' : parentDir, dirs: entries });
    return;
  }

  // API: Prompt replacements — stored on disk so they're shared across devices
  if (pn === '/api/replacements' && req.method === 'GET') {
    fs.readFile(path.join(__dirname, 'app-replacements.json'), 'utf8', (err, raw) => {
      if (err) { jsonRes(res, { replacements: [] }); return; }
      try { jsonRes(res, JSON.parse(raw)); } catch { jsonRes(res, { replacements: [] }); }
    });
    return;
  }
  if (pn === '/api/replacements' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', c => bodyStr += c);
    req.on('end', () => {
      let body;
      try { body = JSON.parse(bodyStr); } catch { jsonRes(res, { error: 'Bad JSON' }, 400); return; }
      const list = Array.isArray(body.replacements) ? body.replacements
        .filter(r => r && typeof r === 'object')
        .map(r => ({ from: String(r.from || ''), to: String(r.to || ''), on: !!r.on })) : [];
      try {
        fs.writeFileSync(path.join(__dirname, 'app-replacements.json'), JSON.stringify({ replacements: list }, null, 2));
        jsonRes(res, { ok: true });
      } catch (e) { jsonRes(res, { error: e.message }, 500); }
    });
    return;
  }

  // API: List app-enabled workflows (from the allowlist)
  if (pn === '/api/workflows' && req.method === 'GET') {
    const store = loadWfStore();
    const existing = new Set(listAllWorkflows());
    const enabled = store.enabled
      .filter(n => existing.has(n))
      .map(n => ({ name: n, label: store.labels[n] || defaultLabel(n) }));
    // Shortcuts whose parent is gone (deleted or disabled) are dropped rather
    // than offered as entries that would fail to load.
    const enabledSet = new Set(enabled.map(e => e.name));
    for (const [id, sc] of Object.entries(store.shortcuts)) {
      if (!enabledSet.has(sc.parent)) continue;
      enabled.push({ name: SHORTCUT_PREFIX + id, label: shortcutLabel(store, sc), parent: sc.parent, shortcut: true });
    }
    enabled.sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()));
    jsonRes(res, enabled);
    return;
  }

  // API: Shortcuts — save the current field values against a workflow (POST),
  // or remove one (DELETE ?id=). The name is stored bare; the "PARENT : NAME"
  // label is derived on read so renaming the parent workflow carries through.
  if (pn === '/api/shortcuts' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', c => bodyStr += c);
    req.on('end', () => {
      let body; try { body = JSON.parse(bodyStr); } catch { jsonRes(res, { error: 'Bad JSON' }, 400); return; }
      const store = loadWfStore();
      // Save-over: the dialog posts the loaded shortcut's own id, so re-saving
      // edits it in place. Its parent never moves — a shortcut is only ever
      // captured from the workflow it already points at.
      if (body.id) {
        const sid = String(body.id).replace(SHORTCUT_PREFIX, '');
        const sc = store.shortcuts[sid];
        if (!sc) { jsonRes(res, { error: 'No such shortcut' }, 404); return; }
        sc.fieldValues = (body.fieldValues && typeof body.fieldValues === 'object') ? body.fieldValues : {};
        sc.updated = new Date().toISOString();
        if (!saveWfStore(store)) { jsonRes(res, { error: 'Could not write the workflow store' }, 500); return; }
        jsonRes(res, { ok: true, name: SHORTCUT_PREFIX + sid, label: shortcutLabel(store, sc), updated: true });
        return;
      }
      const name = String(body.name || '').trim().replace(/\s*:\s*/g, ' - ');   // ':' is the grouping delimiter
      if (!name) { jsonRes(res, { error: 'Missing shortcut name' }, 400); return; }
      if (!body.parent || isShortcutName(body.parent)) { jsonRes(res, { error: 'A shortcut must be saved from a workflow' }, 400); return; }
      if (!listAllWorkflows().includes(body.parent)) { jsonRes(res, { error: 'Unknown workflow: ' + body.parent }, 400); return; }
      // Same name under the same parent overwrites, so re-saving updates in place
      // instead of growing a pile of near-identical entries.
      const existingId = Object.keys(store.shortcuts).find(k => store.shortcuts[k].parent === body.parent
        && store.shortcuts[k].name.toLowerCase() === name.toLowerCase());
      const id = existingId || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
      store.shortcuts[id] = {
        parent: body.parent, name,
        fieldValues: (body.fieldValues && typeof body.fieldValues === 'object') ? body.fieldValues : {},
        created: store.shortcuts[id] ? store.shortcuts[id].created : new Date().toISOString(),
      };
      if (!saveWfStore(store)) { jsonRes(res, { error: 'Could not write the workflow store' }, 500); return; }
      jsonRes(res, { ok: true, name: SHORTCUT_PREFIX + id, label: shortcutLabel(store, store.shortcuts[id]), replaced: !!existingId });
    });
    return;
  }
  if (pn === '/api/shortcuts' && req.method === 'DELETE') {
    const id = (url.searchParams.get('id') || '').replace(SHORTCUT_PREFIX, '');
    const store = loadWfStore();
    if (!store.shortcuts[id]) { jsonRes(res, { error: 'No such shortcut' }, 404); return; }
    delete store.shortcuts[id];
    const ok = saveWfStore(store);
    jsonRes(res, ok ? { ok: true } : { error: 'Could not write the workflow store' }, ok ? 200 : 500);
    return;
  }

  // API: List ALL install-dir workflows with enabled flag + mapping candidates
  if (pn === '/api/workflows/all' && req.method === 'GET') {
    const store = loadWfStore();
    const enabledSet = new Set(store.enabled);
    const all = listAllWorkflows().map(n => {
      const item = { name: n, label: store.labels[n] || defaultLabel(n), enabled: enabledSet.has(n), mapping: store.mappings[n] || null };
      // Only compute candidates/auto-detected guesses for enabled ones (parse cost).
      if (item.enabled) {
        try {
          const wf = JSON.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, n), 'utf8'));
          item.candidates = workflowCandidates(wf);
          const pn2 = resolvePromptNode(wf, store.mappings[n]);
          const sn = resolveStepsNode(wf, store.mappings[n]);
          const sd = resolveSeedNode(wf, store.mappings[n]);
          item.detected = { promptNodeId: pn2 ? pn2.id : null, stepsNodeId: sn ? sn.id : null, seedNodeId: sd ? sd.id : null };
          item.hasPresets = detectPresetGroups(wf).length > 0;
        } catch (e) { item.error = e.message; }
      }
      return item;
    });
    jsonRes(res, all);
    return;
  }

  // API: Start the local ComfyUI install. Uses config.comfyStartCmd (shell string
  // or [cmd, ...args] array); falls back to the ComfyUI-Easy-Install launcher bat
  // next to comfyDir. Probes first so a running instance is never double-started.
  if (pn === '/api/comfy/start' && req.method === 'POST') {
    let responded = false;
    const done = (obj, code) => { if (!responded) { responded = true; jsonRes(res, obj, code || 200); } };
    const launch = () => {
      let cmd = config.comfyStartCmd;
      if (!cmd) {
        const guess = path.join(path.dirname(COMFY_DIR), 'Start ComfyUI.bat');
        if (fs.existsSync(guess)) cmd = guess;
      }
      if (!cmd || (Array.isArray(cmd) && !cmd.length)) {
        done({ error: 'No comfyStartCmd configured and no "Start ComfyUI.bat" found next to comfyDir — set comfyStartCmd in config.json.' }, 400);
        return;
      }
      try {
        const proc = Array.isArray(cmd)
          ? spawn(cmd[0], cmd.slice(1), { detached: true, stdio: 'ignore', windowsHide: true, cwd: path.dirname(cmd[0]) })
          : spawn('"' + cmd + '"', { shell: true, detached: true, stdio: 'ignore', windowsHide: true, cwd: path.dirname(cmd) });
        proc.unref();
        done({ started: true, message: 'ComfyUI starting — model load can take 30-90s.' });
      } catch (e) { done({ error: 'Launch failed: ' + e.message }, 500); }
    };
    const probe = http.get(COMFY_URL + '/system_stats', { timeout: 2500 }, (r) => { r.resume(); done({ running: true }); });
    probe.on('timeout', () => { probe.destroy(); launch(); });
    probe.on('error', launch);
    return;
  }

  // API: Recognize which enabled workflow an embedded graph is (structural match).
  // POST { workflow } -> { name, label, score } of the best match, or {} if none.
  // Fingerprint = node-type multiset + typed link topology; widget values (prompt,
  // seed, lora strengths), positions, titles, and mute/bypass modes are ignored.
  if (pn === '/api/workflow-match' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', c => bodyStr += c);
    req.on('end', () => {
      let body;
      try { body = JSON.parse(bodyStr); } catch { jsonRes(res, { error: 'Bad JSON' }, 400); return; }
      const emb = body && body.workflow;
      if (!emb || !Array.isArray(emb.nodes)) { jsonRes(res, {}); return; }

      // Link keys are slotless (fromType>toType) and compared by containment, not
      // Jaccard: newer ComfyUI frontends materialize extra links and renumber slots
      // when serializing into the PNG, so exact-slot Jaccard under-scores true matches.
      function fingerprint(wf) {
        const nodes = (wf.nodes || []).filter(n => n && n.type && !UI_ONLY_TYPES.has(n.type));
        const typeById = {};
        nodes.forEach(n => { typeById[n.id] = n.type; });
        const types = nodes.map(n => n.type).sort();
        const links = (wf.links || []).map(l => {
          const ft = typeById[l[1]], tt = typeById[l[3]];
          return (ft && tt) ? ft + '>' + tt : null;
        }).filter(Boolean).sort();
        return { types, links };
      }
      function multisetIntersection(a, b) {
        const m = new Map();
        a.forEach(v => m.set(v, (m.get(v) || 0) + 1));
        let inter = 0;
        const m2 = new Map();
        b.forEach(v => m2.set(v, (m2.get(v) || 0) + 1));
        for (const [v, c] of m2) inter += Math.min(c, m.get(v) || 0);
        return inter;
      }

      // Variants of one workflow (a SFW/NSFW pair, a v2) are often structurally
      // IDENTICAL — they differ only in widgets_values, which the fingerprint ignores —
      // so structure alone picks between them arbitrarily. This compares widget arrays
      // per node type as a tie-break only: it never changes which candidates clear the
      // threshold below, since a re-run legitimately alters prompt/seed widgets.
      // Two bags per graph: exact widget values, and their shape (how many widgets a node
      // carries). Shape is the sturdier signal — a Power Lora Loader keeps its 13 slots
      // across a run that merely toggles which are on, while the 2-slot twin can't look
      // like it no matter what the run changed — so exact values only refine it.
      function widgetBags(wf) {
        const exact = [], shape = [];
        for (const n of (wf.nodes || [])) {
          if (!n || !n.type || UI_ONLY_TYPES.has(n.type) || n.widgets_values === undefined) continue;
          exact.push(n.type + '|' + JSON.stringify(n.widgets_values));
          shape.push(n.type + '|' + (Array.isArray(n.widgets_values) ? n.widgets_values.length : typeof n.widgets_values));
        }
        return { exact: exact.sort(), shape: shape.sort() };
      }
      const simOf = (a, b) => { const mn = Math.min(a.length, b.length); return mn ? multisetIntersection(a, b) / mn : 0; };
      const embFp = fingerprint(emb);
      if (embFp.types.length < 8) { jsonRes(res, {}); return; } // too small to identify confidently
      const embWb = widgetBags(emb);

      const store = loadWfStore();
      const enabledSet = new Set(store.enabled);
      // Scan every workflow, not just the enabled ones: the file that actually produced
      // a media file is often not in the dropdown, and naming it (so the UI can offer to
      // add it) beats silently reporting whichever enabled look-alike scored the same.
      let best = null;
      for (const name of listAllWorkflows()) {
        try {
          const wf = JSON.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, name), 'utf8'));
          const fp = fingerprint(wf);
          const ti = multisetIntersection(embFp.types, fp.types);
          const typeJac = (embFp.types.length + fp.types.length - ti) ? ti / (embFp.types.length + fp.types.length - ti) : 1;
          const li = multisetIntersection(embFp.links, fp.links);
          const minLinks = Math.min(embFp.links.length, fp.links.length);
          const linkContain = minLinks ? li / minLinks : 1;
          const score = 0.7 * typeJac + 0.3 * linkContain;
          const wb = widgetBags(wf);
          const wsim = 0.65 * simOf(embWb.shape, wb.shape) + 0.35 * simOf(embWb.exact, wb.exact);
          const cand = { name, label: store.labels[name] || defaultLabel(name), score, wsim, enabled: enabledSet.has(name) };
          if (!best
              || score > best.score + 1e-9
              || (Math.abs(score - best.score) < 1e-9 && wsim > best.wsim + 1e-9)
              || (Math.abs(score - best.score) < 1e-9 && Math.abs(wsim - best.wsim) < 1e-9 && cand.enabled && !best.enabled)) best = cand;
        } catch {}
      }
      jsonRes(res, best && best.score >= 0.9
        ? { name: best.name, label: best.label, score: Math.round(best.score * 1000) / 1000, widgetScore: Math.round(best.wsim * 1000) / 1000, enabled: best.enabled }
        : {});
    });
    return;
  }

  // API: Mapping candidates + auto-detected guesses for a single workflow
  if (pn === '/api/workflow-nodes' && req.method === 'GET') {
    const wfName = url.searchParams.get('name');
    if (!wfName) { jsonRes(res, { error: 'Missing name' }, 400); return; }
    const wfPath = path.join(WORKFLOWS_DIR, wfName);
    if (!path.resolve(wfPath).startsWith(path.resolve(WORKFLOWS_DIR))) { jsonRes(res, { error: 'Access denied' }, 403); return; }
    fs.readFile(wfPath, 'utf8', (err, raw) => {
      if (err) { jsonRes(res, { error: err.message }, 500); return; }
      try {
        const wf = JSON.parse(raw);
        const mapping = (loadWfStore().mappings || {})[wfName] || null;
        const pn2 = resolvePromptNode(wf, mapping), sn = resolveStepsNode(wf, mapping), sd = resolveSeedNode(wf, mapping);
        jsonRes(res, {
          candidates: workflowCandidates(wf),
          detected: { promptNodeId: pn2 ? pn2.id : null, stepsNodeId: sn ? sn.id : null, seedNodeId: sd ? sd.id : null },
          hasPresets: detectPresetGroups(wf).length > 0,
        });
      } catch (e) { jsonRes(res, { error: 'Parse error: ' + e.message }, 500); }
    });
    return;
  }

  // API: Persist the allowlist + labels + node mappings
  if (pn === '/api/workflows/manage' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', c => bodyStr += c);
    req.on('end', () => {
      let body;
      try { body = JSON.parse(bodyStr); } catch { jsonRes(res, { error: 'Bad JSON' }, 400); return; }
      const store = loadWfStore();
      const valid = new Set(listAllWorkflows());
      if (Array.isArray(body.enabled)) store.enabled = body.enabled.filter(n => valid.has(n));
      if (body.labels && typeof body.labels === 'object') store.labels = body.labels;
      if (body.mappings && typeof body.mappings === 'object') store.mappings = body.mappings;
      const ok = saveWfStore(store);
      jsonRes(res, ok ? { ok: true, enabled: store.enabled } : { error: 'Save failed' }, ok ? 200 : 500);
    });
    return;
  }

  // API: Generate the field config for a workflow (detected fields + user edits).
  // API: list available LoRA files (for the Remix form's "add LoRA row" picker).
  if (pn === '/api/loras' && req.method === 'GET') {
    (async () => {
      let loras = loraNamesFromDisk();
      if (!loras.length) {
        let objectInfo = null; try { objectInfo = await getObjectInfo(); } catch (e) {}
        if (objectInfo) {
          for (const cls of ['LoraLoader', 'LoraLoaderModelOnly', 'Power Lora Loader (rgthree)']) {
            const inf = objectInfo[cls]; if (!inf || !inf.input) continue;
            const spec = (inf.input.required && inf.input.required.lora_name) || (inf.input.optional && inf.input.optional.lora_name);
            if (spec && Array.isArray(spec[0]) && spec[0].length) { loras = spec[0].slice(); break; }
          }
        }
      }
      jsonRes(res, { loras, index: buildLoraIndex(loras) });
    })();
    return;
  }

  // State of the in-flight /object_info fetch (drives the Remix dialog's progress
  // bar while a field config is being built). lastMs is the previous fetch's
  // duration — the UI uses it as the ETA denominator.
  if (pn === '/api/objectinfo-progress' && req.method === 'GET') {
    const p = objectInfoProgress;
    jsonRes(res, { active: p.active, elapsedMs: p.active ? Date.now() - p.startedAt : 0, lastMs: p.lastMs || 0 });
    return;
  }

  if (pn === '/api/workflow-field-config' && req.method === 'GET') {
    const rawName = url.searchParams.get('name');
    if (!rawName) { jsonRes(res, { error: 'Missing name' }, 400); return; }
    const { file: wfName, shortcut } = resolveWfName(rawName);
    if (!wfName) { jsonRes(res, { error: 'No such shortcut' }, 404); return; }
    const wfPath = path.join(WORKFLOWS_DIR, wfName);
    if (!path.resolve(wfPath).startsWith(path.resolve(WORKFLOWS_DIR))) { jsonRes(res, { error: 'Access denied' }, 403); return; }
    fs.readFile(wfPath, 'utf8', async (err, raw) => {
      if (err) { jsonRes(res, { error: err.message }, 500); return; }
      let wf; try { wf = JSON.parse(raw.replace(/^﻿/, '')); } catch (e) { jsonRes(res, { error: 'Parse error: ' + e.message }, 500); return; }
      try {
        const st = fs.statSync(wfPath, { throwIfNoEntry: false });
        let objectInfo = null; try { objectInfo = await getObjectInfo(); } catch (e) {}   // combo choices (cached; null if ComfyUI down)
        const cfg = buildFieldConfig(wf, wfName, st ? st.mtimeMs : 0, objectInfo);
        // A shortcut is the parent's config opened on the values it captured.
        // Fields the workflow no longer has are skipped rather than resurrected,
        // so editing the parent degrades a shortcut instead of breaking it.
        if (shortcut && Array.isArray(cfg.fields)) {
          const saved = shortcut.fieldValues || {};
          for (const f of cfg.fields) if (Object.prototype.hasOwnProperty.call(saved, f.id)) f.value = saved[f.id];
          cfg.shortcut = { name: shortcut.name, parent: shortcut.parent };
          if (saved.__preset) cfg.selectedPreset = saved.__preset;
        }
        jsonRes(res, cfg);
      } catch (e) { jsonRes(res, { error: 'Field config error: ' + e.message }, 500); }
    });
    return;
  }

  // API: Persist field-config user edits (enable/label/value + manual fields).
  // POST { name, edits: {<fieldId>:{enabled?,label?,value?}}, manual?: [field...] }
  if (pn === '/api/workflow-field-config' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', c => bodyStr += c);
    req.on('end', async () => {
      let body; try { body = JSON.parse(bodyStr); } catch { jsonRes(res, { error: 'Bad JSON' }, 400); return; }
      // Build field config from a posted (embedded / un-imported) workflow graph.
      if (body.workflow && typeof body.workflow === 'object' && Array.isArray(body.workflow.nodes)) {
        try {
          let objectInfo = null; try { objectInfo = await getObjectInfo(); } catch (e) {}
          jsonRes(res, buildFieldConfig(body.workflow, body.name || '__embedded__', 0, objectInfo));
        } catch (e) { jsonRes(res, { error: 'Field config error: ' + e.message }, 500); }
        return;
      }
      if (!body.name) { jsonRes(res, { error: 'Missing name' }, 400); return; }
      const store = loadWfStore();
      if (!store.fieldConfigs) store.fieldConfigs = {};
      const entry = store.fieldConfigs[body.name] || { edits: {}, manual: [] };
      if (body.edits && typeof body.edits === 'object') entry.edits = body.edits;
      if (Array.isArray(body.manual)) entry.manual = body.manual;
      if (body.reset) { delete store.fieldConfigs[body.name]; }
      else store.fieldConfigs[body.name] = entry;
      const ok = saveWfStore(store);
      jsonRes(res, ok ? { ok: true } : { error: 'Save failed' }, ok ? 200 : 500);
    });
    return;
  }

  // API: Save a workflow JSON into the app workflows dir. Used by "Fix with
  // to materialize an image-embedded workflow as a file so it can be
  // debugged/edited, and optionally enable it for the workflow dropdown.
  // API: Write the on-screen field values back into the workflow file itself,
  // so the next run of it — from here or from ComfyUI — starts from them.
  //
  // Deliberately narrow: it only writes the fields the Remix dialog exposes,
  // through the same applyFieldConfigOverrides the run path uses, so a value
  // can only land where a run would have put it. Everything else in the graph
  // is left exactly as it was.
  if (pn === '/api/workflows/update' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', c => bodyStr += c);
    req.on('end', async () => {
      let body;
      try { body = JSON.parse(bodyStr); } catch { jsonRes(res, { error: 'Bad JSON' }, 400); return; }
      const rawName = String(body.name || '');
      // A shortcut lives in the store, not on disk — updating one is what the
      // shortcut button already does, and resolving it here would silently
      // rewrite its parent workflow instead.
      if (!rawName || rawName === '__inherit__' || rawName.startsWith(SHORTCUT_PREFIX)) {
        jsonRes(res, { error: 'Pick a workflow stored in ComfyUI first' }, 400); return;
      }
      const wfPath = path.join(WORKFLOWS_DIR, rawName);
      if (!path.resolve(wfPath).startsWith(path.resolve(WORKFLOWS_DIR))) { jsonRes(res, { error: 'Access denied' }, 403); return; }
      if (!fs.existsSync(wfPath)) { jsonRes(res, { error: 'No such workflow' }, 404); return; }
      const values = (body.fieldValues && typeof body.fieldValues === 'object') ? body.fieldValues : null;
      if (!values) { jsonRes(res, { error: 'Missing fieldValues' }, 400); return; }
      try {
        const raw = fs.readFileSync(wfPath, 'utf8');
        const wf = JSON.parse(raw.replace(/^﻿/, ''));
        const st = fs.statSync(wfPath, { throwIfNoEntry: false });
        let objectInfo = null; try { objectInfo = await getObjectInfo(); } catch (e) {}
        const cfg = buildFieldConfig(wf, rawName, st ? st.mtimeMs : 0, objectInfo);
        // Returns { warnings }, not a bare array. Anything it could not write —
        // a node outside the executing graph, a subgraph target — is reported
        // rather than swallowed, because the file is being overwritten.
        const applied = applyFieldConfigOverrides(wf, cfg, values) || {};
        const warnings = Array.isArray(applied.warnings) ? applied.warnings : [];
        // Backup beside the file before the first overwrite. One copy, not a
        // history: the point is a way back from a bad update, and a .bak per
        // save would litter the workflows folder ComfyUI itself lists.
        const bak = wfPath + '.bak';
        try { if (!fs.existsSync(bak)) fs.copyFileSync(wfPath, bak); } catch (e) {}
        fs.writeFileSync(wfPath, JSON.stringify(wf, null, 2));
        jsonRes(res, { ok: true, name: rawName, warnings });
      } catch (e) { jsonRes(res, { error: 'Update failed: ' + e.message }, 500); }
    });
    return;
  }

  if (pn === '/api/workflows/save' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', c => bodyStr += c);
    req.on('end', () => {
      let body;
      try { body = JSON.parse(bodyStr); } catch { jsonRes(res, { error: 'Bad JSON' }, 400); return; }
      if (!body.workflow || typeof body.workflow !== 'object') { jsonRes(res, { error: 'Missing workflow' }, 400); return; }
      let name = String(body.name || 'DEBUG.json').replace(/[\\\/:*?"<>|]/g, '_').trim();
      if (!name.toLowerCase().endsWith('.json')) name += '.json';
      const wfPath = path.join(WORKFLOWS_DIR, name);
      if (!path.resolve(wfPath).startsWith(path.resolve(WORKFLOWS_DIR))) { jsonRes(res, { error: 'Access denied' }, 403); return; }
      // Never clobber an existing workflow unless the caller explicitly asks to.
      // The Remix dialog never asks; a re-save does, because re-saving
      // the same DEBUG file is exactly how that loop works.
      if (!body.overwrite && fs.existsSync(wfPath)) {
        jsonRes(res, { error: 'A workflow named "' + name + '" already exists', exists: true, name }, 409);
        return;
      }
      try {
        fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
        fs.writeFileSync(wfPath, JSON.stringify(body.workflow, null, 2));
      } catch (e) { jsonRes(res, { error: 'Write failed: ' + e.message }, 500); return; }
      if (body.enable) {
        const store = loadWfStore();
        if (!store.enabled.includes(name)) { store.enabled.push(name); saveWfStore(store); }
      }
      jsonRes(res, { ok: true, name });
    });
    return;
  }

  // API: Write an app workflow back into a PNG's metadata, replacing the
  // embedded 'workflow' (graph) and 'prompt' (API) text chunks — so Inherit
  // runs of that image use the fixed workflow from then on.
  if (pn === '/api/image/embed-workflow' && req.method === 'POST') {
    let bodyStr = '';
    req.on('data', c => bodyStr += c);
    req.on('end', async () => {
      let body;
      try { body = JSON.parse(bodyStr); } catch { jsonRes(res, { error: 'Bad JSON' }, 400); return; }
      const { filePath, workflowName } = body;
      if (!filePath || !workflowName) { jsonRes(res, { error: 'Missing filePath or workflowName' }, 400); return; }
      const fileExt = path.extname(filePath).toLowerCase();
      const isPng = fileExt === '.png';
      const isVid = ['.mp4', '.webm', '.mkv', '.mov'].includes(fileExt);
      if (!isPng && !isVid) { jsonRes(res, { error: 'Only PNG and video files can carry an embedded workflow' }, 400); return; }
      const abs = path.resolve(filePath);
      if (!abs.startsWith(path.resolve(ROOT)) && !abs.startsWith(path.resolve(COMFY_OUTPUT))) {
        jsonRes(res, { error: 'File must be under the media or ComfyUI output folder' }, 403); return;
      }
      if (!fs.existsSync(abs)) { jsonRes(res, { error: 'File not found' }, 404); return; }
      const wfPath = path.join(WORKFLOWS_DIR, workflowName);
      if (!path.resolve(wfPath).startsWith(path.resolve(WORKFLOWS_DIR))) { jsonRes(res, { error: 'Access denied' }, 403); return; }
      let wf;
      try { wf = JSON.parse(fs.readFileSync(wfPath, 'utf8')); } catch (e) { jsonRes(res, { error: 'Workflow read failed: ' + e.message }, 500); return; }
      let apiPrompt;
      try { apiPrompt = await workflowToPrompt(wf); } catch (e) { jsonRes(res, { error: 'Workflow conversion failed: ' + e.message }, 500); return; }
      const done = (err) => {
        if (err) { jsonRes(res, { error: err.message }, 500); return; }
        jsonRes(res, { ok: true });
      };
      if (isPng) embedPngText(abs, { workflow: JSON.stringify(wf), prompt: JSON.stringify(apiPrompt) }, done);
      else embedVideoText(abs, JSON.stringify({ prompt: apiPrompt, workflow: wf }), done);
    });
    return;
  }

  // API: Get editable config (MAIN PROMPT, loras) from an APP workflow
  if (pn === '/api/workflow-config' && req.method === 'GET') {
    const wfName = url.searchParams.get('name');
    if (!wfName) { jsonRes(res, { error: 'Missing name' }, 400); return; }
    const wfPath = path.join(COMFY_DIR, 'user', 'default', 'workflows', wfName);
    if (!path.resolve(wfPath).startsWith(path.resolve(path.join(COMFY_DIR, 'user', 'default', 'workflows')))) {
      jsonRes(res, { error: 'Access denied' }, 403); return;
    }
    const wfStat = fs.statSync(wfPath, { throwIfNoEntry: false });
    fs.readFile(wfPath, 'utf8', async (err, raw) => {
      if (err) { jsonRes(res, { error: err.message }, 500); return; }
      try {
        const wf = JSON.parse(raw);
        const mapping = (loadWfStore().mappings || {})[wfName] || null;
        const config = { prompt: '', loras: [], frames: null, seed: null, steps: null, cfg: null, presets: [], mtime: wfStat ? wfStat.mtimeMs : 0 };

        // Prompt / steps / seed via mapping-or-convention resolvers
        const promptNode = resolvePromptNode(wf, mapping);
        if (promptNode) { const wv = promptNode.widgets_values || []; config.prompt = typeof wv[0] === 'string' ? wv[0] : ''; }
        const stepsNode = resolveStepsNode(wf, mapping);
        if (stepsNode) { const wv = stepsNode.widgets_values || []; config.steps = typeof wv[0] === 'number' ? wv[0] : (typeof wv[1] === 'number' ? wv[1] : null); }
        const seedNode = resolveSeedNode(wf, mapping);
        if (seedNode) { const wv = seedNode.widgets_values || []; config.seed = typeof wv[0] === 'number' ? wv[0] : -1; }

        // Dual high/low sampler split (Wan video): report per-pass step counts
        const hl = findHighLowSamplers(wf);
        if (hl) {
          const total = Number(hl.high.widgets_values[3]) || 0;
          const high = Number(hl.high.widgets_values[8]) || 0;
          config.highLowSteps = { high, low: Math.max(0, total - high) };
        }

        // CFG: read from the converted prompt — exact w.r.t. muted/pruned
        // branches and slider/config-node indirection. Only exposed when every
        // executing sampler agrees on the value. The graph heuristic is just a
        // degraded-mode fallback (ComfyUI down = no widget mapping).
        let converted = null;
        try { converted = await workflowToPrompt(JSON.parse(JSON.stringify(wf))); } catch {}
        const sampCfgs = converted ? Object.values(converted)
          .filter(n => (n.class_type || '').startsWith('KSampler') && typeof (n.inputs || {}).cfg === 'number')
          .map(n => n.inputs.cfg) : [];
        if (sampCfgs.length) {
          if (sampCfgs.every(v => v === sampCfgs[0])) config.cfg = sampCfgs[0];
        } else {
          const cfgCtl = resolveCfg(wf);
          if (cfgCtl) config.cfg = cfgCtl.get();
        }

        // Frames slider (mxSlider titled "Frames") — unchanged convention
        for (const node of wf.nodes || []) {
          if ((node.title || '').toUpperCase() === 'FRAMES' && node.type === 'mxSlider') {
            const wv = node.widgets_values || [];
            config.frames = typeof wv[0] === 'number' ? wv[0] : (typeof wv[1] === 'number' ? wv[1] : null);
          }
        }
        // Style/quality preset groups (return title + on state; drop internal memberIds)
        config.presets = detectPresetGroups(wf).map(p => ({ title: p.title, on: p.on }));
        // LoRAs: dual high/low lists for Wan dual-sampler workflows, else a single list.
        const hlLoaders = findHighLowLoraLoaders(wf);
        if (hlLoaders) {
          config.lorasHigh = extractLoras(hlLoaders.high);
          config.lorasLow = extractLoras(hlLoaders.low);
        } else {
          const loraNodes = (wf.nodes || []).filter(n => (n.type || '').includes('Power Lora Loader'));
          if (loraNodes.length > 0) config.loras = extractLoras(loraNodes[0]);
        }
        jsonRes(res, config);
      } catch (e) {
        jsonRes(res, { error: 'Parse error: ' + e.message }, 500);
      }
    });
    return;
  }

  // API: Load an APP workflow, apply overrides, convert to API/prompt format
  if (pn === '/api/workflow-prompt' && (req.method === 'GET' || req.method === 'POST')) {
    // A shortcut runs its parent's graph; the field values it captured reach us
    // in the body, since the dialog has already opened on them.
    const wfName = resolveWfName(url.searchParams.get('name')).file;
    let bodyStr = '';
    req.on('data', c => bodyStr += c);
    req.on('end', async () => {
      let overrides = {};
      if (bodyStr) { try { overrides = JSON.parse(bodyStr); } catch {} }

      // Source graph: a posted (embedded / un-imported) workflow takes precedence
      // over a named file — this is how "Inherit" runs an image's own workflow.
      let wf, effName = wfName || '__embedded__', mtime = 0;
      if (overrides.workflow && typeof overrides.workflow === 'object' && Array.isArray(overrides.workflow.nodes)) {
        wf = overrides.workflow; effName = '__embedded__';
      } else if (wfName) {
        const wfPath = path.join(COMFY_DIR, 'user', 'default', 'workflows', wfName);
        if (!path.resolve(wfPath).startsWith(path.resolve(path.join(COMFY_DIR, 'user', 'default', 'workflows')))) { jsonRes(res, { error: 'Access denied' }, 403); return; }
        let raw; try { raw = fs.readFileSync(wfPath, 'utf8'); } catch (e) { jsonRes(res, { error: e.message }, 500); return; }
        try { wf = JSON.parse(raw); } catch (e) { jsonRes(res, { error: 'Parse error: ' + e.message }, 500); return; }
        const st = fs.statSync(wfPath, { throwIfNoEntry: false }); mtime = st ? st.mtimeMs : 0;
      } else { jsonRes(res, { error: 'Missing name or workflow' }, 400); return; }
      try {
          const mapping = (loadWfStore().mappings || {})[effName] || null;

          // New-style generic field overrides: { fieldValues: {<id>: value} }.
          // Applied to the raw graph before conversion; coexists with the legacy
          // keys below (the field panel sends only fieldValues, so those are skipped).
          let fieldWarnings = [];
          if (overrides.fieldValues && typeof overrides.fieldValues === 'object') {
            const cfg = buildFieldConfig(JSON.parse(JSON.stringify(wf)), effName, mtime);
            fieldWarnings = applyFieldConfigOverrides(wf, cfg, overrides.fieldValues).warnings;
          }

          // Apply prompt override (mapped node, or MAIN PROMPT / best-guess)
          if (overrides.prompt !== undefined) {
            const promptNode = resolvePromptNode(wf, mapping);
            if (promptNode && promptNode.widgets_values) promptNode.widgets_values[0] = overrides.prompt;
          }

          // Apply lora overrides to all Power Lora Loader nodes
          if (overrides.lorasHigh || overrides.lorasLow) {
            // Dual high/low lists → apply each to its mapped loader node.
            const hlLoaders = findHighLowLoraLoaders(wf);
            if (hlLoaders) {
              applyLoraOverrides(hlLoaders.high, overrides.lorasHigh);
              applyLoraOverrides(hlLoaders.low, overrides.lorasLow);
            }
          } else if (overrides.loras && Array.isArray(overrides.loras)) {
            const loraNodes = (wf.nodes || []).filter(n => (n.type || '').includes('Power Lora Loader'));
            for (const node of loraNodes) applyLoraOverrides(node, overrides.loras);
          }

          // Apply frames override to mxSlider "Frames" node
          if (overrides.frames !== undefined && overrides.frames !== null) {
            for (const node of wf.nodes || []) {
              const title = (node.title || '').toUpperCase();
              if (title === 'FRAMES' && node.type === 'mxSlider') {
                const wv = node.widgets_values || [];
                const frameVal = parseInt(overrides.frames);
                if (!isNaN(frameVal)) {
                  // mxSlider has Xi and Xf - set both
                  if (typeof wv[0] === 'number') wv[0] = frameVal;
                  if (typeof wv[1] === 'number') wv[1] = frameVal;
                }
              }
            }
          }

          // Apply steps override (mapped node, or mxSlider "Steps"). Sets wv[0]/wv[1].
          if (overrides.steps !== undefined && overrides.steps !== null) {
            const stepVal = parseInt(overrides.steps);
            const stepsNode = resolveStepsNode(wf, mapping);
            if (!isNaN(stepVal) && stepsNode && stepsNode.widgets_values) {
              const wv = stepsNode.widgets_values;
              if (typeof wv[0] === 'number') wv[0] = stepVal;
              if (typeof wv[1] === 'number') wv[1] = stepVal;
            }
          }

          // High/low sampler split override — the sum becomes total steps on both
          // passes; the high pass covers [0, high), the low pass takes over from there.
          if (overrides.highSteps != null && overrides.lowSteps != null) {
            const hs = parseInt(overrides.highSteps), ls = parseInt(overrides.lowSteps);
            const hl = findHighLowSamplers(wf);
            if (hl && !isNaN(hs) && !isNaN(ls) && hs >= 0 && ls >= 0 && hs + ls > 0) {
              hl.high.widgets_values[3] = hs + ls;
              hl.high.widgets_values[7] = 0;
              hl.high.widgets_values[8] = hs;
              hl.low.widgets_values[3] = hs + ls;
              hl.low.widgets_values[7] = hs;
            }
          }

          // Pin seed on the resolved Seed node (omit/-1 = let the client randomize)
          if (overrides.seed !== undefined && overrides.seed !== null && Number(overrides.seed) >= 0) {
            const seedVal = Math.floor(Number(overrides.seed));
            const seedNode = resolveSeedNode(wf, mapping);
            if (seedNode && seedNode.widgets_values) seedNode.widgets_values[0] = seedVal;
          }

          // Activate exactly one style/quality preset group; mute the others.
          if (overrides.preset) {
            const presetGroups = detectPresetGroups(wf);
            const byId = {};
            for (const n of wf.nodes || []) byId[n.id] = n;
            for (const g of presetGroups) {
              const targetMode = g.title === overrides.preset ? 0 : 2; // 0 = active, 2 = muted
              for (const id of g.memberIds) { if (byId[id]) byId[id].mode = targetMode; }
            }
          }

          const prompt = await workflowToPrompt(wf);
          if (!Object.keys(prompt).length) {
            jsonRes(res, { error: 'Workflow resolves to no runnable output nodes (is ComfyUI running? are all savers muted/bypassed?)' }, 422);
            return;
          }

          // CFG override — applied to the CONVERTED prompt, which reflects the
          // samplers that actually execute. Graph-level CFG sources are too
          // ambiguous to write directly (sliders, rgthree config nodes, and
          // per-sampler widgets can coexist, some feeding pruned branches).
          if (overrides.cfg !== undefined && overrides.cfg !== null) {
            const cfgVal = parseFloat(overrides.cfg);
            if (!isNaN(cfgVal) && cfgVal >= 0) {
              for (const [id, n] of Object.entries(prompt)) {
                if (!(n.class_type || '').startsWith('KSampler') || typeof (n.inputs || {}).cfg !== 'number') continue;
                n.inputs.cfg = cfgVal;
                // Keep the returned graph (extra_pnginfo / embedded metadata) in step
                const gn = (wf.nodes || []).find(x => String(x.id) === id);
                if (gn && Array.isArray(gn.widgets_values)) {
                  const idx = gn.type === 'KSamplerAdvanced' ? 4 : (gn.type === 'KSampler' ? 3 : -1);
                  if (idx >= 0 && typeof gn.widgets_values[idx] === 'number') gn.widgets_values[idx] = cfgVal;
                }
              }
              const ctl = resolveCfg(wf);
              if (ctl) ctl.set(cfgVal);   // sliders/primitives stay visually consistent
            }
          }
          // Warn about node types this ComfyUI doesn't have installed. Their branch is
          // either dropped or (when an input type matches) passed through, so the run
          // can look fine while doing something the workflow never asked for.
          try {
            const oi = await getObjectInfo();
            const missing = new Set();
            for (const n of wf.nodes || []) {
              if (!n.type || oi[n.type] || n.mode === 2 || n.mode === 4) continue;
              if (isUiOnlyNode(n.type) || !(n.outputs || []).length) continue;
              if (((wf.definitions && wf.definitions.subgraphs) || []).some(d => String(d.id) === String(n.type))) continue;
              missing.add(n.type);
            }
            for (const t of missing) fieldWarnings.push('node type "' + t + '" is not installed in ComfyUI — that branch was skipped');
          } catch (e) {}
          // Return the (override-applied) visual graph too: the client submits it
          // as extra_data.extra_pnginfo.workflow, which graph-introspecting nodes
          // (WidgetToString etc.) require at execution time.
          jsonRes(res, { prompt, workflow: wf, fieldWarnings });
        } catch (e) {
          jsonRes(res, { error: 'Parse error: ' + e.message }, 500);
        }
    });
    return;
  }

  // Proxy: forward /api/comfy/* to the ComfyUI API (config.comfyUrl)
  if (pn.startsWith('/api/comfy/')) {
    const comfyPath = pn.replace('/api/comfy', '') + (url.search || '');
    const fwdHeaders = {
      'content-type': req.headers['content-type'] || 'application/json',
    };
    if (req.headers['content-length']) fwdHeaders['content-length'] = req.headers['content-length'];
    if (req.headers['accept']) fwdHeaders['accept'] = req.headers['accept'];
    const ch = comfyHostPort();
    fwdHeaders['host'] = ch.hostname + ':' + ch.port;
    const opts = {
      hostname: ch.hostname, port: ch.port,
      path: comfyPath, method: req.method,
      headers: fwdHeaders,
    };
    const proxyReq = http.request(opts, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', (e) => { jsonRes(res, { error: e.message }, 502); });
    req.pipe(proxyReq);
    return;
  }

  // SPA fallback. The router runs in history mode, so a deep link or a refresh on
  // /browse/… arrives here as a real request for a path no endpoint owns — it has
  // to come back as the app shell, which then routes on the client. Only a browser
  // navigation qualifies: anything asking for JSON, media or an asset must still
  // 404 rather than be handed a page. Sits last, so every real route wins first.
  if (req.method === 'GET' && String(req.headers.accept || '').includes('text/html')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    serveFile(path.join(__dirname, 'index.html'), req, res); return;
  }

  res.writeHead(404); res.end('Not found');

});

// WebSocket proxy: /comfy-ws -> ComfyUI <comfyUrl>/ws
server.on('upgrade', (req, socket, head) => {
  // Attach this BEFORE anything can fail. The pair further down only exists once
  // ComfyUI has answered the upgrade; a client that goes away in the meantime —
  // or a ComfyUI container that stops mid-handshake — emits ECONNRESET on a
  // socket with no listener, which in Node is an uncaught exception that takes
  // the whole server down. That is not theoretical: it killed this process twice
  // in one afternoon, each time looking like "the app is just gone".
  socket.on('error', e => console.log('[WS Proxy] client socket error:', e.code || e.message));

  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  if (!reqUrl.pathname.startsWith('/comfy-ws') || !isAuthed(req)) {
    socket.destroy();
    return;
  }
  const clientId = reqUrl.searchParams.get('clientId') || '';
  const comfyPath = '/ws' + (clientId ? '?clientId=' + clientId : (reqUrl.search || ''));
  const ch = comfyHostPort();
  console.log('[WS Proxy] Upgrade request:', req.url, '-> ' + ch.hostname + ':' + ch.port + comfyPath);
  const opts = {
    hostname: ch.hostname, port: ch.port,
    path: comfyPath, method: 'GET',
    headers: {
      'Connection': 'Upgrade',
      'Upgrade': 'websocket',
      'Sec-WebSocket-Version': req.headers['sec-websocket-version'],
      'Sec-WebSocket-Key': req.headers['sec-websocket-key'],
      'Host': ch.hostname + ':' + ch.port,
    },
  };
  if (req.headers['sec-websocket-extensions']) opts.headers['Sec-WebSocket-Extensions'] = req.headers['sec-websocket-extensions'];
  if (req.headers['sec-websocket-protocol']) opts.headers['Sec-WebSocket-Protocol'] = req.headers['sec-websocket-protocol'];
  const proxyReq = http.request(opts);
  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    console.log('[WS Proxy] Got 101 from ComfyUI');
    // Send back the 101 response
    let response = 'HTTP/1.1 101 Switching Protocols\r\n';
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      response += `${k}: ${v}\r\n`;
    }
    response += '\r\n';
    socket.write(response);
    if (proxyHead.length) socket.write(proxyHead);
    // Pipe both directions
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
    proxySocket.on('error', () => socket.destroy());
    socket.on('error', () => proxySocket.destroy());
  });
  proxyReq.on('response', (res) => {
    console.log('[WS Proxy] Got HTTP response instead of upgrade:', res.statusCode);
    socket.destroy();
  });
  proxyReq.on('error', (e) => { console.log('[WS Proxy] Error:', e.message); socket.destroy(); });
  proxyReq.end();
});

// Bind host for the plain-HTTP listener. Defaults to 0.0.0.0; set config.httpHost to
// '127.0.0.1' to make HTTP loopback-only. That is what actually forces remote clients
// through the mTLS-guarded HTTPS port -- otherwise HTTP is an unauthenticated way in
// that bypasses the client-cert check entirely.
const HTTP_HOST = config.httpHost || '0.0.0.0';
const HTTP_LOOPBACK_ONLY = HTTP_HOST === '127.0.0.1' || HTTP_HOST === 'localhost';
server.listen(PORT, HTTP_LOOPBACK_ONLY ? '127.0.0.1' : HTTP_HOST, () => {
  console.log(`Media Browser: http://localhost:${PORT}${HTTP_LOOPBACK_ONLY ? '  (loopback only)' : ''}`);
  console.log(`Serving: ${ROOT}`);
  console.log(`Favorites: ${FAVORITES_DIR}`);
});

// Windows resolves `localhost` to ::1 before 127.0.0.1, so an IPv4-only loopback bind
// leaves http://localhost:PORT failing while http://127.0.0.1:PORT works. Give the
// IPv6 loopback its own listener sharing the same handlers rather than leave that trap.
if (HTTP_LOOPBACK_ONLY) {
  const v6 = http.createServer(server.listeners('request')[0]);
  for (const listener of server.listeners('upgrade')) v6.on('upgrade', listener);
  v6.on('error', e => console.log(`IPv6 loopback listener not started: ${e.message}`));
  v6.listen(PORT, '::1', () => console.log(`Media Browser: http://[::1]:${PORT}  (loopback only)`));
}

// Optional HTTPS server (for mic access from LAN / phones)
const HTTPS_PORT = parseInt(config.httpsPort, 10) || 8443;
const CERT_PATH = path.join(__dirname, 'certs', 'cert.pem');
const KEY_PATH = path.join(__dirname, 'certs', 'key.pem');
if (fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) {
  try {
    const tls = require('tls');
    const httpsMod = require('https');
    const tlsOpts = {
      cert: fs.readFileSync(CERT_PATH),
      key: fs.readFileSync(KEY_PATH),
    };
    // Optional mutual TLS. With it on, the HTTPS listener only finishes a handshake
    // for clients presenting a cert signed by our client CA -- everyone else is cut
    // off at the TLS layer, before any request is parsed. Gated on config.mtls so it
    // can be turned off without editing code; the HTTP listener is the lock-out
    // escape hatch if every client cert is lost.
    const CLIENT_CA_PATH = config.mtlsClientCa
      ? path.resolve(__dirname, config.mtlsClientCa)
      : path.join(__dirname, 'certs', 'client-ca.crt');
    if (config.mtls) {
      if (fs.existsSync(CLIENT_CA_PATH)) {
        tlsOpts.ca = fs.readFileSync(CLIENT_CA_PATH);
        tlsOpts.requestCert = true;
        tlsOpts.rejectUnauthorized = true;
      } else {
        console.log(`Mutual TLS requested but client CA missing: ${CLIENT_CA_PATH} -- NOT enabled`);
      }
    }
    // Reuse the same request handler + upgrade handler as the HTTP server
    const httpsServer = httpsMod.createServer(tlsOpts, server.listeners('request')[0]);
    // A rejected client cert surfaces here, not as an HTTP error -- log it so a
    // failed handshake is diagnosable instead of looking like a dead port.
    httpsServer.on('tlsClientError', (err, socket) => {
      const peer = (socket && socket.remoteAddress) || '?';
      console.log(`TLS client rejected (${peer}): ${err.message}`);
    });
    for (const listener of server.listeners('upgrade')) {
      httpsServer.on('upgrade', listener);
    }
    // HTTPS is optional, so a bind failure (usually another instance already on
    // this port) must log and leave HTTP serving -- without a handler the 'error'
    // event is unhandled and takes the whole process down.
    httpsServer.on('error', e => console.log(`HTTPS listener not started on ${HTTPS_PORT}: ${e.message}`));
    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log(`Media Browser HTTPS: https://localhost:${HTTPS_PORT}`);
      console.log(`Mutual TLS: ${tlsOpts.requestCert ? 'ON (client cert required)' : 'off'}`);
    });
  } catch (e) {
    console.log('HTTPS server not started:', e.message);
  }
}
