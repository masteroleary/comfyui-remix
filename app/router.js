// ── Routes ─────────────────────────────────────────────────────────────────
// History mode, so URLs are the real ones people already have bookmarked:
// /inspect?path=… keeps working. server.js
// hands any unmatched navigation back the app shell so a deep link or a refresh
// lands where it points instead of 404ing.
//
// The URL is the source of truth for what you're looking at — folder, page,
// search, sort, filter, and the open item. Before the rewrite none of that was in
// the URL: a refresh dropped you at home and Back left the app entirely.
const { createRouter, createWebHistory } = window.VueRouter;

export const routes = [
  { path: '/', name: 'home', component: () => import('./views/HomeView.js') },
  {
    // /browse/<root>/<nested/folder>. The root key names which media tree —
    // `fav` (the library) or `out` (ComfyUI output) — and :path(.*)* is a
    // repeated wildcard so nested folders keep their slashes.
    path: '/browse/:root(fav|out)?/:path(.*)*',
    name: 'browse',
    component: () => import('./views/BrowseView.js'),
    props: true,
  },
  // Same shape as /browse: root key + relative path. An absolute Windows path
  // here would put the server's layout in the address bar and break every
  // bookmark the day mediaDir moves.
  { path: '/view/:root(fav|out)/:path(.*)+', name: 'view', component: () => import('./views/ViewerView.js'), props: true },
  { path: '/inspect', name: 'inspect', component: () => import('./views/InspectView.js') },
  // The workflow library. A page rather than the Remix dialog's picker alone,
  // because the library is a property of the install, not of whichever file
  // happened to be open when you wanted to change it.
  { path: '/workflows', name: 'workflows', component: () => import('./views/WorkflowsView.js') },
  // Settings is routed rather than modal, so each section is linkable and
  // survives a reload. Both paths load the one view: bare = the section menu.
  { path: '/settings', name: 'settings', component: () => import('./views/SettingsView.js') },
  { path: '/settings/:tab', name: 'settings-tab', component: () => import('./views/SettingsView.js') },
  // Anything else is a mistyped URL rather than a page — send it home rather than
  // leaving a blank shell.
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior(to, from, saved) { return saved || { top: 0 }; },
});

// ── Paths ⇄ URLs ───────────────────────────────────────────────────────────
// The server speaks absolute paths, and on Windows they arrive with backslashes
// (D:\comfyui-remix\Media\foo) while the same path in a listing header comes back
// with forward ones. Normalise on the way in, and never let either form reach
// the address bar.
const norm = p => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
const under = (child, parent) => parent
  && (child.toLowerCase() === parent.toLowerCase() || child.toLowerCase().startsWith(parent.toLowerCase() + '/'));

export function splitRoot(abs, roots) {
  const a = norm(abs), out = norm(roots.out), fav = norm(roots.fav);
  // Check output first: it can sit inside the library tree, and the more
  // specific root has to win or its folders would address as library ones.
  if (under(a, out)) return { key: 'out', rel: a.slice(out.length + 1) };
  if (under(a, fav)) return { key: 'fav', rel: a.slice(fav.length + 1) };
  return { key: 'fav', rel: '' };
}
export function joinRoot(key, rel, roots) {
  const base = norm(key === 'out' ? roots.out : roots.fav);
  return rel ? base + '/' + rel : base;
}

// ── Route ⇄ store ──────────────────────────────────────────────────────────
// Read the browsing state out of a route. Kept here so the toolbar, the grid and
// the pager all agree on how a URL spells "page 3 of /Foo, videos only".
export function browseQuery(route, roots) {
  const q = route.query;
  const segs = Array.isArray(route.params.path) ? route.params.path : (route.params.path ? [route.params.path] : []);
  return {
    rootKey: route.params.root || 'fav',
    dir: joinRoot(route.params.root || 'fav', segs.join('/'), roots || { fav: '', out: '' }),
    page: Math.max(1, parseInt(q.page, 10) || 1),
    search: q.q || '',
    sort: ['date', 'name', 'size'].includes(q.sort) ? q.sort : 'date',
    asc: q.asc === '1',
    type: ['all', 'folder', 'video', 'image', 'audio'].includes(q.type) ? q.type : 'all',
    flatten: q.flatten === '1',
  };
}

// Build a browse location from an ABSOLUTE dir, dropping anything at its default
// so the common URL stays short (/browse/fav/Foo rather than
// /browse/fav/Foo?page=1&sort=date&asc=0&type=all).
export function browseTo(patch, base, roots) {
  const s = { page: 1, search: '', sort: 'date', asc: false, type: 'all', flatten: false, ...(base || {}), ...patch };
  const query = {};
  if (s.page > 1) query.page = String(s.page);
  if (s.search) query.q = s.search;
  if (s.sort !== 'date') query.sort = s.sort;
  if (s.asc) query.asc = '1';
  if (s.type !== 'all') query.type = s.type;
  if (s.flatten) query.flatten = '1';
  const { key, rel } = splitRoot(s.dir, roots || { fav: '', out: '' });
  const segs = rel ? rel.split('/').map(encodeURIComponent).join('/') : '';
  return { path: '/browse/' + key + (segs ? '/' + segs : ''), query };
}

// Build a viewer location from an ABSOLUTE file path.
// null when the file is under neither root — including the case where the roots
// simply are not loaded yet. The alternative is a route with an empty path
// segment, which /view/:root/:path(.*)+ rejects at push time; callers can say
// something useful instead of catching a router error.
export function viewTo(absPath, roots) {
  const { key, rel } = splitRoot(absPath, roots || { fav: '', out: '' });
  if (!rel) return null;
  return { name: 'view', params: { root: key, path: rel.split('/') } };
}
