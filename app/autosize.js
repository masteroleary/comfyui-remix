// ── autosize ───────────────────────────────────────────────────────────────
// A textarea that grows to its content instead of scrolling inside a fixed few
// rows. Lifted out of WorkflowFields when the Prompts page needed the same
// behaviour: prompt text is the one thing in this app people paste paragraphs
// of, and a 2-row box is where those paragraphs go to hide.
export function fitTextarea(el) {
  if (!el) return;
  // offsetParent is null on a v-show'd tab, where scrollHeight reads 0 and this
  // would collapse the box to nothing. Leave it; the focus handler refits.
  if (el.offsetParent === null) return;
  // Height must go to 'auto' first or scrollHeight only ever reports the height
  // it already has, and the box can then grow but never shrink.
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

export const autosize = {
  mounted(el) {
    el.addEventListener('input', () => fitTextarea(el));
    el.addEventListener('focus', () => fitTextarea(el));
    fitTextarea(el);
  },
  // Covers the value changing from outside the box — loading a workflow's saved
  // prompt, or a shortcut being applied.
  updated(el) { fitTextarea(el); },
};
