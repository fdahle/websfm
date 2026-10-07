<script setup>
import { ref, computed } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import SettingsField from './ui/SettingsField.vue'
import SettingsGroup from './ui/SettingsGroup.vue'
import WarnBox from './ui/WarnBox.vue'
import { polygonsFromGeoJSON } from '../../core/products/rasterClip.js'

// Clip to Polygon (Tools ▸ Products ▾) — export the DEM or orthophoto with every
// pixel outside a polygon set to nodata/transparent, cropped to the polygon
// (core/products/rasterClip.js). The polygon is a saved Area/Volume measurement on
// that product, or a GeoJSON file already in the product's coordinates — nothing is
// reprojected here, so a file in another CRS would clip the wrong place.
const props = defineProps({
  dem: { type: Object, default: null },
  ortho: { type: Object, default: null },
  // Saved raster measurements (useMeasurementsStore records).
  measurements: { type: Array, default: () => [] },
})
const emit = defineEmits(['close', 'run'])

const kind = ref(props.dem ? 'dem' : 'ortho')
const product = computed(() => (kind.value === 'ortho' ? props.ortho : props.dem))
const candidates = computed(() => props.measurements.filter((m) => (m.kind === 'area' || m.kind === 'volume')
  && m.source === `product:${kind.value}` && (m.world?.length ?? 0) >= 3))
const sourceMode = ref(candidates.value.length ? 'measurement' : 'file')
const measurementId = ref(candidates.value[0]?.id ?? null)
const filePolygons = ref(null)
const fileNote = ref('')
const compression = ref('deflate')

async function onFile(e) {
  const file = e.target.files?.[0]
  e.target.value = ''
  if (!file) return
  try {
    const { polygons, ignored } = polygonsFromGeoJSON(JSON.parse(await file.text()))
    filePolygons.value = polygons.length ? polygons : null
    fileNote.value = polygons.length
      ? `${file.name}: ${polygons.length} polygon(s)${ignored ? `, ${ignored} other feature(s) ignored` : ''}`
      : `${file.name}: no polygons found`
  } catch (err) {
    filePolygons.value = null
    fileNote.value = `${file.name}: not readable GeoJSON (${err.message})`
  }
}

const polygons = computed(() => {
  if (sourceMode.value === 'file') return filePolygons.value
  const m = candidates.value.find((c) => c.id === measurementId.value)
  return m ? [[m.world.map((p) => [p.x, p.y])]] : null
})

function run() {
  emit('run', { kind: kind.value, polygons: JSON.parse(JSON.stringify(polygons.value)), compression: compression.value })
}
</script>

<template>
  <ModalShell title="Clip to Polygon" @close="emit('close')">
    <WarnBox v-if="!dem && !ortho">Build a DEM or orthophoto first.</WarnBox>
    <template v-else>
      <SettingsGroup title="Raster">
        <SettingsField label="Product" label-for="clip-kind">
          <select id="clip-kind" v-model="kind" class="field-select">
            <option value="dem" :disabled="!dem">DEM</option>
            <option value="ortho" :disabled="!ortho">Orthophoto</option>
          </select>
        </SettingsField>
      </SettingsGroup>
      <SettingsGroup title="Polygon">
        <SettingsField>
          <label class="checkbox-row"><input v-model="sourceMode" type="radio" value="measurement" class="checkbox" :disabled="!candidates.length" />
            A saved area measurement on this {{ kind === 'ortho' ? 'orthophoto' : 'DEM' }}</label>
          <label class="checkbox-row"><input v-model="sourceMode" type="radio" value="file" class="checkbox" /> A GeoJSON file</label>
        </SettingsField>
        <SettingsField v-if="sourceMode === 'measurement'" label="Measurement" label-for="clip-m"
          hint="Draw one with the raster's Measure ▸ Area tool and save it.">
          <select id="clip-m" v-model="measurementId" class="field-select">
            <option v-for="m in candidates" :key="m.id" :value="m.id">{{ m.name }}</option>
          </select>
        </SettingsField>
        <SettingsField v-else :hint="fileNote || 'Polygon / MultiPolygon in the product\'s own coordinates (holes supported).'">
          <input type="file" accept=".geojson,.json,application/geo+json" class="field-input" @change="onFile" />
        </SettingsField>
      </SettingsGroup>
      <SettingsGroup title="File">
        <SettingsField label="Compression" label-for="clip-comp">
          <select id="clip-comp" v-model="compression" class="field-select">
            <option value="deflate">DEFLATE</option>
            <option value="none">None</option>
          </select>
        </SettingsField>
      </SettingsGroup>
      <p v-if="product?.crs && product.crs !== 'local'" class="field-hint">Coordinates in {{ product.crs }}.</p>
    </template>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!product || !polygons?.length" @click="run">Export clipped</button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
