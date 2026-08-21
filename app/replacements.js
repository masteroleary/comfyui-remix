// ── Prompt replacements ────────────────────────────────────────────────────
// Global find→replace rules, applied to the built graph right before each run.
// Module state on purpose: the dialog, the inspect page and the rules editor all
// work on these same rows, and the run engine reads them at launch. Two copies
// used to mean a rule typed on one surface did nothing to a run started from it.
//
// Storage is /api/replacements, mirrored into localStorage so the list paints
// before the round trip. The server's copy wins once it answers — it is the one
// shared across devices.
import { api } from './api.js';
import { promptTextById } from './prompts.js';

const { reactive, computed } = window.Vue;

export const replacements = reactive([]);

const plain = () => replacements.map(r => ({ from: r.from, to: r.to, on: !!r.on, promptId: r.promptId || '' }));

export function saveReplacements() {
  try { localStorage.setItem('archiveReplacements', JSON.stringify(plain())); } catch (e) {}
  return api.saveReplacements(plain()).catch(() => {});
}

// Only rules with something to find are worth running; an empty `from` would
// match everywhere.
export function activeReplacements() {
  return replacements.filter(r => r.on && r.from && String(r.from).trim());
}
export const replActiveCount = computed(() => activeReplacements().length);
export const replAllOn = computed(() => replacements.length > 0 && replacements.every(r => r.on));

const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// What a rule substitutes. A [keyword] rule stores the picked prompt as an id,
// so editing that prompt updates every rule using it; `to` is the snapshot taken
// at pick time and the fallback when the prompt has since been deleted.
export const replacementText = r => {
  const live = r && r.promptId ? promptTextById(r.promptId) : '';
  return live || (r && r.to) || '';
};
// A [keyword] nobody has an enabled rule for is dropped rather than sent to the
// model, which would otherwise render the literal word inside the brackets. The
// rules run first, so this only ever sees what none of them claimed.
//
// Square brackets, not braces: braces are ComfyUI's own dynamic-prompt syntax
// ({a|b}, {2$$x|y}) and a keyword scheme has no business colliding with it.
// Brackets are not entirely free either — A1111-style prompt editing writes
// [from:to:step] and [a|b] — so a token carrying | or : is left alone too.
const LEFTOVER_TOKEN = /\[[^[\]|:]*\]/g;
// Dropping the token, then tidying the hole it left: a prompt is a comma-
// separated list, and a removed item otherwise shows as ", ," or a comma
// hanging off either end.
//
// A table rather than a chain of .replace() calls because paintReplacements
// below has to walk the very same steps in the very same order to keep track of
// where each surviving character came from. Two copies of this list would be
// two chances for the preview to quietly disagree with the run.
const STRIP_STEPS = [
  [LEFTOVER_TOKEN, ''],
  [/[ \t]{2,}/g, ' '],
  [/\(\s*\)/g, ''],
  [/,[ \t]*(?=,)/g, ''],
  [/^[\s,]+/, ''],
  [/[\s,]+$/, ''],
  [/[ \t]+\n/g, '\n'],
];
export function stripLeftoverTokens(text) {
  if (typeof text !== 'string' || text.indexOf('[') < 0) return text;
  let out = text;
  for (const [re, rep] of STRIP_STEPS) out = out.replace(re, rep);
  return out;
}

// A library prompt may itself contain [keyword]s — [female] resolving to
// "…with [hair] and…, [outfit]" is what having shelves is for — so one sweep of
// the rules is not enough. A single pass resolves a nested keyword only when its
// rule happens to sit later in the list than the rule that introduced it, and
// the list is in the order the rules were typed: nothing a rule author can see,
// and nothing the editor lets them change. Worse, the leftover sweep then
// deletes what did not resolve, so the run comes back subtly wrong rather than
// visibly broken.
//
// So: every rule once, then the [keyword] rules again until nothing changes.
// Only the keyword rules repeat — a free-text rule like woman -> beautiful woman
// contains its own "find" and would grow on each pass, while a keyword rule
// cannot normally reintroduce its own bracketed token. The cap is for when it
// does: two rules feeding each other stop, and the leftover sweep clears the
// tokens the cap left rather than sending brackets to the model.
//
// Replacements are inserted through a function, not a string, so a $ in prompt
// text stays a $ — ComfyUI's own dynamic-prompt syntax writes {2$$a|b}, and the
// string form of .replace() reads $$ and $& as instructions.
export function applyReplacements(text) {
  if (typeof text !== 'string') return text;
  const rules = activeReplacements();
  let out = text;
  for (const r of rules) out = out.replace(new RegExp(escRe(r.from), 'gi'), () => replacementText(r));
  const keyworded = rules.filter(isKeywordRule);
  for (let pass = 0; pass < 4 && keyworded.length && /[[{]/.test(out); pass++) {
    const before = out;
    for (const r of keyworded) out = out.replace(new RegExp(escRe(r.from), 'gi'), () => replacementText(r));
    if (out === before) break;
  }
  return stripLeftoverTokens(out);
}

// ── The same substitution, with every character's source kept ─────────────
// For the preview only: which rule put each character there, so the editor can
// colour what a run is going to change. It walks the pipeline again rather than
// diffing the before against the after — a diff cannot say which of two rules
// produced a given stretch of text, and [female] resolving next to [male] is
// exactly when that is the question being asked.
//
// A second implementation of applyReplacements is the thing this module exists
// to prevent, so this one checks itself: what it painted is compared against
// what applyReplacements actually returned, and any disagreement returns null.
// The preview then falls back to the plain string — an uncoloured preview is a
// small loss, a coloured one that does not match the run is a trap.
//
// Returns [{ text, rule }] where rule indexes `replacements`, or -1 for the
// prompt's own words.

// One step of a replace, carrying an owner-per-character array along with the
// text. Non-global regexes stop after one match, exactly as .replace() does.
function paintStep(text, owner, re, replFor) {
  let out = '';
  const own = [];
  const carry = (a, b) => { for (let i = a; i < b; i++) own.push(owner[i]); };
  let last = 0, m;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) { out += text.slice(last, m.index); carry(last, m.index); }
    const rep = replFor(m);
    out += rep.text;
    for (let i = 0; i < rep.text.length; i++) own.push(rep.rule);
    last = m.index + m[0].length;
    if (!re.global) break;
    if (m[0] === '') re.lastIndex++;      // a zero-length match would spin here forever
  }
  if (last < text.length) { out += text.slice(last); carry(last, text.length); }
  return { text: out, owner: own };
}

export function paintReplacements(text) {
  if (typeof text !== 'string') return null;
  const rules = activeReplacements();
  let out = text;
  let owner = new Array(text.length).fill(-1);
  // The row index, not the position in the filtered list: that is what the
  // editor colours its rows by, and an off rule in the middle would otherwise
  // shift every colour after it.
  const run = (r) => {
    const rule = replacements.indexOf(r);
    const s = paintStep(out, owner, new RegExp(escRe(r.from), 'gi'), () => ({ text: replacementText(r), rule }));
    out = s.text; owner = s.owner;
  };
  for (const r of rules) run(r);
  const keyworded = rules.filter(isKeywordRule);
  for (let pass = 0; pass < 4 && keyworded.length && /[[{]/.test(out); pass++) {
    const before = out;
    for (const r of keyworded) run(r);
    if (out === before) break;
  }
  if (out.indexOf('[') >= 0) {
    for (const [re, rep] of STRIP_STEPS) {
      // Whatever these steps put back is whitespace standing in for what they
      // removed, so it belongs to whoever owned the start of the match.
      const src = owner;
      const s = paintStep(out, owner, re, m => ({ text: rep, rule: src[m.index] == null ? -1 : src[m.index] }));
      out = s.text; owner = s.owner;
    }
  }
  if (out !== applyReplacements(text)) return null;
  const spans = [];
  for (let i = 0; i < out.length; i++) {
    const o = owner[i] == null ? -1 : owner[i];
    const tail = spans[spans.length - 1];
    if (tail && tail.rule === o) tail.text += out[i];
    else spans.push({ rule: o, text: out[i] });
  }
  return spans;
}

// For a built graph: rewrite prompt-ish string inputs only. Model, sampler,
// filename and numeric-ish keys are skipped — a rule meant for prose would
// otherwise rename a checkpoint.
const SKIP_KEY = /_name$|name$|filename|ckpt|lora|vae|sampler|scheduler|model|path|url|format|extension|seed|width|height|steps|cfg/i;
export function applyReplacementsToNodes(prompt) {
  if (!activeReplacements().length) return prompt;
  for (const node of Object.values(prompt || {})) {
    if (!node || !node.inputs) continue;
    for (const key of Object.keys(node.inputs)) {
      if (typeof node.inputs[key] !== 'string' || SKIP_KEY.test(key)) continue;
      node.inputs[key] = applyReplacements(node.inputs[key]);
    }
  }
  return prompt;
}

// A rule written as [keyword] takes its replacement from the prompt library
// rather than free text. The brackets are part of what the graph says, so they
// stay in `from` and are matched literally like any other rule. Anything with a
// | or a : in it is prompt-editing syntax, not a keyword.
//
// {keyword} is recognised too, for rules written before the syntax moved to
// brackets: those still replace, and still get the library picker. What they do
// NOT get is the sweep above — an unclaimed {token} is left where it is, because
// braces belong to ComfyUI's dynamic prompts and this cannot tell the two apart.
export const KEYWORD_RE = /^\s*[[{][^[\]{}|:]+[\]}]\s*$/;
export const isKeywordRule = r => KEYWORD_RE.test(r && r.from ? r.from : '');
// The word inside the brackets — what the rule is asking the library for.
export const keywordOf = r => {
  const s = r && r.from ? String(r.from).trim() : '';
  return KEYWORD_RE.test(s) ? s.slice(1, -1).trim() : '';
};

// localStorage first so the editor is never empty for a beat, then the server.
// A server with nothing and a local list that has something means this browser
// is the one holding the truth — push it up rather than wiping it.
//
// That push is the only place this module writes without being asked to, which
// makes it the one place worth being strict about. An answer we could not read
// is NOT an empty list: those two used to collapse into the same `[]`, so a 200
// carrying a truncated or non-JSON body — a server restarting mid-response is
// enough — read as "the server has no rules" and this browser's cached copy was
// posted over whatever the server actually held. Every other failure throws out
// of req() and lands in the catch, which correctly changes nothing; only this
// shape came back looking like data. So the list has to arrive as an array
// before any of it is believed, and "no answer" now leaves both copies alone.
let loaded = null;
export function loadReplacements() {
  if (loaded) return loaded;
  try {
    const cached = JSON.parse(localStorage.getItem('archiveReplacements') || '[]');
    if (Array.isArray(cached)) replacements.push(...cached);
  } catch (e) {}
  loaded = api.replacements().then(d => {
    if (!d || !Array.isArray(d.replacements)) return;   // nothing learned; change nothing
    const server = d.replacements;
    if (!server.length && replacements.length) { saveReplacements(); return; }
    replacements.splice(0, replacements.length, ...server);
    try { localStorage.setItem('archiveReplacements', JSON.stringify(plain())); } catch (e) {}
  }).catch(() => {});
  return loaded;
}
