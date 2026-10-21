<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import OlMap from 'ol/Map.js'
import View from 'ol/View.js'
import Projection from 'ol/proj/Projection.js'
import { addProjection } from 'ol/proj.js'
import { useExternalStore } from '../../../stores/useExternalStore.js'
import { ensureProjection } from '../../../core/crs.js'
import { rasterBounds } from '../../../core/io/rasterSample.js'
import { createGpuRasterLayer, gpuRasterStyle, disposeRasterLayer } from './gpuRaster.js'

// The raster tab's tiled display: an OpenLayers map with no controls, positioned to
// the tab's pan/zoom, drawing a tiled GeoTIFF as GPU tiles. `product` is any raster
// meta with an id, a north-up geoTransform and a CRS (null = a local frame, drawn in
// a plain metric projection of its own); `file` resolves its tiled file — an
// imported raster's display file by default, a computed ortho's stored COG when given.
const props = defineProps({
  product: Object,
  scale: Number,
  tx: Number,
  ty: Number,
  file: { type: Function, default: null },
})
const emit = defineEmits(['ready'])
const target = ref(null),
  external = useExternalStore()
let map,
  layer,
  observer,
  generation = 0
function position() {
  if (!map || !props.product) return
  map.updateSize()
  const size = map.getSize(),
    gt = props.product.geoTransform
  if (!size || !gt) return
  map
    .getView()
    .setCenter([
      gt.originX + ((size[0] / 2 - props.tx) / props.scale) * gt.scaleX,
      gt.originY + ((size[1] / 2 - props.ty) / props.scale) * gt.scaleY,
    ])
  map.getView().setResolution(Math.abs(gt.scaleX) / props.scale)
}
// A local-frame raster has no CRS; it only needs SOME metric projection to draw in.
function localProjection(p) {
  const code = `websfm:raster:${p.id}`
  addProjection(new Projection({ code, units: 'm', extent: rasterBounds(p) }))
  return code
}
async function load() {
  const token = ++generation,
    p = props.product
  emit('ready', false)
  if (layer) {
    map?.removeLayer(layer)
    disposeRasterLayer(layer)
    layer = null
  }
  if (!p || !target.value || ![1, 2].includes(p.photometric ?? 1)) return
  try {
    const crs = p.crs || localProjection(p)
    if (p.crs) await ensureProjection(p.crs)
    const file = props.file ? await props.file() : await external.displayFile(p.id)
    if (!file || token !== generation) return
    const next = await createGpuRasterLayer({ ...p, crs }, file)
    if (token !== generation) {
      disposeRasterLayer(next)
      return
    }
    layer = next
    map.setView(
      new View({
        projection: crs,
        center: [0, 0],
        resolution: 1,
        constrainResolution: false,
        smoothResolutionConstraint: false,
        maxZoom: 40,
        minZoom: -20,
      }),
    )
    map.addLayer(layer)
    position()
    map.once('rendercomplete', () => {
      if (token === generation) {
        p.gpuReady = true
        emit('ready', true)
      }
    })
  } catch (err) {
    console.warn('Tiled raster display failed; using preview', err)
  }
}
onMounted(() => {
  map = new OlMap({ target: target.value, layers: [], controls: [], interactions: [], pixelRatio: 1 })
  observer = new ResizeObserver(position)
  observer.observe(target.value)
  load()
})
watch(() => props.product?.id, load)
watch(
  () => [props.product?.style, props.product?.adjust],
  () => {
    if (layer) layer.setStyle(gpuRasterStyle(props.product))
  },
  { deep: true },
)
watch(() => [props.scale, props.tx, props.ty], position)
onBeforeUnmount(() => {
  generation++
  observer?.disconnect()
  disposeRasterLayer(layer)
  map?.setTarget(null)
  map?.dispose()
})
</script>
<template><div ref="target" class="gpu-raster-canvas" aria-label="Tiled raster" /></template>
<style scoped>
.gpu-raster-canvas {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
</style>
