<script setup>
const props = defineProps({
  gcps:   { type: Array,  required: true },
  crs:    { type: String, default: null },
  // Per-GCP accuracy report (useReconstructionStore.gcpAccuracyReport()):
  // [{ gcpId, dTotal, viewCount, observations }] — empty until refreshed.
  report:        { type: Array,  default: () => [] },
  selectedGcpId: { type: String, default: null },
})

const emit = defineEmits(['remove', 'update-accuracy', 'update-name', 'update-position', 'select', 'add'])

// Compact coordinate formatting (projected metres vs. degrees in a geographic CRS).
function fmtCoord(v) {
  if (v == null || Number.isNaN(v)) return '—'
  return Math.abs(v) >= 1000 ? v.toFixed(2) : v.toFixed(6)
}

function reportFor(gcp) {
  return props.report.find((r) => r.gcpId === gcp.id) ?? null
}

// Mean per-observation reprojection error (px) for a GCP's report entry.
function meanReprojPx(entry) {
  const vals = (entry?.observations || []).map((o) => o.reprojPx).filter((v) => v != null)
  if (!vals.length) return null
  return vals.reduce((a, b) => a + b, 0) / vals.length
}

// A GCP needs ≥2 image observations before it can be triangulated / used.
function obsCount(gcp) {
  return gcp.observations?.length || 0
}

// Commit an edited accuracy value back to the parent.
function onAccuracyInput(gcp, kind, e) {
  emit('update-accuracy', { id: gcp.id, kind, value: e.target.value })
}

function onNameInput(gcp, e) {
  emit('update-name', { id: gcp.id, name: e.target.value })
}

function onPositionInput(gcp, axis, e) {
  emit('update-position', { id: gcp.id, axis, value: e.target.value })
}
</script>

<template>
  <div class="table-wrap">
    <div class="toolbar">
      <button class="add-gcp" @click="emit('add')">+ Add GCP</button>
    </div>
    <table v-if="gcps.length">
      <thead>
        <tr>
          <th>Name</th>
          <th>X</th>
          <th>Y</th>
          <th>Z</th>
          <th :title="crs ? `X-axis ground accuracy in ${crs} units` : 'X-axis ground accuracy in CRS units'">
            X accuracy
          </th>
          <th :title="crs ? `Y-axis ground accuracy in ${crs} units` : 'Y-axis ground accuracy in CRS units'">
            Y accuracy
          </th>
          <th :title="crs ? `Z-axis ground accuracy in ${crs} units` : 'Z-axis ground accuracy in CRS units'">
            Z accuracy
          </th>
          <th title="Horizontal image-observation (marker) accuracy in pixels">Image X acc (px)</th>
          <th title="Vertical image-observation (marker) accuracy in pixels">Image Y acc (px)</th>
          <th title="Number of images this GCP is marked in — needs ≥2 to be used">Observations</th>
          <th title="Fitted-vs-surveyed position residual, in CRS units">Residual (CRS)</th>
          <th title="Mean reprojection error across this GCP's marked observations">Reproj (px)</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="gcp in gcps"
          :key="gcp.id"
          :class="{ selected: gcp.id === selectedGcpId }"
          @click="emit('select', gcp.id)"
        >
          <td class="name-cell">
            <input
              class="name-input"
              type="text"
              :value="gcp.name"
              @change="onNameInput(gcp, $event)"
            />
          </td>
          <td class="num">
            <input
              class="coord-input"
              type="number"
              step="any"
              :value="gcp.x"
              @change="onPositionInput(gcp, 'x', $event)"
            />
          </td>
          <td class="num">
            <input
              class="coord-input"
              type="number"
              step="any"
              :value="gcp.y"
              @change="onPositionInput(gcp, 'y', $event)"
            />
          </td>
          <td class="num">
            <input
              class="coord-input"
              type="number"
              step="any"
              :value="gcp.z ?? 0"
              @change="onPositionInput(gcp, 'z', $event)"
            />
          </td>
          <td class="acc-cell">
            <input
              class="acc-input"
              type="number"
              min="0"
              step="any"
              :value="gcp.accuracyX"
              @change="onAccuracyInput(gcp, 'x', $event)"
            />
          </td>
          <td class="acc-cell">
            <input
              class="acc-input"
              type="number"
              min="0"
              step="any"
              :value="gcp.accuracyY"
              @change="onAccuracyInput(gcp, 'y', $event)"
            />
          </td>
          <td class="acc-cell">
            <input
              class="acc-input"
              type="number"
              min="0"
              step="any"
              :value="gcp.accuracyZ"
              @change="onAccuracyInput(gcp, 'z', $event)"
            />
          </td>
          <td class="acc-cell">
            <input
              class="acc-input"
              type="number"
              min="0"
              step="any"
              :value="gcp.accuracyImgX"
              @change="onAccuracyInput(gcp, 'imgx', $event)"
            />
          </td>
          <td class="acc-cell">
            <input
              class="acc-input"
              type="number"
              min="0"
              step="any"
              :value="gcp.accuracyImgY"
              @change="onAccuracyInput(gcp, 'imgy', $event)"
              @click.stop
            />
          </td>
          <td class="num">
            <span :class="{ 'obs-low': obsCount(gcp) < 2 }" :title="obsCount(gcp) < 2 ? 'Needs ≥2 marked images to be usable' : ''">
              {{ obsCount(gcp) }}<span v-if="obsCount(gcp) < 2"> ⚠</span>
            </span>
          </td>
          <td class="num">
            <span v-if="reportFor(gcp)?.dTotal != null">{{ fmtCoord(reportFor(gcp).dTotal) }}</span>
            <span v-else class="na">—</span>
          </td>
          <td class="num">
            <span v-if="meanReprojPx(reportFor(gcp)) != null">{{ meanReprojPx(reportFor(gcp)).toFixed(2) }}</span>
            <span v-else class="na">—</span>
          </td>
          <td class="action-cell">
            <button class="row-remove" title="Remove GCP" @click.stop="emit('remove', gcp.id)">×</button>
          </td>
        </tr>
      </tbody>
    </table>

    <div v-else class="empty">No ground control points — click "Add GCP" above, or import a GCP file. Mark image positions by right-clicking in an image tab.</div>
  </div>
</template>

<style scoped>
.table-wrap {
  position: absolute;
  inset: 0;
  overflow: auto;
  background: var(--bg);
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

thead th {
  position: sticky;
  top: 0;
  background: var(--panel);
  text-align: left;
  padding: 10px 12px;
  font-weight: 600;
  color: var(--text-dim);
  border-bottom: 1px solid var(--panel-border);
  white-space: nowrap;
}

tbody td {
  padding: 6px 12px;
  border-bottom: 1px solid var(--panel-border);
  white-space: nowrap;
}

tbody tr:hover {
  background: rgba(255, 255, 255, 0.04);
}

.name-cell {
  max-width: 220px;
}

.toolbar {
  padding: 8px 12px;
  border-bottom: 1px solid var(--panel-border);
}

.add-gcp {
  padding: 4px 10px;
  background: none;
  border: 1px solid var(--panel-border);
  border-radius: 4px;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.add-gcp:hover {
  background: var(--hover-bg);
}

.name-input {
  width: 140px;
  padding: 3px 6px;
  background: var(--bg);
  border: 1px solid var(--panel-border);
  border-radius: 4px;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
}

.coord-input {
  width: 96px;
  padding: 3px 6px;
  background: var(--bg);
  border: 1px solid var(--panel-border);
  border-radius: 4px;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.name-input:focus,
.coord-input:focus {
  outline: none;
  border-color: var(--accent);
}

.num {
  font-variant-numeric: tabular-nums;
}

.na {
  color: var(--text-dim);
}

.acc-cell {
  width: 120px;
}

.acc-input {
  width: 92px;
  padding: 3px 6px;
  background: var(--bg);
  border: 1px solid var(--panel-border);
  border-radius: 4px;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.acc-input:focus {
  outline: none;
  border-color: var(--accent);
}

.obs-low {
  color: #e0a030;
}

.action-cell {
  width: 32px;
  text-align: center;
}

.row-remove {
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  padding: 1px 6px;
  border-radius: 4px;
}

.row-remove:hover {
  background: rgba(220, 80, 80, 0.12);
  color: #e55;
}

tbody tr { cursor: pointer; }

tbody tr.selected {
  background: rgba(80, 200, 255, 0.08);
}

.empty {
  padding: 40px;
  text-align: center;
  color: var(--text-dim);
}
</style>
