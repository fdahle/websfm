<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import WarnBox from '../ui/WarnBox.vue'
import GlossaryTerm from '../../glossary/GlossaryTerm.vue'
import { useExternalStore } from '../../../stores/useExternalStore.js'
import { useReconstructionStore } from '../../../stores/useReconstructionStore.js'
import { useImagesStore } from '../../../stores/useImagesStore.js'
import { useSensorsStore } from '../../../stores/useSensorsStore.js'
import { useGcpsStore } from '../../../stores/useGcpsStore.js'
import { useProjectsStore } from '../../../stores/useProjectsStore.js'
import { useLog } from '../../../composables/useLog.js'
import { findReferenceMatches } from '../../../workers/computeClient.js'
import { referenceGcpCandidates, candidateCoverage, referencePick } from '../../../core/sfm/referenceGcps.js'
import { gpsSearchOutline, searchRegion } from '../../../core/sfm/referenceMatch.js'
import { worldToPixel } from '../../../core/io/rasterSample.js'
import { makePinholeToMark, makeFrameModelResolver } from '../../../core/sfm/displayFrame.js'
import { ensureProjection, transform, isGeographic, metresToCrsUnits } from '../../../core/crs.js'

const props = defineProps({ hasRelativeOrtho: Boolean, referenceOrthos: { type: Array, default: () => [] } })
const emit = defineEmits(['close'])
const external = useExternalStore(), recon = useReconstructionStore(), images = useImagesStore()
const sensors = useSensorsStore(), gcps = useGcpsStore(), projects = useProjectsStore()
const { log } = useLog()
const selectedReferenceId = ref(props.referenceOrthos[0]?.id ?? ''), band = ref(1)
const reference = computed(() => external.rasterById(selectedReferenceId.value))
const ready = computed(() => props.hasRelativeOrtho && reference.value?.crs && !reference.value.crsUnresolved
  && recon.mainSparseCloud && !recon.productFrameStatus(recon.ortho).stale)
const busy = ref(false), error = ref(''), message = ref(''), candidates = ref([]), preview = ref(null)
const activeIndex = ref(0), demId = ref('')
const active = computed(() => candidates.value[activeIndex.value])
const dems = computed(() => external.rasters.filter(r => r.kind === 'dem' && !r.crsUnresolved))
const photoPreviews = computed(() => (active.value?.observations || []).flatMap(obs => {
  const im = images.images.find(im => im.name === obs.imageName)
  const width = im?.meta?.width, height = im?.meta?.height
  return im?.url && width && height ? [{ ...obs, url: im.url, width, height }] : []
}))
const reviewed = computed(() => candidates.value.filter(c => c.selected))
const invalid = computed(() => reviewed.value.some(c =>
  (c.z != null && c.z !== '' && !Number.isFinite(c.z)) || ['accuracyX', 'accuracyY', 'accuracyZ'].some(k =>
    c[k] != null && c[k] !== '' && !(Number.isFinite(c[k]) && c[k] > 0))))
let generation = 0, tileUrls = []
function dropTileUrls() { for (const u of tileUrls) URL.revokeObjectURL(u); tileUrls = [] }
function reset() { generation++; candidates.value = []; preview.value = null; error.value = ''; message.value = ''; busy.value = false; dropTileUrls() }
// Candidates hold project-CRS coordinates from find time, so a CRS change invalidates them.
watch([selectedReferenceId, band, () => recon.ortho, () => recon.mainSparseCloud, () => projects.currentProjectId, () => projects.currentCrs], reset)
onBeforeUnmount(() => { generation++; dropTileUrls() })

// Where in the reference to look: the ortho's own footprint when it is already
// georeferenced, else the registered photos' GPS positions, else everywhere.
async function searchArea(ortho, cloud, refRaster) {
  const toPixels = (pts, crs) => pts.map(p => transform(p, crs, refRaster.crs)).map(([x, y]) => {
    const px = worldToPixel(refRaster, x, y); return [px.col, px.row]
  })
  if (ortho.crs && ortho.crs !== 'local') {
    await ensureProjection(ortho.crs)
    const x1 = ortho.originX + ortho.width * ortho.gsd, y1 = ortho.originY - ortho.height * ortho.gsd
    const pts = [[ortho.originX, ortho.originY], [x1, ortho.originY], [x1, y1], [ortho.originX, y1]]
    return { region: searchRegion(toPixels(pts, ortho.crs), refRaster.width, refRaster.height), source: 'the georeferenced orthophoto' }
  }
  const outline = gpsSearchOutline(images.images.filter(im => cloud.cameras.get(im.uuid)).map(im => [Number(im.meta?.gpsLon), Number(im.meta?.gpsLat)]))
  if (outline) return { region: searchRegion(toPixels(outline, 'EPSG:4326'), refRaster.width, refRaster.height), source: "the photos' GPS positions" }
  return { region: null, source: null }
}

async function find() {
  const token = ++generation, ortho = recon.ortho, cloud = recon.mainSparseCloud, refRaster = reference.value
  busy.value = true; error.value = ''; message.value = ''; candidates.value = []; dropTileUrls()
  try {
    const file = await external.originalFile(refRaster.id)
    if (!file) throw new Error('The original reference raster is unavailable — re-import it')
    await Promise.all([ensureProjection(refRaster.crs), ensureProjection(projects.currentCrs)])
    const area = await searchArea(ortho, cloud, refRaster)
    if (token !== generation) return
    const result = await findReferenceMatches({
      local: { cog: ortho.cog ?? null, previewUrl: ortho.previewUrl, width: ortho.width, height: ortho.height },
      reference: { file, width: refRaster.width, height: refRaster.height, band: band.value - 1, region: area.region },
    }, { onLog: (m, level, ctx) => log(m, level, ctx) })
    if (token !== generation) return
    const frameModel = makeFrameModelResolver({ summary: recon.summary, sensors: sensors.sensors })
    const sourceImages = images.images.flatMap(image => {
      const camera = cloud.cameras.get(image.uuid)
      if (!camera) return []
      const { dist, selfCal, fiducial, filmMissing } = frameModel(image)
      if (filmMissing) return []
      return [{ uuid: image.uuid, name: image.name, toScan: makePinholeToMark({ K: camera.K, dist, selfCal, fiducial }) }] // candidates become marks
    })
    const toProject = (p) => transform(p, refRaster.crs, projects.currentCrs)
    const found = referenceGcpCandidates({ points: cloud.points, images: sourceImages, ortho, reference: refRaster, ...result })
    const geographic = isGeographic(projects.currentCrs), declared = metresToCrsUnits(refRaster.horizontalAccuracy, projects.currentCrs)
    candidates.value = found.map(c => {
      // Position and planimetric σ from the reference pixel, widened by the match's
      // own residual (core/sfm/referenceGcps.js referencePick).
      const { x, y, sigma } = referencePick(refRaster, ...c.reference, { toProject, geographic, declared, displayFactor: c.residualRefPx })
      const round = v => v == null ? null : Number(v.toPrecision(3))
      return { ...c, x, y, selected: false, role: 'control', z: null, accuracyX: round(sigma), accuracyY: round(sigma), accuracyZ: null, verticalDatum: 'unknown' }
    })
    const tiles = result.tiles.map(t => t.localImage ? {
      local: { ...t.localImage, url: URL.createObjectURL(t.localImage.blob) },
      reference: { ...t.referenceImage, url: URL.createObjectURL(t.referenceImage.blob) } } : null)
    tileUrls = tiles.flatMap(t => t ? [t.local.url, t.reference.url] : [])
    activeIndex.value = 0
    preview.value = { localUrl: ortho.previewUrl, localWidth: ortho.width, localHeight: ortho.height, reference: result.referencePreview, tiles, kl: result.kl, kr: result.kr }
    const cover = candidateCoverage(candidates.value, ortho.width, ortho.height)
    message.value = `${result.matches.length} verified matches`
      + (result.refined ? ` in ${result.tiles.length} fine tiles (single-plane p95 ${result.fine.p95.toFixed(2)} working px)` : ` (coarse alignment only${ortho.cog ? ': no fine tile aligned' : ''})`)
      + `; ${candidates.value.length} candidates with measured photo tracks, covering ${cover.cells} of ${cover.of} cells of the block (hull ${(100 * cover.hull).toFixed(0)} %).`
      + (area.source ? ` Searched around ${area.source}.` : '')
    if (!candidates.value.length) message.value += ' No nearby sparse tracks were suitable; try another reference band or mark control manually.'
    else if (cover.cells < 4) message.value += ' The candidates are bunched: control there fits that area only.'
  } catch (err) { if (token === generation) error.value = err.message }
  finally { if (token === generation) busy.value = false }
}
function selectConfident() { for (const c of candidates.value) c.selected = c.confidence >= 0.5 }
async function fillHeights() {
  const token = generation
  busy.value = true; error.value = ''
  let filled = 0
  try {
    for (const c of reviewed.value) {
      const hit = await external.sampleReferenceDem(c.x, c.y, { rasterId: demId.value })
      if (token !== generation) return
      if (!hit || !(hit.accuracy > 0)) continue
      c.z = hit.z; c.accuracyZ = hit.accuracy; c.verticalDatum = hit.datum
      filled++
    }
    message.value = `Filled ${filled} heights. Points outside the DEM, on nodata, or without declared DEM accuracy were left unchanged.`
  } catch (err) { if (token === generation) error.value = err.message }
  finally { if (token === generation) busy.value = false }
}
async function add() {
  const token = generation, selected = reviewed.value.slice(), crs = projects.currentCrs
  const prefix = `Auto-${reference.value.id}-${recon.mainSparseCloud.createdAt}`
  busy.value = true; error.value = ''
  try {
    // One call: one log line and one save for the batch, each row carrying its
    // own datum, and the CSV dialog's remembered settings left alone.
    const count = await gcps.addGcps(selected.map(c => ({ ...c, name: `${prefix}-${c.pointIndex}`,
      z: c.z === '' ? null : c.z })), crs, {}, { rememberDefaults: false })
    if (token !== generation) return
    message.value = `Added ${count} reviewed points. Checkpoints are excluded from fitting; incomplete control points still need elevation and accuracy before use.`
    candidates.value = []; preview.value = null; dropTileUrls()
  } catch (err) { if (token === generation) error.value = err.message }
  finally { if (token === generation) busy.value = false }
}
// Close-ups in native pixels, 32 working px either side; from the candidate's own
// fine tile when it has one (full detail), else from the overview images.
function closeup(point, k) { const h = 32 * k; return `${point[0] - h} ${point[1] - h} ${2 * h} ${2 * h}` }
function closeupImage(side) {
  const tile = preview.value.tiles[active.value.tile]
  if (tile) return tile[side]
  return side === 'local' ? { url: preview.value.localUrl, x: 0, y: 0, width: preview.value.localWidth, height: preview.value.localHeight } : preview.value.reference
}
const overviewBox = (p) => `${p.x} ${p.y} ${p.width} ${p.height}`
const markR = (p) => Math.max(p.width, p.height) / 120
const localBox = () => ({ width: preview.value.localWidth, height: preview.value.localHeight })
// Native pixels per working pixel on each side of the close-ups.
const k = (side) => side === 'local' ? preview.value.kl : preview.value.kr
</script>

<template>
  <ModalShell title="Find GCPs" @close="emit('close')">
    <p>Match the current orthophoto to a georeferenced reference band, coarse to fine: SIFT on the whole of both, then tiles at the coarser of the two resolutions, each with its own robust alignment. Review candidates below; only selected rows are added.</p>
    <label>Reference orthophoto <select v-model="selectedReferenceId" :disabled="busy">
      <option value="" disabled>Select a reference</option><option v-for="r in referenceOrthos" :key="r.id" :value="r.id">{{ r.name }}</option>
    </select></label>
    <label>Reference band <input v-model.number="band" type="number" min="1" :max="reference?.bands || 1" :disabled="busy" /></label>
    <WarnBox v-if="!ready">Build a current orthophoto and import a reference raster with a resolved CRS first.</WarnBox>
    <WarnBox>Reference locations are estimated near verified matches, using sparse tracks observed in at least two photos. Historical changes and relief can produce false matches. Planimetric σ is prefilled from the reference pixel size; elevation is unknown until you fill or enter it. These candidates do not constrain the solution until you add them.</WarnBox>
    <p v-if="busy" role="status">Processing reference matches… Closing this dialog discards pending results.</p>
    <p v-if="error" role="alert">{{ error }}</p><p v-if="message" role="status">{{ message }}</p>
    <div v-if="preview && candidates.length" class="previews">
      <figure><figcaption>Project orthophoto</figcaption><svg :viewBox="`0 0 ${preview.localWidth} ${preview.localHeight}`">
        <image :href="preview.localUrl" :width="preview.localWidth" :height="preview.localHeight" preserveAspectRatio="none" />
        <g v-for="(c, i) in candidates" :key="i" :transform="`translate(${c.local[0]},${c.local[1]})`"><circle :r="markR(localBox())" fill="none" stroke="yellow" :stroke-width="markR(localBox()) / 3" /><text :x="markR(localBox()) * 1.3" fill="yellow" :font-size="markR(localBox()) * 3">{{ i + 1 }}</text></g>
      </svg></figure>
      <figure><figcaption>Reference band</figcaption><svg :viewBox="overviewBox(preview.reference)">
        <image :href="preview.reference.url" v-bind="{ x: preview.reference.x, y: preview.reference.y, width: preview.reference.width, height: preview.reference.height }" preserveAspectRatio="none" />
        <g v-for="(c, i) in candidates" :key="i" :transform="`translate(${c.reference[0]},${c.reference[1]})`"><circle :r="markR(preview.reference)" fill="none" stroke="yellow" :stroke-width="markR(preview.reference) / 3" /><text :x="markR(preview.reference) * 1.3" fill="yellow" :font-size="markR(preview.reference) * 3">{{ i + 1 }}</text></g>
      </svg></figure>
    </div>
    <fieldset v-if="active && preview" :disabled="busy">
      <legend>Review candidate {{ activeIndex + 1 }} · coordinates in {{ projects.currentCrs }} · confidence {{ (100 * active.confidence).toFixed(0) }} %</legend>
      <div class="previews">
        <figure v-for="side in ['local', 'reference']" :key="side"><figcaption>{{ side === 'local' ? 'Project close-up' : 'Reference close-up' }}</figcaption>
          <svg :viewBox="closeup(active[side], k(side))" aria-label="Candidate close-up">
            <image :href="closeupImage(side).url" v-bind="{ x: closeupImage(side).x, y: closeupImage(side).y, width: closeupImage(side).width, height: closeupImage(side).height }" preserveAspectRatio="none" />
            <path :d="`M${active[side][0] - 5 * k(side)},${active[side][1]}h${10 * k(side)} M${active[side][0]},${active[side][1] - 5 * k(side)}v${10 * k(side)}`" stroke="yellow" :stroke-width="0.5 * k(side)" />
          </svg>
        </figure>
      </div>
      <div v-if="photoPreviews.length" class="previews">
        <figure v-for="photo in photoPreviews" :key="photo.imageName"><figcaption>{{ photo.imageName }} · measured photo mark</figcaption>
          <svg :viewBox="closeup([photo.px, photo.py], 1)"><image :href="photo.url" :width="photo.width" :height="photo.height" />
            <circle :cx="photo.px" :cy="photo.py" r="2" stroke="yellow" stroke-width="0.5" fill="none" />
          </svg>
        </figure>
      </div>
      <label><GlossaryTerm id="ground-control-point">Role</GlossaryTerm> <select v-model="active.role"><option value="control">Control point</option><option value="check">Checkpoint (excluded from fit)</option></select></label>
      <label>Elevation <input v-model.number="active.z" type="number" step="any" placeholder="Unknown" /></label>
      <label v-for="axis in ['X', 'Y', 'Z']" :key="axis">σ {{ axis }} (project units, 1σ) <input v-model.number="active['accuracy' + axis]" type="number" min="0" step="any" placeholder="Unknown" /></label>
      <label>Vertical datum <input v-model="active.verticalDatum" /></label>
    </fieldset>
    <div v-if="candidates.length">
      <button :disabled="busy" @click="selectConfident">Select confidence ≥ 50 %</button>
      <label>Reference DEM <select v-model="demId" :disabled="busy"><option value="">Choose DEM</option><option v-for="r in dems" :key="r.id" :value="r.id">{{ r.name }}</option></select></label>
      <button :disabled="busy || !demId || !reviewed.length" @click="fillHeights">Fill selected heights</button>
    </div>
    <table v-if="candidates.length"><thead><tr><th>Accept</th><th>Review</th><th>X</th><th>Y</th><th>σ XY</th><th>Photos</th><th>Confidence</th><th>Residual (working px)</th></tr></thead>
      <tbody><tr v-for="(c, i) in candidates" :key="i"><td><label><input v-model="c.selected" type="checkbox" :disabled="busy" /> {{ i + 1 }}</label></td><td><button :disabled="busy" @click="activeIndex = i">Review {{ i + 1 }}</button> {{ c.role }}{{ c.z == null ? ' · no Z' : '' }}</td><td>{{ c.x.toFixed(3) }}</td><td>{{ c.y.toFixed(3) }}</td><td>{{ c.accuracyX ?? '—' }}</td><td>{{ c.observations.length }}</td><td>{{ (100 * c.confidence).toFixed(0) }} %</td><td>{{ c.residual.toFixed(2) }}</td></tr></tbody>
    </table>
    <p v-if="invalid" role="alert">Enter a finite elevation and positive accuracies, or leave unknown values blank.</p>
    <template #footer><button class="btn" @click="emit('close')">Close</button>
      <button class="btn" :disabled="!ready || busy || !Number.isInteger(band) || band < 1 || band > (reference?.bands || 1)" @click="find">Find candidates</button>
      <button class="btn btn-primary" :disabled="busy || !reviewed.length || invalid" @click="add">Add {{ reviewed.length }} reviewed candidates</button>
    </template>
  </ModalShell>
</template>
<style scoped src="../ui/modal.css"></style>
<style scoped>
.previews { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
figure { margin: 0; min-width: 0; } figure svg { width: 100%; max-height: 300px; background: #111; }
table { width: 100%; font-size: 12px; } td, th { text-align: left; padding: 4px; }
</style>
