// ── Replacement rules ──────────────────────────────────────────────────────
// The editor for the global find→replace rules. One component, mounted by the
// inspect page and by the Remix dialog, over the one shared list — the rules
// themselves live in app/replacements.js and the run engine reads them there.
//
// A rule whose "find" is written as [keyword] is the reason the prompt library
// exists: its replacement stops being free text and becomes a pick from the
// library — and only from the part of it the keyword names, since [female] is a
// question and every prompt on file is not an answer to it. [female] → Blonde
// Elf, [scene] → Forest. The pick is stored as the prompt's id, so editing that
// prompt updates every rule using it; the resolved text is written alongside so
// an older build (and the server's own copy) still has something literal to
// substitute.
//
// ── A row is a keyword, not a rule ────────────────────────────────────────
// The stored list is unchanged: one rule per keyword-and-value pair, which is
// what makes several answers to one keyword the variations a run fans out over.
// What changed is the editor above it. Four rules for [scene] used to be four
// rows saying "[scene]" four times, with a 2/4 tag on each to explain why —
// a column of the same word, and the reason it was there taking a whole row to
// say. They are one row now, and its value control is a menu of tick boxes:
// the keyword is stated once, and the answers to it are a list where a list
// belongs. Ticking one adds the rule, unticking removes it, so the list on disk
// and the run reading it never learn that the editor changed shape.
//
// The colour follows the row for the same reason. It used to be per rule, so
// one keyword's four answers were four colours and its dot could only show one
// of them; now [scene] is one colour wherever its text lands, in every tab,
// beside the one row that put it there.
import {
  replacements, saveReplacements, replAllOn, isKeywordRule, keywordOf,
} from '../replacements.js';
import { applyReplacements, paintReplacements, replacementGroups, replacementVariations,
  reachableRules, replacementText, isVariationSkipped, setVariationSkipped,
  varyingPickKeys, pickKeyOf, isCompositeRule, isIndexToken } from '../replacements.js';
import { promptLib, loadPrompts, promptsMatching, savePrompts, newPromptId } from '../prompts.js';
import { showToast } from '../store.js';

const { computed, ref, onMounted, onBeforeUnmount, watch } = window.Vue;

// ── Capturing a variation ─────────────────────────────────────────────────
// A tab is one fully resolved prompt, and saving it turns that paragraph into a
// token of its own: [prompt1], filed in the library and given a rule that
// substitutes it. Which is what lets two of them stand side by side —
// "[prompt1] sits across from [prompt2]" — where the keywords underneath cannot,
// because [female] resolving twice in one prompt resolves to the same answer
// both times and the shelves it pulls in behind it resolve once for the pair.
//
// Frozen is the point, but not by copying: the rule carries the library entry's
// id like any [keyword] rule, so the capture stays editable on the Prompts page
// and every use of it follows. What makes it stable is that it is a single
// answer to a keyword nothing else names — it cannot fan out, and it cannot pick
// differently on the next run.
const CAPTURE_CATEGORY = 'Captured';
// The number out of a captured LIBRARY ENTRY name, which has no brackets.
// Whether a RULE is a capture is isCompositeRule and nothing else: this used
// to be a second regex with the brackets optional, so a free-text rule whose
// find was the bare word "prompt1" masked the whole list while never being
// joined as a composite — the writer of the name and the reader of it
// governed by different patterns.
const CAPTURE_NUM_RE = /^\[?prompt(\d+)\]?$/i;

// What the panel is, on the ⓘ beside its title rather than in a paragraph at
// the top of the body. It is four sentences that do not change, sitting above
// the rows they describe and pushing the first one down every time the panel is
// opened — read once, then in the way. On the title so it is reachable with the
// panel shut, which is when "what is this" is actually being asked.
//
// Broken into lines here rather than left as one run: a title attribute wraps
// where the browser decides, and this is long enough for that to come out as a
// wall. Plain text, so no <code> — a tooltip renders none of it.
const HELP = [
  'Applied to the prompt right before each run (case-insensitive, all matches).',
  'Shared by the dialog and the inspect page.',
  '',
  'Write the find as [keyword] to replace it with prompts from the library —',
  'tick as many answers as you like, and a run queues a job for each.',
  '',
  'Write [keyword][0] and [keyword][1] in the prompt instead to put two of those',
  'answers in the same prompt: a keyword addressed by index stops multiplying the',
  'run, and each reference takes the answer at that number below.',
  '',
  'Anything left in brackets that no enabled rule claims is dropped before the run.',
].join('\n');

// What auto-add will take from a file it did not write. The text it scans is
// whatever the open file's fields hold, so these are the bounds on a prompt
// arriving from somewhere else: a token longer than a keyword plausibly is,
// and a run of them longer than anyone typed on purpose.
const MAX_AUTO_TOKEN = 40;
const MAX_AUTO_ADD = 8;
// Long enough that a burst of typing lands as one repaint, short enough that
// the preview still reads as a response to the edit rather than a reload.
const PREVIEW_DEBOUNCE_MS = 200;
// The scope arrives in more than one piece while a form loads, so auto-add
// waits for it to settle rather than firing per field.
const AUTO_ADD_DEBOUNCE_MS = 400;

// The keywords a prompt actually carries. Brackets only, and never braces:
// {a|b} is ComfyUI's own dynamic-prompt syntax and this cannot tell one from a
// keyword. A token holding | or : is A1111 prompt editing ([from:to:step]) and
// is left alone for the same reason — the same exclusions applyReplacements
// makes when it sweeps up what no rule claimed.
const PROMPT_TOKEN = /\[[^[\]|:]+\]/g;
const foldTok = s => String(s == null ? '' : s).trim().toLowerCase();
const oneLine = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

// One colour per row, cycled. Picked to stay legible on the preview's near
// black and, more to the point, to stay apart from each other: the job is
// telling two neighbouring replacements apart at a glance, so adjacent entries
// are from different parts of the wheel rather than sorted into a gradient.
// The same colour marks the row itself, or a colour in the preview would be a
// colour with nothing to trace it back to.
const RULE_COLORS = [
  '#64d2ff', '#a8e06c', '#ffcf6b', '#ff8f8f', '#d0a2f7',
  '#7ee0c0', '#ffb340', '#8fb8ff', '#e0b86c', '#ff9ecb',
];
const ruleColor = i => RULE_COLORS[((i % RULE_COLORS.length) + RULE_COLORS.length) % RULE_COLORS.length];

export default {
  name: 'ReplacementRules',
  props: {
    // The prompt as it stands in the form. Given, not injected: this is mounted
    // by the host, beside the form rather than inside it, so its component
    // parent is the host rather than the form that owns the field.
    prompt: { type: String, default: '' },
    // Every text field the run will rewrite, not just the one being previewed —
    // `replaceableText(cfg.fields)` in both hosts, which is the exact text the
    // run judges by.
    //
    // These have to be the same question or the tabs stop being the run. A
    // keyword living only in a negative prompt is reachable at run time and not
    // from `prompt`, so the panel showed two tabs where the run queued four, and
    // — worse — a tick set on one of those two named a combination the run never
    // builds, so unticking it silently changed nothing. Empty falls back to
    // `prompt`, which is what a host that does not know any better gets.
    scope: { type: String, default: '' },
    // Whether the tab this panel sits on is the one showing. Both hosts keep
    // every tab mounted (v-show), so there is no mount to hang "arriving here"
    // on — and the auto-add below needs exactly that moment. Defaults true so a
    // host that never passes it still gets the feature, just without the gate.
    //
    // Not "active": activeRows and activeReplacements both already mean
    // "switched on and able to fire", which is a different question entirely.
    visible: { type: Boolean, default: true },
  },
  setup(props) {
    // The library is only needed once a [keyword] rule exists, but it is two
    // fields and a fetch — cheaper to have it than to decide when to ask.
    onMounted(() => loadPrompts());

    // What the run can reach, for everything that has to agree with the run: how
    // many prompts there are, which keywords vary between them, what each tab is
    // named. The paragraph below stays on `prompt` — it is the prompt field
    // being previewed, not the whole form.
    const scopeText = computed(() => props.scope || props.prompt || '');
    // Everything the run has decided about each keyword, worked out once: what
    // is live, what is pinned by an index, what is left to fan out over. Every
    // count and colour below reads it from here rather than asking again, which
    // is what keeps the summary, the rows and the tabs describing one run.
    //
    // Empty while the scope is blank — a form that has not loaded is not a
    // prompt with nothing in it, so nothing is pinned and nothing is ignored
    // until there is text to judge against.
    const groupInfo = computed(() => {
      const m = new Map();
      if (!scopeText.value.trim()) return m;
      for (const g of replacementGroups(scopeText.value)) m.set(g.key, g);
      return m;
    });

    // ── Rows ────────────────────────────────────────────────────────────
    // One row per keyword, one row per free-text rule. Free-text rules are not
    // grouped: two of them finding the same word are still variations of each
    // other, but their answers are typed rather than picked, and a single text
    // box cannot hold two of them. A keyword's answers can be a list, so they
    // are.
    //
    // The id is the first rule's place in the stored list, and it is what v-for
    // keys on. Not the keyword: that changes on every keystroke in the find box,
    // and a key that changes mid-edit tears the input out from under the cursor.
    const groupsOf = () => {
      const seen = new Map();
      const out = [];
      replacements.forEach((r, i) => {
        const kw = isKeywordRule(r);
        const k = kw ? 'k:' + foldTok(r.from) : 'f:' + i;
        if (seen.has(k)) { seen.get(k).rules.push(r); return; }
        const row = { id: String(i), key: k, keyword: kw, first: i, rules: [r] };
        seen.set(k, row);
        out.push(row);
      });
      return out;
    };
    // Each answer carries its position in the row, because that position is
    // what [keyword][n] addresses — the stored order, which is the order the
    // rules were added and the order a run applies them in. The value menu
    // lists the library's order instead, so without the number beside each tick
    // there would be nowhere at all to read which answer is which index.
    const rowsRaw = computed(() => groupsOf().map(row => {
      const r0 = row.rules[0];
      const picked = row.rules.map((rule, n) => ({ rule, n })).filter(p => p.rule.promptId).map(p => ({
        rule: p.rule, n: p.n, id: p.rule.promptId,
        name: promptName(p.rule.promptId) || oneLine(p.rule.to) || '(missing)',
      }));
      // What the prompt asks this keyword for by index. A row nothing addresses
      // that way is left exactly as it was: bare [keyword], one answer per job.
      const g = row.keyword ? groupInfo.value.get(foldTok(r0.from)) : null;
      const indices = (g && g.indices) || [];
      const answers = row.rules.length;
      // A [promptN] row builds one figure out of its answers instead of
      // choosing between them, so almost everything the row displays reads
      // differently: the count is parts rather than jobs, and the number worth
      // showing is how many versions of the figure there are.
      const composite = isCompositeRule(r0);
      const shelves = composite ? new Set(row.rules.map(pickKeyOf)).size : 0;
      return Object.assign(row, {
        composite, shelves,
        factor: (g && g.factor) || 1,
        from: String(r0.from == null ? '' : r0.from),
        on: row.rules.every(r => r.on),
        picked,
        pickedIds: new Set(picked.map(p => p.id)),
        pickedAt: new Map(picked.map(p => [p.id, p.n])),
        indices,
        pinned: indices.length > 0,
        // The two ways the prompt and the tick list can disagree, and both are
        // silent without this: an index with no answer behind it renders as
        // nothing at all, and an answer no index names simply never appears.
        // Neither is an error — a keyword being filled in as the prompt is
        // written passes through both — so they are stated, not blocked.
        missing: indices.filter(n => n >= answers),
        unused: indices.length
          ? row.rules.map((r, n) => n).filter(n => !indices.includes(n))
          : [],
      });
    }));
    // Which colour each rule's text gets in the preview: its row's, so one
    // keyword is one colour however many answers it has.
    //
    // Counted down the rows as they are shown, not as they are stored. The
    // stored order shifts under every tick — removing an answer splices a rule
    // out and every rule after it moves up one — so colouring by it had [scene]
    // and the row below it swapping colours when an answer was unticked, which
    // repaints half the preview for an edit that changed one word of it. The
    // shown order only changes when a row is added or deleted, and it is also
    // the order the dots are read in.
    const colorIdx = computed(() => {
      const m = new Map();
      rows.value.forEach((row, n) => { for (const r of row.rules) m.set(r, n); });
      return m;
    });
    const colorAt = (i) => {
      const n = colorIdx.value.get(replacements[i]);
      return ruleColor(n == null ? 0 : n);
    };
    const rowColor = row => colorAt(replacements.indexOf(row.rules[0]));

    // ── The keyword menu on "find" ──────────────────────────────────────
    // Clicking into the find box offers the keywords rather than leaving you to
    // remember and retype them. Typing still works — the list narrows to what
    // has been typed, so the box is a filter as much as a field.
    //
    // Three sections, in the order that matters. What THIS prompt contains
    // comes first, because a rule for one of those changes this run. Then the
    // keywords the rules pull in behind it: a library prompt can carry keywords
    // of its own — [female] resolving to "…, [hair], …" — and [hair] fires in
    // this run just as surely as if the prompt had said it, so it belongs with
    // the ones that will fire rather than with the ones that will not. It keeps
    // its own heading because the reason it is here is a rule, and which rule is
    // worth saying. Everything else the app knows a keyword could be follows,
    // marked, since a rule naming a token this run never reaches is a rule that
    // will not fire — worth offering (the rules are global, and the prompt is
    // about to be edited) but not worth confusing with the ones that will.
    const menuFor = ref('');
    const openMenu = id => { menuFor.value = id; };
    const closeMenu = () => { menuFor.value = ''; };
    //
    // The [0] in [female][0] is not on offer: it is an index into the row that
    // already exists, not a keyword a rule could be written for, and a menu
    // offering to replace [0] with a prompt is offering to break the reference.
    const promptKeywords = computed(() => {
      const seen = new Map();
      for (const m of String(props.prompt || '').match(PROMPT_TOKEN) || []) {
        if (isIndexToken(m)) continue;
        const k = foldTok(m);
        if (!seen.has(k)) seen.set(k, { token: m.trim(), count: 0 });
        seen.get(k).count++;
      }
      return [...seen.values()];
    });
    // The keywords this prompt reaches through a rule rather than by saying
    // them. reachableRules is what decides it — the same call the fan-out counts
    // variations with, so a keyword offered here is one the multiplication will
    // agree is live — and the token comes out of the replacement text, which is
    // where a nested keyword lives.
    //
    // Recorded with the rule that introduced it. [hair] appearing from nowhere
    // in a prompt that says [female] is the question this answers before it is
    // asked, and the answer is the name of the rule that brought it.
    const nestedKeywords = computed(() => {
      const have = new Set(promptKeywords.value.map(k => foldTok(k.token)));
      const seen = new Map();
      for (const r of reachableRules(scopeText.value)) {
        for (const m of String(replacementText(r)).match(PROMPT_TOKEN) || []) {
          const k = foldTok(m);
          if (!k || isIndexToken(k) || have.has(k) || seen.has(k)) continue;
          seen.set(k, { token: m.trim(), via: String(r.from).trim() });
        }
      }
      return [...seen.values()];
    });
    // A library category IS a keyword — that is what a category is for here, and
    // promptsMatching resolves [scene] onto the Scene shelf — and a keyword
    // another rule already names is one this install demonstrably uses. Neither
    // is offered twice, and neither repeats anything this run already reaches.
    const otherKeywords = computed(() => {
      const have = new Set([...promptKeywords.value, ...nestedKeywords.value].map(k => foldTok(k.token)));
      const seen = new Map();
      const add = tok => {
        const k = foldTok(tok);
        if (!k || k === '[]' || isIndexToken(k) || have.has(k) || seen.has(k)) return;
        seen.set(k, { token: String(tok).trim() });
      };
      for (const c of promptLib.categories) add('[' + String(c == null ? '' : c).trim() + ']');
      for (const r of replacements) if (isKeywordRule(r)) add(r.from);
      return [...seen.values()];
    });
    // Already spoken for by some row — shown so the same keyword does not get a
    // second, competing one.
    const ruleFor = tok => replacements.some(r => foldTok(r.from) === foldTok(tok));
    // Narrowed by whatever is in the box. The brackets are stripped off the
    // query so half-typing "[fem" still finds [female].
    const menuList = computed(() => {
      const row = rowsRaw.value.find(x => x.id === menuFor.value);
      if (!row) return { found: [], nested: [], other: [] };
      const q = foldTok(row.from).replace(/[[\]{}]/g, '');
      const hit = e => !q || foldTok(e.token).includes(q);
      return {
        found: promptKeywords.value.filter(hit),
        nested: nestedKeywords.value.filter(hit),
        other: otherKeywords.value.filter(hit),
      };
    });
    function chooseKeyword(row, tok) { setFrom(row, tok); saveReplacements(); closeMenu(); }
    // Esc closes the menu and stops there. Un-stopped it would carry on to the
    // Remix dialog's window handler and close the whole dialog, which is a
    // long way from what dismissing a dropdown should cost. With no menu open
    // it is not ours, so it travels.
    function onFindEsc(e) {
      if (!menuFor.value) return;
      e.stopPropagation();
      closeMenu();
    }

    // ── Editing a row ───────────────────────────────────────────────────
    // Every one of these writes to all of the row's rules, because the row IS
    // the keyword: renaming it, switching it off or deleting it means the
    // keyword, not whichever of its answers happens to be first.
    const addRepl = () => replacements.push({ from: '', to: '', on: true, promptId: '' });

    // ── Keywords the prompt has that no row answers ─────────────────────
    // A prompt that says [mother] against a rules list with no [mother] in it
    // is a keyword that gets swept out of the graph before the run with nothing
    // on screen having mentioned it. Renaming a row is how you get there
    // without noticing: [prompt1] becomes [mother] in the prompt, the old row
    // still reads [prompt1], and the new word answers to nothing.
    //
    // So the tokens the text carries get a row each, empty, waiting to be
    // answered — which is also where the ✕ is if it was not wanted.
    //
    // Only what the text says out loud. A keyword reached through another
    // rule's replacement — [female] resolving to "…, [hair], …" — already fires
    // and is already offered under "pulled in by a rule" in the find menu; a
    // prompt saying [female] sprouting six empty rows for the shelves behind it
    // is a list nobody asked for.
    const autoAdd = () => {
      const text = scopeText.value;
      if (!text || !text.trim()) return;
      const have = new Set(replacements.map(r => foldTok(r.from)));
      const add = [];
      for (const m of text.match(PROMPT_TOKEN) || []) {
        const k = foldTok(m);
        if (!k || isIndexToken(k) || have.has(k)) continue;
        // The token pattern has no length bound and spans newlines, and this
        // text comes out of whatever file is open — including prompts lifted
        // from a downloaded image. One stray [ ... ] around a paragraph would
        // otherwise write that paragraph into a store shared by every device,
        // to be compiled into a regex on every run.
        if (m.length > MAX_AUTO_TOKEN || /[\r\n]/.test(m)) continue;
        // A [promptN] shape is never auto-created: an empty one reads as a
        // capture in play and masks the whole list (see isLiveCapture).
        if (isCompositeRule({ from: m })) continue;
        have.add(k);
        add.push(m.trim());
        if (add.length >= MAX_AUTO_ADD) break;
      }
      if (!add.length) return;
      for (const from of add) replacements.push({ from, to: '', on: true, promptId: '' });
      saveReplacements();
      // Named, because they are appended and the list is sorted and may be
      // scrolled — a row appearing somewhere off screen is not an event.
      showToast('Added ' + add.join(', ') + ' — pick what ' + (add.length === 1 ? 'it' : 'they') + ' should become');
    };
    // Gated on the tab, and debounced behind it. The prompt field lives on the
    // Workflow tab and this panel on the Run tab, so a keyword being typed is
    // never seen half-finished here — which is what keeps [moth, [mothe and
    // [mother] from becoming three rows. The debounce is for the load, where
    // the scope arrives in more than one piece.
    let autoT = null;
    const queueAutoAdd = () => { clearTimeout(autoT); autoT = setTimeout(autoAdd, AUTO_ADD_DEBOUNCE_MS); };
    watch(() => [props.visible, scopeText.value], () => { if (props.visible) queueAutoAdd(); }, { immediate: true });
    onBeforeUnmount(() => { clearTimeout(autoT); clearTimeout(previewT); });
    const delRow = (row) => {
      for (const r of row.rules) {
        const i = replacements.indexOf(r);
        if (i >= 0) replacements.splice(i, 1);
      }
      saveReplacements();
    };
    const setFrom = (row, v) => { for (const r of row.rules) r.from = v; };
    // Turning a row back on by hand takes it out of the capture's hands: it was
    // switched off for you, and you have just said otherwise, so it must not be
    // switched off again on the next pass or restored a second time later.
    const toggleRow = (row) => {
      const on = !row.on;
      for (const r of row.rules) {
        r.on = on;
        // Switched off by hand: whatever the mask thought about this row, the
        // user has just said otherwise and the override retires with it.
        if (!on) { delete r.autoKeep; continue; }
        delete r.autoOff;
        // Switched on while a capture is masking: a deliberate override, and
        // it has to outlive the next false->true swing of the mask or the row
        // goes back off the moment the capture leaves the prompt and returns.
        if (maskOn.value) r.autoKeep = true;
      }
      saveReplacements();
    };
    const swapRow = (row) => {
      const r = row.rules[0];
      const a = r.from; r.from = r.to; r.to = a;
      saveReplacements();
    };
    const toggleReplAll = () => {
      const on = !replAllOn.value;
      replacements.forEach(r => {
        r.on = on;
        if (!on) { delete r.autoKeep; return; }
        delete r.autoOff;
        if (maskOn.value) r.autoKeep = true;
      });
      saveReplacements();
    };

    // ── The value menu ──────────────────────────────────────────────────
    // Tick boxes rather than a dropdown, because a keyword takes as many
    // answers as you like and each one is a job. The shelf offered is the one
    // the keyword names, not the whole library: [female] is a question, and
    // answering it with every prompt on file is the same as not having asked.
    // A keyword nothing matches falls back to everything — see promptsMatching.
    //
    // Anything already picked that the shelf does not hold is appended to it, or
    // a rule pointing at a prompt since refiled would read as though nothing
    // were chosen and unticking it would be impossible.
    const valFor = ref('');
    const openVals = row => { valFor.value = valFor.value === row.id ? '' : row.id; };
    const closeVals = () => { valFor.value = ''; };
    const valMenu = computed(() => {
      const row = rowsRaw.value.find(x => x.id === valFor.value);
      if (!row || !row.keyword) return null;
      const m = promptsMatching(keywordOf(row.rules[0]), '');
      const have = new Set();
      for (const g of m.groups) for (const p of g.prompts) have.add(p.id);
      const stray = [...row.pickedIds].filter(id => !have.has(id))
        .map(id => promptLib.prompts.find(p => p.id === id)).filter(Boolean);
      const groups = stray.length
        ? m.groups.concat([{ category: 'picked, filed elsewhere', prompts: stray }])
        : m.groups;
      return { groups, filtered: m.filtered, keyword: m.keyword };
    });
    // Ticking fills the row's empty rule if it has one and adds a rule if it
    // does not; unticking takes that rule back out, except when it is the last
    // one — the row itself stays, waiting to be answered again, since deleting
    // the keyword is what the ✕ is for. The new rule inherits the row's switch,
    // so adding an answer to a row that is off does not quietly start it
    // running, and it is appended rather than spliced in: the stored order is
    // the order a run applies them in, and the display order is this row.
    function toggleVal(row, p) {
      const hit = row.rules.find(r => r.promptId === p.id);
      if (hit) {
        if (row.rules.length > 1) {
          const i = replacements.indexOf(hit);
          if (i >= 0) replacements.splice(i, 1);
        } else { hit.promptId = ''; hit.to = ''; }
      } else {
        const empty = row.rules.find(r => !r.promptId);
        // The text is snapshotted alongside the id: the id is the live link, and
        // this is what anything that does not know about the library — an older
        // build, the server's own copy — still substitutes.
        if (empty) { empty.promptId = p.id; empty.to = p.text; }
        else replacements.push({ from: row.from, to: p.text, on: row.on, promptId: p.id });
      }
      saveReplacements();
    }
    const valLabel = (row) => {
      if (!row.picked.length) return '— pick prompts —';
      return row.picked.map(p => p.name).join(', ');
    };
    const valTitle = (row) => {
      const kw = String(row.from).trim();
      // A composite row's answers are parts, so the sentence every other row
      // gets — "a run queues a job for each" — is the one thing it must not say.
      if (row.composite) {
        const n = row.picked.length;
        return n
          ? n + ' part' + (n === 1 ? '' : 's') + ' joined into ' + kw
            + (row.shelves > 1 ? ', across ' + row.shelves + ' categories' : '')
            + (row.factor > 1 ? ' — ' + row.factor + ' versions of it, since a category has more than one ticked' : '')
            + '. Click to change.'
          : 'Build ' + kw + ' out of the library — one from each category, joined into a single prompt.'
            + ' Tick two from the same category and the run does one job per version.';
      }
      if (row.pinned) {
        return row.picked.length + ' answer' + (row.picked.length === 1 ? '' : 's') + ' for ' + kw
          + ', and the prompt asks for ' + ixLabel(row) + ' by index — so they all land in the one'
          + ' prompt instead of fanning the run out. Click to change.';
      }
      return row.picked.length
        ? row.picked.length + ' answer' + (row.picked.length === 1 ? '' : 's') + ' for ' + kw
          + (row.picked.length > 1 ? ' — a run queues a job for each' : '') + '. Click to change.'
        : 'Pick what ' + kw + ' is replaced with — tick as many as you like, and a run queues a job for each.';
    };
    // Whether the index beside each answer is worth showing. One answer with
    // nothing addressing it by number is a row where the number is noise; the
    // moment there are two to tell apart, or the prompt has started naming
    // them, it is the only thing that says which is which.
    //
    // Never on a composite row: its answers are not a numbered list of
    // alternatives, and an index into them would be pointing at a part.
    const showIx = row => !row.composite && (row.pinned || row.picked.length > 1);
    const ixLabel = row => (row.indices || []).map(n => '[' + n + ']').join('');

    // ── Pinned by index ─────────────────────────────────────────────────
    // [female][0] and [female][1] put two answers in one prompt, which is the
    // opposite of what two ticked answers normally mean — so the panel says so
    // rather than leaving a keyword with four answers and one job to be worked
    // out from the tab count. One line per pinned keyword, and the two ways the
    // prompt and the tick list can disagree get a line of their own each,
    // because both of them are otherwise only visible as a word that is missing
    // from a paragraph.
    const answerName = (row, n) => {
      const r = row.rules[n];
      if (!r) return '';
      return (isKeywordRule(r) && promptName(r.promptId)) || oneLine(replacementText(r)) || '(nothing)';
    };
    const pinNotes = computed(() => rows.value.filter(r => r.pinned && rowLive(r)).map(row => {
      const kw = String(row.from).trim();
      const warns = [];
      if (row.missing.length) {
        warns.push(row.missing.map(n => kw + '[' + n + ']').join(', ')
          + (row.missing.length === 1 ? ' has no answer ticked, so it is' : ' have no answers ticked, so they are')
          + ' dropped from the prompt.');
      }
      if (row.unused.length) {
        warns.push(row.unused.map(n => '“' + answerName(row, n) + '”').join(', ')
          + (row.unused.length === 1 ? ' is ticked but nothing asks for it' : ' are ticked but nothing asks for them')
          + ' — add ' + row.unused.map(n => kw + '[' + n + ']').join(', ') + ' to use '
          + (row.unused.length === 1 ? 'it.' : 'them.'));
      }
      return { id: row.id, kw, ix: ixLabel(row), n: row.indices.length, warns };
    }));

    // ── One tab per prompt the run will send ────────────────────────────
    // Several answers to one keyword fan a run out, and this preview used to
    // show combination one and stop there — the rest were unreadable until they
    // came back as images. So each combination gets a tab and the panel paints
    // whichever is selected. The whole rule list is still never previewed: it is
    // first-wins, which is a result no run produces any more.
    //
    // Judged against the prompt in front of us, the way the run judges it
    // against the fields it is about to send: a group this text cannot reach
    // resolves the same way in every combination, and a row of tabs holding the
    // identical paragraph is worse than no tabs at all.
    // Whether the panel is showing its body. A <details> keeps its children in
    // the DOM when closed, so this is what stops the preview column being built
    // for a panel nobody has opened — see `resolved` and the v-if on the body.
    const panelOpen = ref(false);
    const variations = computed(() => replacementVariations(scopeText.value));
    // What the preview paints, one beat behind what the rules say.
    //
    // Every keystroke in a find or replace box invalidates `variations`, and
    // with every prompt now rendered in full that repainted N paragraphs per
    // character instead of one — on a client that is often a phone. The rows
    // still update instantly; only the column on the right waits.
    const previewVariations = ref([]);
    let previewT = null;
    watch([variations, panelOpen], ([v, open]) => {
      clearTimeout(previewT);
      if (!open) { previewVariations.value = []; return; }
      if (!previewVariations.value.length) { previewVariations.value = v; return; }
      previewT = setTimeout(() => { previewVariations.value = v; }, PREVIEW_DEBOUNCE_MS);
    }, { immediate: true });
    // Every one of them resolved, not just a selected one. There is no selection
    // any more: all of the prompts are on screen at once, so there is nothing
    // left to clamp, reset when the list reshapes, or leave pointing past the
    // end when unticking an answer collapses six prompts back into three.
    //
    // And each cut into runs by which rule produced it, so the words can carry
    // the colour of the row that put them there. Null when the painted walk and
    // the real one disagree — see paintReplacements; the block then falls back to
    // the plain string rather than showing a preview that is not the run.
    //
    // One pass per variation rather than one for the visible one, which is the
    // cost of showing them all: a few regex passes over a paragraph, times the
    // number of jobs, recomputed only when the rules or the prompt change.
    // Only while the panel is actually open. It is a <details>, which hides its
    // body with CSS rather than removing it, and both hosts keep the Run tab
    // mounted — so every variation was applied, painted and turned into DOM
    // before anything had been clicked, on a tab that was not even showing.
    // Four rows of four answers is 256 paragraphs built for nobody.
    //
    // Painted first and the text taken from the spans: paintReplacements
    // already runs applyReplacements internally for its self-check, so asking
    // for both ran the pipeline three times per variation where two will do —
    // and the spans are cut from the exact string that check compared against,
    // so the two cannot disagree.
    const resolved = computed(() => (panelOpen.value ? previewVariations.value : []).map(v => {
      const painted = paintReplacements(props.prompt || '', v);
      return { painted, text: painted ? painted.map(x => x.text).join('') : applyReplacements(props.prompt || '', v) };
    }));
    // A row only earns a colour once it can actually fire; an off or half-typed
    // row contributes nothing to the preview and a lit dot beside it would be
    // pointing at text that is not there.
    const rowLive = row => !!(row && row.on && String(row.from).trim());

    // ── Display order ───────────────────────────────────────────────────
    // Sorted for reading, never for running: applyReplacements walks the stored
    // list and a free-text rule can rewrite what an earlier one produced, so the
    // array itself is left exactly as it was typed.
    //
    // Alphabetical, with a row that has nothing typed in it yet last rather than
    // first, or every new row would jump away from the button that made it.
    const byFrom = (a, b) => {
      const A = foldTok(a.from), B = foldTok(b.from);
      if (!A !== !B) return A ? -1 : 1;
      return A.localeCompare(B) || a.first - b.first;
    };
    // The order is taken when the panel opens and then held until it opens
    // again. Sorting live meant the row moved out from under the cursor as its
    // keyword was typed — [f… landing between [breasts] and [hair] one letter
    // at a time — and a list that reorders itself mid-edit is worse than one
    // that is briefly out of order.
    //
    // Keyed on the row's key rather than its position: ticking an answer adds a
    // rule and shifts every index after it, where the keyword the row is named
    // for stays what it was. A row the snapshot has never seen — a new one, or
    // one brought in by a sync — sits at the end in list order rather than being
    // sorted into the middle of an edit.
    const sortOrder = ref(null);
    function snapshotOrder() {
      const m = new Map();
      rowsRaw.value.slice().sort(byFrom).forEach((row, n) => m.set(row.key, n));
      sortOrder.value = m;
    }
    // Opening the panel is the other moment worth scanning at: it is when the
    // rows are about to be read, and waiting out a debounce to show a row that
    // should already be there is the delay this is meant to remove.
    function onPanelToggle(e) {
      panelOpen.value = !!e.target.open;
      if (e.target.open) { snapshotOrder(); autoAdd(); }
    }
    // Rows this switched off for a capture are folded out of the list rather
    // than left sitting in it unticked — a column of switched-off rules with
    // nothing saying why is the thing the fold exists to replace. `showHidden`
    // puts them back in place, still off, where their own tick boxes work.
    const rows = computed(() => {
      const order = sortOrder.value;
      let list = rowsRaw.value.slice();
      if (!showHidden.value) list = list.filter(row => !isMasked(row));
      if (!order) return list;
      const at = row => (order.has(row.key) ? order.get(row.key) : Infinity);
      return list.sort((a, b) => at(a) - at(b) || a.first - b.first);
    });
    // ── Active, and ignored ─────────────────────────────────────────────
    // Two numbers, because "switched on" and "going to do something" are not
    // the same thing and the difference is the one worth knowing: a rule for a
    // keyword this prompt never says is set, is enabled, and replaces nothing.
    // It used to be a paragraph above the Remix button naming the keywords —
    // which put the answer on the Run tab, one host only, and left the summary
    // claiming those rules as active. The count belongs beside the count it
    // contradicts.
    //
    // Rows, not rules, on both sides: a keyword with four answers is one thing
    // switched on, and four would be counting its answers twice over, once here
    // and once in the job total beside it.
    //
    // Every unreachable row counts, not just the ones with several answers. The
    // old note only named those, because it was explaining a missing
    // multiplication; this is explaining a rule that will not fire, and a solo
    // one fires exactly as little.
    //
    // A blank scope means the form has not loaded yet rather than that nothing
    // is reachable — reachableRules says the same about a non-string — so
    // everything reads as live until there is text to judge against, or a
    // dialog would open saying every rule it has is ignored.
    const liveKeys = computed(() => {
      if (!scopeText.value.trim()) return null;
      return new Set([...groupInfo.value.values()].filter(g => g.live).map(g => g.key));
    });
    const rowReaches = row => !liveKeys.value || liveKeys.value.has(foldTok(row.from));
    const activeRows = computed(() => rows.value.filter(r => rowLive(r) && rowReaches(r)).length);
    const idleRows = computed(() => rows.value.filter(r => rowLive(r) && !rowReaches(r)));
    // The count says how many; the hover says which, since a number alone sends
    // you down the rows guessing. Their dots are dimmed for the same reason.
    const idleTitle = computed(() => {
      const names = idleRows.value.map(r => String(r.from).trim());
      const list = names.length === 1 ? names[0]
        : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
      return names.length === 1
        ? 'A rule for ' + list + ' is set, but this prompt doesn’t use it — so it replaces nothing and doesn’t multiply the run.'
        : 'Rules for ' + list + ' are set, but this prompt doesn’t use them — so they replace nothing and don’t multiply the run.';
    });

    // ── Composing from captures switches the ingredients off ────────────
    // A capture is the whole paragraph after every keyword under it has already
    // resolved. So once the prompt is built out of [prompt1] and [prompt2], the
    // rows those captures were made from are not ingredients any more — they are
    // a list of rules that cannot reach this run, sitting above the two that can.
    // They are switched off and folded away, and the line that replaces them
    // says how many and offers them back.
    //
    // **On AND reached, not merely on.** A capture is added enabled, so keying
    // this on the tick box alone would fire the instant you captured the first
    // tab — switching off the very [female] whose second tab you were about to
    // capture, and collapsing the tabs under the cursor. "In play" is what the
    // tick box means here, and being named by the prompt is what puts it in play.
    //
    // The switch-off is real and written, so `autoOff` is written beside it: it
    // marks the rows this did, so leaving the state restores exactly those and
    // never a row that was already off when we got here. Without that record the
    // rules list is global and shared, and this would read as [female] quietly
    // replacing nothing in every other workflow, forever.
    const isCaptureRule = isCompositeRule;
    // In play: on, named by the prompt, AND actually resolving to something.
    //
    // That last clause is the whole guard. autoAdd creates an empty row for any
    // bracketed token the text carries, so a prompt that merely mentions
    // [prompt1] — a file from another install, or your own after the library
    // entry was deleted — manufactured a capture that substituted nothing and
    // switched off every other rule anyway, with a toast saying the captures
    // already held them. Deleting the row un-masked, the next panel open
    // re-added it, and round it went.
    const isLiveCapture = (r, keys) => r.on && isCaptureRule(r)
      && keys.has(foldTok(r.from)) && !!String(replacementText(r) || '').trim();
    const captureState = computed(() => {
      const keys = liveKeys.value;
      if (!keys) return null;          // no scope yet — decide nothing either way
      return replacements.some(r => isLiveCapture(r, keys));
    });
    const showHidden = ref(false);
    // What the fold follows is the *state*, not the mark. `autoOff` only ever
    // records which rows this switched off, so that leaving the state can put
    // exactly those back — keying the fold on it meant a row already switched
    // off by hand stayed in the list, unticked, which is precisely the clutter
    // the fold exists to remove. A row that is off is irrelevant to this run
    // however it got that way.
    //
    // A row that is ON stays visible even here: something deliberately turned
    // it back on, and it still reaches the run, so folding it away would hide
    // the one row in the group that is actually doing something.
    const maskOn = computed(() => captureState.value === true);
    const isMasked = row => maskOn.value && !row.composite && !row.on;
    const hiddenRows = computed(() => (maskOn.value ? rowsRaw.value.filter(isMasked) : []));
    // The captures doing the hiding, so the line can name them rather than
    // leaving "6 hidden" to be traced back to whatever caused it.
    // By row, not by rule: a composite row holds one rule per part, so naming
    // them off the rule list printed "[prompt1] and [prompt1] and [prompt1]…"
    // once for each of its six answers.
    const hiddenBy = computed(() => {
      const keys = liveKeys.value;
      if (!keys) return [];
      const seen = new Set();
      for (const r of replacements) {
        if (!isLiveCapture(r, keys)) continue;
        seen.add(String(r.from).trim());
      }
      return [...seen];
    });
    const hiddenTitle = computed(() => hiddenRows.value.map(r => String(r.from).trim()).join(', ')
      + ' — switched off and folded away while ' + (hiddenBy.value.join(' / ') || 'the capture')
      + ' is in the prompt. The ones this switched off come back when it leaves;'
      + ' tick any of them to bring it back on its own.');
    watch(captureState, (now, was) => {
      if (now === null) return;        // never act on "don't know"
      // Counted in rows, not rules, like every other count in this panel: a
      // keyword with four answers is one thing switched off, and saying four
      // would disagree with the line that is about to appear in its place.
      const hit = new Set();
      if (now) {
        for (const r of replacements) {
          // Not a capture, not already off, not blank (a row with no find
          // cannot fire, so "the captures already hold it" would be untrue of
          // it), and not one switched back on by hand — that is what autoKeep
          // records, and without it taking the capture out of the prompt and
          // putting it back masked the row again.
          if (isCaptureRule(r) || !r.on || r.autoKeep || !String(r.from).trim()) continue;
          r.on = false; r.autoOff = true; hit.add(foldTok(r.from));
        }
        if (hit.size) {
          saveReplacements();
          showToast(hit.size + ' rule' + (hit.size === 1 ? '' : 's') + ' switched off — the captures already hold them');
        }
        return;
      }
      // Back out: exactly the rows this switched off, and nothing else.
      // autoKeep is deliberately NOT cleared here. It is the record that the
      // user overrode the mask on this row, and the case it exists for is
      // precisely the next false->true swing — take the capture out of the
      // prompt and put it back, and without it the row goes straight off
      // again. Only the user switching that row off retires it.
      for (const r of replacements) {
        if (!r.autoOff) continue;
        r.on = true; delete r.autoOff; hit.add(foldTok(r.from));
      }
      if (hit.size) {
        saveReplacements();
        // != rather than !==: an immediate watcher passes undefined, not null,
        // so the strict form never suppressed the mount run and a host with the
        // form already cached got a toast for something nobody did.
        if (was != null) showToast(hit.size + ' rule' + (hit.size === 1 ? '' : 's') + ' switched back on');
      }
      showHidden.value = false;
    }, { immediate: true });

    // ── What a tab is ───────────────────────────────────────────────────
    // The titles a combination picked — the prompt each [keyword] resolved to —
    // each in the colour of the row that put it there. This is the tab's label
    // now, in place of "Prmpt 3": a number says which prompt only in the sense
    // that it is not the one above it, where the titles say what it actually is,
    // and each one is the colour of the words it is about to contribute to the
    // paragraph below. Which is also why they are one per line: eleven titles do
    // not fit beside eleven more.
    //
    // The keyword itself is not repeated: it is on the row, and the same word in
    // front of every title is a column of noise. It stays on the hover, where a
    // title that does not obviously belong to a keyword can be traced back to
    // one.
    //
    // Keyword rules only. A free-text rule is in every combination and has no
    // title to state — it is not one of the picks that makes this tab this tab.
    // A combination with no picks at all falls back to the number, or its tab
    // would be an empty line.
    //
    // Reachability, not the whole list, and the same call the fan-out counts
    // with — a rule for a keyword this prompt never mentions is in the
    // combination, contributes nothing to it, and naming it here would send
    // someone hunting for a colour that is not in the paragraph.
    function promptName(id) {
      const p = id ? promptLib.prompts.find(x => x.id === id) : null;
      return p ? (p.name || '(unnamed)') : '';
    }
    // The picked prompt's name where there is one, its text where there is not:
    // a free-text rule has no title, and neither has a keyword rule whose prompt
    // has since been deleted — `to` is the snapshot kept for exactly that.
    const ruleTitle = r => (isKeywordRule(r) && promptName(r.promptId)) || oneLine(replacementText(r)) || '(nothing)';
    // Only the groups that vary name a prompt. The rules every combination
    // shares are in all of them, so repeating those says nothing about which
    // prompt is which — a solo rule and a pinned keyword are both in that
    // position, which is why "varies" is one question asked in the module rather
    // than the same filter written out at each site that needs it.
    //
    // It is the hover only now. The titles used to be the visible label of a
    // strip that selected which single paragraph was shown; with every prompt on
    // screen in full, a summary of the words directly beside them is a second,
    // shorter copy of something already legible — and the colours do the naming.
    const varyingKeys = computed(() => varyingPickKeys(scopeText.value));
    const tabs = computed(() => previewVariations.value.map((v, n) => ({
      n,
      on: !isVariationSkipped(v),
      text: (resolved.value[n] || {}).text || '',
      painted: (resolved.value[n] || {}).painted || null,
      // Which keywords made this one what it is, for the hover over its text.
      title: v.filter(r => varyingKeys.value.has(pickKeyOf(r)))
        .map(r => String(r.from).trim() + ' → ' + ruleTitle(r)).join(' · ')
        || 'The prompt with every rule applied',
    })));
    // Straight off the variations, never off `tabs`: the collapsed summary
    // shows this number, and reading it through tabs pulled the whole paint
    // pipeline for a panel nobody had opened.
    const keptCount = computed(() => variations.value.filter(v => !isVariationSkipped(v)).length);
    // Unticking a tab leaves that prompt out of the run; the tick lives in the
    // module, so closing the panel and opening it again finds it where it was.
    //
    // The last one ticked cannot be unticked — its box is disabled rather than
    // refusing the click, because a checkbox bound to a value that did not
    // change is a checkbox the browser has already visibly emptied and Vue has
    // no reason to repaint. The guard below is for anything that reaches this
    // another way.
    function toggleTab(t) {
      const v = variations.value[t.n];
      if (!v || (t.on && keptCount.value < 2)) return;
      setVariationSkipped(v, t.on);
    }
    // ── Saving one ──────────────────────────────────────────────────────
    // The next free [promptN]. Counted across the library AND the rules, not
    // just the library: deleting a captured entry from the Prompts page leaves
    // its rule behind, and reusing that number would point two rows at the same
    // token — the second would never fire, which is the silent kind of wrong.
    const nextCaptureName = () => {
      let n = 0;
      const seen = s => { const m = CAPTURE_NUM_RE.exec(String(s || '').trim()); if (m) n = Math.max(n, Number(m[1])); };
      for (const p of promptLib.prompts) seen(p.name);
      for (const r of replacements) seen(r.from);
      return 'prompt' + (n + 1);
    };
    // Clicking save twice on the same tab is one click and a toast apart, and
    // the second one looks exactly like the first. So an identical capture is
    // handed back rather than filed again — the library is a shelf, not a log.
    // An identical capture already on the shelf, whether or not a rule still
    // points at it: requiring the rule meant deleting a [promptN] row and
    // pressing ＋ again filed a second entry with the same text under a new
    // number rather than re-linking the one already there.
    const sameCapture = text => promptLib.prompts.find(p =>
      p.category === CAPTURE_CATEGORY && String(p.text).trim() === text);
    const ruleFrCapture = p => replacements.find(r => r.promptId === p.id);
    async function saveVariation(n) {
      const v = variations.value[n];
      if (!v) return;
      // savePrompts is a whole-list replace, and loadPrompts marks the library
      // loaded even when the fetch failed — leaving it empty. Saving a capture
      // on top of that would post one entry as the entire library and delete
      // every prompt on the install. The Prompts page guards the same way.
      if (!promptLib.loaded || promptLib.error) {
        showToast('The prompt library has not loaded — can not save a capture yet', 4000);
        return;
      }
      const text = String(applyReplacements(props.prompt || '', v) || '').trim();
      if (!text) { showToast('That prompt resolves to nothing — nothing to save'); return; }
      const had = sameCapture(text);
      if (had) {
        // On the shelf but with no rule left pointing at it: give it its rule
        // back rather than filing the same paragraph twice.
        if (!ruleFrCapture(had)) {
          replacements.push({ from: '[' + had.name + ']', to: had.text, on: true, promptId: had.id });
          saveReplacements();
          showToast('Restored [' + had.name + '] — it was already in the library');
        } else showToast('Already saved as [' + had.name + ']');
        return;
      }
      const name = nextCaptureName();
      const id = newPromptId();
      // The category has to exist in the list or promptsByCategory files the
      // entry under "Uncategorised", which is a shelf nobody chose.
      if (!promptLib.categories.includes(CAPTURE_CATEGORY)) promptLib.categories.push(CAPTURE_CATEGORY);
      promptLib.prompts.push({ id, category: CAPTURE_CATEGORY, name, text });
      // Awaited, and the rule only follows once the entry is really on disk:
      // a fire-and-forget save meant a failed POST reported success while the
      // entry the rule points at existed only until the tab closed.
      try {
        await savePrompts();
      } catch (e) {
        const i = promptLib.prompts.findIndex(p => p.id === id);
        if (i >= 0) promptLib.prompts.splice(i, 1);
        showToast('Could not save the capture: ' + e.message, 5000);
        return;
      }
      // `to` alongside the id, as every [keyword] rule stores it: the id is the
      // live link, and this is what the server's own copy and an older build
      // still have something literal to substitute.
      replacements.push({ from: '[' + name + ']', to: text, on: true, promptId: id });
      saveReplacements();
      showToast('Saved as [' + name + ']');
    }
    // Naming which prompt, off the same summary the text itself hovers with:
    // the picks it was built from went with the label strip, and a button whose
    // tooltip says only "save this prompt" is ambiguous in a column of them.
    const saveTitle = t => 'Save this prompt to the library as its own [keyword], so it can stand beside another one'
      + (t ? ' — ' + t.title : '');

    const tabTitle = t => (t.on
      ? (keptCount.value < 2
        ? 'Something has to run — this is the last one ticked'
        : 'Untick to leave this prompt out of the run')
      : 'Not going to run. Tick to put it back.');
    // Four states, not two. rowLive is false for a row that is switched off AND
    // for one with nothing typed in it yet — telling someone their brand new
    // empty row to switch it on answers a question they did not ask, and points
    // at a checkbox that is already ticked. The fourth is the row the summary
    // counts as ignored: on, filled in, and nothing in this prompt for it to
    // find, which is why its colour is not in the paragraph below either.
    const dotTitle = (row) => {
      if (!rowLive(row)) {
        return String(row.from).trim()
          ? 'Switched on, this row’s colour in the preview below'
          : 'This row’s colour, once it has something to find';
      }
      return rowReaches(row)
        ? 'This row’s colour in the preview below'
        : 'Ignored — this prompt doesn’t contain ' + String(row.from).trim();
    };
    return {
      replacements, saveReplacements, replAllOn, activeRows, promptLib,
      idleRows, idleTitle, rowReaches,
      rows, rowColor, rowLive, dotTitle, colorAt, ruleColor,
      addRepl, delRow, setFrom, toggleRow, swapRow, toggleReplAll,
      menuFor, openMenu, closeMenu, menuList, chooseKeyword, ruleFor, onFindEsc,
      valFor, openVals, closeVals, valMenu, toggleVal, valLabel, valTitle, oneLine,
      showIx, ixLabel, pinNotes,
      variations, onPanelToggle, panelOpen,
      tabs, keptCount, toggleTab, tabTitle,
      saveVariation, saveTitle, HELP,
      hiddenRows, hiddenBy, hiddenTitle, showHidden,
    };
  },
  template: `
    <details class="rmx-repl" @toggle="onPanelToggle">
      <!-- The summary carries the multiplication: a run queues a job per ticked
           prompt, and the number is the whole of what the red block on the Run
           tab used to say. Closed, it is the only thing that says the run is
           about to cost twelve of something — which is why it is on the line you
           can read without opening anything.
           And beside it the rules that are switched on and cannot fire, which
           was a paragraph above the Remix button until it was noticed that it
           belonged next to the number it was correcting: "3 active" counted
           them as active. Muted, not red — an ignored rule is the absence of a
           multiplication, so nothing is about to cost anything — with the
           keywords themselves on the hover. -->
      <!-- The ⓘ swallows its own click: it sits inside the summary, so without
           that, reading what the panel is would shut it. -->
      <summary>Prompt Replacements<span class="rmx-repl-i" :title="HELP" @click.prevent.stop>ⓘ</span><span class="rmx-repl-on" v-if="activeRows"> — {{ activeRows }} active</span><span class="rmx-mut" v-else-if="rows.length && !idleRows.length"> — {{ rows.length }} off</span><span class="rmx-repl-idle" v-if="idleRows.length" :title="idleTitle">{{ activeRows ? ', ' : ' — ' }}{{ idleRows.length }} ignored</span><span class="rmx-repl-jobs" v-if="variations.length > 1">, {{ keptCount }} job{{ keptCount === 1 ? '' : 's' }} total</span></summary>
      <div class="rmx-repl-body" v-if="panelOpen">
        <!-- Two columns wherever there is room: the rules on the left, what they
             produce on the right, so an edit and its effect are beside each
             other rather than a scroll apart. One column below that width — see
             .rmx-repl-cols, which is single-column until the media query. -->
        <div class="rmx-repl-cols">
          <div class="rmx-repl-list">
            <label class="rmx-repl-all"><input type="checkbox" :checked="replAllOn" @change="toggleReplAll"> Toggle all on/off</label>
            <!-- What the captures displaced. It stands where the rows did, names
                 the capture responsible, and says the switch-off undoes itself —
                 because a rule silently off in a list shared by every workflow
                 is the one thing this must never look like. -->
            <div v-if="hiddenRows.length" class="rmx-repl-mask" :title="hiddenTitle">
              <span><b>{{ hiddenRows.length }}</b> rule{{ hiddenRows.length === 1 ? '' : 's' }} off and hidden —
                {{ hiddenBy.join(' and ') || 'the captures' }} already hold{{ hiddenBy.length === 1 ? 's' : '' }} them.</span>
              <button type="button" class="rmx-repl-mask-b" @click="showHidden = !showHidden">{{ showHidden ? 'hide' : 'show' }}</button>
            </div>
            <div v-for="row in rows" :key="row.id" class="rmx-repl-row">
              <span class="rmx-repl-dot" :class="{off: !rowLive(row) || !rowReaches(row)}" :style="{ background: rowColor(row) }"
                    :title="dotTitle(row)"></span>
              <input type="checkbox" :checked="row.on" @change="toggleRow(row)" title="Enable this row">
              <span class="rmx-repl-find">
                <input type="text" class="rmx-inp" placeholder="find, or [keyword]" :value="row.from"
                       @focus="openMenu(row.id)" @click="openMenu(row.id)" @blur="closeMenu" @keydown.esc="onFindEsc"
                       @input="setFrom(row, $event.target.value)" @change="saveReplacements">
                <!-- mousedown is prevented on the whole menu so the input keeps
                     focus: without it the blur above fires first and the row is
                     gone before the click on it lands. -->
                <div v-if="menuFor === row.id && (menuList.found.length || menuList.nested.length || menuList.other.length)" class="rmx-kwmenu" @mousedown.prevent>
                  <div v-if="menuList.found.length" class="rmx-kwmenu-h">in this prompt</div>
                  <button v-for="k in menuList.found" :key="'f'+k.token" type="button" class="rmx-kw"
                          :title="'Replace ' + k.token + ' wherever it appears in the prompt'" @click="chooseKeyword(row, k.token)">
                    <span class="rmx-kw-tok">{{ k.token }}</span>
                    <span v-if="k.count > 1" class="rmx-mut" style="font-size:11px">×{{ k.count }}</span>
                    <span v-if="ruleFor(k.token)" class="rmx-kw-used">has a rule</span>
                  </button>
                  <!-- Not in the prompt, but inside a prompt this one pulls in —
                       it fires in this run all the same. -->
                  <div v-if="menuList.nested.length" class="rmx-kwmenu-h">pulled in by a rule</div>
                  <button v-for="k in menuList.nested" :key="'n'+k.token" type="button" class="rmx-kw"
                          :title="k.token + ' is inside what ' + k.via + ' resolves to, so it fires in this run too'"
                          @click="chooseKeyword(row, k.token)">
                    <span class="rmx-kw-tok">{{ k.token }}</span>
                    <span class="rmx-kw-via">via {{ k.via }}</span>
                    <span v-if="ruleFor(k.token)" class="rmx-kw-used">has a rule</span>
                  </button>
                  <div v-if="menuList.other.length" class="rmx-kwmenu-h">not in this prompt</div>
                  <button v-for="k in menuList.other" :key="'o'+k.token" type="button" class="rmx-kw off"
                          :title="k.token + ' is not in this prompt — a rule for it changes nothing until it is'" @click="chooseKeyword(row, k.token)">
                    <span class="rmx-kw-tok">{{ k.token }}</span>
                    <span v-if="ruleFor(k.token)" class="rmx-kw-used">has a rule</span>
                  </button>
                </div>
              </span>
              <button type="button" class="rmx-btn2 rmx-repl-swap" title="Swap words"
                      :disabled="row.keyword" @click="swapRow(row)">⇄</button>
              <!-- [keyword]: the answers are a tick list, since there can be any
                   number of them and each one is a job. -->
              <span v-if="row.keyword" class="rmx-repl-vals">
                <button type="button" class="rmx-inp rmx-valbtn" :class="{empty: !row.picked.length}"
                        :title="valTitle(row)" @click="openVals(row)">
                  <span class="rmx-valbtn-t">{{ valLabel(row) }}</span>
                  <!-- Which of these answers the prompt asks for by number, and
                       in amber when it asks for one that isn't there. The count
                       badge beside it means "this many jobs", which a pinned
                       keyword no longer does, so it stands down for this one. -->
                  <span v-if="row.pinned" class="rmx-valbtn-ix" :class="{warn: row.missing.length}">{{ ixLabel(row) }}</span>
                  <span v-else-if="row.composite" class="rmx-valbtn-ix" :class="{warn: row.factor > 1}">{{ row.shelves }}×{{ row.factor > 1 ? " " + row.factor + " ver" : "" }}</span>
                  <span v-else-if="row.picked.length > 1" class="rmx-valbtn-n">{{ row.picked.length }}</span>
                  <span class="rmx-valbtn-c">▾</span>
                </button>
                <!-- A backdrop rather than a blur handler: the menu holds real
                     checkboxes, and taking focus off the button to reach one is
                     the whole point of clicking it. -->
                <template v-if="valFor === row.id && valMenu">
                  <div class="rmx-valback" @click="closeVals"></div>
                  <div class="rmx-valmenu" @keydown.esc.stop="closeVals">
                    <div class="rmx-valmenu-h">
                      <span>{{ valMenu.filtered ? valMenu.keyword + ' prompts' : 'all prompts' }}</span>
                      <button type="button" class="rmx-valmenu-x" @click="closeVals" title="Done">✕</button>
                    </div>
                    <template v-for="g in valMenu.groups" :key="g.category">
                      <div class="rmx-kwmenu-h">{{ g.category }}</div>
                      <!-- The index a ticked answer answers to. This menu is in
                           the library's order and the indices are in the order
                           the answers were ticked, so without the number here
                           there is nowhere to read which is which. -->
                      <label v-for="p in g.prompts" :key="p.id" class="rmx-val">
                        <input type="checkbox" :checked="row.pickedIds.has(p.id)" @change="toggleVal(row, p)">
                        <span class="rmx-val-n">{{ p.name || '(unnamed)' }}</span>
                        <span class="rmx-val-t">{{ oneLine(p.text) }}</span>
                        <span v-if="row.pickedIds.has(p.id) && showIx(row)" class="rmx-val-i"
                              :class="{on: row.indices.includes(row.pickedAt.get(p.id))}"
                              :title="row.from + '[' + row.pickedAt.get(p.id) + '] in a prompt takes this one'">{{ row.pickedAt.get(p.id) }}</span>
                      </label>
                    </template>
                    <div v-if="!promptLib.prompts.length" class="rmx-mut" style="padding:8px 10px;font-size:12px">
                      The prompt library is empty — add some on the Prompts page and they show up here.
                    </div>
                  </div>
                </template>
              </span>
              <input v-else type="text" class="rmx-inp" placeholder="replace with" v-model="row.rules[0].to" @change="saveReplacements">
              <button type="button" class="rmx-repl-del" :title="row.keyword ? 'Delete this keyword and every answer to it' : 'Delete rule'" @click="delRow(row)">✕</button>
            </div>
            <div v-if="variations.length > 1" class="rmx-mut" style="font-size:12px;margin-top:8px">
              A keyword with several answers is a variation for each — a run queues one job per ticked combination, <b>{{ keptCount }}</b> of <b>{{ variations.length }}</b>.
            </div>
            <!-- The keywords the prompt addresses by index. Worth its own block:
                 four ticked answers and one job is the exact opposite of the
                 line above, and the prompt is the only other place that says
                 why. The two mismatches underneath it are the ones that are
                 otherwise invisible — a reference with nothing behind it, and
                 an answer nothing asks for, both of which read as a word
                 quietly missing from the paragraph on the right. -->
            <div v-for="p in pinNotes" :key="'pin'+p.id" class="rmx-repl-pin">
              <div><b>{{ p.kw }}{{ p.ix }}</b> — {{ p.n === 1 ? 'one answer' : p.n + ' answers' }} in the one prompt, so {{ p.kw }} doesn’t multiply the run.</div>
              <div v-for="(w, wi) in p.warns" :key="wi" class="warn">{{ w }}</div>
            </div>
            <button type="button" class="rmx-btn2" style="margin-top:6px" @click="addRepl">＋ Add replacement</button>
          </div>

          <div v-if="prompt" class="rmx-repl-final">
            <!-- Every prompt the run will send, in full, one per block. It used
                 to be a strip of titles — "Mature", "Adult" — that selected which
                 single paragraph was shown underneath, so reading the second one
                 meant clicking it, and comparing them meant clicking back and
                 forth. The titles were also a summary of a thing already on
                 screen in the only form that matters: the words themselves, in
                 the colour of the row that put them there.
                 So each block carries its own two controls — the box that decides
                 whether it runs, the ＋ that saves it as a keyword of its own —
                 and there is no selection left to make. Which also retires the
                 loose save button that appeared under the paragraph whenever
                 there was only one variation: every prompt now has its own. -->
            <div class="rmx-repl-prompts">
              <div v-for="t in tabs" :key="t.n" class="rmx-repl-prompt" :class="{skip: !t.on}">
                <div class="rmx-repl-prompt-c">
                  <input type="checkbox" :checked="t.on" :disabled="t.on && keptCount < 2"
                         :title="tabTitle(t)" @change="toggleTab(t)">
                  <button type="button" class="rmx-repl-prompt-s" :title="saveTitle(t)"
                          @click.stop="saveVariation(t.n)">＋</button>
                </div>
                <div class="rmx-repl-final-text" :title="t.title">
                  <template v-if="t.painted && t.painted.length"><span v-for="(s,si) in t.painted" :key="si"
                        :style="s.rule >= 0 ? { color: colorAt(s.rule) } : null"
                        :title="s.rule >= 0 ? 'from ' + (replacements[s.rule] || {}).from : null">{{ s.text }}</span></template>
                  <template v-else>{{ t.text || "(empty once the rules are applied)" }}</template>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </details>
  `,
};
