'use strict';
// ── afterPack: check what was actually packaged ───────────────────────────
// desktop/build.js checks the stage. This checks the app.asar electron-builder
// made out of it, because the claim that matters is about the archive a user
// installs, and two things stand between the stage and it: electron-builder's own
// idea of what to add (its `files` handling, the production node_modules), and
// whatever a future config change does to either. It fails the build — no
// installer is written — if the archive holds anything outside the expected
// shape, anything that looks like a secret, or a readable copy of the source.
//
// Strictly read-only. On Windows the asar integrity hash has already been
// embedded in the exe when this runs, so changing a single byte of app.asar here
// would produce an installer that refuses to start.
const fs = require('fs');
const path = require('path');
const { forbiddenReason, CANARIES, phraseRegex } = require('./leak-rules.js');

const ROOT = path.join(__dirname, '..');

// The packaged app, by shape. Mirrors build.js's allowlist rather than importing
// it: this is the second opinion, and a second opinion that reads the first one's
// list agrees with it by construction.
const ALLOWED = [
  /^package\.json$/,
  /^desktop\/main\.js$/,
  /^server\.js$/,
  /^field-config-runtime\.js$/,
  /^docs\/field-config\/gen_field_config\.js$/,
  /^(index\.html|common\.css|app\.css|ui-guards\.js|logo-home\.webp|favicon\.ico|favicon\.svg|apple-touch-icon\.png|seed\.json)$/,
  /^default-workflows\/[^/]+\.json$/,
  /^app\/(?:[a-z0-9._-]+\/)?[a-z0-9._-]+\.(?:js|css)$/i,
  /^vendor\/[a-z0-9._-]+\.js$/i,
];

// The production dependency closure, from the lockfile: exactly what `npm ci
// --omit=dev` would install. Anything else under node_modules in the archive is a
// devDependency that leaked in — electron-builder, the obfuscator, esbuild.
function prodPackages() {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const names = new Set();
  for (const [k, v] of Object.entries(lock.packages || {})) {
    if (!k.startsWith('node_modules/') || v.dev) continue;
    names.add(k.slice('node_modules/'.length));
  }
  return names;
}

function asarPath(context) {
  const { appOutDir, electronPlatformName, packager } = context;
  if (electronPlatformName === 'darwin' || electronPlatformName === 'mas') {
    return path.join(appOutDir, packager.appInfo.productFilename + '.app', 'Contents', 'Resources', 'app.asar');
  }
  return path.join(appOutDir, 'resources', 'app.asar');
}

module.exports = async function verifyPackage(context) {
  const asar = await import('@electron/asar');
  const archive = asarPath(context);
  if (!fs.existsSync(archive)) throw new Error('[verify-package] no app.asar at ' + archive);

  const problems = [];
  const prod = prodPackages();
  const entries = asar.listPackage(archive, { isPack: false })
    .map(e => e.replace(/\\/g, '/').replace(/^\//, ''));
  // listPackage answers with the platform's separator but statFile/extractFile only
  // resolve one, so everything is kept posix for matching and converted back to ask.
  const native = e => e.split('/').join(path.sep);
  const files = entries.filter(e => !asar.statFile(archive, native(e)).files);

  for (const e of files) {
    if (e.startsWith('node_modules/')) {
      // node_modules/<name>/... or node_modules/@scope/<name>/..., nested ones too.
      const parts = e.split('/');
      const name = parts[1].startsWith('@') ? parts[1] + '/' + parts[2] : parts[1];
      if (!prod.has(name)) problems.push('non-production package in the archive: ' + e);
      const why = forbiddenReason(e, { inDeps: true });
      if (why) problems.push('forbidden in a dependency (' + why + '): ' + e);
      continue;
    }
    if (!ALLOWED.some(re => re.test(e))) problems.push('unexpected file in the archive: ' + e);
    const why = forbiddenReason(e);
    if (why) problems.push('forbidden in the archive (' + why + '): ' + e);
  }

  // A readable copy of the source would carry its comments. The same canaries
  // build.js proved present in the sources must be absent here.
  for (const c of CANARIES) {
    const inAsar = c.file.replace(/\\/g, '/');
    if (!files.includes(inAsar)) { problems.push('canary file missing from the archive: ' + inAsar); continue; }
    const text = asar.extractFile(archive, native(inAsar)).toString('utf8');
    if (phraseRegex(c.phrase).test(text)) problems.push('readable source in the archive: ' + inAsar + ' still says "' + c.phrase + '"');
  }

  // Anything unpacked sits beside the archive in the clear and outside the
  // integrity check. Nothing is configured to unpack, so nothing should be there.
  const unpacked = archive + '.unpacked';
  if (fs.existsSync(unpacked) && fs.readdirSync(unpacked).length) {
    problems.push('files were unpacked beside the archive: ' + unpacked);
  }

  if (problems.length) {
    for (const p of problems) console.error('  ✗ ' + p);
    throw new Error('[verify-package] ' + problems.length + ' problem(s) in ' + archive + ' — installer not written');
  }
  const bytes = fs.statSync(archive).size;
  console.log('  • verify-package: ' + files.length + ' files checked in app.asar (' + (bytes / 1048576).toFixed(1)
    + ' MB, ' + context.electronPlatformName + '), ' + CANARIES.length + ' canaries absent');
};
