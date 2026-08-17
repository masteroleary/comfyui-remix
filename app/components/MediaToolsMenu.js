// ── Media tools flyout ─────────────────────────────────────────────────────
// The per-item tools menu, shared by the viewer's action row and the Remix
// dialog's Preview tab. In the pre-SPA page this was `window.MediaToolsMenu`, a
// global one page assigned and another read — which is exactly the coupling the
// rewrite is meant to remove, so it is a component both sides import.
import { showToast, reload } from '../store.js';
import { api } from '../api.js';

const { ref, onMounted, onBeforeUnmount } = window.Vue;

export default {
  name: 'MediaToolsMenu',
  props: {
    // { path, name, isVideo } — the shape both call sites already speak.
    item: { type: Object, required: true },
  },
  emits: ['done'],
  setup(props, { emit }) {
    const open = ref(false);
    const busy = ref(false);

    async function lastFrame() {
      if (busy.value) return;
      busy.value = true;
      try {
        // The endpoint reads `source`, not `path` — api.lastFrame sends the right one.
        const r = await api.lastFrame(props.item.path);
        showToast('✓ Saved the last frame' + (r && r.name ? ': ' + r.name : ''));
        await reload();
        emit('done', r);
      } catch (e) {
        showToast('Could not grab the last frame: ' + e.message, 5000);
      }
      busy.value = false;
      open.value = false;
    }

    // Dismissal has to run in the capture phase and stop the event: the viewer's
    // own Esc handler closes the whole modal and the Remix dialog's closes the
    // dialog, so the menu must win before either sees it. This is why the pre-SPA
    // component installed the same three listeners.
    const root = ref(null);
    function onOutside(e) {
      if (!open.value) return;
      if (root.value && root.value.contains(e.target)) return;
      open.value = false;
    }
    function onKey(e) {
      if (!open.value || e.key !== 'Escape') return;
      open.value = false;
      e.stopPropagation();
      e.preventDefault();
    }
    onMounted(() => {
      document.addEventListener('mousedown', onOutside, true);
      document.addEventListener('touchstart', onOutside, true);
      document.addEventListener('keydown', onKey, true);
    });
    onBeforeUnmount(() => {
      document.removeEventListener('mousedown', onOutside, true);
      document.removeEventListener('touchstart', onOutside, true);
      document.removeEventListener('keydown', onKey, true);
    });

    return { open, busy, lastFrame, root };
  },
  template: `
    <span class="tools-wrap" ref="root">
      <button class="viewer-act-btn m-tools" title="Tools" @click.stop="open = !open">⋯</button>
      <div v-if="open" class="tools-menu" @click.stop>
        <button v-if="item.isVideo" class="tools-item" :disabled="busy" @click="lastFrame">
          {{ busy ? 'Working…' : '🖼 Save last frame' }}
        </button>
        <div v-else class="tools-item tools-item-empty">No tools for this file type</div>
      </div>
    </span>
  `,
};
