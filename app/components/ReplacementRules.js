// ── Replacement rules ──────────────────────────────────────────────────────
// The editor for the global find→replace rules. One component, mounted by the
// Remix dialog and by the inspect page, over the one shared list — the rules
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
import {
  replacements, saveReplacements, replActiveCount, replAllOn, isKeywordRule, keywordOf,
} from '../replacements.js';
import { applyReplacements, paintReplacements, replacementGroups, replacementVariations } from '../replacements.js';
import { promptLib, loadPrompts, promptsMatching } from '../prompts.js';

const { computed, ref, onMounted } = window.Vue;

// The keywords a prompt actually carries. Brackets only, and never braces:
// {a|b} is ComfyUI's own dynamic-prompt syntax and this cannot tell one from a
// keyword. A token holding | or : is A1111 prompt editing ([from:to:step]) and
// is left alone for the same reason — the same exclusions applyReplacements
// makes when it sweeps up what no rule claimed.
const PROMPT_TOKEN = /\[[^[\]|:]+\]/g;
const foldTok = s => String(s == null ? '' : s).trim().toLowerCase();

// One colour per rule row, cycled. Picked to stay legible on the preview's near
// black and, more to the point, to stay apart from each other: the job is
// telling two neighbouring replacements apart at a glance, so adjacent entries
// are from different parts of the wheel rather than sorted into a gradient.
// The same colour marks the rule's own row, or a colour in the preview would be
// a colour with nothing to trace it back to.
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
  },
  setup(props) {
    // The library is only needed once a [keyword] rule exists, but it is two
    // fields and a fetch — cheaper to have it than to decide when to ask.
    onMounted(() => loadPrompts());

    // ── The keyword menu on "find" ──────────────────────────────────────
    // Clicking into the find box offers the keywords rather than leaving you to
    // remember and retype them. Typing still works — the list narrows to what
    // has been typed, so the box is a filter as much as a field.
    //
    // Two sections, in the order that matters: what THIS prompt contains comes
    // first, because a rule for one of those is the only kind that changes this
    // run. Everything else the app knows a keyword could be follows, marked,
    // since a rule naming a token the prompt does not carry is a rule that will
    // not fire — worth offering (the rules are global, and the prompt is about
    // to be edited) but not worth confusing with the ones that will.
    const menuFor = ref(-1);
    const openMenu = i => { menuFor.value = i; };
    const closeMenu = () => { menuFor.value = -1; };
    const promptKeywords = computed(() => {
      const seen = new Map();
      for (const m of String(props.prompt || '').match(PROMPT_TOKEN) || []) {
        const k = foldTok(m);
        if (!seen.has(k)) seen.set(k, { token: m.trim(), count: 0 });
        seen.get(k).count++;
      }
      return [...seen.values()];
    });
    // A library category IS a keyword — that is what a category is for here, and
    // promptsMatching resolves [scene] onto the Scene shelf — and a keyword
    // another rule already names is one this install demonstrably uses. Neither
    // is offered twice, and neither repeats anything the prompt already has.
    const otherKeywords = computed(() => {
      const have = new Set(promptKeywords.value.map(k => foldTok(k.token)));
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
    // Already spoken for by some rule — shown so the same keyword does not get a
    // second, competing row.
    const ruleFor = tok => replacements.some(r => foldTok(r.from) === foldTok(tok));
    // Narrowed by whatever is in the box. The brackets are stripped off the
    // query so half-typing "[fem" still finds [female].
    const menuList = computed(() => {
      const i = menuFor.value;
      const r = i >= 0 ? replacements[i] : null;
      if (!r) return { found: [], other: [] };
      const q = foldTok(r.from).replace(/[[\]{}]/g, '');
      const hit = e => !q || foldTok(e.token).includes(q);
      return { found: promptKeywords.value.filter(hit), other: otherKeywords.value.filter(hit) };
    });
    function chooseKeyword(r, tok) { r.from = tok; saveReplacements(); closeMenu(); }
    // Esc closes the menu and stops there. Un-stopped it would carry on to the
    // Remix dialog's window handler and close the whole dialog, which is a
    // long way from what dismissing a dropdown should cost. With no menu open
    // it is not ours, so it travels.
    function onFindEsc(e) {
      if (menuFor.value < 0) return;
      e.stopPropagation();
      closeMenu();
    }

    const addRepl = () => replacements.push({ from: '', to: '', on: true });
    const delRepl = i => { replacements.splice(i, 1); saveReplacements(); };
    const swapRepl = r => { const a = r.from; r.from = r.to; r.to = a; saveReplacements(); };
    const toggleReplAll = () => {
      const on = !replAllOn.value;
      replacements.forEach(r => { r.on = on; });
      saveReplacements();
    };
    function pickPrompt(r, id) {
      const p = promptLib.prompts.find(x => x.id === id);
      r.promptId = p ? p.id : '';
      // Snapshot the text too: the id is the live link, this is what anything
      // that does not know about the library still substitutes.
      r.to = p ? p.text : '';
      saveReplacements();
    }
    // The picker offers the shelf the keyword names, not the whole library:
    // [female] is a question, and answering it with every prompt on file is the
    // same as not having asked. One computed for the whole list rather than a
    // call per row, so a render walks the library once. A keyword nothing
    // matches falls back to everything — see promptsMatching.
    const promptOptions = computed(() => replacements.map(
      r => (isKeywordRule(r) ? promptsMatching(keywordOf(r), r.promptId) : null)
    ));
    // What the run will actually send: every enabled rule applied, then any
    // unclaimed [keyword] dropped. Shown rather than described, because the
    // difference between a rule that fired and one that quietly did not is
    // otherwise invisible until the image comes back wrong.
    // Variation one, not the whole rule list. With two rules enabled for the
    // same keyword the whole list is first-wins, which is a result no run
    // produces any more — the run fans out and this is the first of them.
    const variations = computed(() => replacementVariations());
    const firstVariation = computed(() => variations.value[0] || []);
    const finalPrompt = computed(() => applyReplacements(props.prompt || '', firstVariation.value));
    const changed = computed(() => finalPrompt.value !== (props.prompt || ''));
    // The same text again, cut into runs by which rule produced each one, so the
    // preview can colour what the rules put there. Null when the painted walk and
    // the real one disagree — see paintReplacements; the template falls back to
    // the plain string rather than showing a preview that is not the run.
    const painted = computed(() => paintReplacements(props.prompt || '', firstVariation.value));
    // A rule only earns a colour once it can actually fire; an off or half-typed
    // row contributes nothing to the preview and a lit dot beside it would be
    // pointing at text that is not there.
    const ruleLive = r => !!(r && r.on && r.from && String(r.from).trim());
    // ── Display order ───────────────────────────────────────────────────
    // Sorted for reading, never for running: applyReplacements walks the stored
    // list in order and a free-text rule can rewrite what an earlier one
    // produced, so the array itself is left exactly as it was typed. Each row
    // carries the index it really has, which is what every handler here keys on
    // — deleting, colouring, and which row the keyword menu belongs to.
    //
    // Alphabetical puts the several rules for one keyword next to each other,
    // which is the whole reason they need to be findable: they are variations of
    // each other and a run does one job per combination. A row with nothing
    // typed in it yet sorts last rather than to the top, or every new row would
    // jump away from the button that made it.
    const rows = computed(() => replacements
      .map((r, i) => ({ r, i }))
      .sort((a, b) => {
        const A = foldTok(a.r.from), B = foldTok(b.r.from);
        if (!A !== !B) return A ? -1 : 1;
        return A.localeCompare(B) || a.i - b.i;
      }));
    // How many rules share this one's keyword, and which of them this is — the
    // rows are adjacent after the sort, so a plain "2 of 3" is enough to read
    // the group off the list.
    const variantOf = computed(() => {
      const m = new Map();
      for (const g of replacementGroups()) {
        if (g.rules.length < 2) continue;
        g.rules.forEach((r, n) => m.set(r, { n: n + 1, of: g.rules.length }));
      }
      return m;
    });
    const variantTag = r => variantOf.value.get(r) || null;
    // Three states, not two. ruleLive is false for a rule that is switched off
    // AND for a row with nothing typed in it yet — telling someone their brand
    // new empty row to switch it on answers a question they did not ask, and
    // points at a checkbox that is already ticked.
    const dotTitle = r => (ruleLive(r)
      ? 'This rule’s colour in the preview below'
      : (r && r.from && String(r.from).trim())
        ? 'Switched on, this rule’s colour in the preview below'
        : 'This rule’s colour, once it has something to find');
    return {
      finalPrompt, changed, promptOptions,
      replacements, saveReplacements, replActiveCount, replAllOn,
      isKeywordRule, promptLib,
      addRepl, delRepl, swapRepl, toggleReplAll, pickPrompt,
      menuFor, openMenu, closeMenu, menuList, chooseKeyword, ruleFor, onFindEsc,
      painted, ruleColor, ruleLive, dotTitle, rows, variantTag, variations,
    };
  },
  template: `
    <details class="rmx-repl">
      <summary>Prompt Replacements<span class="rmx-repl-on" v-if="replActiveCount"> — {{ replActiveCount }} active</span><span class="rmx-mut" v-else-if="replacements.length"> — {{ replacements.length }} off</span></summary>
      <div class="rmx-repl-body">
        <div class="rmx-mut" style="font-size:12px;margin-bottom:8px">
          Applied to the prompt right before each run (case-insensitive, all matches).
          Shared by the dialog and the inspect page. Write the find as
          <code>[keyword]</code> to replace it with a prompt from the library.
          Anything left in brackets that no enabled rule claims is dropped before the run.
        </div>
        <!-- Two columns wherever there is room: the rules on the left, what they
             produce on the right, so an edit and its effect are beside each
             other rather than a scroll apart. One column below that width — see
             .rmx-repl-cols, which is single-column until the media query. -->
        <div class="rmx-repl-cols">
          <div class="rmx-repl-list">
            <label class="rmx-repl-all"><input type="checkbox" :checked="replAllOn" @change="toggleReplAll"> Toggle all on/off</label>
            <div v-for="e in rows" :key="e.i" class="rmx-repl-row">
              <span class="rmx-repl-dot" :class="{off: !ruleLive(e.r)}" :style="{ background: ruleColor(e.i) }"
                    :title="dotTitle(e.r)"></span>
              <input type="checkbox" v-model="e.r.on" @change="saveReplacements" title="Enable this rule">
              <span class="rmx-repl-find">
                <input type="text" class="rmx-inp" placeholder="find, or [keyword]" v-model="e.r.from"
                       @focus="openMenu(e.i)" @click="openMenu(e.i)" @blur="closeMenu" @keydown.esc="onFindEsc"
                       @change="saveReplacements">
                <!-- mousedown is prevented on the whole menu so the input keeps
                     focus: without it the blur above fires first and the row is
                     gone before the click on it lands. -->
                <div v-if="menuFor === e.i && (menuList.found.length || menuList.other.length)" class="rmx-kwmenu" @mousedown.prevent>
                  <div v-if="menuList.found.length" class="rmx-kwmenu-h">in this prompt</div>
                  <button v-for="k in menuList.found" :key="'f'+k.token" type="button" class="rmx-kw"
                          :title="'Replace ' + k.token + ' wherever it appears in the prompt'" @click="chooseKeyword(e.r, k.token)">
                    <span class="rmx-kw-tok">{{ k.token }}</span>
                    <span v-if="k.count > 1" class="rmx-mut" style="font-size:11px">×{{ k.count }}</span>
                    <span v-if="ruleFor(k.token)" class="rmx-kw-used">has a rule</span>
                  </button>
                  <div v-if="menuList.other.length" class="rmx-kwmenu-h">not in this prompt</div>
                  <button v-for="k in menuList.other" :key="'o'+k.token" type="button" class="rmx-kw off"
                          :title="k.token + ' is not in this prompt — a rule for it changes nothing until it is'" @click="chooseKeyword(e.r, k.token)">
                    <span class="rmx-kw-tok">{{ k.token }}</span>
                    <span v-if="ruleFor(k.token)" class="rmx-kw-used">has a rule</span>
                  </button>
                </div>
              </span>
              <button type="button" class="rmx-btn2 rmx-repl-swap" title="Swap words"
                      :disabled="isKeywordRule(e.r)" @click="swapRepl(e.r)">⇄</button>
              <!-- [keyword]: pick from the library instead of typing. -->
              <select v-if="isKeywordRule(e.r)" class="rmx-inp" :value="e.r.promptId || ''"
                      :title="e.r.to || 'Pick a prompt'" @change="pickPrompt(e.r, $event.target.value)">
                <option value="">{{ promptOptions[e.i].filtered ? '— pick a ' + promptOptions[e.i].keyword + ' prompt —' : '— pick a prompt —' }}</option>
                <optgroup v-for="g in promptOptions[e.i].groups" :key="g.category" :label="g.category">
                  <option v-for="p in g.prompts" :key="p.id" :value="p.id">{{ p.name || '(unnamed)' }}</option>
                </optgroup>
              </select>
              <input v-else type="text" class="rmx-inp" placeholder="replace with" v-model="e.r.to" @change="saveReplacements">
              <!-- One of several rules for the same keyword. They sort together,
                   so saying which of the group this is completes the picture. -->
              <span v-if="variantTag(e.r)" class="rmx-varn" :title="'One of ' + variantTag(e.r).of + ' variations for ' + e.r.from + ' — a run queues a job for each'">{{ variantTag(e.r).n }}/{{ variantTag(e.r).of }}</span>
              <span v-else class="rmx-varn-gap"></span>
              <button type="button" class="rmx-repl-del" title="Delete rule" @click="delRepl(e.i)">✕</button>
            </div>
            <div v-if="variations.length > 1" class="rmx-mut" style="font-size:12px;margin-top:8px">
              Rules sharing a keyword are variations of each other — a run queues one job per combination, <b>{{ variations.length }}</b> in all.
            </div>
            <div v-if="replacements.some(isKeywordRule) && !promptLib.prompts.length" class="rmx-mut" style="font-size:12px;margin-top:6px">
              The prompt library is empty — add some on the Prompts page and they show up here.
            </div>
            <button type="button" class="rmx-btn2" style="margin-top:6px" @click="addRepl">＋ Add replacement</button>
          </div>

          <div v-if="prompt" class="rmx-repl-final">
            <div class="rmx-lbl">Final prompt<span class="rmx-mut" v-if="!changed" style="text-transform:none"> — nothing to replace</span></div>
            <div class="rmx-repl-final-text">
              <template v-if="painted && painted.length"><span v-for="(s,si) in painted" :key="si"
                    :style="s.rule >= 0 ? { color: ruleColor(s.rule) } : null"
                    :title="s.rule >= 0 ? 'from ' + (replacements[s.rule] || {}).from : null">{{ s.text }}</span></template>
              <template v-else>{{ finalPrompt || "(empty once the rules are applied)" }}</template>
            </div>
          </div>
        </div>
      </div>
    </details>
  `,
};
