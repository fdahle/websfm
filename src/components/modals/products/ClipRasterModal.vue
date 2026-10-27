<script setup>
import { ref, computed, watch } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import SettingsField from '../ui/SettingsField.vue'
import SettingsGroup from '../ui/SettingsGroup.vue'
import SettingsStep from '../ui/SettingsStep.vue'
import WarnBox from '../ui/WarnBox.vue'
import { useSourcePick } from '../../../composables/useSourcePick.js'
import { polygonsFromGeoJSON, geojsonCrs } from '../../../core/products/rasterClip.js'
import { pluralize } from '../../../core/textFormat.js'
import { clipRasterEffects } from '../../../core/stepEffects/clipRaster.js'
import FileNameField from '../ui/FileNameField.vue'
import { defaultExportName } from '../../../core/exportNames.js'
import { useProjectsStore } from '../../../stores/useProjectsStore.js'

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
const candidates = computed(() =>
  props.measurements.filter(
    (m) =>
      (m.kind === 'area' || m.kind === 'volume') && m.source === `product:${kind.value}` && (m.world?.length ?? 0) >= 3,
  ),
)
const sourceMode = ref(candidates.value.length ? 'measurement' : 'file')
// Always one of THIS product's measurements (the first, unless the user picked another).
const { id: measurementId } = useSourcePick(candidates)
// The measurements are per product: switching DEM ↔ orthophoto re-decides the polygon
// source from the new product's own, instead of keeping a mode with nothing to pick.
watch(kind, () => {
  sourceMode.value = candidates.value.length ? 'measurement' : 'file'
})
const filePolygons = ref(null)
// The file's CRS when it names one or is lon/lat (rasterClip.js geojsonCrs); null = the raster's.
const fileCrs = ref(null)
const fileNote = ref('')
const compression = ref('deflate')

async function onFile(e) {
  const file = e.target.files?.[0]
  e.target.value = ''
  if (!file) return
  try {
    const json = JSON.parse(await file.text())
    const { polygons, ignored } = polygonsFromGeoJSON(json)
    filePolygons.value = polygons.length ? polygons : null
    fileCrs.value = polygons.length ? geojsonCrs(json, polygons) : null
    fileNote.value = polygons.length
      ? `${file.name}: ${pluralize(polygons.length, 'polygon')}${ignored ? `, ${pluralize(ignored, 'other feature')} ignored` : ''}` +
        (fileCrs.value ? `, in ${fileCrs.value} (reprojected to the raster's CRS)` : `, in the raster's CRS`)
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

// The optional File name, and the name the export gets without one.
const fileName = ref('')
const projects = useProjectsStore()
const defaultName = computed(() =>
  defaultExportName('clip', { base: projects.currentProjectName || 'project', product: kind.value }),
)
// What each step does (core/stepEffects/clipRaster.js).
const effects = computed(() =>
  clipRasterEffects(
    { compression: compression.value },
    {
      product: kind.value,
      mode: sourceMode.value,
      measurement: candidates.value.find((c) => c.id === measurementId.value)?.name ?? null,
      polygons: polygons.value?.length ?? 0,
    },
  ),
)

function run() {
  emit('run', {
    fileName: fileName.value,
    kind: kind.value,
    polygons: JSON.parse(JSON.stringify(polygons.value)),
    polygonsCrs: sourceMode.value === 'file' ? fileCrs.value : null,
    compression: compression.value,
  })
}
</script>

<template>
  <ModalShell title="Clip to Polygon" @close="emit('close')">
    <WarnBox v-if="!dem && !ortho">Build a DEM or orthophoto first.</WarnBox>
    <template v-else>
      <SettingsGroup title="Source">
        <SettingsField label="Product" label-for="clip-kind">
          <select id="clip-kind" v-model="kind" class="field-select">
            <option value="dem" :disabled="!dem">DEM</option>
            <option value="ortho" :disabled="!ortho">Orthophoto</option>
          </select>
        </SettingsField>
      </SettingsGroup>
      <SettingsStep step="1" title="Polygon" :effect="effects.polygon">
        <SettingsField>
          <label class="checkbox-row"
            ><input
              v-model="sourceMode"
              type="radio"
              value="measurement"
              class="checkbox"
              :disabled="!candidates.length"
            />
            A saved area measurement on this {{ kind === 'ortho' ? 'orthophoto' : 'DEM' }}</label
          >
          <label class="checkbox-row"
            ><input v-model="sourceMode" type="radio" value="file" class="checkbox" /> A GeoJSON file</label
          >
        </SettingsField>
        <SettingsField
          v-if="sourceMode === 'measurement'"
          label="Measurement"
          label-for="clip-m"
          hint="Draw one with the raster's Measure ▸ Area tool and save it."
        >
          <select id="clip-m" v-model="measurementId" class="field-select">
            <option v-for="m in candidates" :key="m.id" :value="m.id">{{ m.name }}</option>
          </select>
        </SettingsField>
        <SettingsField
          v-else
          :hint="fileNote || 'Polygon / MultiPolygon in the product\'s own coordinates (holes supported).'"
        >
          <input type="file" accept=".geojson,.json,application/geo+json" class="field-input" @change="onFile" />
        </SettingsField>
      </SettingsStep>
      <SettingsStep step="2" title="Save" :effect="effects.save">
        <SettingsField label="Compression" label-for="clip-comp">
          <select id="clip-comp" v-model="compression" class="field-select">
            <option value="deflate">DEFLATE</option>
            <option value="none">None</option>
          </select>
        </SettingsField>
        <FileNameField v-model="fileName" :default-name="defaultName" />
      </SettingsStep>
      <p v-if="product?.crs && product.crs !== 'local'" class="field-hint">Coordinates in {{ product.crs }}.</p>
    </template>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!product || !polygons?.length" @click="run">Export clipped</button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
