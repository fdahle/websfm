<script setup>
import { ref, computed } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import SettingsField from './ui/SettingsField.vue'
import { EXPORT_DEFAULTS } from '../../core/defaults.user.js'

// One reusable export dialog, parameterised by `kind`. It collects a format + a
// few settings and emits them on run; App.vue maps the result to the right
// exporter.
const props = defineProps({
  kind: { type: String, required: true },
  // A georef fit exists → the cloud export can transform into the project CRS.
  hasGeoref: { type: Boolean, default: false },
})
const emit = defineEmits(['close', 'run'])

const CONFIG = {
  cloud: {
    title: 'Export Point Cloud',
    formats: [
      { value: 'ply-binary', label: 'PLY — binary (compact)' },
      { value: 'ply-ascii',  label: 'PLY — ASCII (text)' },
      { value: 'las',        label: 'LAS 1.2 (surveying standard)' },
      { value: 'xyz',        label: 'XYZ — plain text (x y z r g b)' },
    ],
  },
  mesh: {
    title: 'Export Mesh',
    formats: [
      { value: 'ply-binary', label: 'PLY — binary (faces)' },
      { value: 'ply-ascii',  label: 'PLY — ASCII (text)' },
      { value: 'glb',        label: 'glTF binary (.glb)' },
      { value: 'obj',        label: 'Wavefront OBJ (.obj)' },
      { value: 'stl',        label: 'STL — binary (no colour)' },
    ],
  },
  model: {
    title: 'Export Model',
    formats: [
      { value: 'json', label: 'JSON — cameras + tracks' },
      { value: 'transforms', label: 'transforms.json — NeRF / 3DGS' },
    ],
  },
  colmap: {
    title: 'Export COLMAP Model',
    formats: [
      { value: 'txt', label: 'Text (.txt) — zipped' },
      { value: 'bin', label: 'Binary (.bin) — zipped' },
    ],
  },
  dem: {
    title: 'Export DEM',
    formats: [
      { value: 'geotiff', label: 'GeoTIFF (.tif) — georeferenced' },
      { value: 'asc',     label: 'ESRI ASCII grid (.asc)' },
      { value: 'png',     label: 'Hillshade PNG + world file' },
    ],
  },
  ortho: {
    title: 'Export Orthophoto',
    formats: [
      { value: 'geotiff', label: 'GeoTIFF (.tif) — georeferenced' },
      { value: 'png',     label: 'PNG + world file (.wld)' },
      { value: 'jpeg',    label: 'JPEG + world file' },
    ],
  },
}

const cfg = computed(() => CONFIG[props.kind])

// `format` is chosen dynamically per kind; the rest are the single source of truth
// in core/defaults.user.js.
const settings = ref({
  format: cfg.value.formats.find((f) => !f.disabled)?.value,
  ...EXPORT_DEFAULTS,
})

// GeoTIFF compression selector shows only for the geotiff format.
const isTiff = computed(() => settings.value.format === 'geotiff')

function run() {
  emit('run', { ...settings.value })
}
</script>

<template>
  <ModalShell :title="cfg.title" @close="emit('close')">
    <SettingsField label="Format" label-for="fmt">
      <select id="fmt" v-model="settings.format" class="field-input field-select">
        <option v-for="f in cfg.formats" :key="f.value" :value="f.value" :disabled="f.disabled">
          {{ f.label }}{{ f.disabled ? ' — coming soon' : '' }}
        </option>
      </select>
    </SettingsField>

    <!-- Point cloud -->
    <template v-if="kind === 'cloud'">
      <label class="checkbox-row"><input type="checkbox" v-model="settings.includeColor" class="checkbox" /> Include vertex colours</label>
      <label v-if="hasGeoref" class="checkbox-row"><input type="checkbox" v-model="settings.applyGeoref" class="checkbox" /> Georeference (transform into the project CRS)</label>
      <SettingsField label="Voxel downsample cell" label-for="dscell"
        :hint="`World units${hasGeoref ? ' (project CRS when georeferenced)' : ''}; 0 = keep every point.`">
        <input id="dscell" v-model.number="settings.downsampleCell" type="number" min="0" step="any" class="field-input" />
      </SettingsField>
    </template>

    <!-- Mesh -->
    <template v-else-if="kind === 'mesh'">
      <label class="checkbox-row" :class="{ disabled: settings.format === 'stl' }">
        <input type="checkbox" v-model="settings.includeColor" :disabled="settings.format === 'stl'" class="checkbox" />
        Include vertex colours{{ settings.format === 'stl' ? ' (STL has no colour)' : '' }}
      </label>
    </template>

    <!-- Model JSON -->
    <template v-else-if="kind === 'model'">
      <label v-if="settings.format === 'json'" class="checkbox-row">
        <input type="checkbox" v-model="settings.includeTracks" class="checkbox" /> Include point tracks (image observations)
      </label>
      <p v-else class="field-hint">
        Camera-to-world poses (OpenGL convention) + intrinsics for nerfstudio,
        instant-ngp and 3D Gaussian Splatting. Local SfM frame; pinhole.
      </p>
    </template>

    <!-- COLMAP model -->
    <template v-else-if="kind === 'colmap'">
      <p class="field-hint">
        Exports the sparse model as COLMAP <code>cameras.txt</code>, <code>images.txt</code>
        and <code>points3D.txt</code> in a ZIP — one PINHOLE camera per image, in the local
        SfM frame. Reads into COLMAP, Metashape/RealityCapture and NeRF / Gaussian-Splatting tools.
      </p>
    </template>

    <!-- DEM -->
    <template v-else-if="kind === 'dem'">
      <SettingsField label="NODATA value" label-for="nodata"
        hint="Written for empty cells (holes with no measurement).">
        <input id="nodata" v-model.number="settings.nodata" type="number" step="any" class="field-input" />
      </SettingsField>
      <SettingsField v-if="isTiff" label="Compression" label-for="comp">
        <select id="comp" v-model="settings.compression" class="field-input field-select">
          <option value="none">None (uncompressed)</option>
          <option value="deflate">DEFLATE (lossless)</option>
        </select>
      </SettingsField>
    </template>

    <!-- Ortho -->
    <template v-else-if="kind === 'ortho'">
      <SettingsField v-if="isTiff" label="Compression" label-for="ocomp">
        <select id="ocomp" v-model="settings.compression" class="field-input field-select">
          <option value="none">None (uncompressed)</option>
          <option value="deflate">DEFLATE (lossless)</option>
        </select>
      </SettingsField>
      <SettingsField v-if="settings.format === 'jpeg'" :label="`JPEG quality: ${settings.jpegQuality.toFixed(2)}`" label-for="jq">
        <input id="jq" v-model.number="settings.jpegQuality" type="range" min="0.1" max="1" step="0.05" class="field-input range" />
      </SettingsField>
    </template>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" @click="run">Export</button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
<style scoped>
.checkbox-row { font-size: 13px; color: var(--text); }
.checkbox-row.disabled { opacity: 0.5; cursor: not-allowed; }
.field-input.range { width: 100%; padding: 0; }
code { font-size: 11px; }
</style>
