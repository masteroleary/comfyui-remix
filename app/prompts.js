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

// ── Matching a keyword to the library ──────────────────────────────────────
// A [keyword] rule's picker lists what the keyword asks for rather than the
// whole library: [female] offers the Female shelf, [scene] the Scene one. The
// category is what decides it — that is what a category is for here — and a
// prompt's own name is the second chance, so a "Female Elf" filed under
// Characters still turns up. Folding drops case, spaces, punctuation and a
// trailing plural, because [scene] and a category called "Scenes" are the same
// intent spelled twice.
const foldKey = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/s$/, '');

export function promptsMatching(keyword, keepId) {
  const all = promptsByCategory.value;
  const k = foldKey(keyword);
  if (!k) return { groups: all, filtered: false, keyword: '' };
  // A category the keyword names outright wins on its own, before any of the
  // containment below is tried. "Female" contains "male", so containment alone
  // offers the Female shelf to [male] and — the reverse test being just as
  // true — the Male shelf to [female]. An exact match is the keyword naming one
  // shelf and meaning it, and nothing looser should be able to widen that.
  // Falling through rather than returning here: whatever is already picked still
  // has to survive the narrowing, and that is handled once, below.
  const exact = all.filter(g => foldKey(g.category) === k);
  const groups = exact.length ? exact : all.map(g => {
    const c = foldKey(g.category);
    // A category the keyword names hands over its whole shelf. The reverse
    // containment ([female-lead] finding "Female") needs a category long
    // enough to mean something, or a two-letter one matches every keyword.
    if (c && (c.includes(k) || (c.length >= 3 && k.includes(c)))) return g;
    const prompts = g.prompts.filter(p => foldKey(p.name).includes(k));
    return prompts.length ? { category: g.category, prompts } : null;
  }).filter(Boolean);
  // A keyword nothing answers to would leave an empty dropdown and no way out
  // of it, so fall back to the whole library rather than to a dead end.
  if (!groups.length) return { groups: all, filtered: false, keyword };
  // Whatever is already picked stays pickable wherever it is filed, or a rule
  // with a prompt behind it would render as though nothing were chosen.
  if (keepId && !groups.some(g => g.prompts.some(p => p.id === keepId))) {
    const p = promptLib.prompts.find(x => x.id === keepId);
    if (p) groups.push({ category: (p.category || 'Uncategorised') + ' (picked)', prompts: [p] });
  }
  return { groups, filtered: true, keyword };
}

// What a [keyword] rule substitutes: the prompt's text, found by id.
export const promptTextById = id => {
  const p = promptLib.prompts.find(x => x.id === id);
  return p ? p.text : '';
};
