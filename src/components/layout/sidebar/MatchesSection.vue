<script setup>
import { ref } from 'vue'

defineProps({
  open: { type: Boolean, default: true },
  // Pairwise-match summary: { total, verified, running, error, used?, disabled? }
  matchStats: { type: Object, default: () => ({ total: 0, verified: 0, running: 0, error: 0 }) },
})
const emit = defineEmits(['toggle', 'open-matches'])

// Matches summary is a single expandable row (no per-pair list — pairs are O(N²)
// and live in the dedicated modal). This just toggles the inline stats card.
const matchesExpanded = ref(false)
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
          <button class="link-btn matches-view" @click.stop="emit('open-matches')">View match list</button>
        </li>
      </template>
      <li v-else-if="matchStats.running" class="empty">Matching…</li>
      <li v-else class="empty">No matches — run matching</li>
    </ul>
  </div>
</template>

<style scoped src="./sidebar-sections.css"></style>
