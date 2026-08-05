<script setup>
import { ref, computed, onMounted } from 'vue'
import StatTiles from '../ui/StatTiles.vue'
import DataTable from '../ui/DataTable.vue'
import { useReconstructionStore } from '../../../stores/useReconstructionStore.js'
import { useGcpsStore } from '../../../stores/useGcpsStore.js'
import { useImagesStore } from '../../../stores/useImagesStore.js'
import { sampleDemAtGcps } from '../../../core/eval/demCheck.js'
import { EVAL_THRESHOLDS as T } from '../../../core/eval/health.js'
import { useLog } from '../../../composables/useLog.js'

// Quality Report ▸ Accuracy: the three georeference-accuracy views (GCP residuals,
// pose residuals, DEM-vs-GCP vertical check) sub-tabbed — they all answer "how
// accurate is the georeferenced result". Thresholds come from EVAL_THRESHOLDS.
const recon = useReconstructionStore()
const gcpsStore = useGcpsStore()
const imagesStore = useImagesStore()
const { log } = useLog()

const tab = ref('gcps')
const TABS = [{ id: 'gcps', label: 'GCP Accuracy' }, { id: 'poses', label: 'Pose Residuals' }, { id: 'dem', label: 'DEM vs GCPs' }]

const crsUnit = computed(() => recon.dem?.unit || 'm')
const method = computed(() => recon.georef?.method ?? null)
const fmtM = (v) => (v == null ? '—' : v.toFixed(3))
const tone = (v, thr) => (v == null ? undefined : (v >= thr.bad ? 'bad' : (v >= thr.warn ? 'warn' : 'ok')))

// ── GCP accuracy (async; per-row toggle refits + re-runs) ──
const imageName = (id) => imagesStore.images.find((im) => im.id === id)?.name ?? id
const gcpRows = ref([])
const gcpLoading = ref(true)
async function refreshGcps() {
  gcpLoading.value = true
  const report = await recon.gcpAccuracyReport()
  const byId = new Map(report.map((r) => [r.gcpId, r]))
  gcpRows.value = gcpsStore.gcps.map((g) => {
    const r = byId.get(g.id)
    return {
      id: g.id, name: g.name, enabled: g.enabled !== false,
      role: g.role ?? 'control',
      viewCount: r ? r.viewCount : (g.observations?.length ?? 0),
      dx: r?.dx ?? null, dy: r?.dy ?? null, dz: r?.dz ?? null, dTotal: r?.dTotal ?? null,
      observations: r?.observations ?? [],
    }
  })
  gcpLoading.value = false
}
onMounted(refreshGcps)
async function onToggle(row) {
  gcpsStore.setGcpEnabled(row.id, !row.enabled)
  await recon.georeference()
  await refreshGcps()
  log(`GCP accuracy: refit after ${row.enabled ? 'disabling' : 'enabling'} "${row.name}"`, 'info', 'Evaluate')
}
const rmse = (rows, sel) => {
  const used = rows.filter((r) => sel(r) != null)
  if (!used.length) return null
  return Math.sqrt(used.reduce((a, r) => a + sel(r) ** 2, 0) / used.length)
}
const gcpStats = computed(() => {
  const controls = gcpRows.value.filter((r) => r.enabled && r.role !== 'check' && r.dTotal != null)
  const checks = gcpRows.value.filter((r) => r.enabled && r.role === 'check' && r.dTotal != null)
  const used = checks.length ? checks : controls
  return {
    n: used.length, total: gcpsStore.gcps.length,
    controls: controls.length, checks: checks.length, basis: checks.length ? 'check' : 'control',
    rmseX: rmse(used, (r) => r.dx), rmseY: rmse(used, (r) => r.dy),
    rmseZ: rmse(used, (r) => r.dz), rmseTotal: rmse(used, (r) => r.dTotal),
  }
})
const gcpTiles = computed(() => {
  const s = gcpStats.value
  const t = [
    { label: s.basis === 'check' ? 'Checkpoint RMSE' : 'Control fit RMSE', value: fmtM(s.rmseTotal), unit: crsUnit.value, tone: tone(s.rmseTotal, T.gcpRmse), hint: s.basis === 'check' ? 'Independent accuracy' : 'No valid checkpoints — not independent' },
    { label: 'RMSE X', value: fmtM(s.rmseX), unit: crsUnit.value },
    { label: 'RMSE Y', value: fmtM(s.rmseY), unit: crsUnit.value },
    { label: 'RMSE Z', value: fmtM(s.rmseZ), unit: crsUnit.value },
    { label: 'Controls / checks', value: `${s.controls} / ${s.checks}`, hint: `${s.total} point(s) total` },
  ]
  if (method.value) t.push({ label: 'Georef source', value: method.value === 'gcps' ? 'GCPs' : 'poses',
    tone: method.value === 'gcps' ? undefined : 'warn', hint: method.value === 'poses' ? 'pose fit — <3 GCPs' : undefined })
  return t
})
const gcpColumns = [
  { key: 'enabled', label: 'On', sortable: false }, { key: 'name', label: 'Name' },
  { key: 'role', label: 'Role', format: (v) => v === 'check' ? 'Check' : 'Control' },
  { key: 'viewCount', label: 'Views', align: 'right' },
  { key: 'dx', label: 'ΔX', align: 'right', format: fmtM }, { key: 'dy', label: 'ΔY', align: 'right', format: fmtM },
  { key: 'dz', label: 'ΔZ', align: 'right', format: fmtM }, { key: 'dTotal', label: 'Δ total', align: 'right', format: fmtM },
]

// ── Pose residuals (WS2.5: XY vs Z split) ──
const poseRows = computed(() => recon.poseResidualReport().map((r) => ({ id: r.uuid, ...r, dxy: Math.hypot(r.dx, r.dy) })))
const poseStats = computed(() => {
  const rows = poseRows.value
  return {
    n: rows.length,
    rmse: rmse(rows, (r) => r.dTotal),
    rmseXY: rmse(rows, (r) => r.dxy),
    rmseZ: rmse(rows, (r) => r.dz),
  }
})
const poseTiles = computed(() => [
  { label: 'RMSE total', value: fmtM(poseStats.value.rmse), unit: crsUnit.value, tone: tone(poseStats.value.rmse, T.poseRmse), hint: `warn > ${T.poseRmse.warn} ${crsUnit.value}` },
  { label: 'RMSE horizontal', value: fmtM(poseStats.value.rmseXY), unit: crsUnit.value, hint: 'XY' },
  { label: 'RMSE vertical', value: fmtM(poseStats.value.rmseZ), unit: crsUnit.value, hint: 'Z' },
  { label: 'Poses compared', value: poseStats.value.n },
])
const poseColumns = [
  { key: 'name', label: 'Image' }, { key: 'source', label: 'Source', format: (v) => v === 'exif' ? 'EXIF GPS' : 'Imported' },
  { key: 'dx', label: 'ΔX', align: 'right', format: fmtM },
  { key: 'dy', label: 'ΔY', align: 'right', format: fmtM }, { key: 'dz', label: 'ΔZ', align: 'right', format: fmtM },
  { key: 'dTotal', label: 'Δ total', align: 'right', format: fmtM },
]

// ── DEM vs GCPs ──
const demGcps = computed(() => gcpsStore.gcps.filter((g) => g.enabled !== false && g.x != null && g.y != null))
const demRows = computed(() =>
  sampleDemAtGcps(recon.dem, demGcps.value).map((r) => ({ id: r.gcpId, ...r, absDz: r.dz == null ? null : Math.abs(r.dz) })))
const demStats = computed(() => {
  const sampled = demRows.value.filter((r) => r.dz != null)
  const n = sampled.length
  return {
    n, outside: demRows.value.length - n,
    rmse: rmse(sampled, (r) => r.dz),
    bias: n ? sampled.reduce((a, r) => a + r.dz, 0) / n : null,
  }
})
const demTiles = computed(() => [
  { label: 'ΔZ RMSE', value: fmtM(demStats.value.rmse), unit: crsUnit.value, tone: tone(demStats.value.rmse, T.demDzRmse), hint: `warn > ${T.demDzRmse.warn} ${crsUnit.value}` },
  { label: 'Mean bias', value: fmtM(demStats.value.bias), unit: crsUnit.value,
    tone: demStats.value.bias != null && Math.abs(demStats.value.bias) > 0.5 ? 'warn' : undefined, hint: 'systematic offset' },
  { label: 'Sampled', value: demStats.value.n },
  { label: 'Outside DEM', value: demStats.value.outside, tone: demStats.value.outside ? 'warn' : undefined },
])
const demColumns = [
  { key: 'name', label: 'GCP' }, { key: 'demZ', label: 'DEM Z', align: 'right', format: fmtM },
  { key: 'gcpZ', label: 'GCP Z', align: 'right', format: fmtM },
  { key: 'dz', label: 'ΔZ', align: 'right', format: (v, r) => (r.dz == null ? 'outside' : fmtM(v)) },
  { key: 'absDz', label: '|ΔZ|', align: 'right', format: fmtM },
]
</script>

<template>
  <div class="seg-row">
    <button v-for="t in TABS" :key="t.id" class="seg-btn" :class="{ active: tab === t.id }" @click="tab = t.id">{{ t.label }}</button>
  </div>

  <!-- GCP accuracy -->
  <template v-if="tab === 'gcps'">
    <div v-if="gcpLoading" class="eval-loading">Computing residuals…</div>
    <template v-else>
      <StatTiles :tiles="gcpTiles" />
      <DataTable :columns="gcpColumns" :rows="gcpRows" sort-key="dTotal" sort-dir="desc" empty-text="No GCPs.">
        <template #cell-enabled="{ row }">
          <input type="checkbox" class="checkbox" :checked="row.enabled" @click.stop="onToggle(row)" />
        </template>
        <template #expanded="{ row }">
          <div v-if="row.observations.length" class="obs-list">
            <div v-for="o in row.observations" :key="o.imageId" class="obs-row">
              <span class="obs-name">{{ imageName(o.imageId) }}</span>
              <span class="obs-px">{{ o.reprojPx != null ? o.reprojPx.toFixed(2) + ' px' : '—' }}</span>
            </div>
          </div>
          <div v-else class="obs-empty">No triangulable observations.</div>
        </template>
      </DataTable>
      <p class="eval-note">Checkpoint RMSE is independent: checkpoints are measured here but never enter georeferencing or bundle adjustment. Without checkpoints, the displayed control residual is only a fit residual.</p>
    </template>
  </template>

  <!-- Pose residuals -->
  <template v-else-if="tab === 'poses'">
    <div v-if="!recon.georef" class="eval-loading">Georeference the model first.</div>
    <template v-else>
      <StatTiles :tiles="poseTiles" />
      <DataTable :columns="poseColumns" :rows="poseRows" sort-key="dTotal" sort-dir="desc"
        empty-text="No imported poses match registered images." />
      <p class="eval-note">Registered camera centre (through the georeference) vs the imported pose, worst-first.</p>
    </template>
  </template>

  <!-- DEM vs GCPs -->
  <template v-else>
    <div v-if="!recon.dem" class="eval-loading">Build a DEM first.</div>
    <template v-else>
      <StatTiles :tiles="demTiles" />
      <DataTable :columns="demColumns" :rows="demRows" sort-key="absDz" sort-dir="desc"
        empty-text="No enabled GCPs with coordinates." />
      <p class="eval-note">DEM height at each GCP minus its surveyed Z, worst-first. A non-zero mean bias is a systematic vertical offset.</p>
    </template>
  </template>
</template>

<style scoped src="../ui/modal.css"></style>
<style scoped>
.eval-loading { padding: 24px; text-align: center; color: var(--text-dim); }
.eval-note { font-size: 11px; color: var(--text-dim); margin: 2px 0 0; }
.obs-list { display: flex; flex-direction: column; gap: 3px; }
.obs-row { display: flex; justify-content: space-between; gap: 16px; font-size: 12px; }
.obs-name { color: var(--text); }
.obs-px { color: var(--text-dim); font-variant-numeric: tabular-nums; }
.obs-empty { font-size: 12px; color: var(--text-dim); }
</style>
