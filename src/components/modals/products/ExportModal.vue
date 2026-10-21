<script setup>
import { ref, computed, watch } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import SettingsField from '../ui/SettingsField.vue'
import FieldHelp from '../../guide/FieldHelp.vue'
import CrsPicker from '../../controls/CrsPicker.vue'
import { EXPORT_DEFAULTS } from '../../../core/defaults.user.js'
import { MAX_ORTHO_IMAGE_CELLS } from '../../../core/products/exporters.js'
import { defaultTiling, singleTileFits } from '../../../core/products/tiles3d.js'

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
  // The orthophoto's cell count: a PNG/JPEG is made whole through a canvas, so one
  // beyond MAX_ORTHO_IMAGE_CELLS is offered greyed, with the reason.
  orthoCells: { type: Number, default: 0 },
  // The one cloud a sidebar "Download…" aimed the dialog at (its name), or '' for
  // the ribbon's "the selected cloud, else the first".
  subject: { type: String, default: '' },
  // The mesh this export writes is textured (Tools ▸ Mesh ▸ Texture): GLB and OBJ can
  // carry the texture; for 3D Tiles, the tile is that mesh.
  textured: { type: Boolean, default: false },
  // Measurements: the CRS a georeferenced GeoJSON would be in, or '' when none of
  // the measurements has one (they are then written in their own frames).
  measurementCrs: { type: String, default: '' },
  // DEM / ortho: the CRS the raster was built in ('' for the local frame), which the
  // GeoTIFF export can reproject into another (core/products/warp.js).
  rasterCrs: { type: String, default: '' },
  // What a 3D Tiles export writes (core/products/tiles3d.js tilesSubject): { kind:
  // 'mesh' | 'cloud', count, streamed, textured }, or null. Sets the tiling default.
  tilesSubject: { type: Object, default: null },
})

const hasFrame = computed(() => props.hasGeoref || props.hasScale || props.hasOrientation)
const frameLabel = computed(() => {
  if (props.hasGeoref) return 'Georeference (transform into the project CRS)'
  if (props.hasScale && props.hasOrientation)
    return 'Apply scale and orientation (metres, levelled — no CRS is attached)'
  if (props.hasScale) return 'Apply scale (write metres — no CRS is attached)'
  return 'Apply orientation (levelled, with your origin and heading — model units)'
})
const emit = defineEmits(['close', 'run'])

const CONFIG = {
  cloud: {
    title: 'Export Point Cloud',
    formats: [
      { value: 'ply-binary', label: 'PLY — binary (compact)' },
      { value: 'ply-ascii', label: 'PLY — ASCII (text)' },
      { value: 'las', label: 'LAS 1.2 (surveying standard)' },
      { value: 'laz', label: 'LAZ — compressed LAS (5–10× smaller)' },
      { value: 'xyz', label: 'XYZ — plain text (x y z r g b)' },
    ],
  },
  mesh: {
    title: 'Export Mesh',
    formats: [
      { value: 'ply-binary', label: 'PLY — binary (faces)' },
      { value: 'ply-ascii', label: 'PLY — ASCII (text)' },
      { value: 'glb', label: 'glTF binary (.glb)' },
      { value: 'obj', label: 'Wavefront OBJ (.obj)' },
      { value: 'stl', label: 'STL — binary (no colour)' },
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
    formats: [{ value: 'tileset', label: 'Cesium 3D Tiles 1.1 — tileset.json + glTF tiles (.zip)' }],
  },
  undistorted: {
    title: 'Export Undistorted Images',
    formats: [
      { value: 'jpeg', label: 'JPEG — compact (recommended for MVS)' },
      { value: 'png', label: 'PNG — lossless (much larger)' },
    ],
  },
  dem: {
    title: 'Export DEM',
    formats: [
      { value: 'geotiff', label: 'GeoTIFF (.tif) — georeferenced' },
      { value: 'cog', label: 'Cloud-Optimized GeoTIFF — tiled + overviews' },
      { value: 'asc', label: 'ESRI ASCII grid (.asc)' },
      { value: 'png', label: 'Hillshade PNG + world file' },
    ],
  },
  measurements: {
    title: 'Export Measurements',
    formats: [
      { value: 'csv', label: 'CSV — one row per measurement, units in columns' },
      { value: 'geojson', label: 'GeoJSON — lines and polygons with their values' },
    ],
  },
  ortho: {
    title: 'Export Orthophoto',
    formats: [
      { value: 'geotiff', label: 'GeoTIFF (.tif) — georeferenced' },
      { value: 'cog', label: 'Cloud-Optimized GeoTIFF — tiled + overviews' },
      { value: 'png', label: 'PNG + world file (.wld)' },
      { value: 'jpeg', label: 'JPEG + world file' },
    ],
  },
}

const imageTooLarge = computed(() => props.kind === 'ortho' && props.orthoCells > MAX_ORTHO_IMAGE_CELLS)
const cfg = computed(() => {
  const c = CONFIG[props.kind]
  if (!imageTooLarge.value) return c
  const why = ` — too large (at most ${Math.sqrt(MAX_ORTHO_IMAGE_CELLS).toLocaleString()}² px); use a GeoTIFF`
  return {
    ...c,
    formats: c.formats.map((f) =>
      f.value === 'png' || f.value === 'jpeg' ? { ...f, label: f.label + why, disabled: true } : f,
    ),
  }
})

// `format` is chosen dynamically per kind; the rest are the single source of truth
// in core/defaults.user.js.
const settings = ref({
  format: (props.kind === 'mesh' && props.textured ? 'glb' : null) ?? cfg.value.formats.find((f) => !f.disabled)?.value,
  includeImages: false,
  includeTexture: true,
  ...EXPORT_DEFAULTS,
  // 3D Tiles: a hierarchy for a big model, one tile for a small one (defaultTiling).
  tiling: EXPORT_DEFAULTS.tiling ?? defaultTiling(props.tilesSubject),
})
const tilesMesh = computed(() => props.tilesSubject?.kind === 'mesh')
// One tile cannot hold a streamed cloud or one past the buffer wall.
const singleTileOk = computed(() => !props.tilesSubject || singleTileFits(props.tilesSubject))
const textureFormat = computed(() => settings.value.format === 'glb' || settings.value.format === 'obj')

// The compression selector applies to both TIFF flavours. A COG defaults to
// DEFLATE — an uncompressed tiled file is larger than the baseline one and gains
// nothing, since the format exists to make partial reads cheap.
const isTiff = computed(() => settings.value.format === 'geotiff' || settings.value.format === 'cog')
const isCog = computed(() => settings.value.format === 'cog')
// LAS/LAZ point format 2 always carries RGB (written when the cloud has colour), so
// the colour toggle only steers PLY and XYZ (useExports.js exportCloud).
const isLasFormat = computed(() => settings.value.format === 'las' || settings.value.format === 'laz')
watch(isCog, (cog) => {
  settings.value.compression = cog ? 'deflate' : EXPORT_DEFAULTS.compression
})

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
  // A raster reprojected only when another CRS is picked, and it differs from its own.
  const reproject =
    (props.kind === 'dem' || props.kind === 'ortho') &&
    isTiff.value &&
    props.rasterCrs &&
    settings.value.rasterCrs === 'other' &&
    outputCrs.value &&
    outputCrs.value !== props.rasterCrs
  emit('run', { ...settings.value, outputCrs: reproject ? outputCrs.value : null })
}

// The CRS a reprojected DEM / ortho is written in (the picker resolves its definition).
const outputCrs = ref(props.rasterCrs || 'EPSG:4326')
const isRaster = computed(() => props.kind === 'dem' || props.kind === 'ortho')
// A reprojected copy is always a DEFLATE COG with NaN nodata: those fields don't apply.
const reprojecting = computed(
  () => isRaster.value && isTiff.value && !!props.rasterCrs && settings.value.rasterCrs === 'other',
)
const rasterOp = computed(() => (props.kind === 'dem' ? 'dem' : 'orthophoto'))
</script>

<template>
  <ModalShell :title="cfg.title" @close="emit('close')">
    <p v-if="subject" class="subject">
      Exporting <strong>{{ subject }}</strong>
    </p>
    <SettingsField label="Format" label-for="fmt">
      <select id="fmt" v-model="settings.format" class="field-input field-select">
        <option v-for="f in cfg.formats" :key="f.value" :value="f.value" :disabled="f.disabled">
          {{ f.label }}{{ f.disabled ? ' — coming soon' : '' }}
        </option>
      </select>
    </SettingsField>

    <!-- Point cloud -->
    <template v-if="kind === 'cloud'">
      <label class="checkbox-row">
        <input type="checkbox" v-model="settings.includeColor" :disabled="isLasFormat" class="checkbox" />
        Include vertex colours{{ isLasFormat ? ' (LAS always stores RGB when the cloud has colour)' : '' }}
      </label>
      <label v-if="hasFrame" class="checkbox-row"
        ><input type="checkbox" v-model="settings.applyGeoref" class="checkbox" /> {{ frameLabel }}</label
      >
      <SettingsField
        label="Voxel downsample cell"
        label-for="dscell"
        :hint="`World units${hasGeoref ? ' (project CRS when georeferenced)' : hasScale ? ' (metres when scaled)' : ''}; 0 = keep every point.`"
      >
        <input
          id="dscell"
          v-model.number="settings.downsampleCell"
          type="number"
          min="0"
          step="any"
          class="field-input"
        />
      </SettingsField>
      <p class="field-hint">
        Point attributes (a computed distance, imported intensity or classification) are written to PLY and LAS. LAZ
        keeps only the standard LAS fields; XYZ keeps none.
      </p>
    </template>

    <!-- Mesh -->
    <template v-else-if="kind === 'mesh'">
      <template v-if="textured">
        <label class="checkbox-row">
          <input type="checkbox" v-model="settings.includeTexture" :disabled="!textureFormat" class="checkbox" />
          Include the photo texture{{ textureFormat ? '' : ' (GLB or OBJ only)' }}
        </label>
        <p v-if="textureFormat && settings.includeTexture" class="field-hint">
          {{
            settings.format === 'glb'
              ? 'The atlas pages are embedded in the .glb.'
              : 'Downloads a .zip with the .obj, its .mtl and one JPEG per atlas page.'
          }}
        </p>
      </template>
      <label v-if="!(textured && textureFormat && settings.includeTexture)" class="checkbox-row">
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
        <input type="checkbox" v-model="settings.includeTracks" class="checkbox" /> Include point tracks (image
        observations)
      </label>
      <p v-else class="field-hint">
        Camera-to-world poses (OpenGL convention) + intrinsics for nerfstudio, instant-ngp and 3D Gaussian Splatting.
        Local SfM frame; pinhole.
      </p>
    </template>

    <!-- COLMAP model -->
    <template v-else-if="kind === 'colmap'">
      <p class="field-hint">
        Exchange a complete COLMAP workspace, its feature database, a sparse model, or camera transforms for NeRF /
        Gaussian-Splatting tools. Unsupported descriptor encodings are omitted while keypoints and verified matches are
        retained.
      </p>
      <label v-if="settings.format === 'workspace'" class="checkbox-row">
        <input type="checkbox" v-model="settings.includeImages" class="checkbox" /> Include original source images
        (larger ZIP)
      </label>
    </template>

    <!-- 3D Tiles -->
    <template v-else-if="kind === 'tiles3d'">
      <p class="field-hint">
        For globe viewers (Cesium, and anything else reading 3D Tiles 1.1). The model is placed by a transform measured
        from the project CRS, so it lands correctly even at polar latitudes.
      </p>
      <SettingsField
        label-for="tiling"
        :hint="
          settings.tiling === 'lod'
            ? tilesMesh
              ? 'The mesh split into tiles and decimated per level; viewers load detail where the camera is.'
              : 'One tile per node of the cloud\'s level-of-detail octree; viewers load detail where the camera is.'
            : 'The whole model in one tile, loaded at once.'
        "
      >
        <template #label><FieldHelp op="export-3d-tiles" param="tiling">Tiling</FieldHelp></template>
        <select id="tiling" v-model="settings.tiling" class="field-input field-select">
          <option value="lod">Level of detail (hierarchy of tiles)</option>
          <option value="single" :disabled="!singleTileOk">
            Single tile{{ singleTileOk ? '' : ' — too large for one tile' }}
          </option>
        </select>
      </SettingsField>
      <SettingsField v-if="tilesMesh && settings.tiling === 'lod'" label-for="tiletris">
        <template #label>
          <FieldHelp
            op="export-3d-tiles"
            param="tileTriangles"
            :value="settings.tileTriangles"
            :default-value="EXPORT_DEFAULTS.tileTriangles"
            >Triangles per tile</FieldHelp
          >
        </template>
        <input
          id="tiletris"
          v-model.number="settings.tileTriangles"
          type="number"
          min="1000"
          step="1024"
          class="field-input"
        />
      </SettingsField>
      <p v-if="textured" class="field-hint">
        {{
          settings.tiling === 'lod'
            ? 'The finest tiles keep the photo texture; the coarser, decimated ones have vertex colours.'
            : 'The tile is the selected textured mesh, with its photo texture.'
        }}
      </p>
      <label v-if="!textured || settings.tiling === 'lod'" class="checkbox-row"
        ><input type="checkbox" v-model="settings.includeColor" class="checkbox" /> Include vertex colours</label
      >
      <p v-if="tilesSubject?.streamed" class="field-hint">
        A streamed cloud is written in its own coordinates and placed in the CRS its file names, else the project CRS.
      </p>
      <p v-else-if="!hasGeoref" class="field-hint warn-hint">
        This project has no georeference, so the tileset will have no position on the globe. Georeference the model
        first.
      </p>
    </template>

    <!-- Undistorted images -->
    <template v-else-if="kind === 'undistorted'">
      <p class="field-hint">
        Pinhole images + a PINHOLE sparse model, the handoff COLMAP's
        <code>image_undistorter</code> produces — for OpenMVS, MVE and MVS-Texturing — and a
        <code>transforms.json</code> for NeRF / 3D Gaussian Splatting tools. Lens distortion and film-scan geometry are
        already folded out of the model, so only the pixels are resampled.
      </p>
      <SettingsField
        label="Border"
        label-for="umode"
        hint="Cropping keeps only the region that samples inside the source image."
      >
        <select id="umode" v-model="settings.undistortMode" class="field-input field-select">
          <option value="crop">Crop to the valid region</option>
          <option value="full">Keep the full frame (blank borders)</option>
        </select>
      </SettingsField>
      <SettingsField
        v-if="settings.format === 'jpeg'"
        :label="`JPEG quality: ${settings.undistortQuality.toFixed(2)}`"
        label-for="uq"
      >
        <input
          id="uq"
          v-model.number="settings.undistortQuality"
          type="range"
          min="0.5"
          max="1"
          step="0.01"
          class="field-input range"
        />
      </SettingsField>
      <SettingsField
        label="Maximum dimension"
        label-for="umax"
        hint="Longest output side in pixels; 0 = native resolution. Lower it for a smaller ZIP."
      >
        <input id="umax" v-model.number="settings.undistortMaxDim" type="number" min="0" step="1" class="field-input" />
      </SettingsField>
    </template>

    <!-- DEM -->
    <template v-else-if="kind === 'dem'">
      <p v-if="isCog" class="field-hint">
        Internally tiled with halving overviews, so a viewer can fetch a preview or one window with a few range requests
        instead of the whole file. Readable anywhere a normal GeoTIFF is.
      </p>
      <!-- The hillshade PNG is a rendered preview: it has no elevation cells to flag. -->
      <SettingsField
        v-if="settings.format !== 'png' && !reprojecting"
        label="NODATA value"
        label-for="nodata"
        hint="Written for empty cells (holes with no measurement)."
      >
        <input id="nodata" v-model.number="settings.nodata" type="number" step="any" class="field-input" />
      </SettingsField>
      <SettingsField v-if="isTiff && !reprojecting" label="Compression" label-for="comp">
        <select id="comp" v-model="settings.compression" class="field-input field-select">
          <option value="none">None (uncompressed)</option>
          <option value="deflate">DEFLATE (lossless)</option>
        </select>
      </SettingsField>
    </template>

    <!-- Saved measurements -->
    <template v-else-if="kind === 'measurements'">
      <SettingsField v-if="settings.format === 'geojson' && measurementCrs" label-for="mcoords">
        <template #label><FieldHelp op="dem" param="measurementCoords">Coordinates</FieldHelp></template>
        <select id="mcoords" v-model="settings.measurementCoords" class="field-input field-select">
          <option value="project">Project CRS ({{ measurementCrs }}), heights kept</option>
          <option value="wgs84">WGS 84 longitude/latitude (RFC 7946), 2D</option>
        </select>
      </SettingsField>
      <p v-if="settings.format === 'geojson' && !measurementCrs" class="field-hint">
        No measurement here has a coordinate system, so the file is written in the frames they were measured in and
        marked as not georeferenced.
      </p>
      <p class="field-hint">
        Every value has its unit beside it. Measurements whose raster, layer or frame has changed since are included and
        marked stale.
      </p>
    </template>

    <!-- Ortho -->
    <template v-else-if="kind === 'ortho'">
      <p v-if="isCog" class="field-hint">
        Internally tiled with halving overviews and DEFLATE compression — the orthophoto exactly as it is stored, for
        web/GIS delivery. Readable anywhere a normal GeoTIFF is.
      </p>
      <!-- The COG export is the stored file itself, always DEFLATE. -->
      <SettingsField v-if="isTiff && !isCog && !reprojecting" label="Compression" label-for="ocomp">
        <select id="ocomp" v-model="settings.compression" class="field-input field-select">
          <option value="none">None (uncompressed)</option>
          <option value="deflate">DEFLATE (lossless)</option>
        </select>
      </SettingsField>
      <SettingsField
        v-if="settings.format === 'jpeg'"
        :label="`JPEG quality: ${settings.jpegQuality.toFixed(2)}`"
        label-for="jq"
      >
        <input
          id="jq"
          v-model.number="settings.jpegQuality"
          type="range"
          min="0.1"
          max="1"
          step="0.05"
          class="field-input range"
        />
      </SettingsField>
    </template>

    <!-- DEM / ortho GeoTIFF in another CRS: warped block by block in the export worker. -->
    <template v-if="isRaster && isTiff">
      <SettingsField
        label-for="rcrs"
        :hint="
          rasterCrs
            ? 'Another CRS writes a reprojected copy; the product itself stays as built.'
            : 'A raster in the local frame has no CRS to reproject from.'
        "
      >
        <template #label><FieldHelp :op="rasterOp" param="rasterCrs">Coordinate system</FieldHelp></template>
        <select id="rcrs" v-model="settings.rasterCrs" class="field-input field-select">
          <option value="product">As built ({{ rasterCrs || 'local frame, no CRS' }})</option>
          <option value="other" :disabled="!rasterCrs">Another CRS…</option>
        </select>
      </SettingsField>
      <template v-if="rasterCrs && settings.rasterCrs === 'other'">
        <div class="field"><CrsPicker v-model="outputCrs" /></div>
        <SettingsField
          label-for="rresamp"
          :hint="
            kind === 'dem'
              ? 'Bilinear interpolates heights; Nearest keeps every value as measured.'
              : 'Bilinear is smoother; Nearest keeps every pixel as it was.'
          "
        >
          <template #label><FieldHelp :op="rasterOp" param="resampling">Resampling</FieldHelp></template>
          <select id="rresamp" v-model="settings.resampling" class="field-input field-select">
            <option value="bilinear">Bilinear</option>
            <option value="nearest">Nearest</option>
          </select>
        </SettingsField>
        <p class="field-hint">
          Written as a Cloud-Optimized GeoTIFF (DEFLATE{{ kind === 'dem' ? ', nodata NaN' : '' }}) at the same ground
          cell size.{{ kind === 'dem' ? ' Heights keep their vertical datum: only the horizontal CRS changes.' : '' }}
        </p>
      </template>
    </template>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" @click="run">Export</button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
<style scoped>
.warn-hint {
  color: var(--warn, #b45309);
}
.subject {
  margin: 0;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.field-input.range {
  width: 100%;
  padding: 0;
}
code {
  font-size: 11px;
}
</style>
