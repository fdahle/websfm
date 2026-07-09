<script setup>
import { useContextMenu } from '../../../composables/useContextMenu.js'

const props = defineProps({
  open:       { type: Boolean, default: true },
  // [{ id, name, imageId, imageName, rings, enabled, source }]
  footprints: { type: Array,   default: () => [] },
})
const emit = defineEmits(['toggle', 'remove-footprint', 'jump-to-image'])

// Right-click a footprint row → context menu (Remove).
const { menu: fpCtx, open: openFpCtx, close: closeMenu } = useContextMenu()
function onFpRightClick(e, fp) {
  openFpCtx(e, { fp }, { w: 165, h: 44 })
}
function ctxRemove() { emit('remove-footprint', fpCtx.value.fp.id); closeMenu() }

// Click a row: jump to the linked image (if the footprint resolved to one).
function onRowClick(fp) {
  if (fp.imageId) emit('jump-to-image', { imageId: fp.imageId })
}
</script>

<template>
  <div class="section">
    <button class="section-hd" @click="emit('toggle')">
      <span class="chevron">{{ open ? '▾' : '▸' }}</span>
      <span class="section-name">Footprints</span>
      <span v-if="footprints.length" class="badge">{{ footprints.length }}</span>
    </button>
    <ul v-if="open" class="item-list">
      <li
        v-for="fp in footprints"
        :key="fp.id"
        class="list-item"
        :title="fp.imageName ? `Linked to ${fp.imageName}` : (fp.name || 'Footprint')"
        @click="onRowClick(fp)"
        @contextmenu="onFpRightClick($event, fp)"
      >
        <span class="item-name">{{ fp.name || fp.imageName || 'Footprint' }}</span>
        <span
          class="obs-badge"
          :class="{ unlinked: !fp.imageId }"
          :title="fp.imageId ? 'Linked to an image' : 'Not linked to any image'"
        >{{ fp.imageId ? '🔗' : '—' }}</span>
      </li>
    </ul>

    <!-- Footprint context menu -->
    <Teleport to="body">
      <div
        v-if="fpCtx"
        class="ctx-menu"
        :style="{ left: fpCtx.x + 'px', top: fpCtx.y + 'px' }"
        @click.stop
      >
        <button class="ctx-item danger" @click="ctxRemove">Remove footprint</button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped src="./sidebar-sections.css"></style>
<style scoped>
.obs-badge.unlinked { color: var(--text-dim); }
</style>
