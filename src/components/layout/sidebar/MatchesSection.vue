<script setup>
import { ref } from 'vue'
import { useContextMenu } from '../../../composables/useContextMenu.js'

const props = defineProps({
  open: { type: Boolean, default: true },
  // Pairwise-match summary: { total, verified, running, error, used?, disabled? }
  matchStats: { type: Object, default: () => ({ total: 0, verified: 0, running: 0, error: 0 }) },
})
const emit = defineEmits(['toggle', 'open-matches', 'remove-matches'])

// Matches summary is a single expandable row (no per-pair list — pairs are O(N²)
// and live in the dedicated modal). This just toggles the inline stats card.
const matchesExpanded = ref(false)

// Match summary context menu (right-click). The pair list itself lives in the
// dedicated modal; destructive removal is routed to App's shared confirmation.
const { menu: matchesCtx, open: openMatchesCtx, close: closeMenu } = useContextMenu()
function onMatchesRightClick(e) {
  openMatchesCtx(e, {}, { w: 180, h: 88 })
}
function ctxOpenMatches() {
  emit('open-matches')
  closeMenu()
}
function ctxRemoveMatches() {
  if (props.matchStats.running) return
  emit('remove-matches')
  closeMenu()
}
</script>

<template>
  <div class="section">
    <button class="section-hd" @click="emit('toggle')">
      <span class="chevron">{{ open ? '▾' : '▸' }}</span>
      <span class="section-name">Matches</span>
      <span v-if="matchStats.running" class="status-dot running"></span>
      <span v-else-if="matchStats.verified" class="badge">{{ matchStats.verified }}</span>
    </button>
    <ul v-if="open" class="item-list">
      <template v-if="matchStats.total">
        <li
          class="list-item"
          title="Double-click to open the match list"
          @click="matchesExpanded = !matchesExpanded"
          @dblclick="emit('open-matches')"
          @contextmenu="onMatchesRightClick"
        >
          <button
            class="expand-btn"
            :class="{ open: matchesExpanded }"
            @click.stop="matchesExpanded = !matchesExpanded"
            :title="matchesExpanded ? 'Collapse' : 'Expand'"
          ></button>
          <span class="item-name">Verified pairs</span>
          <span class="obs-badge" :title="`${matchStats.verified} of ${matchStats.total} pair(s)`">{{ matchStats.verified }}</span>
        </li>
        <li v-if="matchesExpanded" class="img-details">
          <div class="detail-row">
            <span class="detail-label">Verified</span>
            <span class="detail-value">{{ matchStats.verified.toLocaleString() }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Total pairs</span>
            <span class="detail-value">{{ matchStats.total.toLocaleString() }}</span>
          </div>
          <div v-if="matchStats.used != null" class="detail-row">
            <span class="detail-label">Used in model</span>
            <span class="detail-value">{{ matchStats.used.toLocaleString() }}</span>
          </div>
          <div v-if="matchStats.disabled" class="detail-row">
            <span class="detail-label">Excluded</span>
            <span class="detail-value">{{ matchStats.disabled.toLocaleString() }}</span>
          </div>
          <div v-if="matchStats.error" class="detail-row">
            <span class="detail-label">Failed</span>
            <span class="detail-value detail-error">{{ matchStats.error }}</span>
          </div>
        </li>
      </template>
      <li v-else-if="matchStats.running" class="empty">Matching…</li>
      <li v-else class="empty">No matches — run matching</li>
    </ul>

    <!-- Match context menu -->
    <Teleport to="body">
      <div
        v-if="matchesCtx"
        class="ctx-menu"
        :style="{ left: matchesCtx.x + 'px', top: matchesCtx.y + 'px' }"
        @click.stop
      >
        <button class="ctx-item" @click="ctxOpenMatches">Open match list</button>
        <div class="ctx-sep"></div>
        <button
          class="ctx-item danger"
          :class="{ 'ctx-disabled': matchStats.running }"
          :disabled="!!matchStats.running"
          :title="matchStats.running ? 'Cancel matching before removing matches' : ''"
          @click="ctxRemoveMatches"
        >Remove matches</button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped src="./sidebar-sections.css"></style>
