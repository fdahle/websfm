<script setup>
defineProps({
  gcps: { type: Array,  required: true },
  crs:  { type: String, default: null },
})

const emit = defineEmits(['remove', 'update-accuracy'])

// Compact coordinate formatting (projected metres vs. degrees in a geographic CRS).
function fmtCoord(v) {
  if (v == null || Number.isNaN(v)) return '—'
  return Math.abs(v) >= 1000 ? v.toFixed(2) : v.toFixed(6)
}

// Commit an edited accuracy value back to the parent.
function onAccuracyInput(gcp, kind, e) {
  emit('update-accuracy', { id: gcp.id, kind, value: e.target.value })
}
</script>

<template>
  <div class="table-wrap">
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
          <th title="Image-observation (marker) accuracy in pixels">Image accuracy (px)</th>
          <th>Observations</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="gcp in gcps" :key="gcp.id">
          <td class="name-cell" :title="gcp.name">{{ gcp.name }}</td>
          <td class="num">{{ fmtCoord(gcp.x) }}</td>
          <td class="num">{{ fmtCoord(gcp.y) }}</td>
          <td class="num">
            <span v-if="gcp.z != null">{{ fmtCoord(gcp.z) }}</span>
            <span v-else class="na">—</span>
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
              :value="gcp.accuracyRel"
              @change="onAccuracyInput(gcp, 'rel', $event)"
            />
          </td>
          <td class="num">{{ gcp.observations?.length || 0 }}</td>
          <td class="action-cell">
            <button class="row-remove" title="Remove GCP" @click="emit('remove', gcp.id)">×</button>
          </td>
        </tr>
      </tbody>
    </table>

    <div v-else class="empty">No ground control points — import a GCP file to populate this table.</div>
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
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 500;
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

.empty {
  padding: 40px;
  text-align: center;
  color: var(--text-dim);
}
</style>
