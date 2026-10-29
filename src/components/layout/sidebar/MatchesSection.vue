<script setup>
import { ref } from 'vue'
import { useContextMenu } from '../../../composables/useContextMenu.js'
import ContextMenu from './ContextMenu.vue'
import { useSidebar } from './sidebarContext.js'
import { pluralize } from '../../../core/textFormat.js'

defineProps({
  open: { type: Boolean, default: true },
})
const emit = defineEmits(['toggle'])
// sidebar.matchStats — pairwise-match summary: { total, verified, running, error, used?, excluded? }
const sidebar = useSidebar()

// Matches summary is a single expandable row (no per-pair list — pairs are O(N²)
// and live in the dedicated modal). This just toggles the inline stats card.
const matchesExpanded = ref(false)

// Match summary context menu (right-click). The pair list itself lives in the
// dedicated modal; destructive removal is routed to App's shared confirmation.
const { menu: matchesCtx, open: openMatchesCtx, close: closeMenu } = useContextMenu()
// Close the menu, then run the item.
function fromMenu(fn) {
  closeMenu()
  fn()
}
function ctxRemoveMatches() {
  if (sidebar.matchStats.running) return
  sidebar.removeMatches()
  closeMenu()
}
</script>

<template>
  <div class="section">
    <button class="section-hd" @click="emit('toggle')">
      <span class="chevron">{{ open ? '▾' : '▸' }}</span>
      <span class="section-name">Matches</span>
      <span v-if="sidebar.matchStats.running" class="status-dot running"></span>
      <span v-else-if="sidebar.matchStats.verified" class="badge">{{ sidebar.matchStats.verified }}</span>
    </button>
    <ul v-if="open" class="item-list">
      <template v-if="sidebar.matchStats.total">
        <li
          class="list-item"
          title="Double-click to open the match list"
          @click="matchesExpanded = !matchesExpanded"
          @dblclick="sidebar.openMatches()"
          @contextmenu="openMatchesCtx"
        >
          <button
            class="expand-btn"
            :class="{ open: matchesExpanded }"
            @click.stop="matchesExpanded = !matchesExpanded"
            :title="matchesExpanded ? 'Collapse' : 'Expand'"
          ></button>
          <span class="item-name">Verified pairs</span>
          <span
            class="obs-badge"
            :title="`${sidebar.matchStats.verified} of ${pluralize(sidebar.matchStats.total, 'pair')}`"
            >{{ sidebar.matchStats.verified }}</span
          >
        </li>
        <li v-if="matchesExpanded" class="img-details">
          <div class="detail-row">
            <span class="detail-label">Verified</span>
            <span class="detail-value">{{ sidebar.matchStats.verified.toLocaleString() }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Total pairs</span>
            <span class="detail-value">{{ sidebar.matchStats.total.toLocaleString() }}</span>
          </div>
          <div v-if="sidebar.matchStats.used != null" class="detail-row">
            <span class="detail-label">Used in model</span>
            <span class="detail-value">{{ sidebar.matchStats.used.toLocaleString() }}</span>
          </div>
          <div v-if="sidebar.matchStats.excluded" class="detail-row">
            <span class="detail-label">Excluded</span>
            <span class="detail-value">{{ sidebar.matchStats.excluded.toLocaleString() }}</span>
          </div>
          <div v-if="sidebar.matchStats.error" class="detail-row">
            <span class="detail-label">Failed</span>
            <span class="detail-value detail-error">{{ sidebar.matchStats.error }}</span>
          </div>
        </li>
      </template>
      <li v-else-if="sidebar.matchStats.running" class="empty">Matching…</li>
      <li v-else class="empty">No matches — run matching</li>
    </ul>

    <!-- Match context menu -->
    <ContextMenu :menu="matchesCtx">
      <button class="ctx-item" @click="fromMenu(() => sidebar.openMatches())">Open match list</button>
      <button class="ctx-item" @click="fromMenu(() => sidebar.downloadMatches())">Download…</button>
      <div class="ctx-sep"></div>
      <button
        class="ctx-item danger"
        :class="{ 'ctx-disabled': sidebar.matchStats.running }"
        :disabled="!!sidebar.matchStats.running"
        :title="sidebar.matchStats.running ? 'Cancel matching before removing matches' : ''"
        @click="ctxRemoveMatches"
      >
        Remove matches
      </button>
    </ContextMenu>
  </div>
</template>

<style scoped src="./sidebar-sections.css"></style>
