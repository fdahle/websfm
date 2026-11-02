<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { useTabDrag } from '../../composables/useTabDrag.js'
import TabContextMenu from '../layout/TabContextMenu.vue'

// The tab strip of the Guide and the Glossary: a fixed Home tab, then one tab per
// opened article or term, which scroll. As the workspace's tabs: drag a tab to move
// it, right-click for Close others / to the left / to the right / all.
const props = defineProps({
  tabs: { type: Array, required: true }, // [{ id, title }]
  activeId: { type: String, required: true }, // 'home' or a tab id
})
const emit = defineEmits(['activate', 'close', 'move', 'close-others', 'close-left', 'close-right', 'close-all'])

const tabList = computed(() => props.tabs.map((t) => ({ ...t, closable: true })))
const {
  draggedTabId,
  dragOverTabId,
  onTabDragStart,
  onTabDragOver,
  onTabDrop,
  onTabDragEnd,
  tabCtx,
  onTabRightClick,
  closeTabCtx,
  tabCtxHasLeft,
  tabCtxHasRight,
  tabCtxHasOthers,
} = useTabDrag({ tabs: tabList, moveTab: (from, to) => emit('move', from, to) })

// A newly opened tab lands at the right of the strip, possibly past its edge: scroll
// it into view (scrollLeft, not scrollIntoView, so only the strip moves).
const tabScroll = ref(null)
watch(
  () => [props.activeId, props.tabs.length],
  async () => {
    if (props.activeId === 'home') return
    await nextTick()
    const strip = tabScroll.value
    const el = strip?.querySelector('.gtab.active')
    if (!el) return
    const sr = strip.getBoundingClientRect()
    const er = el.getBoundingClientRect()
    if (er.left < sr.left) strip.scrollLeft -= sr.left - er.left
    else if (er.right > sr.right) strip.scrollLeft += er.right - sr.right
  },
  { immediate: true },
)
</script>

<template>
  <div class="tab-strip" role="tablist">
    <button
      class="gtab gtab-home"
      :class="{ active: activeId === 'home' }"
      role="tab"
      @click="emit('activate', 'home')"
    >
      Home
    </button>
    <div ref="tabScroll" class="tab-scroll">
      <button
        v-for="t in tabList"
        :key="t.id"
        class="gtab"
        :class="{
          'active': activeId === t.id,
          'dragging': t.id === draggedTabId,
          'drag-over': t.id === dragOverTabId && t.id !== draggedTabId,
        }"
        role="tab"
        draggable="true"
        @click="emit('activate', t.id)"
        @contextmenu="onTabRightClick($event, t)"
        @dragstart="onTabDragStart($event, t)"
        @dragover="onTabDragOver($event, t)"
        @drop="onTabDrop(t)"
        @dragend="onTabDragEnd"
      >
        {{ t.title }}
        <span class="gtab-close" title="Close tab" @click.stop="emit('close', t.id)">×</span>
      </button>
    </div>
  </div>
  <TabContextMenu
    v-if="tabCtx"
    :x="tabCtx.x"
    :y="tabCtx.y"
    :has-others="tabCtxHasOthers"
    :has-left="tabCtxHasLeft"
    :has-right="tabCtxHasRight"
    @close="emit('close', tabCtx.id)"
    @close-others="emit('close-others', tabCtx.id)"
    @close-left="emit('close-left', tabCtx.id)"
    @close-right="emit('close-right', tabCtx.id)"
    @close-all="emit('close-all')"
    @dismiss="closeTabCtx"
  />
</template>

<style scoped>
/* Home sits outside the scroll area (fixed); only the opened tabs scroll. */
.tab-strip {
  display: flex;
  padding: 6px 0 0;
  border-bottom: 1px solid var(--panel-border);
  flex-shrink: 0;
}
.tab-scroll {
  display: flex;
  gap: 2px;
  flex: 1;
  min-width: 0;
  padding: 0 10px 0 8px;
  overflow-x: auto;
  /* overflow-x:auto alone makes the browser compute overflow-y to auto too,
     which adds a stray vertical scrollbar and fights touchpad h-scroll. */
  overflow-y: hidden;
  scrollbar-width: thin;
}
.gtab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  background: none;
  border: none;
  color: var(--text-dim);
  font: inherit;
  font-size: 12.5px;
  /* Extra bottom padding gives the thin horizontal scrollbar its own lane so it
     doesn't crowd the tab text. Active underline is an inset shadow (not a
     border) so it survives overflow-y:hidden without a negative-margin trick. */
  padding: 7px 10px 11px;
  cursor: pointer;
}
/* Home is fixed at the left, divided from the scrolling tabs by a thin rule. */
.gtab-home {
  flex-shrink: 0;
  padding-left: 12px;
  border-right: 1px solid var(--panel-border);
}
.gtab:hover:not(.active) {
  color: var(--text);
}
.gtab.active {
  color: var(--text);
  box-shadow: inset 0 -2px 0 var(--accent);
}
/* While dragging: the dragged tab fades, and an accent bar on the leading edge of
   the hovered tab marks the drop, as on the workspace's tabs. */
.gtab.dragging {
  opacity: 0.45;
}
.gtab.drag-over {
  box-shadow: inset 3px 0 0 var(--accent);
}
.gtab.active.drag-over {
  box-shadow:
    inset 3px 0 0 var(--accent),
    inset 0 -2px 0 var(--accent);
}
.gtab-close {
  font-size: 13px;
  line-height: 1;
  color: var(--text-dim);
  border-radius: 3px;
  padding: 0 2px;
}
.gtab-close:hover {
  background: var(--hover-bg);
  color: var(--text);
}
</style>
