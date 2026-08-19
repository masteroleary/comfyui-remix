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
import { applyReplacements } from '../replacements.js';
import { promptLib, loadPrompts, promptsMatching } from '../prompts.js';

const { computed, onMounted } = window.Vue;

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
    const finalPrompt = computed(() => applyReplacements(props.prompt || ''));
    const changed = computed(() => finalPrompt.value !== (props.prompt || ''));
    return {
      finalPrompt, changed, promptOptions,
      replacements, saveReplacements, replActiveCount, replAllOn,
      isKeywordRule, promptLib,
      addRepl, delRepl, swapRepl, toggleReplAll, pickPrompt,
    };
  },
  template: `
    <details class="rmx-repl">
      <summary>Prompt Replacements<span class="rmx-mut" v-if="replActiveCount"> — {{ replActiveCount }} active</span><span class="rmx-mut" v-else-if="replacements.length"> — {{ replacements.length }} off</span></summary>
      <div class="rmx-repl-body">
        <div class="rmx-mut" style="font-size:12px;margin-bottom:8px">
          Applied to the prompt right before each run (case-insensitive, all matches).
          Shared by the dialog and the inspect page. Write the find as
          <code>[keyword]</code> to replace it with a prompt from the library.
          Anything left in brackets that no enabled rule claims is dropped before the run.
        </div>
        <label class="rmx-repl-all"><input type="checkbox" :checked="replAllOn" @change="toggleReplAll"> Toggle all on/off</label>
        <div v-for="(r,i) in replacements" :key="i" class="rmx-repl-row">
          <input type="checkbox" v-model="r.on" @change="saveReplacements" title="Enable this rule">
          <input type="text" class="rmx-inp" placeholder="find, or [keyword]" v-model="r.from" @change="saveReplacements">
          <button type="button" class="rmx-btn2 rmx-repl-swap" title="Swap words"
                  :disabled="isKeywordRule(r)" @click="swapRepl(r)">⇄</button>
          <!-- [keyword]: pick from the library instead of typing. -->
          <select v-if="isKeywordRule(r)" class="rmx-inp" :value="r.promptId || ''"
                  :title="r.to || 'Pick a prompt'" @change="pickPrompt(r, $event.target.value)">
            <option value="">{{ promptOptions[i].filtered ? '— pick a ' + promptOptions[i].keyword + ' prompt —' : '— pick a prompt —' }}</option>
            <optgroup v-for="g in promptOptions[i].groups" :key="g.category" :label="g.category">
              <option v-for="p in g.prompts" :key="p.id" :value="p.id">{{ p.name || '(unnamed)' }}</option>
            </optgroup>
          </select>
          <input v-else type="text" class="rmx-inp" placeholder="replace with" v-model="r.to" @change="saveReplacements">
          <button type="button" class="rmx-repl-del" title="Delete rule" @click="delRepl(i)">✕</button>
        </div>
        <div v-if="replacements.some(isKeywordRule) && !promptLib.prompts.length" class="rmx-mut" style="font-size:12px;margin-top:6px">
          The prompt library is empty — add some on the Prompts page and they show up here.
        </div>
        <button type="button" class="rmx-btn2" style="margin-top:6px" @click="addRepl">＋ Add replacement</button>

        <div v-if="prompt" class="rmx-repl-final">
          <div class="rmx-lbl">Final prompt<span class="rmx-mut" v-if="!changed" style="text-transform:none"> — nothing to replace</span></div>
          <div class="rmx-repl-final-text">{{ finalPrompt || "(empty once the rules are applied)" }}</div>
        </div>
      </div>
    </details>
  `,
};
