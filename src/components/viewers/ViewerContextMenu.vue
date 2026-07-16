<script setup>
// Small right-click context menu shared by the 3D and 2D (map) viewers. Purely
// presentational: the owner opens/closes it (via useContextMenu, which also wires
// the document-click dismiss) and supplies the item list; a click emits the item id.
defineProps({
  menu:  { type: Object, default: null },   // { x, y } | null
  items: { type: Array,  default: () => [] }, // [{ id, label, active?, separator?, disabled? }]
})
const emit = defineEmits(['select'])
</script>

<template>
  <Teleport to="body">
    <div
      v-if="menu"
      class="viewer-ctx"
      :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
      @click.stop
      @contextmenu.prevent.stop
    >
      <template v-for="(it, i) in items" :key="it.id || i">
        <div v-if="it.separator" class="vctx-sep"></div>
        <button
          v-else
          class="vctx-item"
          :class="{ disabled: it.disabled }"
          :disabled="it.disabled"
          @click="!it.disabled && emit('select', it.id)"
        >
          <span class="vctx-check">{{ it.active ? '✓' : '' }}</span>{{ it.label }}
        </button>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.viewer-ctx {
  position: fixed;
  z-index: 60;
  min-width: 172px;
  padding: 4px;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
  user-select: none;
}
.vctx-item {
  display: flex;
  align-items: center;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  padding: 6px 10px 6px 4px;
  border-radius: 4px;
  cursor: pointer;
}
.vctx-item:hover { background: var(--hover-bg); }
.vctx-item.disabled { opacity: 0.4; cursor: default; }
.vctx-item.disabled:hover { background: none; }
.vctx-check {
  display: inline-block;
  width: 16px;
  text-align: center;
  color: var(--accent);
  flex-shrink: 0;
}
.vctx-sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--panel-border);
}
</style>
