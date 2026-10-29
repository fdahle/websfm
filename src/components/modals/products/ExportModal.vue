<script setup>
import { ref, computed, watch } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import SettingsField from '../ui/SettingsField.vue'
import FieldHelp from '../../guide/FieldHelp.vue'
import CrsPicker from '../../controls/CrsPicker.vue'
import { EXPORT_DEFAULTS } from '../../../core/defaults.user.js'
import { MAX_ORTHO_IMAGE_CELLS } from '../../../core/products/exporters.js'
import { defaultTiling, singleTileFits } from '../../../core/products/tiles3d.js'
import { defaultExportName } from '../../../core/exportNames.js'
import FileNameField from '../ui/FileNameField.vue'
import { pluralize } from '../../../core/textFormat.js'

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
  // What the default file name starts from (useExports exportNameBase): the cloud's
  // or mesh's own export name, a vector layer's, else the project's.
  nameBase: { type: String, default: 'project' },
  // Camera poses / calibration: how many cameras each source has ({ imported,
  // estimated } for poses, { entered, estimated } for calibration). A source with none
  // is offered greyed; the estimated one is the default when the sparse model has any.
  sources: { type: Object, default: () => ({}) },
  // The project CRS ('' for a local frame): poses and vector layers can be converted
  // from it to WGS 84 (GeoJSON, KML).
  projectCrs: { type: String, default: '' },
  // A vector layer export: the image footprints (titled so), not another layer.
  footprints: { type: Boolean, default: false },
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

// Per kind: the title, the formats ({ value, label, hint? }) and a `hint` for every
// format. The Format field shows the chosen format's hint, else the kind's: what the
// file holds, which the label alone does not say.
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
      {
        value: 'transforms',
        label: 'transforms.json — NeRF / 3DGS',
        hint: 'Camera-to-world poses (OpenGL convention) + intrinsics for nerfstudio, instant-ngp and 3D Gaussian Splatting. Local SfM frame; pinhole.',
      },
    ],
  },
  colmap: {
    title: 'Export SfM Project',
    hint:
      'Exchange a complete COLMAP workspace, its feature database, a sparse model, or camera transforms for NeRF / ' +
      'Gaussian-Splatting tools. Unsupported descriptor encodings are omitted while keypoints and verified matches ' +
      'are retained.',
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
    hint:
      'For globe viewers (Cesium, and anything else reading 3D Tiles 1.1). The model is placed by a transform ' +
      'measured from the project CRS, so it lands correctly even at polar latitudes.',
    formats: [{ value: 'tileset', label: 'Cesium 3D Tiles 1.1 — tileset.json + glTF tiles (.zip)' }],
  },
  undistorted: {
    title: 'Export Undistorted Images',
    hint:
      "Pinhole images + a PINHOLE sparse model, the handoff COLMAP's image_undistorter produces (for OpenMVS, MVE " +
      'and MVS-Texturing), and a transforms.json for NeRF / 3D Gaussian Splatting tools. Lens distortion and ' +
      'film-scan geometry are already folded out of the model, so only the pixels are resampled.',
    formats: [
      { value: 'jpeg', label: 'JPEG — compact (recommended for MVS)' },
      { value: 'png', label: 'PNG — lossless (much larger)' },
    ],
  },
  dem: {
    title: 'Export DEM',
    formats: [
      { value: 'geotiff', label: 'GeoTIFF (.tif) — georeferenced' },
      {
        value: 'cog',
        label: 'Cloud-Optimized GeoTIFF — tiled + overviews',
        hint:
          'Internally tiled with halving overviews, so a viewer can fetch a preview or one window with a few range ' +
          'requests instead of the whole file. Readable anywhere a normal GeoTIFF is.',
      },
      { value: 'asc', label: 'ESRI ASCII grid (.asc)' },
      { value: 'png', label: 'Hillshade PNG + world file' },
      { value: 'support', label: 'Support layer GeoTIFF (.tif) — % of each cell measured' },
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
      {
        value: 'cog',
        label: 'Cloud-Optimized GeoTIFF — tiled + overviews',
        hint:
          'Internally tiled with halving overviews and DEFLATE compression: the orthophoto exactly as it is stored, ' +
          'for web/GIS delivery. Readable anywhere a normal GeoTIFF is.',
      },
      { value: 'png', label: 'PNG + world file (.wld)' },
      { value: 'jpeg', label: 'JPEG + world file' },
    ],
  },
  poses: {
    title: 'Export Camera Poses',
    formats: [
      { value: 'csv', label: 'CSV — one row per camera' },
      { value: 'txt', label: 'Text (.txt) — tab-separated' },
      { value: 'geojson', label: 'GeoJSON — one point per camera, for GIS' },
    ],
  },
  sensors: {
    title: 'Export Calibration',
    hint: 'Import ▸ Calibration reads it back: one row per camera group, or per image.',
    formats: [
      { value: 'csv', label: 'CSV' },
      { value: 'txt', label: 'Text (.txt) — tab-separated' },
    ],
  },
  cameraFiducials: {
    title: 'Export Camera Fiducials',
    hint: "Each film camera's calibrated marks in millimetres, one row per mark. Import ▸ Camera Fiducials reads it back.",
    formats: [
      { value: 'csv', label: 'CSV' },
      { value: 'txt', label: 'Text (.txt) — tab-separated' },
    ],
  },
  imageFiducials: {
    title: 'Export Image Fiducials',
    hint: "Each scan's detected or marked fiducials in pixels, one row per mark. Import ▸ Image Fiducials reads it back.",
    formats: [
      { value: 'csv', label: 'CSV' },
      { value: 'txt', label: 'Text (.txt) — tab-separated' },
    ],
  },
  keypoints: {
    title: 'Export Keypoints',
    formats: [
      {
        value: 'json',
        label: 'JSON — one entry per image',
        hint: 'Position (pixels), scale and response of each keypoint.',
      },
      {
        value: 'csv',
        label: 'CSV — one row per keypoint',
        hint: 'image, x, y, scale, response: one row per keypoint, for a spreadsheet or pandas.',
      },
    ],
  },
  matches: {
    title: 'Export Matches',
    hint: 'The pairs whose matches passed geometric verification; a rejected pair has none to list.',
    formats: [
      { value: 'json', label: 'JSON — one entry per pair' },
      { value: 'csv', label: 'CSV — one row per match' },
    ],
  },
  vectors: {
    title: 'Export Vector Layer',
    formats: [
      { value: 'geojson', label: 'GeoJSON (.geojson)' },
      { value: 'kml', label: 'KML (.kml) — Google Earth, WGS 84' },
    ],
  },
}

const imageTooLarge = computed(() => props.kind === 'ortho' && props.orthoCells > MAX_ORTHO_IMAGE_CELLS)
const cfg = computed(() => {
  const c = CONFIG[props.kind]
  if (props.kind === 'vectors') {
    return {
      ...c,
      title: props.footprints ? 'Export Footprints' : c.title,
      formats: c.formats.map((f) =>
        f.value === 'kml' && !props.projectCrs
          ? { ...f, label: f.label + ' — needs a project CRS', disabled: true }
          : f,
      ),
    }
  }
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
  fileName: '',
  ...EXPORT_DEFAULTS,
  // 3D Tiles: a hierarchy for a big model, one tile for a small one (defaultTiling).
  tiling: EXPORT_DEFAULTS.tiling ?? defaultTiling(props.tilesSubject),
  // Camera poses and calibration: the estimated ones when the sparse model has any.
  poseSource: props.sources.estimated ? 'estimated' : 'imported',
  sensorSource: props.sources.estimated ? 'estimated' : 'entered',
})
const estimatedPoses = computed(() => props.kind === 'poses' && settings.value.poseSource === 'estimated')
// Estimated poses are in the export frame (georeferenced, scaled or oriented) with
// Apply ticked, else in the model frame; imported ones in the project CRS.
const posesCrs = computed(() =>
  !estimatedPoses.value || (props.hasGeoref && settings.value.applyGeoref) ? props.projectCrs : '',
)
const posesFrameHint = computed(() => {
  if (posesCrs.value) return `Positions in ${posesCrs.value}.`
  if (!estimatedPoses.value) return 'Positions as imported (the project has no CRS).'
  if (hasFrame.value && settings.value.applyGeoref)
    return props.hasScale ? 'Positions in metres, no CRS.' : 'Positions in model units, in your orientation.'
  return 'Positions in the model frame (model units, no CRS).'
})
// GeoJSON can be written in WGS 84 when the coordinates are in a CRS.
const wgs84Offered = computed(
  () => settings.value.format === 'geojson' && (props.kind === 'vectors' ? !!props.projectCrs : !!posesCrs.value),
)
const formatHint = computed(() => {
  const f = cfg.value.formats.find((x) => x.value === settings.value.format)
  return f?.hint ?? cfg.value.hint ?? ''
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
  const { format, fileName } = settings.value
  const own = {
    poses: () => ({
      source: settings.value.poseSource,
      orientation: settings.value.poseOrientation,
      accuracy: settings.value.poseAccuracy,
      applyGeoref: settings.value.applyGeoref,
      coords: wgs84Offered.value ? settings.value.geoJsonCoords : 'project',
    }),
    sensors: () => ({ source: settings.value.sensorSource }),
    matches: () => ({ content: settings.value.matchContent }),
    vectors: () => ({ coords: wgs84Offered.value ? settings.value.geoJsonCoords : 'project' }),
    cameraFiducials: () => ({}),
    imageFiducials: () => ({}),
    keypoints: () => ({}),
  }[props.kind]
  if (own) {
    emit('run', { format, fileName, ...own() })
    return
  }
  // The undistorted exporter takes plain names; the persisted defaults are
  // namespaced so they can't collide with the other kinds' knobs. Mapping here
  // (rather than store-side) keeps one home for the values — see the modal-unit
  // rule in CLAUDE.md.
  if (props.kind === 'undistorted') {
    emit('run', {
      format: settings.value.format,
      fileName: settings.value.fileName,
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
// The name an export without a typed File name gets (the same function names the file).
const defaultName = computed(() =>
  defaultExportName(props.kind, {
    format: settings.value.format,
    base: props.nameBase,
    crs: reprojecting.value && outputCrs.value !== props.rasterCrs ? outputCrs.value : null,
    source: props.kind === 'poses' ? settings.value.poseSource : settings.value.sensorSource,
    content: settings.value.matchContent,
  }),
)
// The ortho's empty pixels: a GeoTIFF or PNG may keep the alpha band; a JPEG has none.
// The COG (the stored file) and a reprojected copy always keep it.
const orthoAlphaApplies = computed(
  () =>
    props.kind === 'ortho' &&
    (settings.value.format === 'png' || (settings.value.format === 'geotiff' && !reprojecting.value)),
)
const orthoNodataApplies = computed(
  () =>
    (orthoAlphaApplies.value && !settings.value.orthoAlpha) ||
    (props.kind === 'ortho' && settings.value.format === 'jpeg'),
)
</script>

<template>
  <!-- Every export reads the same way: what is exported, where it comes from (Source),
       the Format with what its file holds, the File name, the kind's own settings, notes. -->
  <ModalShell :title="cfg.title" @close="emit('close')">
    <p v-if="subject" class="subject">
      Exporting <strong>{{ subject }}</strong>
    </p>
    <SettingsField v-if="kind === 'poses'" label-for="psrc">
      <template #label><FieldHelp op="export-camera-poses" param="source">Source</FieldHelp></template>
      <select id="psrc" v-model="settings.poseSource" class="field-input field-select">
        <option value="estimated" :disabled="!sources.estimated">
          Estimated by the reconstruction ({{ pluralize(sources.estimated ?? 0, 'camera') }})
        </option>
        <option value="imported" :disabled="!sources.imported">
          Imported poses ({{ pluralize(sources.imported ?? 0, 'pose') }})
        </option>
      </select>
    </SettingsField>
    <SettingsField v-else-if="kind === 'sensors'" label-for="ssrc">
      <template #label><FieldHelp op="export-calibration" param="source">Source</FieldHelp></template>
      <select id="ssrc" v-model="settings.sensorSource" class="field-input field-select">
        <option value="estimated" :disabled="!sources.estimated">
          Estimated by the reconstruction, one row per camera group
        </option>
        <option value="estimatedPerImage" :disabled="!sources.estimated">
          Estimated by the reconstruction, one row per image ({{ pluralize(sources.estimated ?? 0, 'camera') }})
        </option>
        <option value="entered" :disabled="!sources.entered">
          As entered ({{ pluralize(sources.entered ?? 0, 'camera group') }})
        </option>
      </select>
    </SettingsField>
    <SettingsField label="Format" label-for="fmt">
      <select id="fmt" v-model="settings.format" class="field-input field-select">
        <option v-for="f in cfg.formats" :key="f.value" :value="f.value" :disabled="f.disabled">
          {{ f.label }}
        </option>
      </select>
      <template v-if="kind === 'dem' && settings.format === 'support'" #hint>
        <FieldHelp op="dem" param="supportExport">Support layer</FieldHelp>: for each DEM cell, the percentage that
        points landed in (0 = filled by interpolation), 255 where the DEM is empty. On the DEM's grid, or its overview
        for a DEM too large for one plane.
      </template>
      <template v-else-if="formatHint" #hint>{{ formatHint }}</template>
    </SettingsField>
    <FileNameField v-model="settings.fileName" :default-name="defaultName" />

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
    </template>

    <!-- COLMAP model -->
    <template v-else-if="kind === 'colmap'">
      <label v-if="settings.format === 'workspace'" class="checkbox-row">
        <input type="checkbox" v-model="settings.includeImages" class="checkbox" /> Include original source images
        (larger ZIP)
      </label>
    </template>

    <!-- 3D Tiles -->
    <template v-else-if="kind === 'tiles3d'">
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
      <!-- The hillshade PNG is a rendered preview, the support layer a percentage: no elevation cells to flag. -->
      <SettingsField
        v-if="settings.format !== 'png' && settings.format !== 'support' && !reprojecting"
        label="NODATA value"
        label-for="nodata"
        hint="Written for empty cells (holes with no measurement)."
      >
        <input id="nodata" v-model.number="settings.nodata" type="number" step="any" class="field-input" />
      </SettingsField>
      <SettingsField
        v-if="(isTiff || settings.format === 'support') && !reprojecting"
        label="Compression"
        label-for="comp"
      >
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
      <!-- The COG export is the stored file itself, always DEFLATE. -->
      <SettingsField v-if="isTiff && !isCog && !reprojecting" label="Compression" label-for="ocomp">
        <select id="ocomp" v-model="settings.compression" class="field-input field-select">
          <option value="none">None (uncompressed)</option>
          <option value="deflate">DEFLATE (lossless)</option>
        </select>
      </SettingsField>
      <!-- Empty pixels: an alpha band, or (unticked, and in a JPEG) a NODATA value. -->
      <label v-if="orthoAlphaApplies" class="checkbox-row">
        <input type="checkbox" v-model="settings.orthoAlpha" class="checkbox" />
        <FieldHelp op="orthophoto" param="orthoAlpha">Alpha band (transparent empty pixels)</FieldHelp>
      </label>
      <SettingsField v-if="orthoNodataApplies" label-for="onodata">
        <template #label
          ><FieldHelp
            op="orthophoto"
            param="orthoNodata"
            :value="settings.orthoNodata"
            :default-value="EXPORT_DEFAULTS.orthoNodata"
            >NODATA value</FieldHelp
          ></template
        >
        <input
          id="onodata"
          v-model.number="settings.orthoNodata"
          type="number"
          min="0"
          max="255"
          step="1"
          class="field-input"
        />
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

    <!-- Camera poses -->
    <template v-else-if="kind === 'poses'">
      <label class="checkbox-row">
        <input type="checkbox" v-model="settings.poseOrientation" class="checkbox" />
        <FieldHelp op="export-camera-poses" param="poseOrientation">Orientation (omega, phi, kappa)</FieldHelp>
      </label>
      <label class="checkbox-row">
        <input type="checkbox" v-model="settings.poseAccuracy" :disabled="estimatedPoses" class="checkbox" />
        Accuracies{{ estimatedPoses ? ' (imported poses only)' : '' }}
      </label>
      <label v-if="estimatedPoses && hasFrame" class="checkbox-row">
        <input type="checkbox" v-model="settings.applyGeoref" class="checkbox" /> {{ frameLabel }}
      </label>
      <SettingsField v-if="wgs84Offered" label-for="pcoords">
        <template #label><FieldHelp op="export-camera-poses" param="geoJsonCoords">Coordinates</FieldHelp></template>
        <select id="pcoords" v-model="settings.geoJsonCoords" class="field-input field-select">
          <option value="project">Project CRS ({{ posesCrs }}), heights kept</option>
          <option value="wgs84">WGS 84 longitude/latitude (RFC 7946), height as a property</option>
        </select>
      </SettingsField>
      <p class="field-hint">
        {{ posesFrameHint }}
        {{
          estimatedPoses
            ? 'Import ▸ Camera Poses reads the file back as pose priors with the same angles.'
            : 'The poses as imported, with their accuracies.'
        }}
      </p>
    </template>

    <!-- Calibration -->
    <template v-else-if="kind === 'sensors'">
      <p v-if="settings.sensorSource !== 'entered'" class="field-hint">
        Focal length and principal point as bundle adjustment ended, in pixels (a film scan's in its fiducial frame);
        the lens model each group was corrected with, and any radial terms self-calibration fitted on top of it
        (selfcal_k1…k3).
      </p>
    </template>

    <!-- Matches -->
    <template v-else-if="kind === 'matches'">
      <SettingsField label="Content" label-for="mcontent">
        <select id="mcontent" v-model="settings.matchContent" class="field-input field-select">
          <option value="matches">Every pair with its matches (keypoint indices)</option>
          <option value="pairs">The pair list only, with match counts</option>
        </select>
      </SettingsField>
    </template>

    <!-- Vector layer (footprints, contours, imported polygons) -->
    <template v-else-if="kind === 'vectors'">
      <SettingsField v-if="wgs84Offered" label="Coordinates" label-for="vcoords">
        <select id="vcoords" v-model="settings.geoJsonCoords" class="field-input field-select">
          <option value="project">Project CRS ({{ projectCrs }})</option>
          <option value="wgs84">WGS 84 longitude/latitude (RFC 7946)</option>
        </select>
      </SettingsField>
      <p v-if="!projectCrs" class="field-hint">
        The project has no CRS, so the layer is written in its own coordinates.
      </p>
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
</style>
