// ── Prompts ────────────────────────────────────────────────────────────────
// The prompt library: a name, a category, and the text itself. It exists for the
// replacement rules — a rule whose "find" is [keyword] picks its replacement
// from here — so the two things a row must make easy are choosing the category
// and reading the whole text, which is why the box grows to its content instead
// of scrolling inside three rows.
//
// The list is the shared one from app/prompts.js, so a rule editor open in a
// dialog sees an edit here the moment it is saved.
import { showToast } from '../store.js';
import { promptLib, loadPrompts, savePrompts, newPromptId } from '../prompts.js';
import { autosize } from '../autosize.js';

const { ref, computed, onMounted } = window.Vue;

export default {
  name: 'PromptsView',
  directives: { autosize },
  setup() {
    const saving = ref(false);
    const newCat = ref('');
    const catOpen = ref(false);

    onMounted(() => loadPrompts());

    // Category order decides the order here and in every picker; anything filed
    // under a category that was removed still shows, under its own heading, so
    // it can be re-filed rather than quietly lost.
    const groups = computed(() => {
      const known = promptLib.categories;
      const out = known.map(c => ({ category: c, prompts: promptLib.prompts.filter(p => p.category === c) }));
      const orphans = promptLib.prompts.filter(p => !known.includes(p.category));
      if (orphans.length) out.push({ category: 'Uncategorised', prompts: orphans, orphan: true });
      return out;
    });

    async function persist(what) {
      if (saving.value) return;
      saving.value = true;
      try { await savePrompts(); if (what) showToast(what); }
      catch (e) { showToast('Could not save: ' + e.message, 5000); }
      finally { saving.value = false; }
    }

    function addPrompt(category) {
      promptLib.prompts.unshift({
        id: newPromptId(),
        name: '',
        category: category || promptLib.categories[0] || '',
        text: '',
      });
    }
    function removePrompt(p) {
      if (!window.confirm('Delete "' + (p.name || 'this prompt') + '"?')) return;
      const i = promptLib.prompts.indexOf(p);
      if (i >= 0) promptLib.prompts.splice(i, 1);
      persist('Prompt deleted');
    }
    function addCategory() {
      const name = newCat.value.trim();
      if (!name) return;
      if (promptLib.categories.includes(name)) { showToast('There is already a ' + name + ' category'); return; }
      promptLib.categories.push(name);
      newCat.value = '';
      persist('Category added');
    }
    function removeCategory(c) {
      const used = promptLib.prompts.filter(p => p.category === c).length;
      const msg = used
        ? 'Remove the ' + c + ' category? Its ' + used + ' prompt(s) stay, filed as Uncategorised until you move them.'
        : 'Remove the ' + c + ' category?';
      if (!window.confirm(msg)) return;
      promptLib.categories = promptLib.categories.filter(x => x !== c);
      persist('Category removed');
    }

    return {
      lib: promptLib, groups, saving, newCat, catOpen,
      addPrompt, removePrompt, addCategory, removeCategory, persist,
    };
  },
  template: `
    <div class="wf-page">
      <div class="wf-head">
        <router-link class="wf-back" to="/" title="Home">←</router-link>
        <h1 class="wf-title">Prompts</h1>
        <button class="wf-add" @click="addPrompt()" title="Add a prompt to the first category">＋ Add</button>
      </div>
      <div class="wf-blurb">
        Reusable prompt text, filed by category. A replacement rule written as
        <code>[keyword]</code> picks its replacement from this list.
      </div>

      <div class="pr-cats">
        <button class="pr-cat-toggle" :class="{ on: catOpen }" @click="catOpen = !catOpen">
          {{ lib.categories.length }} categor{{ lib.categories.length === 1 ? 'y' : 'ies' }} {{ catOpen ? '▲' : '▼' }}
        </button>
        <div v-if="catOpen" class="pr-cat-edit">
          <span v-for="c in lib.categories" :key="c" class="pr-cat-chip">
            {{ c }}<button class="pr-cat-x" :title="'Remove ' + c" @click="removeCategory(c)">✕</button>
          </span>
          <span class="pr-cat-new">
            <input class="wf-map-sel" v-model="newCat" placeholder="New category" @keydown.enter="addCategory">
            <button class="wf-add" :disabled="!newCat.trim()" @click="addCategory">Add</button>
          </span>
        </div>
      </div>

      <div v-if="!lib.loaded" class="loading"><div class="spinner"></div> Loading…</div>
      <div v-else-if="lib.error" class="loading">{{ lib.error }}</div>
      <div v-else-if="!lib.prompts.length" class="loading">
        No prompts yet — ＋ Add writes the first one.
      </div>

      <div v-for="g in groups" :key="g.category" class="pr-group">
        <div class="pr-group-head">
          <span class="pr-group-name">{{ g.category }}</span>
          <span class="rmx-mut">{{ g.prompts.length }}</span>
          <button v-if="!g.orphan" class="btn-sm-add" :title="'Add a prompt to ' + g.category" @click="addPrompt(g.category)">＋</button>
        </div>
        <div v-for="p in g.prompts" :key="p.id" class="pr-row">
          <div class="pr-row-top">
            <input class="pr-name" v-model="p.name" placeholder="Name — what the dropdown shows" @change="persist()">
            <select class="pr-cat" v-model="p.category" @change="persist()">
              <option v-for="c in lib.categories" :key="c" :value="c">{{ c }}</option>
              <option v-if="g.orphan" :value="p.category">{{ p.category || '(none)' }}</option>
            </select>
            <button class="pr-del" title="Delete this prompt" @click="removePrompt(p)">🗑</button>
          </div>
          <textarea v-autosize class="pr-text" rows="2" v-model="p.text"
                    placeholder="The text this prompt stands for" @change="persist()"></textarea>
        </div>
      </div>
    </div>
  `,
};
