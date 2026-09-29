<script setup>
import { computed, ref, watch } from 'vue'
import { useMeasurementsStore } from '../../stores/useMeasurementsStore.js'
import { measurementSource, measurementStamp, measurementStale } from '../../core/products/measurementRecord.js'
import { pixelToWorld } from '../../core/io/rasterSample.js'
import { polylineLength, planimetricArea, sampleProfile } from '../../core/products/measure.js'
import { isGeographic, linearCrsUnit } from '../../core/crs.js'

const props = defineProps({
  product: Object, source: Object, descriptor: Object, frameStatus: Object,
  kind: String, scale: Number, tx: Number, ty: Number,
})
const saved = useMeasurementsStore(), name = ref(''), selectedId = ref('')
const sourceKey = computed(() => measurementSource(props.kind, props.product))
const records = computed(() => saved.records.filter(r => r.source === sourceKey.value))
const selected = computed(() => records.value.find(r => r.id === selectedId.value))
const stale = computed(() => selected.value && measurementStale(selected.value, props.product, props.frameStatus))
const tool = ref('pan')
const vertices = ref([])
const finished = ref(false)
const unit = computed(() => selected.value?.unit || (props.product?.unit === 'model' ? 'model units'
  : props.product?.unit || (props.product?.crs && props.product.crs !== 'local' ? linearCrsUnit(props.product.crs) : 'model units')))
const unavailable = computed(() => !props.descriptor || props.frameStatus?.stale || props.product?.crsUnresolved
  || (props.product?.crs && isGeographic(props.product.crs)))
const grid = computed(() => {
  if (props.kind !== 'dem' || !props.descriptor) return null
  const data = props.source?.unsafePlane() ?? props.product?.data
  return data ? { ...props.descriptor, data, mask: props.product?.mask, nodata: props.product?.nodata } : null
})
const world = computed(() => selected.value?.world ?? vertices.value.map(p => pixelToWorld(props.descriptor, p.x, p.y)))
const distance = computed(() => polylineLength(world.value))
const area = computed(() => planimetricArea(world.value))
const profile = computed(() => selected.value?.profile ?? (tool.value === 'profile' && grid.value ? sampleProfile(grid.value, world.value) : []))
const paths = computed(() => {
  const valid = profile.value.filter(p => p.z != null)
  if (!valid.length) return []
  const lo = Math.min(...valid.map(p => p.z)), hi = Math.max(...valid.map(p => p.z))
  const out = []; let path = ''
  for (const p of profile.value) {
    if (p.z == null) { if (path) out.push(path); path = ''; continue }
    const x = 10 + 380 * p.distance / (distance.value || 1)
    const y = 100 - 90 * (p.z - lo) / (hi - lo || 1)
    path += `${path ? ' L' : 'M'}${x},${y}`
  }
  if (path) out.push(path)
  return out
})
const elevationRange = computed(() => {
  const z = profile.value.filter(p => p.z != null).map(p => p.z)
  return z.length ? `${Math.min(...z).toFixed(2)}–${Math.max(...z).toFixed(2)}` : 'no data'
})
const screenPoints = computed(() => vertices.value.map(p => `${props.tx + p.x * props.scale},${props.ty + p.y * props.scale}`).join(' '))
function reset() { selectedId.value = ''; name.value = ''; vertices.value = []; finished.value = false }
function choose(value) { tool.value = value; reset() }
function pick(x, y) {
  if (tool.value === 'pan' || unavailable.value || stale.value) return false
  if (finished.value) reset()
  const px = (x - props.tx) / props.scale, py = (y - props.ty) / props.scale
  if (px >= 0 && py >= 0 && px < props.product.width && py < props.product.height)
    vertices.value.push({ x: px, y: py })
  return true
}
function saveMeasurement() {
  selectedId.value = saved.add({ name: name.value.trim() || `${tool.value} ${records.value.length + 1}`,
    source: sourceKey.value, stamp: measurementStamp(props.product), kind: tool.value,
    vertices: vertices.value, world: world.value, distance: distance.value, area: area.value,
    unit: unit.value, verticalUnit: props.product?.verticalUnit || unit.value,
    profile: tool.value === 'profile' ? profile.value : null })
  finished.value = true
}
function openMeasurement(id) {
  selectedId.value = id
  const r = selected.value
  if (!r) { reset(); return }
  tool.value = r.kind; vertices.value = r.vertices.map(p => ({ ...p })); name.value = r.name; finished.value = true
}
function exportProfile() {
  const csv = `distance (${selected.value?.unit || unit.value}),elevation (${selected.value?.verticalUnit || props.product?.verticalUnit || unit.value})\n`
    + profile.value.map(p => `${p.distance},${p.z ?? ''}`).join('\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
  const a = document.createElement('a'); a.href = url; a.download = 'elevation-profile.csv'; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
watch(() => [props.product, props.product?.createdAt, props.product?.importedAt, props.frameStatus?.stale], () => { choose('pan') })
defineExpose({ pick, active: computed(() => tool.value !== 'pan') })
</script>

<template>
  <div class="measure-toolbar" @mousedown.stop @dblclick.stop>
    <label>Measure <select aria-label="Measurement tool" :value="tool" :disabled="!product || unavailable" @change="choose($event.target.value)">
      <option value="pan">Pan</option><option value="length">Ruler / polyline</option>
      <option value="area">Planimetric area</option><option value="profile" :disabled="!grid">Elevation profile</option>
    </select></label>
    <template v-if="tool !== 'pan'">
      <button :disabled="!vertices.length || finished" @click="vertices.pop()">Undo point</button>
      <button :disabled="vertices.length < (tool === 'area' ? 3 : 2)" @click="finished = true">Finish</button>
      <button @click="reset">Clear</button>
      <span>{{ finished ? 'Click to start another measurement' : 'Click vertices; Shift-drag to pan' }}</span>
    </template>
    <label v-if="records.length">Saved <select aria-label="Saved measurement" :value="selectedId" @change="openMeasurement($event.target.value)"><option value="">Choose measurement</option><option v-for="r in records" :key="r.id" :value="r.id">{{ r.name }}{{ measurementStale(r, product, frameStatus) ? ' (stale)' : '' }}</option></select></label>
    <span v-if="saved.error" role="alert">{{ saved.error }}</span>
    <span v-if="unavailable">Measurements need a current frame with linear coordinates.</span>
  </div>
  <svg v-if="vertices.length && !stale" class="measure-overlay" aria-label="Measurement geometry">
    <polygon v-if="tool === 'area' && vertices.length > 2" :points="screenPoints" fill="#43b9e033" stroke="#43b9e0" stroke-width="2" />
    <polyline v-else :points="screenPoints" fill="none" stroke="#43b9e0" stroke-width="2" />
    <circle v-for="(p, i) in vertices" :key="i" :cx="tx + p.x * scale" :cy="ty + p.y * scale" r="4" fill="white" stroke="#147c9e" />
  </svg>
  <div v-if="vertices.length > 1" class="measure-result" @mousedown.stop>
    <span v-if="stale" role="status">Stale: source raster or coordinate frame changed. Showing the saved result; redraw to measure the current source.</span>
    <b v-if="selected">{{ selected.kind === 'area' ? `Planimetric area: ${selected.area?.toFixed(2)} ${selected.unit}²` : `Horizontal distance: ${selected.distance.toFixed(2)} ${selected.unit}` }}</b>
    <b v-else-if="tool === 'area'">{{ area == null ? 'Polygon crosses itself — move or undo a point' : `Planimetric area: ${area.toFixed(2)} ${unit}²` }}</b>
    <b v-else>Horizontal distance: {{ distance.toFixed(2) }} {{ unit }}</b>
    <label>Name <input v-model="name" aria-label="Measurement name" /></label>
    <button v-if="!selected" :disabled="unavailable || (tool === 'area' && (vertices.length < 3 || area == null))" @click="saveMeasurement">Save measurement</button>
    <template v-else><button :disabled="!name.trim()" @click="saved.rename(selectedId, name)">Rename measurement</button><button @click="saved.remove(selectedId); reset()">Delete measurement</button></template>
    <template v-if="tool === 'profile'">
      <svg viewBox="0 0 400 110" role="img" aria-label="Elevation profile; gaps indicate no data">
        <path v-for="(path, i) in paths" :key="i" :d="path" fill="none" stroke="currentColor" stroke-width="2" />
      </svg>
      <span>Elevation: {{ elevationRange }} {{ selected?.verticalUnit || product?.verticalUnit || unit }} · gaps = no data</span>
      <button @click="exportProfile">Export profile CSV</button>
    </template>
  </div>
</template>

<style scoped>
.measure-toolbar { position: absolute; z-index: 4; top: 8px; left: 8px; right: 8px; display: flex; gap: 6px; flex-wrap: wrap; align-items: center; padding: 6px; background: var(--panel); border: 1px solid var(--panel-border); border-radius: 5px; font-size: 12px; }
.measure-overlay { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.measure-result { position: absolute; bottom: 12px; left: 8px; z-index: 4; display: flex; flex-direction: column; gap: 6px; padding: 10px; max-width: 420px; background: var(--panel); border: 1px solid var(--panel-border); border-radius: 5px; font-size: 12px; }
.measure-result svg { width: 380px; max-width: 100%; height: 110px; color: var(--accent); }
</style>
