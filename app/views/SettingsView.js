// ── Settings ───────────────────────────────────────────────────────────────
// Settings as routes rather than a dialog. /settings is a menu of the same
// three sections the old tab strip carried; /settings/:tab is one of them.
//
// SettingsPanel still owns every field, every load and the save — this view
// only decides which section it shows and where Back goes. Splitting the tabs
// across URLs is what makes them linkable and survivable across a reload, which
// a modal with internal tab state could never be.
import { store } from '../store.js';
import SettingsPanel from '../components/SettingsPanel.js';

const { computed } = window.Vue;
const { useRoute, useRouter } = window.VueRouter;

const SECTIONS = [
  { key: 'config',   icon: '🔧', label: 'Config',   sub: 'API keys, ComfyUI URL and folders' },
  { key: 'privacy',  icon: '🕶',  label: 'Privacy',  sub: 'Media caching and the content filter' },
  { key: 'security', icon: '🔒', label: 'Security', sub: 'Password gate for the whole app' },
];

export default {
  name: 'SettingsView',
  components: { SettingsPanel },
  setup() {
    const route = useRoute();
    const router = useRouter();

    // Unknown section falls back to the menu rather than rendering an empty
    // page, so a stale or hand-typed URL still lands somewhere useful.
    const tab = computed(() => {
      const t = route.params.tab;
      return SECTIONS.some(s => s.key === t) ? t : '';
    });
    const section = computed(() => SECTIONS.find(s => s.key === tab.value) || null);

    // Saving closes the section, which here means going back to the menu.
    const done = () => { router.push(tab.value ? { name: 'settings' } : { name: 'home' }); };

    return { store, SECTIONS, tab, section, done };
  },
  template: `
    <div class="home">
      <div class="set-view-head">
        <button class="set-view-back" @click="done">‹ {{ tab ? 'Settings' : 'Home' }}</button>
        <div class="set-view-title">{{ section ? section.label : 'Settings' }}</div>
      </div>

      <!-- Menu: the same three sections the dialog carried as tabs. -->
      <div v-if="!tab" class="home-tiles">
        <router-link v-for="sec in SECTIONS" :key="sec.key" class="home-tile"
                     :to="{ name: 'settings-tab', params: { tab: sec.key } }">
          <span class="home-tile-icon">{{ sec.icon }}</span>
          <span class="home-tile-label">{{ sec.label }}</span>
          <span class="home-tile-sub">{{ sec.sub }}</span>
        </router-link>
      </div>

      <!-- One section, rendered by the panel itself. open stays true because the
           route being here IS the open state. -->
      <SettingsPanel v-else :open="true" :page="true" :only="tab" @close="done" />
    </div>
  `,
};
