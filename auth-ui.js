'use strict';
// Logout control, shared by every page.
//
// The lock screen is rendered by the server in place of whatever page was asked
// for, so any page that actually runs is already past the gate. All this does is
// reveal that page's #logoutBtn when a password is in use (there's nothing to log
// out of otherwise) and wire it to drop the session cookie.
//
// Both halves work through the document rather than through the button element:
// index.html's copy sits inside a Vue in-DOM template, and Vue discards the
// original node on mount and builds a fresh one. A reference captured at load
// time — or an inline style set on it — belongs to the node that got thrown away.
// So: visibility comes from a class on <html> (see common.css) and the click is
// delegated. See [[vue-reactivity-gotcha]] for the same class of trap.
(function () {
  function refresh() {
    return fetch('/api/auth/status', { credentials: 'same-origin' })
      .then(r => r.json())
      .then(s => { document.documentElement.classList.toggle('auth-on', !!(s && s.enabled)); })
      .catch(() => {});
  }
  // Called by Settings after saving, so turning protection on or off shows and
  // hides the button without a reload.
  window.refreshAuthUi = refresh;
  refresh();

  document.addEventListener('click', e => {
    const btn = e.target && e.target.closest && e.target.closest('#logoutBtn');
    if (!btn) return;
    // Safe mode back on, before anything else. It is a per-browser preference in
    // localStorage, and the logout response only clears the *cache*
    // (Clear-Site-Data: "cache") -- so a session that turned the filter off used to
    // hand that state to whoever unlocked the browser next. Putting it back is also
    // putting it to its default, so this cannot surprise anyone in the other
    // direction. Done before the request, and outside its promise, so it happens
    // even when the POST fails and we reload anyway.
    //
    // The key is spelled out here rather than imported: this file is a plain script
    // shared by every page, not an ES module, so it cannot reach app/store.js. That
    // is the other end of this string -- see readLs('archiveSafe') there.
    try { localStorage.setItem('archiveSafe', '1'); } catch (err) { /* private mode, blocked storage */ }
    // Reload either way: on success the server answers the next request with the
    // lock screen, and on failure the reload surfaces whatever state we're in.
    fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
      .then(() => location.reload(), () => location.reload());
  });
})();
