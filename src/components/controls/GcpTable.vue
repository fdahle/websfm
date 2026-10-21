<script setup>
import { VERTICAL_DATUMS, isConvertible } from '../../core/verticalDatum.js'
import { ref } from 'vue'

// Short labels for the cramped per-row datum select (core/verticalDatum.js ids).
const DATUM_SHORT = [
  { id: 'unknown', label: 'datum?' },
  { id: 'ellipsoidal', label: 'ellipsoid' },
  { id: 'geoid:EGM2008', label: 'EGM2008' },
  { id: 'geoid:EGM96', label: 'EGM96' },
  { id: 'orthometric', label: 'geoid (other)' },
  { id: 'local', label: 'local' },
]
const CONVERTIBLE = VERTICAL_DATUMS.filter((d) => isConvertible(d.id))
const props = defineProps({
  gcps: { type: Array, required: true },
  crs: { type: String, default: null },
  // Per-GCP accuracy report (useReconstructionStore.gcpAccuracyReport()):
  // [{ gcpId, dTotal, viewCount, observations }] — empty until refreshed.
  report: { type: Array, default: () => [] },
  selectedGcpId: { type: String, default: null },
  // Whether any reference DEM has been imported (useExternalStore.hasReferenceDem).
  // Reads the INDEX, never a loaded plane — the planes hydrate lazily, so a
  // freshly reopened project has rasters but no sources in memory.
  hasReferenceDem: { type: Boolean, default: false },
  // Project scene type ('aerial' | 'object' | null) — orders the two create
  // buttons; an object project is almost always adding markers.
  sceneType: { type: String, default: null },
})

const emit = defineEmits([
  'remove',
  'update-accuracy',
  'update-name',
  'update-position',
  'select',
  'add',
  'update-role',
  'update-vertical-datum',
  'fill-z',
  'check-z',
  'convert-heights',
  'update-observation-accuracy',
])

// Rows whose per-image observations are expanded (click the Observations count).
// That sub-row is the one place a single mark's σ is edited — the sidebar only
// displays — so a mark that was hard to place can be down-weighted on its own.
const obsExpanded = ref({})
function toggleObs(id) {
  if (obsExpanded.value[id]) delete obsExpanded.value[id]
  else obsExpanded.value[id] = true
}
const COLUMN_COUNT = 15

function reprojFor(gcp, imageId) {
  return reportFor(gcp)?.observations?.find((o) => o.imageId === imageId)?.reprojPx ?? null
}

function onObsAccuracyInput(gcp, obs, axis, e) {
  emit('update-observation-accuracy', { gcpId: gcp.id, imageId: obs.imageId, axis, value: e.target.value })
}

// A MARKER is a scale-bar endpoint: image marks and no surveyed position. Its
// coordinate and ground-accuracy cells are not "blank", they do not exist — so
// the row collapses them rather than showing editable zeros that would read as
// surveyed values (and, per core/io/gcp.js `isGroundControl`, still could not
// constrain anything if filled in).
const isMarker = (gcp) => gcp.role === 'marker'

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
      <!-- Two explicit actions rather than one "+ Add" plus a role edit: a point
           created as control and re-roled afterwards keeps the coordinates it was
           born with. Scene type orders them; both are always available. -->
      <template v-if="sceneType === 'object'">
        <button
          class="add-gcp"
          title="A scale-bar endpoint: image marks, no surveyed position"
          @click="emit('add', 'marker')"
        >
          + Add marker
        </button>
        <button class="add-gcp" title="A surveyed point that constrains georeferencing" @click="emit('add', 'control')">
          + Add control
        </button>
      </template>
      <template v-else>
        <button class="add-gcp" title="A surveyed point that constrains georeferencing" @click="emit('add', 'control')">
          + Add control
        </button>
        <button
          class="add-gcp"
          title="A scale-bar endpoint: image marks, no surveyed position"
          @click="emit('add', 'marker')"
        >
          + Add marker
        </button>
      </template>
      <!-- Only offered once a reference DEM is imported; a greyed-out button
           with no explanation is worse than no button. -->
      <template v-if="hasReferenceDem">
        <span class="toolbar-sep"></span>
        <button
          class="tool-btn"
          title="Set Z (and its accuracy) from the imported reference DEM for every GCP that has no elevation yet"
          @click="emit('fill-z')"
        >
          Fill Z from reference DEM
        </button>
        <button
          class="tool-btn"
          title="Report reference-DEM minus GCP elevation for every GCP — non-destructive"
          @click="emit('check-z')"
        >
          Check Z
        </button>
      </template>
      <!-- Re-expresses heights (adds the geoid separation); the per-row datum
           select only relabels what the numbers already are. -->
      <template v-if="gcps.some((g) => g.role !== 'marker')">
        <span class="toolbar-sep"></span>
        <select
          class="tool-btn"
          aria-label="Convert heights"
          title="Convert every GCP's Z to this vertical datum: ellipsoidal and EGM96/EGM2008 heights convert, others are skipped"
          value=""
          @change="
            ($event) => {
              emit('convert-heights', $event.target.value)
              $event.target.value = ''
            }
          "
        >
          <option value="" disabled>Convert heights to…</option>
          <option v-for="d in CONVERTIBLE" :key="d.id" :value="d.id">{{ d.label }}</option>
        </select>
      </template>
    </div>
    <table v-if="gcps.length">
      <thead>
        <tr>
          <th>Name</th>
          <th title="Controls constrain the solution; checkpoints only measure independent accuracy">Role</th>
          <th title="Accuracy provenance and vertical height datum">Uncertainty</th>
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
          <th title="Default X accuracy for newly marked image observations">Default image X σ (px)</th>
          <th title="Default Y accuracy for newly marked image observations">Default image Y σ (px)</th>
          <th title="Number of images this GCP is marked in — needs ≥2 to be used">Observations</th>
          <th title="Fitted-vs-surveyed position residual, in CRS units">Residual (CRS)</th>
          <th title="Mean reprojection error across this GCP's marked observations">Reproj (px)</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <template v-for="gcp in gcps" :key="gcp.id">
          <tr :class="{ selected: gcp.id === selectedGcpId }" @click="emit('select', gcp.id)">
            <td class="name-cell">
              <input class="name-input" type="text" :value="gcp.name" @change="onNameInput(gcp, $event)" />
            </td>
            <td>
              <select
                class="role-input"
                :value="gcp.role || 'control'"
                @change="emit('update-role', { id: gcp.id, role: $event.target.value })"
                @click.stop
              >
                <option value="control">Control</option>
                <option value="check">Check</option>
                <option value="marker">Marker</option>
              </select>
            </td>
            <td
              v-if="isMarker(gcp)"
              class="marker-note"
              colspan="7"
              title="A marker has no surveyed position — it exists to give a scale bar a reproducible endpoint"
            >
              no surveyed position
            </td>
            <td
              v-if="!isMarker(gcp)"
              class="uncertainty-cell"
              :class="{ unknown: !gcp.accuracyStatus || gcp.accuracyStatus === 'unknown' }"
              :title="`Ground accuracy: ${gcp.accuracyStatus || 'unknown'}; height datum: ${gcp.verticalDatum || 'unknown'}`"
            >
              {{
                !gcp.accuracyStatus || gcp.accuracyStatus === 'unknown'
                  ? '⚠ unknown'
                  : gcp.accuracyStatus.replace('preset:', '')
              }}
              <select
                class="datum-select"
                :value="gcp.verticalDatum || 'unknown'"
                @click.stop
                @change="emit('update-vertical-datum', { id: gcp.id, verticalDatum: $event.target.value })"
              >
                <option v-for="d in DATUM_SHORT" :key="d.id" :value="d.id">{{ d.label }}</option>
              </select>
            </td>
            <td v-if="!isMarker(gcp)" class="num">
              <input
                class="coord-input"
                type="number"
                step="any"
                :value="gcp.x"
                @change="onPositionInput(gcp, 'x', $event)"
              />
            </td>
            <td v-if="!isMarker(gcp)" class="num">
              <input
                class="coord-input"
                type="number"
                step="any"
                :value="gcp.y"
                @change="onPositionInput(gcp, 'y', $event)"
              />
            </td>
            <td v-if="!isMarker(gcp)" class="num">
              <input
                class="coord-input"
                type="number"
                step="any"
                :value="gcp.z ?? ''"
                @change="onPositionInput(gcp, 'z', $event)"
              />
            </td>
            <td v-if="!isMarker(gcp)" class="acc-cell">
              <input
                class="acc-input"
                type="number"
                min="0"
                step="any"
                :value="gcp.accuracyX"
                @change="onAccuracyInput(gcp, 'x', $event)"
              />
            </td>
            <td v-if="!isMarker(gcp)" class="acc-cell">
              <input
                class="acc-input"
                type="number"
                min="0"
                step="any"
                :value="gcp.accuracyY"
                @change="onAccuracyInput(gcp, 'y', $event)"
              />
            </td>
            <td v-if="!isMarker(gcp)" class="acc-cell">
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
              <button
                class="obs-toggle"
                :class="{ 'obs-low': obsCount(gcp) < 2 }"
                :disabled="!obsCount(gcp)"
                :title="
                  obsCount(gcp) < 2 ? 'Needs ≥2 marked images to be usable' : 'Show marked images and their accuracy'
                "
                @click.stop="toggleObs(gcp.id)"
              >
                <span v-if="obsCount(gcp)" class="chevron">{{ obsExpanded[gcp.id] ? '▾' : '▸' }}</span>
                {{ obsCount(gcp) }}<span v-if="obsCount(gcp) < 2"> ⚠</span>
              </button>
            </td>
            <td class="num">
              <span
                v-if="reportFor(gcp)?.dTotal != null"
                :title="
                  reportFor(gcp).normalized == null
                    ? ''
                    : `Mahalanobis residual ${reportFor(gcp).normalized.toFixed(2)}σ`
                "
              >
                {{ fmtCoord(reportFor(gcp).dTotal)
                }}<small v-if="reportFor(gcp).normalized != null" class="sigma-tag">
                  · {{ reportFor(gcp).normalized.toFixed(1) }}σ</small
                >
              </span>
              <span v-else class="na">—</span>
            </td>
            <td class="num">
              <span v-if="meanReprojPx(reportFor(gcp)) != null">{{ meanReprojPx(reportFor(gcp)).toFixed(2) }}</span>
              <span v-else class="na">—</span>
            </td>
            <td class="action-cell">
              <button class="row-remove" title="Remove point" @click.stop="emit('remove', gcp.id)">×</button>
            </td>
          </tr>
          <tr v-if="obsExpanded[gcp.id] && obsCount(gcp)" class="obs-row">
            <td :colspan="COLUMN_COUNT">
              <table class="obs-table">
                <thead>
                  <tr>
                    <th>Marked image</th>
                    <th title="Per-observation X marking accuracy (1σ pixels)">Image X σ (px)</th>
                    <th title="Per-observation Y marking accuracy (1σ pixels)">Image Y σ (px)</th>
                    <th title="Reprojection error of this mark">Reproj (px)</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="obs in gcp.observations" :key="obs.imageId ?? obs.imageName">
                    <td
                      :class="{ 'obs-missing': obs.imageId == null }"
                      :title="obs.imageId == null ? `${obs.imageName} — not loaded yet` : obs.imageName"
                    >
                      {{ obs.imageName }}
                    </td>
                    <td class="acc-cell">
                      <input
                        class="acc-input"
                        type="number"
                        min="0"
                        step="any"
                        :disabled="obs.imageId == null"
                        :value="obs.accuracyX ?? gcp.accuracyImgX"
                        @click.stop
                        @change="onObsAccuracyInput(gcp, obs, 'x', $event)"
                      />
                    </td>
                    <td class="acc-cell">
                      <input
                        class="acc-input"
                        type="number"
                        min="0"
                        step="any"
                        :disabled="obs.imageId == null"
                        :value="obs.accuracyY ?? gcp.accuracyImgY"
                        @click.stop
                        @change="onObsAccuracyInput(gcp, obs, 'y', $event)"
                      />
                    </td>
                    <td class="num">
                      <span v-if="reprojFor(gcp, obs.imageId) != null">{{
                        reprojFor(gcp, obs.imageId).toFixed(2)
                      }}</span>
                      <span v-else class="na">—</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </td>
          </tr>
        </template>
      </tbody>
    </table>

    <div v-else class="empty">
      No ground control points — click "Add GCP" above, or import a GCP file. Mark image positions by right-clicking in
      an image tab.
    </div>
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
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.toolbar-sep {
  width: 1px;
  align-self: stretch;
  background: var(--panel-border);
}

.tool-btn {
  padding: 4px 10px;
  background: none;
  border: 1px solid var(--panel-border);
  border-radius: 5px;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.tool-btn:hover {
  background: var(--hover-bg);
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

.role-input {
  padding: 3px 6px;
  background: var(--bg);
  border: 1px solid var(--panel-border);
  border-radius: 4px;
  color: var(--text);
  font: inherit;
  font-size: 12px;
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
.sigma-tag {
  color: var(--text-dim);
  font-size: 10px;
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

.obs-toggle {
  background: none;
  border: none;
  color: inherit;
  font: inherit;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  padding: 0;
}
.obs-toggle.obs-low {
  color: #e0a030;
}
.obs-toggle:disabled {
  cursor: default;
}
.obs-toggle .chevron {
  color: var(--text-dim);
  font-size: 10px;
  margin-right: 2px;
}

tbody tr.obs-row {
  cursor: default;
  background: rgba(255, 255, 255, 0.02);
}
tbody tr.obs-row:hover {
  background: rgba(255, 255, 255, 0.02);
}
tbody tr.obs-row > td {
  padding: 4px 12px 8px 36px;
}
.obs-table {
  width: auto;
  font-size: 12px;
}
.obs-table thead th {
  position: static;
  padding: 4px 12px 4px 0;
  background: none;
  font-size: 11px;
}
.obs-table tbody td {
  padding: 2px 12px 2px 0;
  border-bottom: none;
}
.obs-table tbody tr:hover {
  background: none;
}
.obs-missing {
  color: var(--text-dim);
  font-style: italic;
}

.uncertainty-cell {
  max-width: 90px;
  font-size: 10px;
  color: var(--text-dim);
}
.uncertainty-cell.unknown {
  color: #e0a030;
}
.uncertainty-cell small {
  display: block;
  font-size: 9px;
  opacity: 0.75;
}
.datum-select {
  display: block;
  max-width: 78px;
  margin-top: 2px;
  font-size: 9px;
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--panel-border);
}

.action-cell {
  width: 32px;
  text-align: center;
}

.marker-note {
  color: var(--text-dim);
  font-style: italic;
  font-size: 11px;
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

tbody tr {
  cursor: pointer;
}

tbody tr.selected {
  background: rgba(80, 200, 255, 0.08);
}

.empty {
  padding: 40px;
  text-align: center;
  color: var(--text-dim);
}
</style>
