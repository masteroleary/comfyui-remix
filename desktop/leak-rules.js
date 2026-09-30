'use strict';
// ── What the desktop package must never carry ─────────────────────────────
// One list, read by both checks: desktop/build.js runs it over dist/stage, and
// desktop/verify-package.js runs it again over the app.asar electron-builder
// actually produced. Two copies of this list is how one of them would stop
// being true — the stage passing a pattern the package check had never heard
// of, or the other way round — so neither file keeps its own.
//
// Paths are compared as posix, relative to the app root ("app/main.js", not
// "D:\\...\\app\\main.js"), since that is the shape both a staged path and an
// asar entry reduce to.

// Everything here names something that exists in a real install and must stay
// on that machine: the live config holds API keys and the password hashes,
// certs/ holds the TLS and client-CA private keys, and the app-*.json stores
// hold private prompts. A clean CI checkout has none of them, but a local build
// from a working tree does, which is why the stage is an allowlist in the first
// place and why this list is checked anyway.
//
// `deps` marks the rules that still apply inside node_modules. A README or a
// scripts/ folder is normal in a dependency; key material, an app config or a
// backup copy is not, whoever shipped it.
const FORBIDDEN = [
  { re: /(^|\/)config\.[^/]*$/i, why: 'a config file (API keys, password hashes)', deps: true },
  { re: /(^|\/)certs(\/|$)/i, why: 'the certs folder (private keys)', deps: true },
  { re: /\.(pem|key|p12|pfx|crt)$/i, why: 'key or certificate material', deps: true },
  { re: /(^|\/)scripts(\/|$)/i, why: 'machine-specific scripts' },
  { re: /(^|\/)CLAUDE[^/]*\.md$/i, why: 'the project runbook' },
  { re: /(^|\/)\.claude(\/|$)/i, why: 'Claude Code project config', deps: true },
  { re: /(^|\/)app-[^/]*\.json$/i, why: 'app state (prompts, rules, workflows, index)', deps: true },
  { re: /(^|\/)Media(\/|$)/, why: 'the media library' },
  { re: /\.bak/i, why: 'a backup copy', deps: true },
  { re: /\.md$/i, why: 'documentation' },
  { re: /(^|\/)debug-results\.json$/i, why: 'debug output', deps: true },
  { re: /(^|\/)\.git/i, why: 'git metadata', deps: true },
  // Staged sources only: the package is *meant* to carry node_modules (the
  // production dependencies electron-builder adds itself), and verify-package
  // checks those against the lockfile instead.
  { re: /(^|\/)node_modules(\/|$)/, why: 'node_modules in the stage', stageOnly: true },
];

function forbiddenReason(rel, { inDeps = false, stage = false } = {}) {
  for (const r of FORBIDDEN) {
    if (r.stageOnly && !stage) continue;
    if (inDeps && !r.deps) continue;
    if (r.re.test(rel)) return r.why;
  }
  return null;
}

// ── Canaries ──────────────────────────────────────────────────────────────
// Phrases that occur only inside comments of the sources named beside them. If
// one reaches a packaged file, a comment survived — which means the minifier
// was skipped for that file and the rest of it is sitting there readable too.
// build.js refuses to run with a canary its source no longer contains: a canary
// that cannot fire is a check that always passes.
//
// Chosen from prose, never from anything that could also be a string literal,
// or the check would trip on every build for the wrong reason.
const CANARIES = [
  { file: 'server.js', phrase: 'A prefix match is not containment' },
  { file: 'server.js', phrase: 'Same-origin guard for state-changing requests' },
  { file: 'app/main.js', phrase: 'where a legacy helper is still needed' },
  { file: 'app/main.js', phrase: 'Vue and Vue Router are the vendored UMD builds' },
  { file: 'app/components/RemixDialog.js', phrase: 'hand-pushed reactive' },
  { file: 'app/views/JobsView.js', phrase: 'the leader-elected socket' },
  { file: 'field-config-runtime.js', phrase: 'Pure logic + injected deps' },
  { file: 'docs/field-config/gen_field_config.js', phrase: 'Known graph widget layouts' },
  { file: 'ui-guards.js', phrase: 'Backdrop clicks must START on the backdrop' },
  { file: 'index.html', phrase: 'The whole app. One root, one router' },
  { file: 'desktop/main.js', phrase: 'One question asked in four places' },
  { file: 'app.css', phrase: 'for the routes the toolbar doesn' },
];

// Matched on the words rather than the exact spacing, so a phrase that wraps
// onto the next comment line ("legacy\n// helper") still counts as present in
// its source, and reflowing that comment does not quietly switch the canary off.
function phraseRegex(phrase) {
  const words = phrase.split(/\s+/).filter(Boolean)
    .map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(words.join('[\\s/*]+'));
}

// Per-file canaries, drawn from the file itself rather than from a list: the
// longest lines of prose in its comments that do not also appear in its
// comment-stripped form (`stripped` — the minifier's output, which keeps every
// string literal verbatim). That second condition is what makes it safe to pick
// them automatically: a comment that repeats a string (a usage line, a log
// message) is still in the stripped text and is passed over. Covers files no
// fixed list knows about yet — desktop/main.js among them.
function proseComments(source, stripped, kind, max = 3) {
  const lines = [];
  const add = t => {
    t = t.replace(/\s+/g, ' ').trim();
    if (t.length >= 32 && t.split(' ').length >= 6 && !stripped.includes(t)) lines.push(t);
  };
  const blockLines = body => { for (const l of body.split(/\r?\n/)) add(l.replace(/^[ \t]*\*?/, '')); };
  if (kind === 'js') {
    for (const m of source.matchAll(/^[ \t]*\/\/+[ \t]?(.*)$/gm)) add(m[1]);
    // Block comments only where they open a line: mid-line, "/*" is as likely
    // to be a glob inside a string ('**/*.json') as the start of a comment.
    for (const m of source.matchAll(/^[ \t]*\/\*([\s\S]*?)\*\//gm)) blockLines(m[1]);
  } else if (kind === 'css') {
    for (const m of source.matchAll(/\/\*([\s\S]*?)\*\//g)) blockLines(m[1]);
  } else if (kind === 'html') {
    for (const m of source.matchAll(/<!--([\s\S]*?)-->/g)) for (const l of m[1].split(/\r?\n/)) add(l);
  }
  return [...new Set(lines)].sort((a, b) => b.length - a.length).slice(0, max);
}

module.exports = { FORBIDDEN, forbiddenReason, CANARIES, phraseRegex, proseComments };
