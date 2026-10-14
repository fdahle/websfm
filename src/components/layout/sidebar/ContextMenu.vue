<script setup>
import { useMenuPlacement } from '../../../composables/useMenuPlacement.js'

// The sidebar's right-click menu shell: teleported to <body>, opened at the cursor
// and kept on screen by its measured size. `menu` is useContextMenu's ref value
// (`{ x, y, … }` or null); the items go in the default slot, which receives it.
const props = defineProps({
  menu: { type: Object, default: null },
})
const { el, pos } = useMenuPlacement(() => props.menu)
</script>

<template>
  <Teleport to="body">
    <div v-if="menu" ref="el" class="ctx-menu" :style="pos" @click.stop>
      <slot :menu="menu" />
    </div>
  </Teleport>
</template>

<style scoped>
.ctx-menu {
  position: fixed;
  z-index: 300;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  padding: 4px;
  min-width: 165px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
}
</style>
