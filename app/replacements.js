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
const foldFrom = r => String(r && r.from ? r.from : '').trim().toLowerCase();

// ── Indexed keyword references ────────────────────────────────────────────
// [female][0] and [female][1] in one prompt ask for the first and the second of
// the answers ticked for [female] — both of them, in the same render — where a
// bare [female] asks for "one of them" and fans the run out over all of them.
//
// So an index is the opt-out from the multiplication rather than an addition to
// it: a keyword the text addresses by index is PINNED (see replacementGroups),
// its whole answer list rides along in every combination, and each reference
// picks its own out of it. Mixing the two forms is not a third thing — one
// [female][0] anywhere pins the keyword, and a bare [female] elsewhere then
// resolves to answer 0, because the indexed references have already committed
// the run to a particular set of answers, and re-opening a fan-out around them
// would queue N prompts differing in the one word that had just been pinned.
//
// Counting from 0, because the only reading that lets [female][0] and
// [female][1] sit side by side and name two different answers is the one where
// the first index is 0 — and a scheme where [female][1] is sometimes the first
// answer and sometimes the second is worse than either.
//
// An index with no answer behind it — [female][1] with one answer ticked — is
// left exactly where it is, and the leftover sweep at the end of
// applyReplacements deletes it along with the comma it was sitting in. That is
// deliberate rather than substituting '' here: the sweep is the only thing that
// tidies the hole a dropped item leaves, and it only runs at all when a bracket
// survives to trigger it. Blanking it here would leave the ", ," behind.
const INDEX_ONLY_RE = /^\[\d+\]$/;
// [0] is a position, not a keyword. The token scanners offer what a rule could
// be written for, and an index is already part of the token beside it.
export const isIndexToken = t => INDEX_ONLY_RE.test(String(t == null ? '' : t).trim());
// Which indices a text addresses a keyword by. Matched exactly as the rules
// match — literally and case-insensitively — so [Female][2] finds a rule
// written [female], the same way a bare [Female] would.
export function indexedUses(text, from) {
  const kw = String(from == null ? '' : from).trim();
  if (typeof text !== 'string' || !kw || text.indexOf('[') < 0) return [];
  const re = new RegExp(escRe(kw) + '\\[(\\d+)\\]', 'gi');
  const out = new Set();
  let m;
  while ((m = re.exec(text)) !== null) out.add(Number(m[1]));
  return [...out].sort((a, b) => a - b);
}

// The pattern a rule matches with, and the answer a match names. Both are
// shared by the substitution and by the preview's second walk of it, because a
// regex written out twice is a preview that quietly stops being the run.
//
// A keyword rule swallows an [n] suffix. Without it [female][1] reads as a bare
// [female] to replace followed by a stray [1] for the leftover sweep to delete
// — the wrong answer arriving as a plausible one, since the prompt still comes
// back looking replaced. Trimmed, and only for a keyword rule: the brackets are
// the whole of what it finds, so a space around them is a typo rather than part
// of it — and an untrimmed pattern would also expect that space to sit between
// the token and its index.
const ruleRe = r => new RegExp(isKeywordRule(r)
  ? escRe(String(r.from).trim()) + '(?:\\[(\\d+)\\])?'
  : escRe(r.from), 'gi');
// A keyword's answers within one rule list, in stored order — which is the
// order the indices address them in, and the order the editor lists them in.
function keywordGroups(rules) {
  const m = new Map();
  for (const r of rules) {
    if (!isKeywordRule(r)) continue;
    const k = foldFrom(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}
// Which rule a match resolves to: the n-th answer for [kw][n], the first for a
// bare [kw], and nothing at all when the index is past the end — the caller
// then leaves the token where it is for the sweep to clear.
//
// A bare token taking the first answer is also exactly what the old first-wins
// behaviour did with a list carrying several rules for one keyword, which is
// still the shape a group that cannot fire rides along in.
const pickFor = (group, n) => (group ? group[n == null ? 0 : Number(n)] : null);

// ── Variations ────────────────────────────────────────────────────────────
// Two enabled rules that find the same thing used to mean the first one won and
// the second silently did nothing: by the time it looked, the token it wanted
// had already been replaced. That is a trap — the row is ticked, it sits in the
// list, and it changes nothing — so they are variations instead. Each group
// contributes one choice to a run, and the caller queues a job per combination.

// Which rules the text in front of us can actually reach. A rule whose "find"
// is nowhere in the prompt replaces nothing, so several rules for it are not
// variations of anything: every combination produces the identical prompt, and
// the run queues N identical jobs for it. Switching to a workflow whose prompt
// carries no [keyword] at all and still getting the multiplication is the
// expensive version of that — the rules did not change, the text did.
//
// Reachability rather than a plain scan, because a rule's replacement can carry
// another rule's find: [female] → "…, [hair], …" makes [hair] live in a prompt
// that never mentioned it. So each rule that lights up adds its replacement to
// the haystack and we go round again until nothing new does.
//
// The haystack only grows — a real replacement also *removes* the text it
// matched, and this deliberately does not — because the direction to be wrong
// in is "kept a variation that changes nothing", never "dropped one that would
// have". Same reason a caller with no text to offer gets everything back live.
//
// The haystack it grew is worth keeping as well as the answer: it is every
// scrap of text this run can reach, which is also the only honest place to look
// for an indexed reference — see replacementGroups. `hay` is null when there was
// no text to judge by, which is the same "everything is live" case.
function reach(text, rules) {
  const list = rules || activeReplacements();
  const live = new Set();
  if (typeof text !== 'string') { for (const r of list) live.add(r); return { live, hay: null }; }
  let hay = text.toLowerCase();
  for (;;) {
    let grew = false;
    for (const r of list) {
      if (live.has(r)) continue;
      // Literal and case-insensitive, exactly as applyReplacements matches it.
      const from = String(r.from).trim().toLowerCase();
      if (!from || hay.indexOf(from) < 0) continue;
      live.add(r);
      hay += '\n' + String(replacementText(r)).toLowerCase();
      grew = true;
    }
    if (!grew) return { live, hay };
  }
}
export function reachableRules(text, rules) { return reach(text, rules).live; }

// `text` is what this run is going to rewrite, when the caller knows it: each
// group is flagged `live` or not, and a group that cannot fire is not a choice
// to fan out over. Callers with nothing to offer get every group live, which is
// what this did before it could tell.
//
// Grouped on the folded `from`, because that is what "the same rule" means to
// the substitution: matching is case-insensitive, so [Female] and [female] are
// one group and would otherwise both fire on the same token.
export function replacementGroups(text) {
  const groups = new Map();
  const { live, hay } = reach(text);
  for (const r of activeReplacements()) {
    const k = String(r.from).trim().toLowerCase();
    if (!groups.has(k)) groups.set(k, { key: k, label: String(r.from).trim(), rules: [] });
    groups.get(k).rules.push(r);
  }
  // One answer per group: its rules all find the same thing, so they are all
  // reachable or none of them are.
  for (const g of groups.values()) {
    g.live = g.rules.some(r => live.has(r));
    // Against the grown haystack rather than the text as given: a [hair][1]
    // living inside what [female] resolves to reaches this run as surely as one
    // the prompt said out loud, and pinning from only half of them would leave
    // the fan-out and the substitution disagreeing about the same token.
    g.indices = hay == null ? [] : indexedUses(hay, g.label);
    g.pinned = g.indices.length > 0;
    // The one question every caller is actually asking: does this group
    // multiply the run? Live, pinned and unreachable are three different
    // reasons for the answer, and each site working them out for itself is how
    // the job labels and the preview tabs end up naming different keywords.
    g.varies = g.live && !g.pinned && g.rules.length > 1;
  }
  return [...groups.values()];
}
// The keywords with something to choose between, for everything that has to
// name them: the preview's tabs, their hovers, and the label on each queued job.
export function varyingGroupKeys(text) {
  return new Set(replacementGroups(text).filter(g => g.varies).map(g => g.key));
}
// Every combination, each a complete rule list. Order inside a list is the order
// the rules were typed, not the order the grouping happened to visit them:
// applyReplacements walks a list in sequence and a free-text rule can rewrite
// what an earlier one produced, so regrouping must not quietly reorder them.
//
// Always at least one list — with no rules at all that is the empty one, which
// is exactly what a run with nothing to replace should apply.
export function replacementVariations(text) {
  let combos = [[]];
  for (const g of replacementGroups(text)) {
    const next = [];
    // A group that cannot fire still rides along in every list — the run
    // applies it and it finds nothing — it just does not multiply the run.
    // Kept rather than dropped because "cannot fire" is judged from the text
    // this surface can see, and the built graph holds text it cannot.
    //
    // A pinned group rides along whole for the opposite reason: every one of
    // its answers fires, in the same prompt, at the index that named it. It is
    // the one case where a list carrying several rules for one keyword is the
    // point rather than the trap — applyReplacements reads them as a list.
    if (!g.varies) for (const c of combos) next.push(c.concat(g.rules));
    else for (const c of combos) for (const r of g.rules) next.push(c.concat([r]));
    combos = next;
  }
  const order = new Map(replacements.map((r, i) => [r, i]));
  const at = r => (order.has(r) ? order.get(r) : 0);
  return combos.map(c => c.slice().sort((a, b) => at(a) - at(b)));
}
// How many prompts the rules multiply out to, before anything is unticked.
export function variationCount(text) {
  return replacementGroups(text).reduce((n, g) => n * (g.varies ? g.rules.length : 1), 1);
}

// ── Leaving one out ───────────────────────────────────────────────────────
// The preview's tabs are ticked by default and can be unticked, which drops that
// one prompt from the run. It is the cheap answer to what the fan-out makes easy
// to do by accident: three keywords with three answers each is 27 jobs, and it
// is usually five of them that were wanted.
//
// Keyed on what the combination *is* — each choice's find and the prompt it
// resolves to — never on where it sits in the list. The list is rebuilt from the
// rules on every read, so an index means a different prompt the moment a rule is
// added, and a tick that quietly slides onto another combination is worse than
// one that is forgotten.
//
// The choices, and nothing else. A combination carries every enabled rule, but
// most of them are in all of the combinations — the solo rules, and the ones for
// a keyword this text cannot reach — so they say nothing about which one this is.
// Keying on them anyway meant switching any unrelated rule on or off rewrote
// every key at once and the whole panel came back ticked, which is not what
// ticking one keyword's box asked for. A rule earns a place in the key by being
// picked: it appears exactly once in this list (a group riding along unreachable
// contributes all of its rules, not one) and its keyword has more than one
// enabled rule to pick from.
//
// So the keys survive everything that does not change what there is to choose
// between, and when something does — the second [hair] rule switched off, which
// really does leave two prompts where there were four — the ticks for the
// combinations that no longer exist stop matching, and come back if it is
// switched on again.
//
// Held in the module, next to the rules, because the run is what has to honour
// it and the editor is gone every time the panel is closed. A key the current
// rules cannot produce simply never matches, which is what makes a stale one
// harmless rather than something to garbage-collect.
export const variationSkips = reactive(new Set());
const ruleKey = r => foldFrom(r) + '=' + ((r && (r.promptId || r.to)) || '');
const tally = (list) => {
  const n = new Map();
  for (const r of list) n.set(foldFrom(r), (n.get(foldFrom(r)) || 0) + 1);
  return n;
};
export const variationKey = (list) => {
  const here = tally(list || []);
  const all = tally(activeReplacements());
  return (list || [])
    .filter(r => here.get(foldFrom(r)) === 1 && (all.get(foldFrom(r)) || 0) > 1)
    .map(ruleKey).join('\u0001');
};
// An empty key is a combination with nothing chosen in it — the only one there
// is. It cannot be skipped, and refusing it here means no stray '' can ever sit
// in the set matching every such combination in every workflow.
export const isVariationSkipped = list => {
  const k = variationKey(list);
  return !!k && variationSkips.has(k);
};
export function setVariationSkipped(list, skip) {
  const k = variationKey(list);
  if (!k) return;
  if (skip) variationSkips.add(k); else variationSkips.delete(k);
}
// What a run queues. Never empty: a Run button that does nothing, with every
// tab on screen saying why in a place nobody is looking, is the one outcome
// worth ruling out here as well as in the editor — which keeps the last tick
// from being cleared in the first place.
export function keptVariations(text) {
  const all = replacementVariations(text);
  const kept = all.filter(v => !isVariationSkipped(v));
  return kept.length ? kept : all;
}

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
// So: the [keyword] rules first, repeated until nothing changes, and only then
// the literal ones — once, over the text the keywords actually produced.
//
// The order is what makes a literal rule mean what it says. Run in list order
// with the keywords, "blonde -> platinum" saw the prompt as typed, and the
// prompt as typed says [female]: the word it was written for arrives later,
// carried in by the shelf, and the rule that was sitting right there in the list
// did nothing to it. Now every literal rule reads the finished text, so it
// replaces its word wherever it ends up — whether it was in the prompt or came
// out of a library entry.
//
// Only the keyword rules repeat — a free-text rule like woman -> beautiful woman
// contains its own "find" and would grow on each pass, while a keyword rule
// cannot normally reintroduce its own bracketed token. The cap is for when it
// does: two rules feeding each other stop, and the leftover sweep clears the
// tokens the cap left rather than sending brackets to the model. The keywords
// sweep once more after the literal rules for the other direction — a literal
// replacement that writes a [keyword] of its own resolves rather than being
// swept away as unclaimed.
//
// Replacements are inserted through a function, not a string, so a $ in prompt
// text stays a $ — ComfyUI's own dynamic-prompt syntax writes {2$$a|b}, and the
// string form of .replace() reads $$ and $& as instructions.
export function applyReplacements(text, only) {
  if (typeof text !== 'string') return text;
  // `only` is one variation's rule list. Without it every enabled rule runs —
  // the right answer when there is nothing to vary, and the old first-wins
  // answer when there is, which is why a run always passes one.
  const rules = only || activeReplacements();
  const keyworded = rules.filter(isKeywordRule);
  const literal = rules.filter(r => !isKeywordRule(r));
  // A keyword rule replaces both the bare token and every [kw][n] beside it,
  // out of the whole group rather than out of itself: the rule that happens to
  // run first is not the one an index names, and each of a pinned keyword's
  // answers has to be reachable from whichever of them the sweep reaches first.
  // The rules after it in the group then find nothing left to do, exactly as
  // they always have.
  const groups = keywordGroups(rules);
  let out = text;
  const apply = r => {
    if (!isKeywordRule(r)) { out = out.replace(ruleRe(r), () => replacementText(r)); return; }
    const g = groups.get(foldFrom(r)) || [r];
    // The capture group only exists on this branch, so `n` is always the index
    // and never .replace()'s offset argument creeping into its place.
    out = out.replace(ruleRe(r), (m0, n) => {
      const pick = pickFor(g, n);
      return pick ? replacementText(pick) : m0;
    });
  };
  const sweepKeywords = () => {
    for (let pass = 0; pass < 4 && keyworded.length && /[[{]/.test(out); pass++) {
      const before = out;
      for (const r of keyworded) apply(r);
      if (out === before) break;
    }
  };
  sweepKeywords();
  for (const r of literal) apply(r);
  sweepKeywords();
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

export function paintReplacements(text, only) {
  if (typeof text !== 'string') return null;
  const rules = only || activeReplacements();
  const groups = keywordGroups(rules);
  let out = text;
  let owner = new Array(text.length).fill(-1);
  // The row index, not the position in the filtered list: that is what the
  // editor colours its rows by, and an off rule in the middle would otherwise
  // shift every colour after it.
  //
  // Which rule that is depends on the match for a keyword: [female][1] is the
  // second answer's colour, sitting beside [female][0] in the first's. So the
  // colour is worked out per match, from the same pickFor the substitution uses.
  const run = (r) => {
    if (!isKeywordRule(r)) {
      const rule = replacements.indexOf(r);
      const s = paintStep(out, owner, ruleRe(r), () => ({ text: replacementText(r), rule }));
      out = s.text; owner = s.owner;
      return;
    }
    const g = groups.get(foldFrom(r)) || [r];
    const src = owner;
    const s = paintStep(out, owner, ruleRe(r), (m) => {
      const pick = pickFor(g, m[1]);
      // An index past the end leaves the token alone, so it keeps whoever put
      // it there rather than being re-attributed to the rule that declined it.
      // The leftover sweep below deletes it either way; this only decides which
      // colour the deletion is credited to.
      return pick
        ? { text: replacementText(pick), rule: replacements.indexOf(pick) }
        : { text: m[0], rule: src[m.index] == null ? -1 : src[m.index] };
    });
    out = s.text; owner = s.owner;
  };
  // The same two phases as applyReplacements, in the same order. This walk is
  // checked against that one at the end, so a divergence here does not paint
  // the wrong thing — it drops the colours entirely.
  const keyworded = rules.filter(isKeywordRule);
  const literal = rules.filter(r => !isKeywordRule(r));
  const sweepKeywords = () => {
    for (let pass = 0; pass < 4 && keyworded.length && /[[{]/.test(out); pass++) {
      const before = out;
      for (const r of keyworded) run(r);
      if (out === before) break;
    }
  };
  sweepKeywords();
  for (const r of literal) run(r);
  sweepKeywords();
  if (out.indexOf('[') >= 0) {
    for (const [re, rep] of STRIP_STEPS) {
      // Whatever these steps put back is whitespace standing in for what they
      // removed, so it belongs to whoever owned the start of the match.
      const src = owner;
      const s = paintStep(out, owner, re, m => ({ text: rep, rule: src[m.index] == null ? -1 : src[m.index] }));
      out = s.text; owner = s.owner;
    }
  }
  if (out !== applyReplacements(text, only)) return null;
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
// Exported because the form asks the same question of its own fields when it
// works out which rules a run can even reach — the two must agree, or a rule
// counted as live here would be skipped there and multiply the queue for
// nothing.
export const SKIP_KEY = /_name$|name$|filename|ckpt|lora|vae|sampler|scheduler|model|path|url|format|extension|seed|width|height|steps|cfg/i;
export function applyReplacementsToNodes(prompt, only) {
  if (!(only || activeReplacements()).length) return prompt;
  for (const node of Object.values(prompt || {})) {
    if (!node || !node.inputs) continue;
    for (const key of Object.keys(node.inputs)) {
      if (typeof node.inputs[key] !== 'string' || SKIP_KEY.test(key)) continue;
      node.inputs[key] = applyReplacements(node.inputs[key], only);
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
