<script setup>
import { computed } from 'vue'
import StatTiles from '../ui/StatTiles.vue'
import DataTable from '../ui/DataTable.vue'
import { useReconstructionStore } from '../../../stores/useReconstructionStore.js'
import { useImagesStore } from '../../../stores/useImagesStore.js'

// Quality Report ▸ Dense (WS2.4): split into two clearly-labelled groups — "Per-map
// coverage" (a table) and "Fusion cull breakdown" (tiles, only when a dense summary
// exists). GSD is now real (persisted per-map MEDIAN valid depth ÷ fx); pre-v3
// indexes fall back to the depth midpoint and mark it "~".
const recon = useReconstructionStore()
const imagesStore = useImagesStore()
const nameByUuid = computed(() => new Map(imagesStore.images.map((im) => [im.uuid, im.name])))

function coverageOf(depth) {
  if (!depth || !depth.length) return { validPx: 0, depthMin: null, depthMax: null, depthMedian: null }
  let valid = 0, min = Infinity, max = -Infinity
  const vals = []
  for (let i = 0; i < depth.length; i++) {
    const d = depth[i]
    if (d > 0) { valid++; vals.push(d); if (d < min) min = d; if (d > max) max = d }
  }
  if (!valid) return { validPx: 0, depthMin: null, depthMax: null, depthMedian: null }
  vals.sort((a, b) => a - b)
  return { validPx: valid, depthMin: min, depthMax: max, depthMedian: vals[vals.length >> 1] }
}

const rows = computed(() => {
  const meta = recon.depthMapsMeta
  const live = recon.depthMaps
  let src
  if (meta.length) {
    src = meta.map((m) => ({ ...m, fx: m.K?.fx ?? null }))
  } else {
    src = [...live.values()].map((m) => ({ uuid: m.uuid, width: m.width, height: m.height, fx: m.K?.fx ?? null, ...coverageOf(m.depth) }))
  }
  return src.map((m) => {
    const px = m.width * m.height
    const pctValid = (m.validPx != null && px) ? (m.validPx / px) * 100 : null
    // Real GSD from median depth (v3); else midpoint (approximate, flagged).
    let repDepth = m.depthMedian ?? null
    let approx = false
    if (repDepth == null && m.depthMin != null && m.depthMax != null) { repDepth = (m.depthMin + m.depthMax) / 2; approx = true }
    const gsd = (repDepth != null && m.fx) ? repDepth / m.fx : null
    return {
      id: m.uuid, name: nameByUuid.value.get(m.uuid) ?? m.uuid, dims: `${m.width}×${m.height}`,
      pctValid, depthMin: m.depthMin, depthMax: m.depthMax, depthMedian: m.depthMedian ?? null, gsd, approx,
    }
  })
})

const ds = computed(() => recon.denseSummary)
const pct = (v) => (v == null ? '—' : v.toFixed(1))
const num = (v, d = 3) => (v == null ? '—' : v.toFixed(d))

const cullTiles = computed(() => {
  const d = ds.value
  if (!d) return null
  const cb = d.cullBreakdown ?? {}
  return [
    { label: 'Cost median', value: num(d.costMedian) },
    { label: 'Kept', value: pct(d.keptPct), unit: '%' },
    { label: 'Merge cell', value: num(d.mergeCell) },
    { label: 'No depth', value: pct(cb.noDepthPct), unit: '%' },
    { label: 'High cost', value: pct(cb.highCostPct), unit: '%' },
    { label: 'Low views', value: pct(cb.lowViewsPct), unit: '%' },
    { label: 'Low parallax', value: pct(cb.lowParallaxPct), unit: '%' },
    { label: 'Grazing', value: pct(cb.grazingPct), unit: '%' },
  ]
})

const columns = [
  { key: 'name', label: 'Image' },
  { key: 'dims', label: 'Dims', sortable: false },
  { key: 'pctValid', label: 'Valid %', align: 'right', format: (v) => (v == null ? '—' : v.toFixed(1) + '%') },
  { key: 'depthMedian', label: 'Depth med', align: 'right', format: (v) => num(v, 2) },
  { key: 'depthMin', label: 'Min', align: 'right', format: (v) => num(v, 2) },
  { key: 'depthMax', label: 'Max', align: 'right', format: (v) => num(v, 2) },
  { key: 'gsd', label: 'GSD', align: 'right', format: (v, r) => (v == null ? '—' : (r.approx ? '~' : '') + num(v, 4)) },
]
</script>

<template>
  <div v-if="!rows.length" class="eval-loading">No depth maps.</div>
  <template v-else>
    <div class="grp-label">Per-map coverage <span class="grp-note">({{ recon.depthMapCount }} maps)</span></div>
    <DataTable :columns="columns" :rows="rows" sort-key="pctValid" sort-dir="asc" empty-text="No depth maps." />
    <p class="eval-note">Sorted lowest-coverage first. GSD = median depth ÷ fx; "~" marks a pre-v3 midpoint estimate.</p>

    <template v-if="cullTiles">
      <div class="grp-label">Fusion cull breakdown</div>
      <StatTiles :tiles="cullTiles" />
      <p class="eval-note">Why Stage B dropped pixels during fusion.</p>
    </template>
  </template>
</template>

<style scoped src="../ui/modal.css"></style>
<style scoped>
.eval-loading { padding: 24px; text-align: center; color: var(--text-dim); }
.eval-note { font-size: 11px; color: var(--text-dim); margin: 2px 0 0; }
.grp-label { font-size: 12px; font-weight: 600; color: var(--text); margin-top: 4px; }
.grp-note { font-weight: 400; color: var(--text-dim); }
</style>
