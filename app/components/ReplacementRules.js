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
  reachableRules, replacementText, isVariationSkipped, setVariationSkipped } from '../replacements.js';
import { promptLib, loadPrompts, promptsMatching } from '../prompts.js';

const { computed, ref, onMounted } = window.Vue;

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
    // The prompt as it stands in the form. Given, not injected: this renders in
    // the host's slot, so its component parent is the host rather than the form
    // that owns the field.
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
    const rowsRaw = computed(() => groupsOf().map(row => {
      const r0 = row.rules[0];
      const picked = row.rules.filter(r => r.promptId).map(r => ({
        rule: r, id: r.promptId, name: promptName(r.promptId) || oneLine(r.to) || '(missing)',
      }));
      return Object.assign(row, {
        from: String(r0.from == null ? '' : r0.from),
        on: row.rules.every(r => r.on),
        picked,
        pickedIds: new Set(picked.map(p => p.id)),
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
    const promptKeywords = computed(() => {
      const seen = new Map();
      for (const m of String(props.prompt || '').match(PROMPT_TOKEN) || []) {
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
          if (!k || have.has(k) || seen.has(k)) continue;
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
        if (!k || k === '[]' || have.has(k) || seen.has(k)) return;
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
    const delRow = (row) => {
      for (const r of row.rules) {
        const i = replacements.indexOf(r);
        if (i >= 0) replacements.splice(i, 1);
      }
      saveReplacements();
    };
    const setFrom = (row, v) => { for (const r of row.rules) r.from = v; };
    const toggleRow = (row) => { const on = !row.on; for (const r of row.rules) r.on = on; saveReplacements(); };
    const swapRow = (row) => {
      const r = row.rules[0];
      const a = r.from; r.from = r.to; r.to = a;
      saveReplacements();
    };
    const toggleReplAll = () => {
      const on = !replAllOn.value;
      replacements.forEach(r => { r.on = on; });
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
      return row.picked.length
        ? row.picked.length + ' answer' + (row.picked.length === 1 ? '' : 's') + ' for ' + kw
          + (row.picked.length > 1 ? ' — a run queues a job for each' : '') + '. Click to change.'
        : 'Pick what ' + kw + ' is replaced with — tick as many as you like, and a run queues a job for each.';
    };

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
    const variations = computed(() => replacementVariations(scopeText.value));
    const vIdx = ref(0);
    // Clamped on read rather than watched and reset. Editing a rule reshapes the
    // list under the cursor — unticking one answer collapses six prompts back
    // into three — and an index left past the end would paint nothing at all.
    const vSel = computed(() => Math.min(Math.max(vIdx.value, 0), Math.max(variations.value.length - 1, 0)));
    const pickVariation = n => { vIdx.value = n; };
    const variation = computed(() => variations.value[vSel.value] || []);
    const finalPrompt = computed(() => applyReplacements(props.prompt || '', variation.value));
    // The same text again, cut into runs by which rule produced each one, so the
    // preview can colour what the rules put there. Null when the painted walk and
    // the real one disagree — see paintReplacements; the template falls back to
    // the plain string rather than showing a preview that is not the run.
    const painted = computed(() => paintReplacements(props.prompt || '', variation.value));
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
    function onPanelToggle(e) { if (e.target.open) snapshotOrder(); }
    const rows = computed(() => {
      const order = sortOrder.value;
      const list = rowsRaw.value.slice();
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
      return new Set(replacementGroups(scopeText.value).filter(g => g.live).map(g => g.key));
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
    // In the order the rows are listed, not the order the rules are stored. The
    // rows are what is on screen — the keyword list beside these tabs, read top
    // to bottom — so a tab that names its picks in any other order is asking you
    // to match them up by colour. Reading down the rows and along a tab now give
    // the same sequence, which is also the order the palette runs in, since the
    // colours are handed out down that same list.
    //
    // Sorting the filtered copy, never the variation itself: that array is the
    // rule list a run applies, and its order is the order they execute in.
    const rowAt = (r) => {
      const n = colorIdx.value.get(r);
      return n == null ? Infinity : n;
    };
    const picksFor = (v) => {
      const live = reachableRules(scopeText.value, v);
      return v.filter(r => isKeywordRule(r) && live.has(r))
        .sort((a, b) => rowAt(a) - rowAt(b))
        .map(r => ({
          i: replacements.indexOf(r), from: String(r.from).trim(),
          title: ruleTitle(r), full: oneLine(replacementText(r)),
        }));
    };
    // Only the groups that vary name a tab. The rules every combination shares
    // are in all of them, so repeating those in each tooltip says nothing about
    // which tab is which.
    const varyingKeys = computed(() => new Set(
      replacementGroups(scopeText.value).filter(g => g.live && g.rules.length > 1).map(g => g.key)
    ));
    const tabs = computed(() => variations.value.map((v, n) => ({
      n,
      label: 'Prmpt ' + (n + 1),
      picks: picksFor(v),
      on: !isVariationSkipped(v),
      // The hover names the keywords the visible titles answer, and only the
      // ones that vary: the rules every combination shares are in all of them,
      // so repeating those in each tooltip says nothing about which tab is which.
      title: v.filter(r => varyingKeys.value.has(foldTok(r.from)))
        .map(r => String(r.from).trim() + ' → ' + ruleTitle(r)).join(' · ')
        || 'The prompt with every rule applied',
    })));
    const keptCount = computed(() => tabs.value.filter(t => t.on).length);
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
      finalPrompt, replacements, saveReplacements, replAllOn, activeRows, promptLib,
      idleRows, idleTitle, rowReaches,
      rows, rowColor, rowLive, dotTitle, colorAt, ruleColor,
      addRepl, delRow, setFrom, toggleRow, swapRow, toggleReplAll,
      menuFor, openMenu, closeMenu, menuList, chooseKeyword, ruleFor, onFindEsc,
      valFor, openVals, closeVals, valMenu, toggleVal, valLabel, valTitle, oneLine,
      painted, variations, onPanelToggle,
      tabs, vSel, pickVariation, keptCount, toggleTab, tabTitle,
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
      <summary>Prompt Replacements<span class="rmx-repl-on" v-if="activeRows"> — {{ activeRows }} active</span><span class="rmx-mut" v-else-if="rows.length && !idleRows.length"> — {{ rows.length }} off</span><span class="rmx-repl-idle" v-if="idleRows.length" :title="idleTitle">{{ activeRows ? ', ' : ' — ' }}{{ idleRows.length }} ignored</span><span class="rmx-repl-jobs" v-if="variations.length > 1">, {{ keptCount }} job{{ keptCount === 1 ? '' : 's' }} total</span></summary>
      <div class="rmx-repl-body">
        <div class="rmx-mut" style="font-size:12px;margin-bottom:8px">
          Applied to the prompt right before each run (case-insensitive, all matches).
          Shared by the dialog and the inspect page. Write the find as
          <code>[keyword]</code> to replace it with prompts from the library — tick
          as many answers as you like, and a run queues a job for each.
          Anything left in brackets that no enabled rule claims is dropped before the run.
        </div>
        <!-- Two columns wherever there is room: the rules on the left, what they
             produce on the right, so an edit and its effect are beside each
             other rather than a scroll apart. One column below that width — see
             .rmx-repl-cols, which is single-column until the media query. -->
        <div class="rmx-repl-cols">
          <div class="rmx-repl-list">
            <label class="rmx-repl-all"><input type="checkbox" :checked="replAllOn" @change="toggleReplAll"> Toggle all on/off</label>
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
                  <span v-if="row.picked.length > 1" class="rmx-valbtn-n">{{ row.picked.length }}</span>
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
                      <label v-for="p in g.prompts" :key="p.id" class="rmx-val">
                        <input type="checkbox" :checked="row.pickedIds.has(p.id)" @change="toggleVal(row, p)">
                        <span class="rmx-val-n">{{ p.name || '(unnamed)' }}</span>
                        <span class="rmx-val-t">{{ oneLine(p.text) }}</span>
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
            <button type="button" class="rmx-btn2" style="margin-top:6px" @click="addRepl">＋ Add replacement</button>
          </div>

          <div v-if="prompt" class="rmx-repl-final">
            <!-- One tab per combination the rules multiply out to, one per line,
                 each labelled with the titles it picked in the colours those
                 titles are about to appear in below. The run queues a job for
                 each, so this is the only place they can be read before they come
                 back as images. -->
            <div v-if="tabs.length > 1" class="rmx-repl-tabs">
              <!-- Two controls in one row: the box decides whether this prompt
                   runs, the titles decide which one is on screen. An unticked tab
                   still selects — you have to be able to read what you are
                   leaving out. -->
              <span v-for="t in tabs" :key="t.n" class="rmx-repl-tab" :class="{on: t.n === vSel, skip: !t.on}">
                <input type="checkbox" :checked="t.on" :disabled="t.on && keptCount < 2"
                       :title="tabTitle(t)" @change="toggleTab(t)">
                <button type="button" class="rmx-repl-tab-l" :title="t.title"
                        @click="pickVariation(t.n)">
                  <template v-if="t.picks.length"><span v-for="p in t.picks" :key="p.i"
                        :style="{ color: colorAt(p.i) }" :title="p.from + ' → ' + p.full">{{ p.title }}</span></template>
                  <template v-else>{{ t.label }}</template>
                </button>
              </span>
            </div>
            <div class="rmx-repl-final-text">
              <template v-if="painted && painted.length"><span v-for="(s,si) in painted" :key="si"
                    :style="s.rule >= 0 ? { color: colorAt(s.rule) } : null"
                    :title="s.rule >= 0 ? 'from ' + (replacements[s.rule] || {}).from : null">{{ s.text }}</span></template>
              <template v-else>{{ finalPrompt || "(empty once the rules are applied)" }}</template>
            </div>
          </div>
        </div>
      </div>
    </details>
  `,
};
