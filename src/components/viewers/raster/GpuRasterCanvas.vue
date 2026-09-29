<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import OlMap from 'ol/Map.js'
import View from 'ol/View.js'
import { useExternalStore } from '../../../stores/useExternalStore.js'
import { ensureProjection } from '../../../core/crs.js'
import { createGpuRasterLayer, gpuRasterStyle, disposeRasterLayer } from './gpuRaster.js'

const props = defineProps({ product: Object, scale: Number, tx: Number, ty: Number })
const emit = defineEmits(['ready'])
const target = ref(null), external = useExternalStore()
let map, layer, observer, generation = 0
function position() {
  if (!map || !props.product) return
  map.updateSize()
  const size = map.getSize(), gt = props.product.geoTransform
  if (!size || !gt) return
  map.getView().setCenter([gt.originX + (size[0] / 2 - props.tx) / props.scale * gt.scaleX,
    gt.originY + (size[1] / 2 - props.ty) / props.scale * gt.scaleY])
  map.getView().setResolution(Math.abs(gt.scaleX) / props.scale)
}
async function load() {
  const token = ++generation, p = props.product
  emit('ready', false)
  if (layer) { map?.removeLayer(layer); disposeRasterLayer(layer); layer = null }
  if (!p || !target.value || ![1, 2].includes(p.photometric ?? 1)) return
  try {
    await ensureProjection(p.crs)
    const file = await external.displayFile(p.id)
    if (!file || token !== generation) return
    const next = await createGpuRasterLayer(p, file)
    if (token !== generation) { disposeRasterLayer(next); return }
    layer = next
    map.setView(new View({ projection: p.crs, center: [0, 0], resolution: 1,
      constrainResolution: false, smoothResolutionConstraint: false, maxZoom: 40, minZoom: -20 }))
    map.addLayer(layer); position()
    map.once('rendercomplete', () => { if (token === generation) { p.gpuReady = true; emit('ready', true) } })
  } catch (err) { console.warn('Tiled raster display failed; using preview', err) }
}
onMounted(() => {
  map = new OlMap({ target: target.value, layers: [], controls: [], interactions: [], pixelRatio: 1 })
  observer = new ResizeObserver(position); observer.observe(target.value)
  load()
})
watch(() => props.product?.id, load)
watch(() => props.product?.style, () => { if (layer) layer.setStyle(gpuRasterStyle(props.product)) }, { deep: true })
watch(() => [props.scale, props.tx, props.ty], position)
onBeforeUnmount(() => { generation++; observer?.disconnect(); disposeRasterLayer(layer); map?.setTarget(null); map?.dispose() })
</script>
<template><div ref="target" class="gpu-raster-canvas" aria-label="Tiled reference raster" /></template>
<style scoped>.gpu-raster-canvas { position: absolute; inset: 0; pointer-events: none; }</style>
