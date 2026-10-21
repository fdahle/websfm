<script setup>
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import Icon from '../Icon.vue'
import FloatingToolbox from './FloatingToolbox.vue'
import { useMeasurementsStore } from '../../stores/useMeasurementsStore.js'
import { useExternalStore } from '../../stores/useExternalStore.js'
import { measurementSource, measurementStamp, measurementStale } from '../../core/products/measurementRecord.js'
import { pixelToWorld, worldToPixel } from '../../core/io/rasterSample.js'
import {
  polylineLength,
  planimetricArea,
  sampleProfile,
  polygonVolume,
  groundVolume,
  SURFACE_VOLUME_MAX_SAMPLES,
} from '../../core/products/measure.js'
import { isGeographic } from '../../core/crs.js'
import { rasterGroundScale, rasterUnits, volumeUnitLabel } from '../../core/products/rasterUnits.js'
import { viewerMayHandleKey } from '../../utils/keyRouting.js'
import { demRef } from '../../core/products/demWindow.js'
import { productDescriptor } from '../../core/io/rasterSource.js'
import { readDemWindow } from '../../workers/computeClient.js'

// Raster measurements over the active ProductViewer. The tool is CHOSEN from the
// Ribbon's contextual DEM/Orthophoto tab (Measure group) — this component only
// draws: a slim drawing bar while a tool is active, the geometry overlay, a result
// card, and the saved-measurement list. ProductViewer re-exposes `state` /
// `setTool` / `toggleSaved` so the Ribbon can show which tool is on.
//
// Host-agnostic on purpose (the raster tab and the 2D map host it): values come only
// from `source` (a RasterSource, computed or imported alike) and screen geometry
// only from `view`, so the same tool can run over the product tab and the map.
//   view: { toScreen(wx, wy) → {x, y}, fromScreen(sx, sy) → {x, y} } in the
//         RASTER's own world frame. The host replaces the object whenever its
//         transform changes, which is what re-renders the overlay.
// All measuring happens in the raster's frame; a host's reprojection only ever
// touches drawing and input.

const props = defineProps({
  product: Object,
  source: Object,
  descriptor: Object,
  frameStatus: Object,
  kind: String,
  view: Object,
  // How this host pans while a tool is active (the hint line names it).
  panHint: { type: String, default: 'Shift-drag pans' },
})
// 'command' (id, value): the saved list's Export… opens Export ▸ Measurements for it.
const emit = defineEmits(['command'])

const TOOLS = {
  length: { label: 'Ruler', icon: 'ruler', min: 2 },
  area: { label: 'Area', icon: 'area', min: 3 },
  profile: { label: 'Profile', icon: 'profile', min: 2 },
  volume: { label: 'Volume', icon: 'volume', min: 3 },
}

const root = ref(null)
const saved = useMeasurementsStore(),
  name = ref(''),
  selectedId = ref('')
const showSaved = ref(false)
const sourceKey = computed(() => measurementSource(props.kind, props.product))
const records = computed(() => saved.records.filter((r) => r.source === sourceKey.value))
const selected = computed(() => records.value.find((r) => r.id === selectedId.value))
const stale = computed(() => selected.value && measurementStale(selected.value, props.product, props.frameStatus))
const tool = ref('pan')
// Raster-world {x, y}; saved records also keep the pixel form (see saveMeasurement).
const vertices = ref([])
const finished = ref(false)
// A saved record keeps the units it was measured in; live drawing asks the raster.
const productUnits = computed(() => rasterUnits(props.product))
const unit = computed(() => selected.value?.unit || productUnits.value.horizontal)
const verticalUnit = computed(() => selected.value?.verticalUnit || productUnits.value.vertical)
const unavailable = computed(
  () =>
    !props.descriptor ||
    !props.view ||
    props.frameStatus?.stale ||
    props.product?.crsUnresolved ||
    (props.product?.crs && isGeographic(props.product.crs)),
)
const world = computed(() => selected.value?.world ?? vertices.value)
// A block-built DEM (SAT-3) is measured on a window of its COG around the drawn shape,
// at the finest level within WINDOW_CELLS — read in the worker once the shape stops
// changing. Until it arrives (and for any other DEM) the plane is the grid.
const WINDOW_CELLS = 16 * 1024 ** 2
const windowGrid = shallowRef(null)
let windowToken = 0,
  windowTimer = null
// Keyed by the coordinates: drawing pushes into the same vertex array.
watch(
  [() => world.value.map((p) => `${p.x},${p.y}`).join(';'), () => props.product],
  ([, product]) => {
    const pts = world.value
    clearTimeout(windowTimer)
    const token = ++windowToken
    if (props.kind !== 'dem' || !product?.cog || !(pts?.length >= 2)) {
      windowGrid.value = null
      return
    }
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity
    for (const p of pts) {
      minX = Math.min(minX, p.x)
      maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y)
      maxY = Math.max(maxY, p.y)
    }
    const key = `${minX},${minY},${maxX},${maxY}`
    if (windowGrid.value?.key === key && windowGrid.value.product === product) return
    windowTimer = setTimeout(async () => {
      try {
        const g = await readDemWindow({
          dem: demRef(product),
          rect: { minX, minY, maxX, maxY },
          maxCells: WINDOW_CELLS,
        })
        if (token !== windowToken) return
        windowGrid.value = g && {
          key,
          product,
          ...productDescriptor(g),
          data: g.data,
          mask: g.mask,
          nodata: null,
          zOffset: product.vOffset || 0,
          level: g.level,
        }
      } catch {
        if (token === windowToken) windowGrid.value = null
      }
    }, 150)
  },
  { immediate: true },
)
onBeforeUnmount(() => clearTimeout(windowTimer))
const grid = computed(() => {
  if (props.kind !== 'dem' || !props.descriptor) return null
  if (windowGrid.value?.product === props.product) return windowGrid.value
  const data = props.source?.unsafePlane()
  // zOffset: a reference DEM's declared vertical offset, the same correction
  // sampleReferenceDem applies — the measurement stamp already records it.
  return data
    ? {
        ...props.descriptor,
        data,
        mask: props.product?.mask,
        nodata: props.product?.nodata,
        zOffset: props.product?.vOffset || 0,
      }
    : null
})
// Point scale factor of the raster's projected CRS at its centre (rasterUnits.js):
// every horizontal quantity below is divided back to ground. 1 for local/model
// frames; a geographic CRS has none, and measuring is disabled for it.
const gridScale = ref(1)
let scaleToken = 0
watch(
  [() => props.product?.crs, () => props.descriptor],
  async ([crs, desc]) => {
    const token = ++scaleToken
    gridScale.value = 1
    try {
      const k = await rasterGroundScale(desc, crs)
      if (token === scaleToken && k != null) gridScale.value = k
    } catch {
      /* unresolvable CRS: measuring is already disabled for it */
    }
  },
  { immediate: true },
)
// A reopened record reads with the scale it was saved with, so its numbers stay
// the ones that were saved.
const recordScale = computed(() => selected.value?.groundScale ?? gridScale.value)
const distance = computed(() => polylineLength(world.value) / recordScale.value)
const area = computed(() => {
  const a = planimetricArea(world.value)
  return a == null ? a : a / recordScale.value ** 2
})
const perimeter = computed(() =>
  world.value.length > 2 ? polylineLength([...world.value, world.value[0]]) / recordScale.value : 0,
)
const profile = computed(
  () =>
    selected.value?.profile ??
    (tool.value === 'profile' && grid.value
      ? sampleProfile(grid.value, world.value).map((p) => ({ ...p, distance: p.distance / gridScale.value }))
      : []),
)

// Volume (cut/fill) against a base surface; live while drawing, the saved snapshot
// once a record is open. Errors are surfaced as text, never as a zero volume.
const baseKind = ref('plane')
const baseHeight = ref(null)
// DEM of difference: the computed DEM (no `id`; a reference raster has one) in a CRS
// against an imported reference DEM, sampled through the external store's
// reprojected query in the DEM's own CRS. Base value `ref:<rasterId>`.
const external = useExternalStore()
const referenceBases = computed(() =>
  props.kind === 'dem' && !props.product?.id && props.product?.crs && props.product.crs !== 'local'
    ? external.demRasters
    : [],
)
const refSampler = shallowRef(null)
const refError = ref('')
watch([baseKind, () => props.product?.crs, () => props.product?.verticalDatum], async ([kind, crs]) => {
  refSampler.value = null
  refError.value = ''
  if (!kind.startsWith('ref:')) return
  try {
    // Strict: a reference hole, or a cell centre off the reference, is unmeasured;
    // never a neighbour's height borrowed across the hole's edge. Heights in the
    // DEM's vertical datum when the reference's converts to it (a geoid offset
    // would otherwise read as a uniform change).
    const s = await external.referenceDemSampler(kind.slice(4), crs, {
      strict: true,
      datum: props.product?.verticalDatum ?? null,
    })
    if (baseKind.value === kind) refSampler.value = { name: s.meta.name, sample: s.sample }
  } catch (err) {
    refError.value = err?.message ?? String(err)
  }
})
const volume = computed(() => {
  if (selected.value?.kind === 'volume') return selected.value.volume
  if (tool.value !== 'volume' || !grid.value || vertices.value.length < 3) return null
  // An empty custom-height field is "no base", never 0: Number(null/'') is 0, and a
  // cut/fill against sea level on a plateau looks plausible enough to be saved.
  if (baseKind.value.startsWith('ref:')) {
    if (refError.value) return { error: 'reference' }
    if (!refSampler.value) return null
    // Each compared cell reprojects into the reference: a sub-grid of at most 64 k
    // cells while the polygon is drawn (this reruns per vertex), 262 k once closed.
    return groundVolume(
      polygonVolume(grid.value, world.value, {
        base: 'surface',
        surface: refSampler.value,
        maxSurfaceSamples: finished.value ? SURFACE_VOLUME_MAX_SAMPLES : 65536,
      }),
      gridScale.value,
    )
  }
  const h = baseHeight.value
  return groundVolume(
    polygonVolume(grid.value, world.value, { base: baseKind.value, height: h === '' || h == null ? null : Number(h) }),
    gridScale.value,
  )
})
const volumeUnit = computed(() => volumeUnitLabel({ horizontal: unit.value, vertical: verticalUnit.value }))
const VOLUME_ERRORS = {
  'self-intersecting': 'The polygon crosses itself — move or undo a point.',
  'base':
    'Base undetermined: the plane needs three non-collinear vertices on valid DEM cells, the lowest point needs one, a custom base needs a height.',
  'no-data': 'No valid DEM cells inside the polygon (where a reference DEM is the base: none it covers too).',
  'reference': 'The reference DEM cannot be sampled here.',
  'polygon': 'Add at least three vertices.',
}
const num = (v, digits = 2) =>
  v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })
const fmtVolume = (v) => `${v.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${volumeUnit.value}`

const zRange = computed(() => {
  let lo = Infinity,
    hi = -Infinity
  for (const p of profile.value)
    if (p.z != null) {
      if (p.z < lo) lo = p.z
      if (p.z > hi) hi = p.z
    }
  return lo <= hi ? { lo, hi } : null
})
const PLOT = { w: 360, h: 96, left: 4, top: 6 }
const paths = computed(() => {
  const range = zRange.value
  if (!range) return []
  const out = []
  let path = ''
  for (const p of profile.value) {
    if (p.z == null) {
      if (path) out.push(path)
      path = ''
      continue
    }
    const x = PLOT.left + ((PLOT.w - 2 * PLOT.left) * p.distance) / (distance.value || 1)
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
function withScaleRow(r) {
  return r.error ? r : { ...r, rows: [...(r.rows || []), ...scaleRow.value] }
}
const baseResult = computed(() => {
  const k = shownKind.value
  if (k === 'area') {
    const a = selected.value ? selected.value.area : area.value
    if (a == null) return { error: 'The polygon crosses itself — move or undo a point.' }
    return {
      label: 'Planimetric area',
      value: `${num(a)} ${unit.value}²`,
      rows: [
        ['Perimeter', `${num(perimeter.value)} ${unit.value}`],
        ['Vertices', world.value.length],
      ],
    }
  }
  if (k === 'profile') {
    const r = zRange.value
    return {
      label: 'Horizontal length',
      value: `${num(selected.value?.distance ?? distance.value)} ${unit.value}`,
      rows: [
        ['Elevation', r ? `${num(r.lo)} – ${num(r.hi)} ${verticalUnit.value}` : 'no data'],
        ['Relief', r ? `${num(r.hi - r.lo)} ${verticalUnit.value}` : '—'],
      ],
    }
  }
  if (k === 'volume') {
    const v = volume.value
    if (!v || v.error) return { error: VOLUME_ERRORS[v?.error] ?? 'Volume unavailable.' }
    const diff = v.base.kind === 'surface'
    const base = diff
      ? `Reference DEM "${v.base.name}"`
      : v.base.kind === 'plane'
        ? 'Best-fit plane'
        : `${v.base.kind === 'lowest' ? 'Lowest vertex' : 'Custom'}, ${num(v.base.height)} ${verticalUnit.value}`
    // Against another epoch, "cut/fill" reads as gain and loss.
    return {
      label: diff ? 'Net change' : 'Net volume',
      value: fmtVolume(v.net),
      rows: [
        [diff ? 'Gain (above the reference)' : 'Cut (above base)', fmtVolume(v.cut)],
        [diff ? 'Loss (below the reference)' : 'Fill (below base)', fmtVolume(v.fill)],
        ['Base', base],
        ['Area', `${num(area.value ?? 0)} ${unit.value}²`],
        ['DEM coverage', `${(v.coverage * 100).toFixed(1)}% of ${v.insideCells.toLocaleString()} cells`],
        ...(v.sampleStep > 1 ? [['Sampled', `1 cell in ${v.sampleStep}×${v.sampleStep} (an estimate)`]] : []),
      ],
      warn: [
        v.coverage < 1
          ? diff
            ? 'Holes in either DEM and parts outside the reference are excluded, not interpolated.'
            : 'Holes and off-raster parts are excluded, not interpolated.'
          : '',
        diff ? "Both DEMs must use the same vertical datum; a reference's declared offset is applied." : '',
      ]
        .filter(Boolean)
        .join(' '),
    }
  }
  return {
    label: 'Horizontal distance',
    value: `${num(selected.value?.distance ?? distance.value)} ${unit.value}`,
    rows: world.value.length > 2 ? [['Vertices', world.value.length]] : [],
  }
})
const canSave = computed(
  () => !unavailable.value && !result.value.error && vertices.value.length >= (TOOLS[tool.value]?.min ?? 2),
)

const hint = computed(() => {
  if (finished.value) return 'Click to start a new measurement'
  const need = (TOOLS[tool.value]?.min ?? 2) - vertices.value.length
  return need > 0
    ? `Click ${need === 1 ? 'one more point' : `${need} points`} · ${props.panHint}`
    : `Click to add points · Enter finishes · ${props.panHint}`
})
const screenVertices = computed(() => (props.view ? vertices.value.map((p) => props.view.toScreen(p.x, p.y)) : []))
const screenPoints = computed(() => screenVertices.value.map((p) => `${p.x},${p.y}`).join(' '))
const closedShape = computed(
  () => (shownKind.value === 'area' || shownKind.value === 'volume') && vertices.value.length > 2,
)

function reset() {
  selectedId.value = ''
  name.value = ''
  vertices.value = []
  finished.value = false
}
function choose(value) {
  tool.value = value
  reset()
}
// Ribbon entry point: clicking the active tool again turns measuring off.
// opts.base 'reference' (Measure ▸ DEM of difference): open Volume against the first
// reference DEM, never toggling it off.
function setTool(value, opts = {}) {
  if (opts.base === 'reference' && value === 'volume') {
    choose('volume')
    baseKind.value = referenceBases.value.length ? `ref:${referenceBases.value[0].id}` : 'plane'
    return
  }
  choose(tool.value === value ? 'pan' : value)
}
function toggleSaved() {
  showSaved.value = !showSaved.value
}
function pick(x, y) {
  if (tool.value === 'pan' || unavailable.value || stale.value) return false
  if (finished.value) reset()
  const w = props.view.fromScreen(x, y)
  const px = w && worldToPixel(props.descriptor, w.x, w.y)
  if (px && px.col >= 0 && px.row >= 0 && px.col < props.descriptor.width && px.row < props.descriptor.height)
    vertices.value.push({ x: w.x, y: w.y })
  return true
}
function finish() {
  if (vertices.value.length >= (TOOLS[tool.value]?.min ?? 2)) finished.value = true
}
function saveMeasurement() {
  selectedId.value = saved.add({
    name: name.value.trim() || `${TOOLS[tool.value].label} ${records.value.length + 1}`,
    source: sourceKey.value,
    stamp: measurementStamp(props.product),
    kind: tool.value,
    // `vertices` (pixel) is what older records hold and what the store validates;
    // `world` is what reopening reads.
    vertices: vertices.value.map((p) => {
      const c = worldToPixel(props.descriptor, p.x, p.y)
      return { x: c.col, y: c.row }
    }),
    world: vertices.value.map((p) => ({ x: p.x, y: p.y })),
    distance: distance.value,
    area: area.value,
    // The frame `world` is in, and what it was measured on, for the export.
    crs: props.product?.crs ?? 'local',
    sourceName: props.product?.name ?? null,
    unit: unit.value,
    verticalUnit: verticalUnit.value,
    groundScale: gridScale.value,
    profile: tool.value === 'profile' ? profile.value : null,
    volume: tool.value === 'volume' ? volume.value : null,
  })
  name.value = selected.value?.name ?? ''
  finished.value = true
}
function openMeasurement(id) {
  selectedId.value = id
  const r = selected.value
  if (!r) {
    reset()
    return
  }
  const pts = r.world ?? r.vertices.map((p) => pixelToWorld(props.descriptor, p.x, p.y))
  tool.value = r.kind
  vertices.value = pts.map((p) => ({ x: p.x, y: p.y }))
  name.value = r.name
  finished.value = true
}
function deleteMeasurement() {
  saved.remove(selectedId.value)
  reset()
}
function recordValue(r) {
  const u = r.unit || 'model units'
  if (r.kind === 'area') return r.area == null ? '—' : `${num(r.area)} ${u}²`
  if (r.kind === 'volume') {
    if (!r.volume || r.volume.error) return '—'
    const v = volumeUnitLabel({ horizontal: u, vertical: r.verticalUnit || u })
    return `${r.volume.net.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${v}`
  }
  return `${num(r.distance)} ${u}`
}
// The list's Export…: Export ▸ Measurements, for this raster's records only.
function exportSaved() {
  const n = records.value.length
  emit('command', 'export-measurements', {
    ids: records.value.map((r) => r.id),
    label: `${n} measurement${n === 1 ? '' : 's'} on ${props.product?.name ?? (props.kind === 'ortho' ? 'the orthophoto' : 'the DEM')}`,
  })
}
function exportProfile() {
  const csv =
    `distance (${selected.value?.unit || unit.value}),elevation (${verticalUnit.value})\n` +
    profile.value.map((p) => `${p.distance},${p.z ?? ''}`).join('\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
  const a = document.createElement('a')
  a.href = url
  a.download = 'elevation-profile.csv'
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// Keyboard while a tool is active and this tab is in front (v-show hides others).
// Ignored while a dialog is open or a field has focus (see utils/keyRouting); a key
// acted on is consumed, so App's Escape does not also leave the map's GCP edit.
function onKey(e) {
  if (tool.value === 'pan' || !root.value?.offsetParent) return
  if (!viewerMayHandleKey(e)) return
  if (e.key === 'Enter') {
    finish()
    e.preventDefault()
  } else if (e.key === 'Backspace' && vertices.value.length && !finished.value) {
    vertices.value.pop()
    e.preventDefault()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    if (vertices.value.length) reset()
    else choose('pan')
  }
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

// Multi-source on purpose: an array-returning getter is a NEW array on every
// evaluation, so any parent re-render (which recreates `frameStatus`) would read as
// a change — and the parent re-renders precisely when the tool changes, because
// the Ribbon displays it. Each source here is compared on its own.
watch(
  [
    () => props.product,
    () => props.product?.createdAt,
    () => props.product?.importedAt,
    () => !!props.frameStatus?.stale,
  ],
  () => {
    choose('pan')
  },
)

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
      <circle v-for="(p, i) in screenVertices" :key="i" :cx="p.x" :cy="p.y" r="4" class="vertex" />
    </svg>

    <!-- The measuring tool's toolbox: the ribbon (raster ▸ Measure) picks the tool. -->
    <FloatingToolbox
      v-if="tool !== 'pan'"
      id="measure"
      :title="TOOLS[tool].label"
      :aria-label="`${TOOLS[tool].label} measurement`"
      anchor="top-center"
      close-title="Stop measuring (Esc)"
      @close="choose('pan')"
    >
      <div class="mb-row">
        <template v-if="tool === 'volume' && !selected">
          <label class="mb-field"
            >Base
            <select v-model="baseKind" class="mb-input" aria-label="Volume base surface">
              <option value="plane">Best-fit plane</option>
              <option value="lowest">Lowest vertex</option>
              <option value="custom">Custom height</option>
              <option v-for="r in referenceBases" :key="r.id" :value="`ref:${r.id}`">
                Reference DEM: {{ r.name }}
              </option>
            </select>
          </label>
          <input
            v-if="baseKind === 'custom'"
            v-model.number="baseHeight"
            type="number"
            step="any"
            class="mb-input mb-num"
            aria-label="Base height"
            :placeholder="verticalUnit"
          />
          <span class="mb-sep"></span>
        </template>
        <span class="mb-hint">{{ hint }}</span>
        <button
          class="mb-btn"
          title="Remove the last point (Backspace)"
          :disabled="!vertices.length || finished"
          @click="vertices.pop()"
        >
          <Icon name="undo" class="mb-icon" /><span class="sr-only">Undo point</span>
        </button>
        <button
          class="mb-btn"
          :disabled="finished || vertices.length < TOOLS[tool].min"
          title="Finish (Enter)"
          @click="finish"
        >
          Finish
        </button>
        <button class="mb-btn" :disabled="!vertices.length" title="Clear the drawing (Esc)" @click="reset">
          Clear
        </button>
      </div>
    </FloatingToolbox>

    <div v-if="saved.error" class="measure-alert" role="alert">{{ saved.error }}</div>

    <aside
      v-if="showSaved"
      class="measure-panel saved-panel"
      aria-label="Saved measurements"
      @mousedown.stop
      @dblclick.stop
    >
      <header class="mp-head">
        <span class="mp-title">Saved measurements</span>
        <button
          v-if="records.length"
          class="mb-btn"
          title="Export these measurements as CSV or GeoJSON"
          @click="exportSaved"
        >
          Export…
        </button>
        <button class="mb-btn mb-close" aria-label="Close saved measurements" @click="showSaved = false">
          <Icon name="x" class="mb-icon" />
        </button>
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

    <section
      v-if="vertices.length > 1"
      class="measure-panel result-panel"
      aria-label="Measurement result"
      @mousedown.stop
      @dblclick.stop
    >
      <header class="mp-head">
        <span class="mp-title">{{ selected?.name || TOOLS[shownKind]?.label }}</span>
        <span v-if="stale" class="badge">stale</span>
      </header>
      <p v-if="stale" class="mp-note" role="status">
        Source raster or coordinate frame changed. Showing the saved result; redraw to measure the current source.
      </p>
      <p v-if="result.error" class="mp-error">{{ result.error }}</p>
      <template v-else>
        <div class="mp-label">{{ result.label }}</div>
        <div class="mp-value">{{ result.value }}</div>
        <dl v-if="result.rows.length" class="mp-rows">
          <template v-for="[k, v] in result.rows" :key="k"
            ><dt>{{ k }}</dt>
            <dd>{{ v }}</dd></template
          >
        </dl>
        <p v-if="result.warn" class="mp-note" role="status">{{ result.warn }}</p>
      </template>
      <svg
        v-if="shownKind === 'profile'"
        class="mp-plot"
        :viewBox="`0 0 ${PLOT.w} ${PLOT.h}`"
        preserveAspectRatio="none"
        role="img"
        aria-label="Elevation profile; gaps indicate no data"
      >
        <path v-for="(path, i) in paths" :key="i" :d="path" />
      </svg>
      <footer class="mp-actions">
        <template v-if="!selected">
          <input
            v-model="name"
            class="mb-input mp-name"
            aria-label="Measurement name"
            :placeholder="`${TOOLS[shownKind]?.label} ${records.length + 1}`"
            @keydown.enter.stop="canSave && saveMeasurement()"
          />
          <button class="btn btn-primary btn-sm" :disabled="!canSave" @click="saveMeasurement">Save measurement</button>
        </template>
        <template v-else>
          <input v-model="name" class="mb-input mp-name" aria-label="Measurement name" />
          <button
            class="btn btn-sm"
            :disabled="!name.trim() || name.trim() === selected.name"
            title="Rename this measurement"
            @click="saved.rename(selectedId, name)"
          >
            Rename
          </button>
          <button class="btn btn-sm btn-danger" title="Delete this measurement" @click="deleteMeasurement">
            Delete
          </button>
        </template>
        <button v-if="shownKind === 'profile'" class="btn btn-sm" @click="exportProfile">Export profile CSV</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.measure-layer {
  position: absolute;
  inset: 0;
  z-index: 4;
  pointer-events: none;
  font-size: 12px;
  color: var(--text);
}
.measure-layer > :not(.measure-overlay) {
  pointer-events: auto;
}
.measure-overlay {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.geom {
  fill: none;
  stroke: #43b9e0;
  stroke-width: 2;
}
.geom-fill {
  fill: rgba(67, 185, 224, 0.18);
}
.vertex {
  fill: #fff;
  stroke: #147c9e;
  stroke-width: 1.5;
}

/* Drawing toolbox body (the chrome is FloatingToolbox). */
.mb-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.mb-icon {
  width: 15px;
  height: 15px;
  flex: none;
}
.mb-sep {
  width: 1px;
  align-self: stretch;
  background: var(--panel-border);
  margin: 0 2px;
}
.mb-hint {
  color: var(--text-dim);
  white-space: nowrap;
}
.mb-field {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--text-dim);
}
.mb-input {
  font: inherit;
  font-size: 12px;
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--panel-border);
  border-radius: 4px;
  padding: 3px 6px;
}
.mb-input:focus {
  outline: none;
  border-color: var(--accent);
}
.mb-num {
  width: 84px;
}
.mb-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 26px;
  min-width: 26px;
  padding: 0 8px;
  font: inherit;
  font-size: 12px;
  color: var(--text);
  background: none;
  border: 1px solid var(--panel-border);
  border-radius: 5px;
  cursor: pointer;
}
.mb-btn:hover:not(:disabled) {
  background: var(--hover-bg);
}
.mb-btn:disabled {
  opacity: 0.45;
  cursor: default;
}
.mb-close {
  border-color: transparent;
  padding: 0 4px;
  color: var(--text-dim);
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}

.measure-alert {
  position: absolute;
  top: 96px;
  left: 50%;
  transform: translateX(-50%);
  padding: 6px 10px;
  border-radius: 6px;
  background: var(--panel);
  border: 1px solid var(--danger);
  color: var(--danger);
}

/* Cards — the sidebar/detail surface, floating over the raster. */
.measure-panel {
  position: absolute;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
}
.result-panel {
  left: 10px;
  bottom: 12px;
  width: 340px;
  max-width: calc(100% - 20px);
}
.saved-panel {
  right: 10px;
  top: 10px;
  width: 280px;
  max-width: calc(100% - 20px);
  max-height: calc(100% - 70px);
  overflow: auto;
}
.mp-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 22px;
}
.mp-title {
  font-weight: 600;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mp-label {
  color: var(--text-dim);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.mp-value {
  font-size: 20px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
}
.mp-rows {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 3px 12px;
  margin: 2px 0 0;
}
.mp-rows dt {
  color: var(--text-dim);
}
.mp-rows dd {
  margin: 0;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.mp-note {
  margin: 0;
  color: var(--text-dim);
  line-height: 1.4;
}
.mp-error {
  margin: 0;
  color: var(--danger);
  line-height: 1.4;
}
.mp-empty {
  margin: 0;
  color: var(--text-dim);
}
.mp-plot {
  width: 100%;
  height: 96px;
  border: 1px solid var(--panel-border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--accent);
}
.mp-plot path {
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  vector-effect: non-scaling-stroke;
}
.mp-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  margin-top: 4px;
}
.mp-name {
  flex: 1 1 120px;
  min-width: 0;
}
.btn-sm {
  font-size: 12px;
  padding: 3px 10px;
}
.btn-danger {
  color: var(--danger);
}
.badge {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 1px 6px;
  border-radius: 8px;
  color: var(--danger);
  border: 1px solid currentColor;
}

.saved-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.saved-item {
  display: grid;
  grid-template-columns: 16px 1fr auto;
  grid-template-areas: 'icon name badge' 'icon value value';
  column-gap: 8px;
  width: 100%;
  padding: 6px;
  font: inherit;
  font-size: 12px;
  text-align: left;
  color: var(--text);
  background: none;
  border: 1px solid transparent;
  border-radius: 5px;
  cursor: pointer;
}
.saved-item:hover {
  background: var(--hover-bg);
}
.saved-item.current {
  border-color: var(--accent);
}
.si-icon {
  grid-area: icon;
  width: 16px;
  height: 16px;
  color: var(--text-dim);
}
.si-name {
  grid-area: name;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.saved-item .badge {
  grid-area: badge;
}
.si-value {
  grid-area: value;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
</style>
