<script setup>
import { ref } from 'vue'
import { useContextMenu } from '../../../composables/useContextMenu.js'

const props = defineProps({
  open:          { type: Boolean, default: true },
  gcps:          { type: Array,   default: () => [] },
  // Per-GCP accuracy report (useReconstructionStore.gcpAccuracyReport()):
  // [{ gcpId, dTotal, observations: [{ imageId, reprojPx }] }] — empty until refreshed.
  report:        { type: Array,   default: () => [] },
  selectedGcpId: { type: String,  default: null },
})
const emit = defineEmits(['toggle', 'remove-gcp', 'select', 'jump-to-image', 'remove-observation',
  'update-observation-accuracy', 'open-gcp'])

const gcpExpanded = ref({})
function toggleGcpExpand(id) {
  if (gcpExpanded.value[id]) delete gcpExpanded.value[id]
  else gcpExpanded.value[id] = true
}

// Right-click a GCP row → context menu (Remove).
const { menu: gcpCtx, open: openGcpCtx, close: closeMenu } = useContextMenu()
function onGcpRightClick(e, gcp) {
  emit('select', gcp.id)
  openGcpCtx(e, { gcp }, { w: 160, h: 44 })
}
function ctxRemoveGcp() { emit('remove-gcp', gcpCtx.value.gcp.id); closeMenu() }

// Compact coordinate formatting (projected metres vs. lat/lon degrees).
function fmtCoord(v) {
  if (v == null || Number.isNaN(v)) return '—'
  return Math.abs(v) >= 1000 ? v.toFixed(2) : v.toFixed(6)
}

// Live reprojection error (px) for one observation, from the accuracy report.
function reprojFor(gcpId, imageId) {
  const entry = props.report.find((r) => r.gcpId === gcpId)
  const obs = entry?.observations?.find((o) => o.imageId === imageId)
  return obs?.reprojPx ?? null
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
          :class="{ selected: gcp.id === selectedGcpId }"
          :title="gcp.name"
          @click="emit('select', gcp.id); toggleGcpExpand(gcp.id)"
          @dblclick="emit('open-gcp', gcp.id)"
          @contextmenu="onGcpRightClick($event, gcp)"
        >
          <button
            class="expand-btn"
            :class="{ open: gcpExpanded[gcp.id] }"
            @click.stop="toggleGcpExpand(gcp.id)"
            :title="gcpExpanded[gcp.id] ? 'Collapse' : 'Expand'"
          ></button>
          <span class="item-name">{{ gcp.name }}</span>
          <span class="role-badge" :class="gcp.role === 'check' ? 'check' : 'control'"
            :title="gcp.role === 'check' ? 'Checkpoint — excluded from adjustment' : 'Control point — constrains georeferencing'">
            {{ gcp.role === 'check' ? 'CHK' : 'CTL' }}
          </span>
          <span
            class="obs-badge"
            :class="{ low: (gcp.observations?.length || 0) < 2 }"
            :title="(gcp.observations?.length || 0) < 2 ? 'Needs ≥2 marked images to be usable' : `${gcp.observations.length} observation(s)`"
          >
            {{ gcp.observations?.length || 0 }}<template v-if="(gcp.observations?.length || 0) < 2"> ⚠</template>
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

          <div class="obs-header">Marked images ({{ gcp.observations?.length || 0 }})</div>
          <ul v-if="gcp.observations?.length" class="obs-list">
            <li v-for="obs in gcp.observations" :key="obs.imageId ?? obs.imageName" class="obs-item">
              <button
                v-if="obs.imageId != null"
                class="obs-jump"
                :title="`Open ${obs.imageName}`"
                @click.stop="emit('jump-to-image', { imageId: obs.imageId })"
              >{{ obs.imageName }}</button>
              <span
                v-else
                class="obs-missing"
                :title="`${obs.imageName} — not loaded yet; add this image to enable its link`"
              >{{ obs.imageName }}</span>
              <span v-if="reprojFor(gcp.id, obs.imageId) != null" class="obs-reproj" title="Reprojection error (px)">
                {{ reprojFor(gcp.id, obs.imageId).toFixed(1) }}px
              </span>
              <label class="obs-sigma" title="Per-observation X/Y marking accuracy (1σ pixels)">
                σ
                <input type="number" min="0" step="any" :value="obs.accuracyX ?? gcp.accuracyImgX"
                  @click.stop @change="emit('update-observation-accuracy', { gcpId: gcp.id, imageId: obs.imageId, axis: 'x', value: $event.target.value })" />
                /
                <input type="number" min="0" step="any" :value="obs.accuracyY ?? gcp.accuracyImgY"
                  @click.stop @change="emit('update-observation-accuracy', { gcpId: gcp.id, imageId: obs.imageId, axis: 'y', value: $event.target.value })" />
              </label>
              <button class="obs-remove" title="Remove this observation" @click.stop="emit('remove-observation', { gcpId: gcp.id, imageId: obs.imageId })">×</button>
            </li>
          </ul>
          <div v-else class="obs-empty">Right-click a position in an image tab to mark this GCP.</div>
        </li>
      </template>
      <li v-if="!gcps.length" class="empty">No GCPs — right-click in an image tab to add one, or import a control-point file</li>
    </ul>

    <!-- GCP context menu -->
    <Teleport to="body">
      <div
        v-if="gcpCtx"
        class="ctx-menu"
        :style="{ left: gcpCtx.x + 'px', top: gcpCtx.y + 'px' }"
        @click.stop
      >
        <button class="ctx-item danger" @click="ctxRemoveGcp">Remove GCP</button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped src="./sidebar-sections.css"></style>
<style scoped>
.list-item.selected { background: rgba(80, 200, 255, 0.1); }

.obs-badge.low { color: #e0a030; }

.role-badge {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: .04em;
  color: #3fae6a;
}
.role-badge.check { color: #38a9c7; }

.obs-header {
  margin: 6px 0 2px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-dim);
}
.obs-list { list-style: none; margin: 0; padding: 0; }
.obs-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 1px 0;
}
.obs-jump {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
  background: none;
  border: none;
  color: var(--accent, #5cf);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
  padding: 0;
}
.obs-jump:hover { text-decoration: underline; }
.obs-missing {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--text-dim);
  font-style: italic;
  cursor: default;
}
.obs-reproj { font-size: 10px; color: var(--text-dim); font-variant-numeric: tabular-nums; }
.obs-sigma { display: flex; align-items: center; gap: 2px; font-size: 9px; color: var(--text-dim); }
.obs-sigma input { width: 36px; padding: 1px 2px; font-size: 9px; color: var(--text); background: var(--bg); border: 1px solid var(--panel-border); border-radius: 3px; }
.obs-remove {
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  padding: 0 3px;
}
.obs-remove:hover { color: #e55; }
.obs-empty { font-size: 11px; color: var(--text-dim); font-style: italic; margin: 2px 0; }
</style>
