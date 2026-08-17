'use strict';
// Shared front-end guards, loaded by every page of the app.
//
// ── Backdrop clicks must START on the backdrop ──────────────────────────────
// Drag-selecting text inside a dialog (a Width value, a folder name, a path)
// and releasing the button past the dialog's edge makes the browser fire ONE
// click on the nearest common ancestor of press and release — the backdrop.
// Every "click outside to close" handler reads that as a deliberate outside
// click and closes the dialog mid-selection, losing whatever was typed.
//
// A real backdrop click presses and releases on the backdrop itself. So: any
// element marked `data-backdrop` ignores a click whose press landed elsewhere.
// Marking is opt-in per element rather than global, because press-here /
// release-there is also how a wobbled click on a button with an inner icon or
// label reaches the button — those clicks are real and must still fire.
(function () {
  let pressTarget = null;
  const note = e => { pressTarget = e.target; };
  document.addEventListener('pointerdown', note, true);
  document.addEventListener('mousedown', note, true);   // fallback: no Pointer Events
  document.addEventListener('click', e => {
    const from = pressTarget;
    pressTarget = null;   // one press per click; keyboard-fired clicks have none
    const el = e.target;
    if (from && from !== el && el instanceof Element && el.hasAttribute('data-backdrop')) {
      e.stopPropagation();
    }
  }, true);
})();

// ── No zoom ────────────────────────────────────────────────────────────────
// `user-scalable=no` in the viewport meta is honoured by Chrome/Android and by
// iOS home-screen web apps, but iOS *Safari* has ignored it since iOS 10 — the
// only way to refuse a pinch there is to cancel the gesture events. Likewise a
// trackpad pinch on desktop arrives as ctrl+wheel, which no viewport tag stops.
// The CSS half (touch-action, text-size-adjust) lives in common.css.
(function () {
  // Safari-only. Cancelling `gesturestart` refuses the whole pinch.
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(type, e => e.preventDefault(), { passive: false });
  }
  // Second finger down = a pinch starting. Cancelled here rather than on
  // touchmove so the common single-touch scroll path keeps its passive
  // fast-path (touchstart fires once per gesture, touchmove fires per frame).
  document.addEventListener('touchstart', e => {
    if (e.touches.length > 1) e.preventDefault();
  }, { passive: false });
  // Trackpad pinch / ctrl+wheel. Keyboard zoom (ctrl +/-) is deliberately left
  // alone — browsers own that shortcut and it's the accessibility escape hatch.
  document.addEventListener('wheel', e => {
    if (e.ctrlKey) e.preventDefault();
  }, { passive: false });
})();
