// ── Media tile ─────────────────────────────────────────────────────────────
// One card in a media grid: a square thumbnail with its overlays, and an info
// bar beneath it. Lifted out of BrowseView so the Remix dialog's run outputs are
// the same object rather than a lookalike — they were a bare <img> in a 90px
// box, so a file you had just generated could not be opened, read or remixed the
// way the identical file could be one screen earlier in the browser.
//
// The tile decides nothing. It emits `open` (the thumbnail) and `remix` (the
// info bar) and leaves the meaning to the host: in the browser both are route
// changes, in the dialog they are a route change plus a close. Keeping that out
// of here is what lets one component serve both without knowing about either.
import { thumbUrl } from '../api.js';

const { computed } = window.Vue;

export default {
  name: 'MediaTile',
  props: {
    // The listing's own shape: { path, name, isDir/isImage/isVideo/isAudio,
    // size, thumb, v, thumbV, workflow, nsfw }. Anything missing simply doesn't
    // render — a caller with only half the fields gets a plainer tile, not a
    // broken one.
    item: { type: Object, required: true },
    selected: { type: Boolean, default: false },
    // Hosts that act on a set of files (the inspect page's outputs) turn this
    // on. It is a span rather than a checkbox because the tile is a <button>,
    // and a real input nested in one is invalid and swallows its own clicks.
    selectable: { type: Boolean, default: false },
  },
  emits: ['open', 'remix', 'toggle'],
  setup(props) {
    const canRemix = computed(() => !props.item.isDir && !!(props.item.isImage || props.item.isVideo));
    // Folders are excluded rather than tested for a dot, or a folder named
    // "v1.5" would claim an extension of "5".
    const ext = computed(() => {
      const it = props.item;
      return !it.isDir && it.name && it.name.includes('.') ? it.name.split('.').pop().toLowerCase() : '';
    });
    const extColor = computed(() => {
      const it = props.item;
      return it.isVideo ? 'var(--video)' : it.isImage ? 'var(--image)'
        : it.isAudio ? 'var(--audio)' : 'var(--text3)';
    });
    // The [keyword]s this file's embedded workflow still holds, already narrowed
    // by the server to the ones this install has a rule for.
    const hasKw = computed(() => !!(props.item.keywords || []).length);
    const kwTitle = computed(() => {
      const k = props.item.keywords || [];
      if (!k.length) return '';
      return 'Its workflow still holds ' + k.join(' ')
        + ' — remixing this file can start from the template rather than the prompt it resolved to';
    });
    return { canRemix, ext, extColor, thumbUrl, hasKw, kwTitle };
  },
  template: `
    <button class="card" :class="{ 'is-dir': item.isDir, 'is-selected': selected }" @click="$emit('open')">
      <span class="card-thumb">
        <span v-if="selectable" class="card-cb" :class="{ on: selected }"
              :title="selected ? 'Deselect' : 'Select'" @click.stop="$emit('toggle')">{{ selected ? '✓' : '' }}</span>
        <span class="card-icon" v-if="item.isDir">📁</span>
        <img v-else-if="item.thumb || item.isImage" loading="lazy"
             :src="thumbUrl(item.path, item.thumbV || item.v)" :alt="item.name">
        <span class="card-icon" v-else>{{ item.isVideo ? '🎬' : item.isAudio ? '🎵' : '📄' }}</span>
        <!-- A video thumbnail is a still: without the marker it reads as an image. -->
        <span v-if="item.isVideo" class="play-overlay"><span class="play-circle">
          <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></span></span>
        <span v-if="ext" class="ext-badge" :style="{ color: extColor }">{{ ext }}</span>
        <!-- Both flags ride along on every listing already; the tile is where
             they are worth anything, since the alternative is opening the file
             to find out whether it carries a graph. -->
        <span v-if="item.workflow || item.nsfw || hasKw" class="card-tags">
          <span v-if="item.workflow" class="card-tag" title="Has an embedded workflow">wf</span>
          <!-- The embedded workflow still holds the [keyword]s it was written
               with — the rules only ever rewrite the graph that executes, so a
               remix of this file can start from the template rather than from
               the sentence it resolved to. -->
          <span v-if="hasKw" class="card-tag kw" :title="kwTitle">[kw]</span>
          <span v-if="item.nsfw" class="card-tag nsfw" title="Prompt matched the content filter">18+</span>
        </span>
      </span>
      <span class="card-info" :class="{ 'is-remix': canRemix }"
            :title="canRemix ? 'Remix ' + item.name : item.name"
            @click.stop="$emit('remix')">
        <span class="card-info-text">
          <span class="card-name">{{ item.name }}</span>
          <span v-if="item.size" class="card-meta">{{ item.size }}</span>
        </span>
        <span v-if="canRemix" class="meta-badge" title="Remix this workflow">
          <svg viewBox="0 0 24 24"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>
        </span>
      </span>
    </button>
  `,
};
