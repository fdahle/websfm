<script setup>
import { ref, computed, watch } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import SettingsField from '../ui/SettingsField.vue'
import SettingsGroup from '../ui/SettingsGroup.vue'
import SettingsStep from '../ui/SettingsStep.vue'
import ChoiceCards from '../ui/ChoiceCards.vue'
import FieldHelp from '../../guide/FieldHelp.vue'
import CrsPicker from '../../controls/CrsPicker.vue'
import { EXPORT_DEFAULTS } from '../../../core/defaults.user.js'
import { MAX_ORTHO_IMAGE_CELLS } from '../../../core/products/exporters.js'
import { defaultTiling, singleTileFits } from '../../../core/products/tiles3d.js'
import { defaultExportName } from '../../../core/exportNames.js'
import FileNameField from '../ui/FileNameField.vue'
import { t } from '../../../composables/useI18n.js'
import { CATALOGS } from '../../../core/i18n/index.js'
import I18nText from '../../I18nText.vue'
import { iiifImageUri, iiifTemplateProblem } from '../../../core/io/allmaps.js'

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
  if (props.hasGeoref) return t('export.frame.georef')
  if (props.hasScale && props.hasOrientation) return t('export.frame.scaleOrient')
  if (props.hasScale) return t('export.frame.scale')
  return t('export.frame.orient')
})
const emit = defineEmits(['close', 'run'])

// Per kind, its formats in the order they are offered (the cards). Their words are in the
// catalogue (core/i18n/en/export.js ▸ format.<kind>.<id>): a label, a blurb under it,
// and a hint for the Format step's line when the format needs more; else the kind's.
const FORMATS = {
  cloud: ['ply-binary', 'ply-ascii', 'las', 'laz', 'copc', 'xyz'],
  mesh: ['ply-binary', 'ply-ascii', 'glb', 'obj', 'stl'],
  model: ['json', 'transforms'],
  colmap: ['workspace', 'database', 'txt', 'bin', 'transforms', 'openmvg', 'nvm', 'metashape'],
  tiles3d: ['tileset'],
  undistorted: ['jpeg', 'png'],
  dem: ['geotiff', 'cog', 'asc', 'png', 'support'],
  measurements: ['csv', 'geojson'],
  ortho: ['geotiff', 'cog', 'png', 'jpeg', 'mbtiles', 'xyz'],
  poses: ['csv', 'txt', 'geojson'],
  sensors: ['csv', 'txt'],
  cameraFiducials: ['csv', 'txt'],
  imageFiducials: ['csv', 'txt'],
  keypoints: ['json', 'csv'],
  matches: ['json', 'csv'],
  vectors: ['geojson', 'kml'],
  allmaps: ['annotations'],
}
// A catalogue text that only some formats or kinds have: '' where there is none.
const optional = (key, params) => (key in CATALOGS.en ? t(key, params) : '')

const imageTooLarge = computed(() => props.kind === 'ortho' && props.orthoCells > MAX_ORTHO_IMAGE_CELLS)
// Why a format is offered greyed ('' when it is not): KML needs a CRS to convert from,
// and an orthophoto PNG/JPEG is made whole through a canvas.
function unavailable(value) {
  if (props.kind === 'vectors' && value === 'kml' && !props.projectCrs) return t('export.unavailable.needsCrs')
  if (imageTooLarge.value && (value === 'png' || value === 'jpeg'))
    return t('export.unavailable.tooLarge', { side: Math.sqrt(MAX_ORTHO_IMAGE_CELLS) })
  return ''
}
const cfg = computed(() => ({
  title: t(`export.title.${props.kind === 'vectors' && props.footprints ? 'footprints' : props.kind}`),
  hint: optional(`export.hint.${props.kind}`),
  formats: (FORMATS[props.kind] ?? []).map((value) => {
    const base = `export.format.${props.kind}.${value}`
    return {
      value,
      label: t(`${base}.label`),
      blurb: optional(`${base}.blurb`),
      hint: optional(`${base}.hint`),
      why: unavailable(value),
    }
  }),
}))

// `format` is chosen dynamically per kind; the rest are the single source of truth
// in core/defaults.user.js.
const settings = ref({
  format: (props.kind === 'mesh' && props.textured ? 'glb' : null) ?? cfg.value.formats.find((f) => !f.why)?.value,
  includeImages: false,
  includeTexture: true,
  fileName: '',
  ...EXPORT_DEFAULTS,
  // 3D Tiles: a hierarchy for a big model, one tile for a small one (defaultTiling).
  tiling: EXPORT_DEFAULTS.tiling ?? defaultTiling(props.tilesSubject),
  // Camera poses and calibration: the estimated ones when the sparse model has any.
  poseSource: props.sources.estimated ? 'estimated' : 'imported',
  sensorSource: props.sources.estimated ? 'estimated' : 'entered',
  // Allmaps: the address the project's last export used.
  ...(props.sources.iiif ? { iiifTemplate: props.sources.iiif.template, iiifVersion: props.sources.iiif.version } : {}),
})
const estimatedPoses = computed(() => props.kind === 'poses' && settings.value.poseSource === 'estimated')
// Estimated poses are in the export frame (georeferenced, scaled or oriented) with
// Apply ticked, else in the model frame; imported ones in the project CRS.
const posesCrs = computed(() =>
  !estimatedPoses.value || (props.hasGeoref && settings.value.applyGeoref) ? props.projectCrs : '',
)
const posesFrameHint = computed(() => {
  if (posesCrs.value) return t('export.poses.inCrs', { crs: posesCrs.value })
  if (!estimatedPoses.value) return t('export.poses.asImported')
  if (hasFrame.value && settings.value.applyGeoref)
    return t(props.hasScale ? 'export.poses.metres' : 'export.poses.oriented')
  return t('export.poses.modelFrame')
})
// GeoJSON can be written in WGS 84 when the coordinates are in a CRS.
const wgs84Offered = computed(
  () => settings.value.format === 'geojson' && (props.kind === 'vectors' ? !!props.projectCrs : !!posesCrs.value),
)
const formatHint = computed(() => {
  const f = cfg.value.formats.find((x) => x.value === settings.value.format)
  return f?.hint || cfg.value.hint
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
const isWebTiles = computed(
  () => props.kind === 'ortho' && (settings.value.format === 'mbtiles' || settings.value.format === 'xyz'),
)
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
    allmaps: () => ({ iiifTemplate: settings.value.iiifTemplate, iiifVersion: settings.value.iiifVersion }),
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

// The formats as cards: the name, what the file holds under it, or why it is greyed.
const formatCards = computed(() =>
  cfg.value.formats.map((f) => ({
    id: f.value,
    label: f.label,
    blurb: f.why || f.blurb || undefined,
    disabled: !!f.why,
  })),
)

// The steps, as the export applies them: ① the format, ② the kind's own settings (when
// this format has any), ③ a DEM's or orthophoto's coordinate system (GeoTIFF), then the
// file name.
const optionsShown = computed(() => {
  const f = settings.value.format
  switch (props.kind) {
    case 'model':
      return f === 'json'
    case 'colmap':
      return f === 'workspace'
    case 'dem':
      return !reprojecting.value && f !== 'png'
    case 'ortho':
      return (
        (isTiff.value && !isCog.value && !reprojecting.value) ||
        orthoAlphaApplies.value ||
        orthoNodataApplies.value ||
        isWebTiles.value ||
        f === 'jpeg'
      )
    case 'sensors':
      return settings.value.sensorSource !== 'entered'
    case 'vectors':
      return wgs84Offered.value || !props.projectCrs
    case 'cameraFiducials':
    case 'imageFiducials':
    case 'keypoints':
      return false
    default:
      return true
  }
})
// Allmaps: why the IIIF address cannot name the photos yet ('' when it can), and the
// address the first aligned photo gets.
const iiifProblem = computed(() => {
  if (props.kind !== 'allmaps') return ''
  const problem = iiifTemplateProblem(settings.value.iiifTemplate, props.sources.estimated ?? 0)
  return problem ? t(`export.allmaps.problem.${problem}`) : ''
})
const iiifExample = computed(() =>
  props.sources.example
    ? t('export.allmaps.example', {
        name: props.sources.example,
        uri: iiifImageUri(settings.value.iiifTemplate, props.sources.example),
      })
    : '',
)
// The Export button's reason when it cannot run.
const runBlocked = computed(() => iiifProblem.value)

const optionsTitle = computed(() => optional(`export.step.options.${props.kind}`) || t('export.step.options.other'))
const crsShown = computed(() => isRaster.value && isTiff.value)
const stepNo = computed(() => {
  let n = 1
  const options = optionsShown.value ? ++n : 0
  const crs = crsShown.value ? ++n : 0
  return { options, crs, file: n + 1 }
})
const hasSource = computed(() => !!props.subject || props.kind === 'poses' || props.kind === 'sensors')
</script>

<template>
  <!-- Every export reads the same way, as numbered steps like a Tools dialog: where it
       comes from (Source), ① the Format as cards with what its file holds, ② the kind's
       own settings, ③ a raster's coordinate system, then the File name. -->
  <ModalShell :title="cfg.title" @close="emit('close')">
    <SettingsGroup v-if="hasSource" :title="t('export.source.label')">
      <p v-if="subject" class="subject">
        <I18nText k="export.exporting" :params="{ name: subject }" />
      </p>
      <SettingsField v-if="kind === 'poses'" label-for="psrc">
        <template #label
          ><FieldHelp op="export-camera-poses" param="source">{{ t('export.source.label') }}</FieldHelp></template
        >
        <select id="psrc" v-model="settings.poseSource" class="field-input field-select">
          <option
            value="estimated"
            :disabled="!sources.estimated"
            :title="sources.estimated ? null : t('export.source.noSparse')"
          >
            {{ t('export.source.posesEstimated', { n: sources.estimated ?? 0 }) }}
          </option>
          <option
            value="imported"
            :disabled="!sources.imported"
            :title="sources.imported ? null : t('export.source.noImportedPoses')"
          >
            {{ t('export.source.posesImported', { n: sources.imported ?? 0 }) }}
          </option>
        </select>
      </SettingsField>
      <SettingsField v-else-if="kind === 'sensors'" label-for="ssrc">
        <template #label
          ><FieldHelp op="export-calibration" param="source">{{ t('export.source.label') }}</FieldHelp></template
        >
        <select id="ssrc" v-model="settings.sensorSource" class="field-input field-select">
          <option
            value="estimated"
            :disabled="!sources.estimated"
            :title="sources.estimated ? null : t('export.source.noSparse')"
          >
            {{ t('export.source.sensorsEstimated') }}
          </option>
          <option
            value="estimatedPerImage"
            :disabled="!sources.estimated"
            :title="sources.estimated ? null : t('export.source.noSparse')"
          >
            {{ t('export.source.sensorsEstimatedPerImage', { n: sources.estimated ?? 0 }) }}
          </option>
          <option
            value="entered"
            :disabled="!sources.entered"
            :title="sources.entered ? null : t('export.source.noEnteredCalibration')"
          >
            {{ t('export.source.sensorsEntered', { n: sources.entered ?? 0 }) }}
          </option>
        </select>
      </SettingsField>
    </SettingsGroup>

    <SettingsStep step="1" :title="t('export.step.format')" :effect="formatHint">
      <template v-if="kind === 'dem' && settings.format === 'support'" #effect>
        <FieldHelp op="dem" param="supportExport">{{ t('export.supportLayer.label') }}</FieldHelp>{{
          t('export.supportLayer.effect')
        }}
      </template>
      <ChoiceCards
        v-model="settings.format"
        :options="formatCards"
        class="format-cards"
        :aria-label="t('export.step.format')"
      />
    </SettingsStep>

    <SettingsStep v-if="optionsShown" :step="stepNo.options" :title="optionsTitle">
      <!-- Point cloud -->
      <template v-if="kind === 'cloud'">
        <label :title="isLasFormat ? t('export.cloud.lasAlwaysRgb') : null" class="checkbox-row">
          <input
            type="checkbox"
            v-model="settings.includeColor"
            :disabled="isLasFormat"
            :title="isLasFormat ? t('export.cloud.lasAlwaysRgb') : null"
            class="checkbox"
          />
          {{ t(isLasFormat ? 'export.cloud.lasColours' : 'export.cloud.colours') }}
        </label>
        <label v-if="hasFrame" class="checkbox-row"
          ><input type="checkbox" v-model="settings.applyGeoref" class="checkbox" /> {{ frameLabel }}</label
        >
        <SettingsField
          :label="t('export.cloud.voxel.label')"
          label-for="dscell"
          :hint="
            t(
              hasGeoref
                ? 'export.cloud.voxel.hintGeoref'
                : hasScale
                  ? 'export.cloud.voxel.hintScaled'
                  : 'export.cloud.voxel.hint',
            )
          "
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
        <p class="field-hint">{{ t('export.cloud.attributes') }}</p>
      </template>

      <!-- Mesh -->
      <template v-else-if="kind === 'mesh'">
        <template v-if="textured">
          <label :title="textureFormat ? null : t('export.mesh.textureFormats')" class="checkbox-row">
            <input
              type="checkbox"
              v-model="settings.includeTexture"
              :disabled="!textureFormat"
              :title="textureFormat ? null : t('export.mesh.textureFormats')"
              class="checkbox"
            />
            {{ t(textureFormat ? 'export.mesh.texture' : 'export.mesh.textureOnly') }}
          </label>
          <p v-if="textureFormat && settings.includeTexture" class="field-hint">
            {{ t(settings.format === 'glb' ? 'export.mesh.glbTexture' : 'export.mesh.objTexture') }}
          </p>
        </template>
        <label
          :title="settings.format === 'stl' ? t('export.mesh.stlNoColour') : null"
          v-if="!(textured && textureFormat && settings.includeTexture)"
          class="checkbox-row"
        >
          <input
            type="checkbox"
            v-model="settings.includeColor"
            :disabled="settings.format === 'stl'"
            :title="settings.format === 'stl' ? t('export.mesh.stlNoColour') : null"
            class="checkbox"
          />
          {{ t(settings.format === 'stl' ? 'export.mesh.stlColours' : 'export.mesh.colours') }}
        </label>
        <label v-if="hasFrame" class="checkbox-row">
          <input type="checkbox" v-model="settings.applyGeoref" class="checkbox" /> {{ frameLabel }}
        </label>
      </template>

      <!-- Model JSON -->
      <template v-else-if="kind === 'model'">
        <label v-if="settings.format === 'json'" class="checkbox-row">
          <input type="checkbox" v-model="settings.includeTracks" class="checkbox" /> {{ t('export.model.tracks') }}
        </label>
      </template>

      <!-- COLMAP model -->
      <template v-else-if="kind === 'colmap'">
        <label v-if="settings.format === 'workspace'" class="checkbox-row">
          <input type="checkbox" v-model="settings.includeImages" class="checkbox" /> {{ t('export.colmap.images') }}
        </label>
      </template>

      <!-- 3D Tiles -->
      <template v-else-if="kind === 'tiles3d'">
        <SettingsField
          label-for="tiling"
          :hint="
            t(
              settings.tiling === 'lod'
                ? tilesMesh
                  ? 'export.tiles3d.lodMesh'
                  : 'export.tiles3d.lodCloud'
                : 'export.tiles3d.singleHint',
            )
          "
        >
          <template #label
            ><FieldHelp op="export-3d-tiles" param="tiling">{{ t('export.tiles3d.tiling') }}</FieldHelp></template
          >
          <select id="tiling" v-model="settings.tiling" class="field-input field-select">
            <option value="lod">{{ t('export.tiles3d.lod') }}</option>
            <option
              value="single"
              :disabled="!singleTileOk"
              :title="singleTileOk ? null : t('export.tiles3d.tooLarge')"
            >
              {{ t(singleTileOk ? 'export.tiles3d.single' : 'export.tiles3d.singleTooLarge') }}
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
              >{{ t('export.tiles3d.triangles') }}</FieldHelp
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
          {{ t(settings.tiling === 'lod' ? 'export.tiles3d.textureLod' : 'export.tiles3d.textureSingle') }}
        </p>
        <label v-if="!textured || settings.tiling === 'lod'" class="checkbox-row"
          ><input type="checkbox" v-model="settings.includeColor" class="checkbox" />
          {{ t('export.tiles3d.colours') }}</label
        >
        <p v-if="tilesSubject?.streamed" class="field-hint">{{ t('export.tiles3d.streamed') }}</p>
        <p v-else-if="!hasGeoref" class="field-hint warn-hint">{{ t('export.tiles3d.noGeoref') }}</p>
      </template>

      <!-- Undistorted images -->
      <template v-else-if="kind === 'undistorted'">
        <SettingsField
          :label="t('export.undistorted.border')"
          label-for="umode"
          :hint="t('export.undistorted.borderHint')"
        >
          <select id="umode" v-model="settings.undistortMode" class="field-input field-select">
            <option value="crop">{{ t('export.undistorted.crop') }}</option>
            <option value="full">{{ t('export.undistorted.full') }}</option>
          </select>
        </SettingsField>
        <SettingsField
          v-if="settings.format === 'jpeg'"
          :label="t('export.undistorted.quality', { q: settings.undistortQuality })"
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
          :label="t('export.undistorted.maxDim')"
          label-for="umax"
          :hint="t('export.undistorted.maxDimHint')"
        >
          <input
            id="umax"
            v-model.number="settings.undistortMaxDim"
            type="number"
            min="0"
            step="1"
            class="field-input"
          />
        </SettingsField>
      </template>

      <!-- DEM -->
      <template v-else-if="kind === 'dem'">
        <!-- The hillshade PNG is a rendered preview, the support layer a percentage: no elevation cells to flag. -->
        <SettingsField
          v-if="settings.format !== 'png' && settings.format !== 'support' && !reprojecting"
          :label="t('export.raster.nodata')"
          label-for="nodata"
          :hint="t('export.raster.nodataHint')"
        >
          <input id="nodata" v-model.number="settings.nodata" type="number" step="any" class="field-input" />
        </SettingsField>
        <SettingsField
          v-if="(isTiff || settings.format === 'support') && !reprojecting"
          :label="t('export.raster.compression')"
          label-for="comp"
        >
          <select id="comp" v-model="settings.compression" class="field-input field-select">
            <option value="none">{{ t('export.raster.none') }}</option>
            <option value="deflate">{{ t('export.raster.deflate') }}</option>
          </select>
        </SettingsField>
      </template>

      <!-- Saved measurements -->
      <template v-else-if="kind === 'measurements'">
        <SettingsField v-if="settings.format === 'geojson' && measurementCrs" label-for="mcoords">
          <template #label
            ><FieldHelp op="dem" param="measurementCoords">{{
              t('export.measurements.coordinates')
            }}</FieldHelp></template
          >
          <select id="mcoords" v-model="settings.measurementCoords" class="field-input field-select">
            <option value="project">{{ t('export.measurements.project', { crs: measurementCrs }) }}</option>
            <option value="wgs84">{{ t('export.measurements.wgs84') }}</option>
          </select>
        </SettingsField>
        <p v-if="settings.format === 'geojson' && !measurementCrs" class="field-hint">
          {{ t('export.measurements.noCrs') }}
        </p>
        <p class="field-hint">{{ t('export.measurements.units') }}</p>
      </template>

      <!-- Ortho -->
      <template v-else-if="kind === 'ortho'">
        <!-- The COG export is the stored file itself, always DEFLATE. -->
        <SettingsField
          v-if="isTiff && !isCog && !reprojecting"
          :label="t('export.raster.compression')"
          label-for="ocomp"
        >
          <select id="ocomp" v-model="settings.compression" class="field-input field-select">
            <option value="none">{{ t('export.raster.none') }}</option>
            <option value="deflate">{{ t('export.raster.deflate') }}</option>
          </select>
        </SettingsField>
        <!-- Empty pixels: an alpha band, or (unticked, and in a JPEG) a NODATA value. -->
        <label v-if="orthoAlphaApplies" class="checkbox-row">
          <input type="checkbox" v-model="settings.orthoAlpha" class="checkbox" />
          <FieldHelp op="orthophoto" param="orthoAlpha">{{ t('export.raster.alpha') }}</FieldHelp>
        </label>
        <SettingsField v-if="orthoNodataApplies" label-for="onodata">
          <template #label
            ><FieldHelp
              op="orthophoto"
              param="orthoNodata"
              :value="settings.orthoNodata"
              :default-value="EXPORT_DEFAULTS.orthoNodata"
              >{{ t('export.raster.nodata') }}</FieldHelp
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
        <SettingsField v-if="isWebTiles" label-for="tfmt">
          <template #label
            ><FieldHelp op="orthophoto" param="tileFormat">{{ t('export.raster.tileFormat') }}</FieldHelp></template
          >
          <select id="tfmt" v-model="settings.tileFormat" class="field-input field-select">
            <option value="png">{{ t('export.raster.tilePng') }}</option>
            <option value="jpeg">{{ t('export.raster.tileJpeg') }}</option>
            <option value="webp">{{ t('export.raster.tileWebp') }}</option>
          </select>
        </SettingsField>
        <SettingsField
          v-if="settings.format === 'jpeg' || (isWebTiles && settings.tileFormat !== 'png')"
          :label="
            t(isWebTiles ? 'export.raster.tileQuality' : 'export.raster.jpegQuality', { q: settings.jpegQuality })
          "
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
          <FieldHelp op="export-camera-poses" param="poseOrientation">{{ t('export.poses.orientation') }}</FieldHelp>
        </label>
        <label :title="estimatedPoses ? t('export.poses.onlyImported') : null" class="checkbox-row">
          <input
            type="checkbox"
            v-model="settings.poseAccuracy"
            :disabled="estimatedPoses"
            :title="estimatedPoses ? t('export.poses.onlyImported') : null"
            class="checkbox"
          />
          {{ t(estimatedPoses ? 'export.poses.accuraciesImported' : 'export.poses.accuracies') }}
        </label>
        <label v-if="estimatedPoses && hasFrame" class="checkbox-row">
          <input type="checkbox" v-model="settings.applyGeoref" class="checkbox" /> {{ frameLabel }}
        </label>
        <SettingsField v-if="wgs84Offered" label-for="pcoords">
          <template #label
            ><FieldHelp op="export-camera-poses" param="geoJsonCoords">{{
              t('export.poses.coordinates')
            }}</FieldHelp></template
          >
          <select id="pcoords" v-model="settings.geoJsonCoords" class="field-input field-select">
            <option value="project">{{ t('export.poses.project', { crs: posesCrs }) }}</option>
            <option value="wgs84">{{ t('export.poses.wgs84') }}</option>
          </select>
        </SettingsField>
        <p class="field-hint">
          {{ posesFrameHint }}
          {{ t(estimatedPoses ? 'export.poses.readBack' : 'export.poses.imported') }}
        </p>
      </template>

      <!-- Calibration -->
      <template v-else-if="kind === 'sensors'">
        <p v-if="settings.sensorSource !== 'entered'" class="field-hint">{{ t('export.sensors.estimated') }}</p>
      </template>

      <!-- Matches -->
      <template v-else-if="kind === 'matches'">
        <SettingsField :label="t('export.matches.content')" label-for="mcontent">
          <select id="mcontent" v-model="settings.matchContent" class="field-input field-select">
            <option value="matches">{{ t('export.matches.matches') }}</option>
            <option value="pairs">{{ t('export.matches.pairs') }}</option>
          </select>
        </SettingsField>
      </template>

      <!-- Allmaps: where the photos are served from -->
      <template v-else-if="kind === 'allmaps'">
        <SettingsField label-for="iiiftpl" :hint="iiifProblem || iiifExample">
          <template #label
            ><FieldHelp op="export-allmaps" param="iiifTemplate">{{ t('export.allmaps.address') }}</FieldHelp></template
          >
          <input
            id="iiiftpl"
            v-model="settings.iiifTemplate"
            type="url"
            spellcheck="false"
            :placeholder="t('export.allmaps.placeholder')"
            class="field-input wide"
          />
        </SettingsField>
        <SettingsField label-for="iiifver">
          <template #label
            ><FieldHelp op="export-allmaps" param="iiifVersion">{{ t('export.allmaps.api') }}</FieldHelp></template
          >
          <select id="iiifver" v-model.number="settings.iiifVersion" class="field-input field-select">
            <option :value="2">{{ t('export.allmaps.version', { v: 2 }) }}</option>
            <option :value="3">{{ t('export.allmaps.version', { v: 3 }) }}</option>
          </select>
        </SettingsField>
        <p class="field-hint">{{ t('export.allmaps.photos', { n: sources.estimated ?? 0 }) }}</p>
      </template>

      <!-- Vector layer (footprints, contours, imported polygons) -->
      <template v-else-if="kind === 'vectors'">
        <SettingsField v-if="wgs84Offered" :label="t('export.vectors.coordinates')" label-for="vcoords">
          <select id="vcoords" v-model="settings.geoJsonCoords" class="field-input field-select">
            <option value="project">{{ t('export.vectors.project', { crs: projectCrs }) }}</option>
            <option value="wgs84">{{ t('export.vectors.wgs84') }}</option>
          </select>
        </SettingsField>
        <p v-if="!projectCrs" class="field-hint">{{ t('export.vectors.noCrs') }}</p>
      </template>
    </SettingsStep>

    <!-- DEM / ortho GeoTIFF in another CRS: warped block by block in the export worker. -->
    <SettingsStep v-if="crsShown" :step="stepNo.crs" :title="t('export.step.crs')">
      <SettingsField label-for="rcrs" :hint="t(rasterCrs ? 'export.raster.crsHint' : 'export.raster.localHint')">
        <template #label
          ><FieldHelp :op="rasterOp" param="rasterCrs">{{ t('export.raster.crs') }}</FieldHelp></template
        >
        <select id="rcrs" v-model="settings.rasterCrs" class="field-input field-select">
          <option value="product">
            {{ t('export.raster.asBuilt', { crs: rasterCrs || t('export.raster.localFrame') }) }}
          </option>
          <option value="other" :disabled="!rasterCrs" :title="rasterCrs ? null : t('export.raster.localHint')">
            {{ t('export.raster.anotherCrs') }}
          </option>
        </select>
      </SettingsField>
      <template v-if="rasterCrs && settings.rasterCrs === 'other'">
        <div class="field"><CrsPicker v-model="outputCrs" /></div>
        <SettingsField
          label-for="rresamp"
          :hint="t(kind === 'dem' ? 'export.raster.resamplingDem' : 'export.raster.resamplingOrtho')"
        >
          <template #label
            ><FieldHelp :op="rasterOp" param="resampling">{{ t('export.raster.resampling') }}</FieldHelp></template
          >
          <select id="rresamp" v-model="settings.resampling" class="field-input field-select">
            <option value="bilinear">{{ t('export.raster.bilinear') }}</option>
            <option value="nearest">{{ t('export.raster.nearest') }}</option>
          </select>
        </SettingsField>
        <p class="field-hint">
          {{ t(kind === 'dem' ? 'export.raster.reprojectedDem' : 'export.raster.reprojectedOrtho') }}
        </p>
      </template>
    </SettingsStep>

    <SettingsStep :step="stepNo.file" :title="t('export.step.file')">
      <FileNameField v-model="settings.fileName" :default-name="defaultName" />
    </SettingsStep>

    <template #footer>
      <button class="btn" @click="emit('close')">{{ t('common.cancel') }}</button>
      <button class="btn btn-primary" :disabled="!!runBlocked" :title="runBlocked || null" @click="run">
        {{ t('export.run') }}
      </button>
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
.format-cards.choice-cards {
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
}
.field-input.range {
  width: 100%;
  padding: 0;
}
</style>
