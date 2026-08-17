// ── Pager ──────────────────────────────────────────────────────────────────
// The page strip, rendered above and below the grid. Same window as the pre-SPA
// PagerApp — first, last, and two either side of the current page, with … for
// the gaps — but a page is a route now: the old go() called loadDir() and
// scrolled to the top by hand, while a push lands on ?page=N that BrowseView
// reloads from and the router's scrollBehavior already returns to the top.
//
// Reads store.page / store.pages, so both copies stay in step with no shared
// pagerState to feed.
import { store } from '../store.js';
import { browseQuery, browseTo } from '../router.js';

const { computed } = window.Vue;
const { useRoute, useRouter } = window.VueRouter;

export default {
  name: 'Pager',
  setup() {
    const route = useRoute();
    const router = useRouter();

    const items = computed(() => {
      const page = store.page, pages = store.pages;
      if (pages <= 1) return [];
      const out = [{ k: 'prev', label: '‹', p: page - 1, disabled: page === 1 }];
      const nums = new Set([1, pages]);
      for (let p = Math.max(2, page - 2); p <= Math.min(pages - 1, page + 2); p++) nums.add(p);
      let prev = 0;
      for (const p of [...nums].sort((a, b) => a - b)) {
        if (p - prev > 1) out.push({ k: 'd' + p, dots: true });
        out.push({ k: 'n' + p, label: String(p), p, cur: p === page });
        prev = p;
      }
      out.push({ k: 'next', label: '›', p: page + 1, disabled: page === pages });
      return out;
    });

    function go(p) {
      if (!p || p < 1 || p > store.pages || p === store.page) return;
      router.push(browseTo({ page: p }, browseQuery(route, store.roots), store.roots));
    }

    return { items, go };
  },
  template: `
    <div class="pager" v-if="items.length">
      <template v-for="it in items" :key="it.k">
        <span v-if="it.dots" class="pg-dots">…</span>
        <button v-else class="pg-btn" :class="{cur: it.cur}" :disabled="it.disabled" @click="go(it.p)">{{ it.label }}</button>
      </template>
    </div>
  `,
};
