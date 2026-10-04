<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from '../Icon.vue'
import { useMeasurementsStore } from '../../stores/useMeasurementsStore.js'
import { measurementSource, measurementStamp, measurementStale } from '../../core/products/measurementRecord.js'
import { pixelToWorld } from '../../core/io/rasterSample.js'
import { polylineLength, planimetricArea, sampleProfile, polygonVolume, groundVolume } from '../../core/products/measure.js'
import { isGeographic, linearCrsUnit, ensureProjection, transform, metresPerCrsUnit } from '../../core/crs.js'
import { pointScaleFactor } from '../../core/products/localFrame.js'

// Raster measurements over the active ProductViewer. The tool is CHOSEN from the
// Ribbon's contextual DEM/Orthophoto tab (Measure group) — this component only
// draws: a slim drawing bar while a tool is active, the geometry overlay, a result
// card, and the saved-measurement list. ProductViewer re-exposes `state` /
// `setTool` / `toggleSaved` so the Ribbon can show which tool is on.

const props = defineProps({
  product: Object, source: Object, descriptor: Object, frameStatus: Object,
  kind: String, scale: Number, tx: Number, ty: Number,
})

const TOOLS = {
  length: { label: 'Ruler', icon: 'ruler', min: 2 },
  area: { label: 'Area', icon: 'area', min: 3 },
  profile: { label: 'Profile', icon: 'profile', min: 2 },
  volume: { label: 'Volume', icon: 'volume', min: 3 },
}

const root = ref(null)
const saved = useMeasurementsStore(), name = ref(''), selectedId = ref('')
const showSaved = ref(false)
const sourceKey = computed(() => measurementSource(props.kind, props.product))
const records = computed(() => saved.records.filter(r => r.source === sourceKey.value))
const selected = computed(() => records.value.find(r => r.id === selectedId.value))
const stale = computed(() => selected.value && measurementStale(selected.value, props.product, props.frameStatus))
const tool = ref('pan')
const vertices = ref([])
const finished = ref(false)
const unit = computed(() => selected.value?.unit || (props.product?.unit === 'model' ? 'model units'
  : props.product?.unit || (props.product?.crs && props.product.crs !== 'local' ? linearCrsUnit(props.product.crs) : 'model units')))
const verticalUnit = computed(() => selected.value?.verticalUnit || props.product?.verticalUnit || unit.value)
const unavailable = computed(() => !props.descriptor || props.frameStatus?.stale || props.product?.crsUnresolved
  || (props.product?.crs && isGeographic(props.product.crs)))
const grid = computed(() => {
  if (props.kind !== 'dem' || !props.descriptor) return null
  const data = props.source?.unsafePlane() ?? props.product?.data
  // zOffset: a reference DEM's declared vertical offset, the same correction
  // sampleReferenceDem applies — the measurement stamp already records it.
  return data ? { ...props.descriptor, data, mask: props.product?.mask, nodata: props.product?.nodata,
    zOffset: props.product?.vOffset || 0 } : null
})
const world = computed(() => selected.value?.world ?? vertices.value.map(p => pixelToWorld(props.descriptor, p.x, p.y)))
// Point scale factor of the raster's projected CRS at its centre: grid lengths are
// ground lengths × k, so every horizontal quantity below is divided back to ground
// (localFrame.js / measure.js groundVolume). 1 for local/model frames.
const gridScale = ref(1)
let scaleToken = 0
watch([() => props.product?.crs, () => props.descriptor], async ([crs, desc]) => {
  const token = ++scaleToken
  gridScale.value = 1
  if (!crs || crs === 'local' || !desc) return
  try {
    await ensureProjection(crs)
    if (token !== scaleToken || isGeographic(crs)) return
    const c = pixelToWorld(desc, desc.width / 2, desc.height / 2)
    const k = pointScaleFactor((xy) => transform(xy, crs, 'EPSG:4326'), c.x, c.y, { metresPerUnit: metresPerCrsUnit(crs) ?? 1 })
    if (token === scaleToken && k > 0) gridScale.value = k
  } catch { /* unresolvable CRS: measuring is already disabled for it */ }
}, { immediate: true })
const distance = computed(() => polylineLength(world.value) / gridScale.value)
const area = computed(() => { const a = planimetricArea(world.value); return a == null ? a : a / gridScale.value ** 2 })
const perimeter = computed(() => (world.value.length > 2 ? polylineLength([...world.value, world.value[0]]) / gridScale.value : 0))
const profile = computed(() => selected.value?.profile ?? (tool.value === 'profile' && grid.value
  ? sampleProfile(grid.value, world.value).map((p) => ({ ...p, distance: p.distance / gridScale.value })) : []))

// Volume (cut/fill) against a base surface; live while drawing, the saved snapshot
// once a record is open. Errors are surfaced as text, never as a zero volume.
const baseKind = ref('plane')
const baseHeight = ref(null)
const volume = computed(() => {
  if (selected.value?.kind === 'volume') return selected.value.volume
  if (tool.value !== 'volume' || !grid.value || vertices.value.length < 3) return null
  // An empty custom-height field is "no base", never 0: Number(null/'') is 0, and a
  // cut/fill against sea level on a plateau looks plausible enough to be saved.
  const h = baseHeight.value
  return groundVolume(polygonVolume(grid.value, world.value, { base: baseKind.value, height: h === '' || h == null ? null : Number(h) }), gridScale.value)
})
const volumeUnit = computed(() => (verticalUnit.value === unit.value ? `${unit.value}³` : `${unit.value}²·${verticalUnit.value}`))
const VOLUME_ERRORS = {
  'self-intersecting': 'The polygon crosses itself — move or undo a point.',
  base: 'Base undetermined: the plane needs three non-collinear vertices on valid DEM cells, the lowest point needs one, a custom base needs a height.',
  'no-data': 'No valid DEM cells inside the polygon.',
  polygon: 'Add at least three vertices.',
}
const num = (v, digits = 2) => v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })
const fmtVolume = (v) => `${v.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${volumeUnit.value}`

const zRange = computed(() => {
  let lo = Infinity, hi = -Infinity
  for (const p of profile.value) if (p.z != null) { if (p.z < lo) lo = p.z; if (p.z > hi) hi = p.z }
  return lo <= hi ? { lo, hi } : null
})
const PLOT = { w: 360, h: 96, left: 4, top: 6 }
const paths = computed(() => {
  const range = zRange.value
  if (!range) return []
  const out = []; let path = ''
  for (const p of profile.value) {
    if (p.z == null) { if (path) out.push(path); path = ''; continue }
    const x = PLOT.left + (PLOT.w - 2 * PLOT.left) * p.distance / (distance.value || 1)
    const y = PLOT.top + (PLOT.h - 2 * PLOT.top) * (1 - (p.z - range.lo) / (range.hi - range.lo || 1))
    path += `${path ? ' L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`
  }
  if (path) out.push(path)
  return out
})

// What the result card shows: one headline value plus labelled rows.
const shownKind = computed(() => selected.value?.kind ?? tool.value)
// Shown whenever the projection scale factor moved the numbers, so a value can be
// reconciled with a GIS that reports grid measurements.
const scaleRow = computed(() => {
  const k = selected.value ? selected.value.groundScale : gridScale.value
  return k && Math.abs(k - 1) > 1e-6 ? [['Ground values', `grid ÷ k, scale factor k = ${k.toFixed(6)}`]] : []
})
const result = computed(() => withScaleRow(baseResult.value))
function withScaleRow(r) { return r.error ? r : { ...r, rows: [...(r.rows || []), ...scaleRow.value] } }
const baseResult = computed(() => {
  const k = shownKind.value
  if (k === 'area') {
    const a = selected.value ? selected.value.area : area.value
    if (a == null) return { error: 'The polygon crosses itself — move or undo a point.' }
    return { label: 'Planimetric area', value: `${num(a)} ${unit.value}²`,
      rows: [['Perimeter', `${num(perimeter.value)} ${unit.value}`], ['Vertices', world.value.length]] }
  }
  if (k === 'profile') {
    const r = zRange.value
    return { label: 'Horizontal length', value: `${num(selected.value?.distance ?? distance.value)} ${unit.value}`,
      rows: [['Elevation', r ? `${num(r.lo)} – ${num(r.hi)} ${verticalUnit.value}` : 'no data'],
        ['Relief', r ? `${num(r.hi - r.lo)} ${verticalUnit.value}` : '—']] }
  }
  if (k === 'volume') {
    const v = volume.value
    if (!v || v.error) return { error: VOLUME_ERRORS[v?.error] ?? 'Volume unavailable.' }
    const base = v.base.kind === 'plane' ? 'Best-fit plane'
      : `${v.base.kind === 'lowest' ? 'Lowest vertex' : 'Custom'}, ${num(v.base.height)} ${verticalUnit.value}`
    return { label: 'Net volume', value: fmtVolume(v.net),
      rows: [['Cut (above base)', fmtVolume(v.cut)], ['Fill (below base)', fmtVolume(v.fill)], ['Base', base],
        ['Area', `${num(area.value ?? 0)} ${unit.value}²`],
        ['DEM coverage', `${(v.coverage * 100).toFixed(1)}% of ${v.insideCells.toLocaleString()} cells`]],
      warn: v.coverage < 1 ? 'Holes and off-raster parts are excluded, not interpolated.' : '' }
  }
  return { label: 'Horizontal distance', value: `${num(selected.value?.distance ?? distance.value)} ${unit.value}`,
    rows: world.value.length > 2 ? [['Vertices', world.value.length]] : [] }
})
const canSave = computed(() => !unavailable.value && !result.value.error && vertices.value.length >= (TOOLS[tool.value]?.min ?? 2))

const hint = computed(() => {
  if (finished.value) return 'Click to start a new measurement'
  const need = (TOOLS[tool.value]?.min ?? 2) - vertices.value.length
  return need > 0 ? `Click ${need === 1 ? 'one more point' : `${need} points`} · Shift-drag pans`
    : 'Click to add points · Enter finishes · Shift-drag pans'
})
const screenPoints = computed(() => vertices.value.map(p => `${props.tx + p.x * props.scale},${props.ty + p.y * props.scale}`).join(' '))
const closedShape = computed(() => (shownKind.value === 'area' || shownKind.value === 'volume') && vertices.value.length > 2)

function reset() { selectedId.value = ''; name.value = ''; vertices.value = []; finished.value = false }
function choose(value) { tool.value = value; reset() }
// Ribbon entry point: clicking the active tool again turns measuring off.
function setTool(value) { choose(tool.value === value ? 'pan' : value) }
function toggleSaved() { showSaved.value = !showSaved.value }
function pick(x, y) {
  if (tool.value === 'pan' || unavailable.value || stale.value) return false
  if (finished.value) reset()
  const px = (x - props.tx) / props.scale, py = (y - props.ty) / props.scale
  if (px >= 0 && py >= 0 && px < props.product.width && py < props.product.height)
    vertices.value.push({ x: px, y: py })
  return true
}
function finish() { if (vertices.value.length >= (TOOLS[tool.value]?.min ?? 2)) finished.value = true }
function saveMeasurement() {
  selectedId.value = saved.add({ name: name.value.trim() || `${TOOLS[tool.value].label} ${records.value.length + 1}`,
    source: sourceKey.value, stamp: measurementStamp(props.product), kind: tool.value,
    vertices: vertices.value, world: world.value, distance: distance.value, area: area.value,
    unit: unit.value, verticalUnit: props.product?.verticalUnit || unit.value, groundScale: gridScale.value,
    profile: tool.value === 'profile' ? profile.value : null,
    volume: tool.value === 'volume' ? volume.value : null })
  name.value = selected.value?.name ?? ''
  finished.value = true
}
function openMeasurement(id) {
  selectedId.value = id
  const r = selected.value
  if (!r) { reset(); return }
  tool.value = r.kind; vertices.value = r.vertices.map(p => ({ ...p })); name.value = r.name; finished.value = true
}
function deleteMeasurement() { saved.remove(selectedId.value); reset() }
function recordValue(r) {
  const u = r.unit || 'model units'
  if (r.kind === 'area') return r.area == null ? '—' : `${num(r.area)} ${u}²`
  if (r.kind === 'volume') {
    if (!r.volume || r.volume.error) return '—'
    const v = r.verticalUnit && r.verticalUnit !== u ? `${u}²·${r.verticalUnit}` : `${u}³`
    return `${r.volume.net.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${v}`
  }
  return `${num(r.distance)} ${u}`
}
function exportProfile() {
  const csv = `distance (${selected.value?.unit || unit.value}),elevation (${verticalUnit.value})\n`
    + profile.value.map(p => `${p.distance},${p.z ?? ''}`).join('\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
  const a = document.createElement('a'); a.href = url; a.download = 'elevation-profile.csv'; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// Keyboard while a tool is active and this tab is in front (v-show hides others).
function onKey(e) {
  if (tool.value === 'pan' || !root.value?.offsetParent) return
  const t = e.target
  if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return
  if (e.key === 'Enter') { finish(); e.preventDefault() }
  else if (e.key === 'Backspace' && vertices.value.length && !finished.value) { vertices.value.pop(); e.preventDefault() }
  else if (e.key === 'Escape') { if (vertices.value.length) reset(); else choose('pan') }
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

// Multi-source on purpose: an array-returning getter is a NEW array on every
// evaluation, so any parent re-render (which recreates `frameStatus`) would read as
// a change — and the parent re-renders precisely when the tool changes, because
// the Ribbon displays it. Each source here is compared on its own.
watch([() => props.product, () => props.product?.createdAt, () => props.product?.importedAt, () => !!props.frameStatus?.stale],
  () => { choose('pan') })

// What the Ribbon needs to render the Measure group.
const state = computed(() => ({
  tool: tool.value,
  available: !!props.product && !unavailable.value,
  heights: !!grid.value,
  savedCount: records.value.length,
  showSaved: showSaved.value,
}))
defineExpose({ pick, active: computed(() => tool.value !== 'pan'), state, setTool, toggleSaved })
</script>

<template>
  <div ref="root" class="measure-layer">
    <svg v-if="vertices.length && !stale" class="measure-overlay" aria-label="Measurement geometry">
      <polygon v-if="closedShape" :points="screenPoints" class="geom geom-fill" />
      <polyline v-else :points="screenPoints" class="geom" />
      <circle v-for="(p, i) in vertices" :key="i" :cx="tx + p.x * scale" :cy="ty + p.y * scale" r="4" class="vertex" />
    </svg>

    <div v-if="tool !== 'pan'" class="measure-bar" role="toolbar" :aria-label="`${TOOLS[tool].label} measurement`"
      @mousedown.stop @dblclick.stop>
      <span class="mb-tool"><Icon :name="TOOLS[tool].icon" class="mb-icon" />{{ TOOLS[tool].label }}</span>
      <template v-if="tool === 'volume' && !selected">
        <span class="mb-sep"></span>
        <label class="mb-field">Base
          <select v-model="baseKind" class="mb-input" aria-label="Volume base surface">
            <option value="plane">Best-fit plane</option>
            <option value="lowest">Lowest vertex</option>
            <option value="custom">Custom height</option>
          </select>
        </label>
        <input v-if="baseKind === 'custom'" v-model.number="baseHeight" type="number" step="any"
          class="mb-input mb-num" aria-label="Base height" :placeholder="verticalUnit" />
      </template>
      <span class="mb-sep"></span>
      <span class="mb-hint">{{ hint }}</span>
      <button class="mb-btn" title="Remove the last point (Backspace)" :disabled="!vertices.length || finished" @click="vertices.pop()">
        <Icon name="undo" class="mb-icon" /><span class="sr-only">Undo point</span>
      </button>
      <button class="mb-btn" :disabled="finished || vertices.length < TOOLS[tool].min" title="Finish (Enter)" @click="finish">Finish</button>
      <button class="mb-btn" :disabled="!vertices.length" title="Clear the drawing (Esc)" @click="reset">Clear</button>
      <button class="mb-btn mb-close" title="Stop measuring (Esc)" aria-label="Stop measuring" @click="choose('pan')">
        <Icon name="x" class="mb-icon" />
      </button>
    </div>

    <div v-if="saved.error" class="measure-alert" role="alert">{{ saved.error }}</div>

    <aside v-if="showSaved" class="measure-panel saved-panel" aria-label="Saved measurements" @mousedown.stop @dblclick.stop>
      <header class="mp-head">
        <span class="mp-title">Saved measurements</span>
        <button class="mb-btn mb-close" aria-label="Close saved measurements" @click="showSaved = false"><Icon name="x" class="mb-icon" /></button>
      </header>
      <p v-if="!records.length" class="mp-empty">Nothing saved on this raster yet.</p>
      <ul v-else class="saved-list">
        <li v-for="r in records" :key="r.id">
          <button class="saved-item" :class="{ current: r.id === selectedId }" @click="openMeasurement(r.id)">
            <Icon :name="TOOLS[r.kind]?.icon ?? 'ruler'" class="si-icon" />
            <span class="si-name">{{ r.name }}</span>
            <span v-if="measurementStale(r, product, frameStatus)" class="badge">stale</span>
            <span class="si-value">{{ recordValue(r) }}</span>
          </button>
        </li>
      </ul>
    </aside>

    <section v-if="vertices.length > 1" class="measure-panel result-panel" aria-label="Measurement result" @mousedown.stop @dblclick.stop>
      <header class="mp-head">
        <span class="mp-title">{{ selected?.name || TOOLS[shownKind]?.label }}</span>
        <span v-if="stale" class="badge">stale</span>
      </header>
      <p v-if="stale" class="mp-note" role="status">Source raster or coordinate frame changed. Showing the saved result; redraw to measure the current source.</p>
      <p v-if="result.error" class="mp-error">{{ result.error }}</p>
      <template v-else>
        <div class="mp-label">{{ result.label }}</div>
        <div class="mp-value">{{ result.value }}</div>
        <dl v-if="result.rows.length" class="mp-rows">
          <template v-for="[k, v] in result.rows" :key="k"><dt>{{ k }}</dt><dd>{{ v }}</dd></template>
        </dl>
        <p v-if="result.warn" class="mp-note" role="status">{{ result.warn }}</p>
      </template>
      <svg v-if="shownKind === 'profile'" class="mp-plot" :viewBox="`0 0 ${PLOT.w} ${PLOT.h}`" preserveAspectRatio="none"
        role="img" aria-label="Elevation profile; gaps indicate no data">
        <path v-for="(path, i) in paths" :key="i" :d="path" />
      </svg>
      <footer class="mp-actions">
        <template v-if="!selected">
          <input v-model="name" class="mb-input mp-name" aria-label="Measurement name" :placeholder="`${TOOLS[shownKind]?.label} ${records.length + 1}`" @keydown.enter.stop="canSave && saveMeasurement()" />
          <button class="btn btn-primary btn-sm" :disabled="!canSave" @click="saveMeasurement">Save measurement</button>
        </template>
        <template v-else>
          <input v-model="name" class="mb-input mp-name" aria-label="Measurement name" />
          <button class="btn btn-sm" :disabled="!name.trim() || name.trim() === selected.name" title="Rename this measurement" @click="saved.rename(selectedId, name)">Rename</button>
          <button class="btn btn-sm btn-danger" title="Delete this measurement" @click="deleteMeasurement">Delete</button>
        </template>
        <button v-if="shownKind === 'profile'" class="btn btn-sm" @click="exportProfile">Export profile CSV</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.measure-layer { position: absolute; inset: 0; z-index: 4; pointer-events: none; font-size: 12px; color: var(--text); }
.measure-layer > :not(.measure-overlay) { pointer-events: auto; }
.measure-overlay { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.geom { fill: none; stroke: #43b9e0; stroke-width: 2; }
.geom-fill { fill: rgba(67, 185, 224, 0.18); }
.vertex { fill: #fff; stroke: #147c9e; stroke-width: 1.5; }

/* Drawing bar — same chrome as the 3D viewer's selection bar. */
.measure-bar {
  position: absolute; top: 10px; left: 50%; transform: translateX(-50%);
  /* max-content: with left:50% the shrink-to-fit width would be capped at half
     the view, wrapping a bar that fits comfortably. */
  display: flex; align-items: center; gap: 6px; width: max-content; max-width: calc(100% - 32px); flex-wrap: wrap;
  padding: 5px 6px 5px 10px; background: var(--panel); border: 1px solid var(--panel-border);
  border-radius: 8px; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
}
.mb-tool { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; }
.mb-icon { width: 15px; height: 15px; flex: none; }
.mb-sep { width: 1px; align-self: stretch; background: var(--panel-border); margin: 0 2px; }
.mb-hint { color: var(--text-dim); white-space: nowrap; }
.mb-field { display: inline-flex; align-items: center; gap: 6px; color: var(--text-dim); }
.mb-input {
  font: inherit; font-size: 12px; color: var(--text); background: var(--bg);
  border: 1px solid var(--panel-border); border-radius: 4px; padding: 3px 6px;
}
.mb-input:focus { outline: none; border-color: var(--accent); }
.mb-num { width: 84px; }
.mb-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 26px; min-width: 26px;
  padding: 0 8px; font: inherit; font-size: 12px; color: var(--text); background: none;
  border: 1px solid var(--panel-border); border-radius: 5px; cursor: pointer;
}
.mb-btn:hover:not(:disabled) { background: var(--hover-bg); }
.mb-btn:disabled { opacity: 0.45; cursor: default; }
.mb-close { border-color: transparent; padding: 0 4px; color: var(--text-dim); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }

.measure-alert {
  position: absolute; top: 52px; left: 50%; transform: translateX(-50%); padding: 6px 10px;
  border-radius: 6px; background: var(--panel); border: 1px solid var(--danger); color: var(--danger);
}

/* Cards — the sidebar/detail surface, floating over the raster. */
.measure-panel {
  position: absolute; display: flex; flex-direction: column; gap: 6px; padding: 10px 12px;
  background: var(--panel); border: 1px solid var(--panel-border); border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
}
.result-panel { left: 10px; bottom: 12px; width: 340px; max-width: calc(100% - 20px); }
.saved-panel { right: 10px; top: 10px; width: 280px; max-width: calc(100% - 20px); max-height: calc(100% - 70px); overflow: auto; }
.mp-head { display: flex; align-items: center; gap: 8px; min-height: 22px; }
.mp-title { font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mp-label { color: var(--text-dim); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
.mp-value { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.2; }
.mp-rows { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; margin: 2px 0 0; }
.mp-rows dt { color: var(--text-dim); }
.mp-rows dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
.mp-note { margin: 0; color: var(--text-dim); line-height: 1.4; }
.mp-error { margin: 0; color: var(--danger); line-height: 1.4; }
.mp-empty { margin: 0; color: var(--text-dim); }
.mp-plot {
  width: 100%; height: 96px; border: 1px solid var(--panel-border); border-radius: 4px;
  background: var(--bg); color: var(--accent);
}
.mp-plot path { fill: none; stroke: currentColor; stroke-width: 2; vector-effect: non-scaling-stroke; }
.mp-actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 4px; }
.mp-name { flex: 1 1 120px; min-width: 0; }
.btn-sm { font-size: 12px; padding: 3px 10px; }
.btn-danger { color: var(--danger); }
.badge {
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; padding: 1px 6px; border-radius: 8px;
  color: var(--danger); border: 1px solid currentColor;
}

.saved-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.saved-item {
  display: grid; grid-template-columns: 16px 1fr auto; grid-template-areas: 'icon name badge' 'icon value value';
  column-gap: 8px; width: 100%; padding: 6px; font: inherit; font-size: 12px; text-align: left; color: var(--text);
  background: none; border: 1px solid transparent; border-radius: 5px; cursor: pointer;
}
.saved-item:hover { background: var(--hover-bg); }
.saved-item.current { border-color: var(--accent); }
.si-icon { grid-area: icon; width: 16px; height: 16px; color: var(--text-dim); }
.si-name { grid-area: name; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.saved-item .badge { grid-area: badge; }
.si-value { grid-area: value; color: var(--text-dim); font-variant-numeric: tabular-nums; }
</style>
