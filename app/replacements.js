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
export function stripLeftoverTokens(text) {
  if (typeof text !== 'string' || text.indexOf('[') < 0) return text;
  return text.replace(LEFTOVER_TOKEN, '')
    // Tidy the hole the token left: a prompt is a comma-separated list, and a
    // dropped item otherwise shows as ", ," or a comma hanging off either end.
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\(\s*\)/g, '')
    .replace(/,[ \t]*(?=,)/g, '')
    .replace(/^[\s,]+/, '')
    .replace(/[\s,]+$/, '')
    .replace(/[ \t]+\n/g, '\n');
}

export function applyReplacements(text) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const r of activeReplacements()) out = out.replace(new RegExp(escRe(r.from), 'gi'), replacementText(r));
  return stripLeftoverTokens(out);
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

// localStorage first so the editor is never empty for a beat, then the server.
// A server with nothing and a local list that has something means this browser
// is the one holding the truth — push it up rather than wiping it.
let loaded = null;
export function loadReplacements() {
  if (loaded) return loaded;
  try {
    const cached = JSON.parse(localStorage.getItem('archiveReplacements') || '[]');
    if (Array.isArray(cached)) replacements.push(...cached);
  } catch (e) {}
  loaded = api.replacements().then(d => {
    const server = Array.isArray(d && d.replacements) ? d.replacements : [];
    if (!server.length && replacements.length) { saveReplacements(); return; }
    replacements.splice(0, replacements.length, ...server);
    try { localStorage.setItem('archiveReplacements', JSON.stringify(plain())); } catch (e) {}
  }).catch(() => {});
  return loaded;
}
