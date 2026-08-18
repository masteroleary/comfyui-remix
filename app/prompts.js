// ── Prompt library ─────────────────────────────────────────────────────────
// Named blocks of prompt text, filed under a category. The Prompts page edits
// them; the replacement rules consume them — a rule whose "find" is written as
// [keyword] takes its replacement from here instead of free text, so a graph can
// say [female] and mean whichever character prompt is picked today.
//
// Module state, like the replacement rules themselves: one list for the whole
// app, loaded once, so the page and every rule editor are looking at the same
// objects rather than three copies that drift.
import { api } from './api.js';

const { reactive, computed } = window.Vue;

export const promptLib = reactive({ categories: [], prompts: [], loaded: false, error: '' });

let loading = null;
export function loadPrompts(force) {
  if (!force && (promptLib.loaded || loading)) return loading || Promise.resolve();
  loading = api.prompts().then(d => {
    promptLib.categories = (d && d.categories) || [];
    promptLib.prompts = (d && d.prompts) || [];
    promptLib.loaded = true;
    promptLib.error = '';
  }).catch(e => {
    promptLib.error = e.message;
    promptLib.loaded = true;      // an empty library is a usable one
  }).finally(() => { loading = null; });
  return loading;
}

// Whole-list save, matching the endpoint: the editor holds the list, so a row it
// dropped stays dropped rather than being merged back in from the server's copy.
export function savePrompts() {
  return api.savePrompts({ categories: promptLib.categories, prompts: promptLib.prompts });
}

// Ids are only needed to tell two same-named prompts apart in a <select>.
export const newPromptId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// Grouped for the pickers: category order follows the category list, and
// anything filed under a category that has since been removed lands in a
// trailing group rather than vanishing from the UI that could fix it.
export const promptsByCategory = computed(() => {
  const groups = new Map(promptLib.categories.map(c => [c, []]));
  const orphans = [];
  for (const p of promptLib.prompts) {
    const g = groups.get(p.category);
    if (g) g.push(p); else orphans.push(p);
  }
  const out = [...groups.entries()].map(([category, prompts]) => ({ category, prompts }));
  if (orphans.length) out.push({ category: 'Uncategorised', prompts: orphans });
  return out.filter(g => g.prompts.length);
});

// What a [keyword] rule substitutes: the prompt's text, found by id.
export const promptTextById = id => {
  const p = promptLib.prompts.find(x => x.id === id);
  return p ? p.text : '';
};
