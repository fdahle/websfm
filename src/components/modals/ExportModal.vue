<script setup>
import { ref, computed, watch } from 'vue'
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
  // A valid scale-bar fit exists (and no georeference) → the cloud export can be
  // written in METRES with no CRS. One checkbox covers both, because both answer
  // the same question: "put real units on this file?"
  hasScale: { type: Boolean, default: false },
  // A user orientation (Tools ▸ Model ▾ ▸ Orient model) exists → the export can be
  // levelled, re-origined and turned. Combines with scale; a georeference outranks it.
  hasOrientation: { type: Boolean, default: false },
})

const hasFrame = computed(() => props.hasGeoref || props.hasScale || props.hasOrientation)
const frameLabel = computed(() => {
  if (props.hasGeoref) return 'Georeference (transform into the project CRS)'
  if (props.hasScale && props.hasOrientation) return 'Apply scale and orientation (metres, levelled — no CRS is attached)'
  if (props.hasScale) return 'Apply scale (write metres — no CRS is attached)'
  return 'Apply orientation (levelled, with your origin and heading — model units)'
})
const emit = defineEmits(['close', 'run'])

const CONFIG = {
  cloud: {
    title: 'Export Point Cloud',
    formats: [
      { value: 'ply-binary', label: 'PLY — binary (compact)' },
      { value: 'ply-ascii',  label: 'PLY — ASCII (text)' },
      { value: 'las',        label: 'LAS 1.2 (surveying standard)' },
      { value: 'laz',        label: 'LAZ — compressed LAS (5–10× smaller)' },
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
    title: 'Export SfM Project',
    formats: [
      { value: 'workspace', label: 'COLMAP workspace — database + sparse model' },
      { value: 'database', label: 'COLMAP database.db — cameras + features + matches' },
      { value: 'txt', label: 'Text (.txt) — zipped' },
      { value: 'bin', label: 'Binary (.bin) — zipped' },
      { value: 'transforms', label: 'transforms.json — NeRF / 3DGS' },
      { value: 'openmvg', label: 'OpenMVG sfm_data.json' },
      { value: 'nvm', label: 'VisualSFM NVM v3' },
    ],
  },
  tiles3d: {
    title: 'Export 3D Tiles',
    formats: [
      { value: 'tileset', label: 'Cesium 3D Tiles 1.1 — tileset.json + .glb' },
    ],
  },
  undistorted: {
    title: 'Export Undistorted Images',
    formats: [
      { value: 'jpeg', label: 'JPEG — compact (recommended for MVS)' },
      { value: 'png',  label: 'PNG — lossless (much larger)' },
    ],
  },
  dem: {
    title: 'Export DEM',
    formats: [
      { value: 'geotiff', label: 'GeoTIFF (.tif) — georeferenced' },
      { value: 'cog',     label: 'Cloud-Optimized GeoTIFF — tiled + overviews' },
      { value: 'asc',     label: 'ESRI ASCII grid (.asc)' },
      { value: 'png',     label: 'Hillshade PNG + world file' },
    ],
  },
  ortho: {
    title: 'Export Orthophoto',
    formats: [
      { value: 'geotiff', label: 'GeoTIFF (.tif) — georeferenced' },
      { value: 'cog',     label: 'Cloud-Optimized GeoTIFF — tiled + overviews' },
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
  includeImages: false,
  ...EXPORT_DEFAULTS,
})

// The compression selector applies to both TIFF flavours. A COG defaults to
// DEFLATE — an uncompressed tiled file is larger than the baseline one and gains
// nothing, since the format exists to make partial reads cheap.
const isTiff = computed(() => settings.value.format === 'geotiff' || settings.value.format === 'cog')
const isCog = computed(() => settings.value.format === 'cog')
watch(isCog, (cog) => { settings.value.compression = cog ? 'deflate' : EXPORT_DEFAULTS.compression })

function run() {
  // The undistorted exporter takes plain names; the persisted defaults are
  // namespaced so they can't collide with the other kinds' knobs. Mapping here
  // (rather than store-side) keeps one home for the values — see the modal-unit
  // rule in CLAUDE.md.
  if (props.kind === 'undistorted') {
    emit('run', {
      format: settings.value.format,
      mode: settings.value.undistortMode,
      quality: settings.value.undistortQuality,
      maxDim: settings.value.undistortMaxDim,
    })
    return
  }
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
      <label v-if="hasFrame" class="checkbox-row"><input type="checkbox" v-model="settings.applyGeoref" class="checkbox" /> {{ frameLabel }}</label>
      <SettingsField label="Voxel downsample cell" label-for="dscell"
        :hint="`World units${hasGeoref ? ' (project CRS when georeferenced)' : (hasScale ? ' (metres when scaled)' : '')}; 0 = keep every point.`">
        <input id="dscell" v-model.number="settings.downsampleCell" type="number" min="0" step="any" class="field-input" />
      </SettingsField>
    </template>

    <!-- Mesh -->
    <template v-else-if="kind === 'mesh'">
      <label class="checkbox-row">
        <input type="checkbox" v-model="settings.includeColor" :disabled="settings.format === 'stl'" class="checkbox" />
        Include vertex colours{{ settings.format === 'stl' ? ' (STL has no colour)' : '' }}
      </label>
      <label v-if="hasFrame" class="checkbox-row">
        <input type="checkbox" v-model="settings.applyGeoref" class="checkbox" /> {{ frameLabel }}
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
        Exchange a complete COLMAP workspace, its feature database, a sparse model,
        or camera transforms for NeRF / Gaussian-Splatting tools. Unsupported descriptor
        encodings are omitted while keypoints and verified matches are retained.
      </p>
      <label v-if="settings.format === 'workspace'" class="checkbox-row">
        <input type="checkbox" v-model="settings.includeImages" class="checkbox" /> Include original source images (larger ZIP)
      </label>
    </template>

    <!-- 3D Tiles -->
    <template v-else-if="kind === 'tiles3d'">
      <p class="field-hint">
        A single tile for globe viewers (Cesium, and anything else reading 3D
        Tiles 1.1). The model is placed by a transform measured from the project
        CRS, so it lands correctly even at polar latitudes. Level-of-detail tiling
        is not included — this is the whole model in one tile.
      </p>
      <label class="checkbox-row"><input type="checkbox" v-model="settings.includeColor" class="checkbox" /> Include vertex colours</label>
      <p v-if="!hasGeoref" class="field-hint warn-hint">
        This project has no georeference, so the tileset will have no position on
        the globe. Georeference the model first.
      </p>
    </template>

    <!-- Undistorted images -->
    <template v-else-if="kind === 'undistorted'">
      <p class="field-hint">
        Pinhole images + a PINHOLE sparse model, the handoff COLMAP's
        <code>image_undistorter</code> produces — for OpenMVS, MVE and MVS-Texturing.
        Lens distortion and film-scan geometry are already folded out of the model,
        so only the pixels are resampled.
      </p>
      <SettingsField label="Border" label-for="umode"
        hint="Cropping keeps only the region that samples inside the source image.">
        <select id="umode" v-model="settings.undistortMode" class="field-input field-select">
          <option value="crop">Crop to the valid region</option>
          <option value="full">Keep the full frame (blank borders)</option>
        </select>
      </SettingsField>
      <SettingsField v-if="settings.format === 'jpeg'"
        :label="`JPEG quality: ${settings.undistortQuality.toFixed(2)}`" label-for="uq">
        <input id="uq" v-model.number="settings.undistortQuality" type="range" min="0.5" max="1" step="0.01" class="field-input range" />
      </SettingsField>
      <SettingsField label="Maximum dimension" label-for="umax"
        hint="Longest output side in pixels; 0 = native resolution. Lower it if the ZIP would exceed 4 GB.">
        <input id="umax" v-model.number="settings.undistortMaxDim" type="number" min="0" step="1" class="field-input" />
      </SettingsField>
    </template>

    <!-- DEM -->
    <template v-else-if="kind === 'dem'">
      <p v-if="isCog" class="field-hint">
        Internally tiled with halving overviews, so a viewer can fetch a preview or
        one window with a few range requests instead of the whole file. Readable
        anywhere a normal GeoTIFF is.
      </p>
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
      <p v-if="isCog" class="field-hint">
        Internally tiled with halving overviews, for web/GIS delivery of a large
        orthophoto. Readable anywhere a normal GeoTIFF is.
      </p>
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
.warn-hint { color: var(--warn, #b45309); }
.field-input.range { width: 100%; padding: 0; }
code { font-size: 11px; }
</style>
