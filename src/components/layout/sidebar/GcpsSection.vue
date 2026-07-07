<script setup>
import { ref } from 'vue'

defineProps({
  open: { type: Boolean, default: true },
  gcps: { type: Array, default: () => [] },
})
const emit = defineEmits(['toggle', 'remove-gcp'])

const gcpExpanded = ref({})
function toggleGcpExpand(id) {
  if (gcpExpanded.value[id]) delete gcpExpanded.value[id]
  else gcpExpanded.value[id] = true
}

// Compact coordinate formatting (projected metres vs. lat/lon degrees).
function fmtCoord(v) {
  if (v == null || Number.isNaN(v)) return '—'
  return Math.abs(v) >= 1000 ? v.toFixed(2) : v.toFixed(6)
}
</script>

<template>
  <div class="section">
    <button class="section-hd" @click="emit('toggle')">
      <span class="chevron">{{ open ? '▾' : '▸' }}</span>
      <span class="section-name">Ground Control Points</span>
      <span v-if="gcps.length" class="badge">{{ gcps.length }}</span>
    </button>
    <ul v-if="open" class="item-list">
      <template v-for="gcp in gcps" :key="gcp.id">
        <li
          class="list-item"
          :title="gcp.name"
          @click="toggleGcpExpand(gcp.id)"
        >
          <button
            class="expand-btn"
            :class="{ open: gcpExpanded[gcp.id] }"
            @click.stop="toggleGcpExpand(gcp.id)"
            :title="gcpExpanded[gcp.id] ? 'Collapse' : 'Expand'"
          ></button>
          <span class="item-name">{{ gcp.name }}</span>
          <span v-if="gcp.observations?.length" class="obs-badge" :title="`${gcp.observations.length} observation(s)`">
            {{ gcp.observations.length }}
          </span>
        </li>
        <li v-if="gcpExpanded[gcp.id]" class="img-details">
          <div class="detail-row">
            <span class="detail-label">X</span>
            <span class="detail-value">{{ fmtCoord(gcp.x) }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Y</span>
            <span class="detail-value">{{ fmtCoord(gcp.y) }}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Z</span>
            <span class="detail-value">
              <template v-if="gcp.z != null">{{ fmtCoord(gcp.z) }}</template>
              <span v-else class="detail-dim">—</span>
            </span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Observations</span>
            <span class="detail-value">{{ gcp.observations?.length || 0 }}</span>
          </div>
          <button class="gcp-remove" @click.stop="emit('remove-gcp', gcp.id)">Remove</button>
        </li>
      </template>
      <li v-if="!gcps.length" class="empty">No GCPs — import a control-point file</li>
    </ul>
  </div>
</template>

<style scoped src="./sidebar-sections.css"></style>
