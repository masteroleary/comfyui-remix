'use strict';
// ── Desktop staging ────────────────────────────────────────────────────────
// Builds dist/stage, the only tree electron-builder is allowed to package
// (electron-builder.config.js maps `files` to it and nothing else).
//
// The stage is an explicit allowlist, never a glob of the repo root. A checkout
// on a machine that runs the server holds config.json (API keys and the password
// hashes), certs/ (the TLS and client-CA private keys) and the app-*.json stores
// (private prompts) right beside the code — a clean CI checkout has none of
// them, but "the build works from CI" is not a reason to let a local build pick
// them up. Adding a file to the program means naming it below, the same way
// adding one to the server means naming it in its static allowlist.
//
// What is staged is not the source either: the user asked for an installer that
// does not hand over the code. So every first-party script is minified (which
// drops every comment) and then obfuscated, CSS is minified and HTML loses its
// comments. That is a deterrent, not encryption: the code has to run, so it can
// always be read by someone determined. What it rules out is the installer
// being the repository with a different file extension.
//
// Then it checks its own work and exits non-zero on any failure: every staged
// script parses, no staged path looks like a secret, and no comment survived.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const esbuild = require('esbuild');
const JavaScriptObfuscator = require('javascript-obfuscator');
const { forbiddenReason, CANARIES, phraseRegex, proseComments } = require('./leak-rules.js');

const ROOT = path.join(__dirname, '..');
const STAGE = path.join(ROOT, 'dist', 'stage');

// How a script is loaded decides how it may be rewritten. Server-side files and
// the Electron main are CommonJS under Node; app/** is native ES modules in the
// page; ui-guards.js is a classic <script>, so its top level is the page's
// global scope and must not be parsed as a module's.
const CJS = 'cjs';
const ESM = 'esm';
const SCRIPT = 'script';

// Single files, by exact path. server.js requires the two field-config modules;
// the rest are the root assets its static allowlist names (cross-checked below,
// so a file added there and forgotten here fails the build rather than 404ing
// in the installed app).
const FILES = [
  ['server.js', CJS],
  ['field-config-runtime.js', CJS],
  ['docs/field-config/gen_field_config.js', CJS],
  ['desktop/main.js', CJS],
  ['index.html'],
  ['common.css'],
  ['app.css'],
  ['ui-guards.js', SCRIPT],
  ['logo-home.webp'],
  ['favicon.ico'],
  ['favicon.svg'],
  ['apple-touch-icon.png'],
  ['seed.json'],
];

// Directories, by extension. Nothing else in them is taken, so a stray
// RemixDialog.js.bak or a notes.md left in app/ stays behind.
//   vendor/ is copied verbatim: those are Vue's public production builds,
//   already minified, and running them through the obfuscator would only make
//   a well-known library slower to parse for no secrecy gained.
const TREES = [
  { dir: 'app', exts: ['.js', '.css'], recursive: true, kind: ESM },
  { dir: 'vendor', exts: ['.js'], verbatim: true },
  { dir: 'default-workflows', exts: ['.json'] },
];

// ── Obfuscator options ─────────────────────────────────────────────────────
// Deliberately conservative, and not to be widened without re-launching the UI
// after. The front end is Vue 3's global build compiling templates from strings
// at runtime, and a setup() returns an object whose keys those template strings
// read by name. Anything that renames a property or an object key — renameGlobals,
// transformObjectKeys, renameProperties — makes the template ask for a key that
// no longer exists, and the failure is silent: the app boots to a blank control
// rather than throwing. controlFlowFlattening and deadCodeInjection have both
// shipped bugs that miscompile short-circuit and optional-call expressions (see
// the obfuscator changelog), which this code is full of, so they stay off too.
// What is left — a base64 string array and hex-renamed locals — hides the prose
// and the literals without touching anything the runtime resolves by name.
const OBFUSCATE = {
  // v5 can stamp its own banner into the output; nothing here should say what
  // tool produced it, or read as anything but the program.
  advertisement: false,
  compact: true,
  // import() specifiers stay literal. The router lazy-loads every view by path and
  // the server's /app/ allowlist matches on it, so a specifier pulled into the
  // string table is one more thing that has to decode correctly for a route to open.
  ignoreImports: true,
  stringArray: true,
  stringArrayEncoding: ['base64'],
  stringArrayThreshold: 0.75,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  selfDefending: false,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  debugProtection: false,
  transformObjectKeys: false,
  unicodeEscapeSequence: false,
  sourceMap: false,
  // Fixed, so one source builds one package: the next release's diff then shows
  // what changed instead of every name and table order reshuffled.
  seed: 1,
};

const rel = p => path.relative(ROOT, p).split(path.sep).join('/');
const fail = msg => { console.error('  ✗ ' + msg); process.exitCode = 1; };

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function stageOut(relPath) {
  const out = path.join(STAGE, relPath);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  return out;
}

// esbuild keeps the module format (an ESM export must stay an export, a CJS
// require stay a require). The obfuscator needs no telling: v5 has no sourceType
// option and tries a script parse, then a module one, on its own. A classic script
// is minified with no format, so its top-level `let` stays a page global.
function minifyJs(source, relPath, kind) {
  const min = esbuild.transformSync(source, {
    loader: 'js',
    format: kind === SCRIPT ? undefined : kind,
    minify: true,
    legalComments: 'none',
    platform: kind === ESM ? 'browser' : 'node',
    target: 'es2020',
  });
  if (relPath) for (const w of min.warnings) console.warn('  ! esbuild ' + relPath + ': ' + w.text);
  return min.code;
}

function transformJs(source, relPath, kind) {
  const min = minifyJs(source, relPath, kind);
  // ui-guards.js is a page script, so it takes the browser target like app/**.
  const opts = { ...OBFUSCATE, target: kind === CJS ? 'node' : 'browser' };
  const obf = JavaScriptObfuscator.obfuscate(min, opts);
  return obf.getObfuscatedCode();
}

// What a file looks like with its comments gone and nothing else done: string literals
// kept verbatim. The derived canaries are chosen against this — prose that is in the
// source but not here was a comment and nothing else — and then looked for in what was
// actually staged. Choosing them against the staged output instead (as this once did)
// picks only phrases already absent from it, which is a check that cannot fail.
function commentsStripped(source, kind, jsKind) {
  if (kind === 'css') return esbuild.transformSync(source, { loader: 'css', minify: true, legalComments: 'none' }).code;
  if (kind === 'html') return stripHtmlComments(source);
  return minifyJs(source, null, jsKind || CJS);
}

// HTML carries only comments, no script to minify (index.html is a shell that
// links files staged separately). Drop the comments and leave the markup — an
// HTML minifier is a dependency this does not need for the one job here.
function stripHtmlComments(source) {
  return source.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n');
}

// ── Stage ───────────────────────────────────────────────────────────────────
console.log('Staging ->', rel(STAGE));
rmrf(path.join(ROOT, 'dist', 'stage'));
fs.mkdirSync(STAGE, { recursive: true });

const staged = [];      // every relative path written
const stagedJs = [];    // { rel, kind } for scripts we transformed (parse check)
const strippedByRel = {}; // rel -> post-transform text, for the canary self-check

function copyVerbatim(src, relPath) {
  const out = stageOut(relPath);
  fs.copyFileSync(src, out);
  staged.push(relPath);
}

function writeText(relPath, text) {
  const out = stageOut(relPath);
  fs.writeFileSync(out, text);
  staged.push(relPath);
  return text;
}

function stageOne(relPath, kind) {
  const src = path.join(ROOT, relPath);
  if (!fs.existsSync(src)) { fail('allowlisted file missing: ' + relPath); return; }
  const ext = path.extname(relPath).toLowerCase();
  if (ext === '.js') {
    const text = fs.readFileSync(src, 'utf8');
    strippedByRel[relPath] = writeText(relPath, transformJs(text, relPath, kind || CJS));
    stagedJs.push({ rel: relPath, kind: kind || CJS });
  } else if (ext === '.css') {
    const min = esbuild.transformSync(fs.readFileSync(src, 'utf8'), { loader: 'css', minify: true, legalComments: 'none' });
    strippedByRel[relPath] = writeText(relPath, min.code);
  } else if (ext === '.html') {
    strippedByRel[relPath] = writeText(relPath, stripHtmlComments(fs.readFileSync(src, 'utf8')));
  } else {
    copyVerbatim(src, relPath); // json / images
  }
}

for (const [relPath, kind] of FILES) stageOne(relPath, kind);

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

for (const t of TREES) {
  const base = path.join(ROOT, t.dir);
  if (!fs.existsSync(base)) { fail('allowlisted directory missing: ' + t.dir); continue; }
  const entries = t.recursive ? walk(base) : fs.readdirSync(base).map(n => path.join(base, n)).filter(p => fs.statSync(p).isFile());
  for (const abs of entries) {
    const ext = path.extname(abs).toLowerCase();
    if (!t.exts.includes(ext)) continue;
    const relPath = rel(abs);
    if (t.verbatim) { copyVerbatim(abs, relPath); continue; }
    stageOne(relPath, t.kind);
  }
}

// package.json is staged in a reduced form: electron-builder needs `main`, the
// version (electron-updater compares it) and the production dependency list to
// know what to add from node_modules — but scripts, devDependencies and the repo
// URL are the build's business, not the shipped app's. extraMetadata in the
// builder config also sets `main`; this keeps the staged file honest on its own.
(() => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const slim = {
    name: pkg.name,
    productName: pkg.productName,
    version: pkg.version,
    description: pkg.description,
    author: pkg.author,
    license: pkg.license,
    main: 'desktop/main.js',
    dependencies: pkg.dependencies || {},
  };
  writeText('package.json', JSON.stringify(slim, null, 2) + '\n');
})();

console.log('  staged ' + staged.length + ' files');

// ── Cross-check: server.js static allowlist vs. what we staged ───────────────
// The server serves an explicit allowlist of root assets; the packaged app runs
// that same server. A root asset the server will serve but the stage never
// copied is a 404 in the installed app that no test on the web build would show.
(() => {
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const wanted = new Set();
  for (const m of server.matchAll(/pn === '\/([A-Za-z0-9._-]+\.[A-Za-z0-9]+)'/g)) {
    if (m[1] !== 'index.html') wanted.add(m[1]);
  }
  const stagedSet = new Set(staged);
  for (const w of wanted) {
    if (!stagedSet.has(w)) fail('server.js serves /' + w + ' but it was not staged');
  }
})();

// ── Verify (a) every staged script still parses ──────────────────────────────
// Obfuscation that emitted something unparsable is the failure most worth
// catching here, before it reaches an installer. CJS/script is checked with
// `node --check`; ESM is fed back through esbuild (a full parse) because
// `node --check` on a bare .js treats it as a script and rejects import/export.
for (const { rel: r, kind } of stagedJs) {
  const p = path.join(STAGE, r);
  if (kind === ESM) {
    try { esbuild.transformSync(fs.readFileSync(p, 'utf8'), { loader: 'js', format: 'esm' }); }
    catch (e) { fail('staged module does not parse: ' + r + ' — ' + e.message.split('\n')[0]); }
  } else {
    const res = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' });
    if (res.status !== 0) fail('staged script does not parse: ' + r + ' — ' + (res.stderr || '').split('\n')[1]);
  }
}

// ── Verify (b) no staged path looks like a secret ────────────────────────────
for (const r of staged) {
  const why = forbiddenReason(r, { stage: true });
  if (why) fail('forbidden file staged (' + why + '): ' + r);
}

// ── Verify (c) no comment survived (canary) ──────────────────────────────────
// Two passes. The fixed CANARIES prove the pipeline stripped known prose; each
// is first confirmed present in its source, so a canary that silently stopped
// matching (a reworded comment) fails the build rather than passing vacuously.
// Then proseComments derives fresh canaries from every staged JS/CSS/HTML file —
// including desktop/main.js, which no fixed list would have — and confirms none
// reached the staged output.
for (const c of CANARIES) {
  const srcPath = path.join(ROOT, c.file);
  if (!fs.existsSync(srcPath)) { fail('canary source missing: ' + c.file); continue; }
  const re = phraseRegex(c.phrase);
  if (!re.test(fs.readFileSync(srcPath, 'utf8'))) {
    fail('canary no longer in source (rewrite it in leak-rules.js): "' + c.phrase + '" in ' + c.file);
    continue;
  }
  // Prose that IS a string literal (a log line) legitimately survives; only flag
  // it when the source carried it as a comment. c.phrase here is only comment prose.
  // Read back off the disk, not from what the transform returned: a file that stopped
  // being transformed at all (copied verbatim) has no transform result to look in, and
  // would pass here while shipping every comment it has.
  const stagedPath = path.join(STAGE, c.file);
  if (!fs.existsSync(stagedPath)) { fail('canary file not staged: ' + c.file); continue; }
  if (re.test(fs.readFileSync(stagedPath, 'utf8'))) fail('canary survived into staged ' + c.file + ': "' + c.phrase + '"');
}

const jsKindOf = new Map(stagedJs.map(j => [j.rel, j.kind]));
let derivedChecked = 0;
for (const r of staged) {
  const out = strippedByRel[r];
  if (out == null) continue; // verbatim copies (vendor, images, json) carry no comments
  const ext = path.extname(r).toLowerCase();
  const kind = ext === '.css' ? 'css' : ext === '.html' ? 'html' : 'js';
  const srcText = fs.readFileSync(path.join(ROOT, r), 'utf8');
  let ref;
  try { ref = commentsStripped(srcText, kind, jsKindOf.get(r)); }
  catch (e) { fail('could not build the comment reference for ' + r + ': ' + e.message.split('\n')[0]); continue; }
  for (const phrase of proseComments(srcText, ref, kind)) {
    derivedChecked++;
    if (out.includes(phrase)) fail('comment survived into staged ' + r + ': "' + phrase.slice(0, 60) + '…"');
  }
}
console.log('  canaries: ' + CANARIES.length + ' fixed + ' + derivedChecked + ' derived checked');

if (process.exitCode) {
  console.error('\nStaging FAILED — see ✗ above. dist/stage left in place for inspection.');
  process.exit(process.exitCode);
}
console.log('\nStaging OK -> ' + rel(STAGE));
