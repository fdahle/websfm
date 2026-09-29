<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import WarnBox from './ui/WarnBox.vue'
import { useExternalStore } from '../../stores/useExternalStore.js'
import { useReconstructionStore } from '../../stores/useReconstructionStore.js'
import { useImagesStore } from '../../stores/useImagesStore.js'
import { useSensorsStore } from '../../stores/useSensorsStore.js'
import { useGcpsStore } from '../../stores/useGcpsStore.js'
import { useProjectsStore } from '../../stores/useProjectsStore.js'
import { findReferenceMatches } from '../../workers/computeClient.js'
import { referenceGcpCandidates } from '../../core/sfm/referenceGcps.js'
import { makeCanonicalToScan } from '../../core/sfm/displayFrame.js'
import { ensureProjection, transform } from '../../core/crs.js'
import { distortionOf } from '../../core/sfm/distortion.js'

const props = defineProps({ hasRelativeOrtho: Boolean, referenceOrthos: { type: Array, default: () => [] } })
const emit = defineEmits(['close'])
const external = useExternalStore(), recon = useReconstructionStore(), images = useImagesStore()
const sensors = useSensorsStore(), gcps = useGcpsStore(), projects = useProjectsStore()
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
let generation = 0
function reset() { generation++; candidates.value = []; preview.value = null; error.value = ''; message.value = ''; busy.value = false }
watch([selectedReferenceId, band, () => recon.ortho, () => recon.mainSparseCloud, () => projects.currentProjectId], reset)
onBeforeUnmount(() => { generation++ })
async function find() {
  const token = ++generation, ortho = recon.ortho, cloud = recon.mainSparseCloud, refRaster = reference.value
  busy.value = true; error.value = ''; message.value = ''; candidates.value = []
  try {
    const raw = await external.readRasterWindow(refRaster.id, { maxDim: 1536, bands: [band.value - 1] })
    if (token !== generation) return
    const result = await findReferenceMatches(ortho.previewDataUrl, raw)
    if (token !== generation) return
    const sourceImages = images.images.flatMap(image => {
      const camera = cloud.cameras.get(image.uuid)
      if (!camera) return []
      const sensor = sensors.sensors.find(s => s.id === image.sensorId)
      const fiducial = recon.summary?.fiducialTransforms?.find(f => f.uuid === image.uuid)
      if (sensor?.kind === 'film' && !fiducial) return []
      const selfCal = recon.summary?.selfCalDistortion?.find(s => s.sensorId === image.sensorId)
      return [{ uuid: image.uuid, name: image.name, toScan: makeCanonicalToScan({ K: camera.K,
        dist: sensor ? distortionOf(sensor) : null, selfCal, fiducial }) }]
    })
    await Promise.all([ensureProjection(refRaster.crs), ensureProjection(projects.currentCrs)])
    if (token !== generation) return
    candidates.value = referenceGcpCandidates({ points: cloud.points, images: sourceImages, ortho,
      reference: refRaster, ...result, referenceLayout: raw }).map(c => {
      const [x, y] = transform([c.x, c.y], refRaster.crs, projects.currentCrs)
      return { ...c, x, y, selected: false, role: 'control', z: null, accuracyX: null, accuracyY: null, accuracyZ: null, verticalDatum: 'unknown' }
    })
    activeIndex.value = 0
    preview.value = { ...result, referenceWidth: raw.width, referenceHeight: raw.height, localUrl: ortho.previewDataUrl }
    message.value = `${result.inliers} verified matches; ${candidates.value.length} candidates with measured photo tracks. Alignment p95: ${result.p95.toFixed(2)} reference working pixels.`
    if (!candidates.value.length) message.value += ' No nearby sparse tracks were suitable; try another reference band or mark control manually.'
  } catch (err) { if (token === generation) error.value = err.message }
  finally { if (token === generation) busy.value = false }
}
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
    let count = 0
    for (const c of selected) {
      if (token !== generation) return
      count += await gcps.addGcps([{ ...c, name: `${prefix}-${c.pointIndex}`,
        z: c.z === '' ? null : c.z }], crs, {}, { verticalDatum: c.verticalDatum })
    }
    if (token !== generation) return
    message.value = `Added ${count} reviewed points. Checkpoints are excluded from fitting; incomplete control points still need elevation and accuracy before use.`
    candidates.value = []; preview.value = null
  } catch (err) { if (token === generation) error.value = err.message }
  finally { if (token === generation) busy.value = false }
}
function closeup(point) { return `${point[0] - 32} ${point[1] - 32} 64 64` }
</script>

<template>
  <ModalShell title="Find GCPs" @close="emit('close')">
    <p>Match the current orthophoto to a georeferenced reference band using SIFT and robust planar alignment. Review candidates below; only selected rows are added.</p>
    <label>Reference orthophoto <select v-model="selectedReferenceId" :disabled="busy">
      <option value="" disabled>Select a reference</option><option v-for="r in referenceOrthos" :key="r.id" :value="r.id">{{ r.name }}</option>
    </select></label>
    <label>Reference band <input v-model.number="band" type="number" min="1" :max="reference?.bands || 1" :disabled="busy" /></label>
    <WarnBox v-if="!ready">Build a current orthophoto and import a reference raster with a resolved CRS first.</WarnBox>
    <WarnBox>Reference locations are estimated near verified matches, using sparse tracks observed in at least two photos. Historical changes and relief can produce false matches. Elevation and accuracy are unknown until you review them; these candidates do not yet constrain the solution.</WarnBox>
    <p v-if="busy" role="status">Processing reference matches… Closing this dialog discards pending results.</p>
    <p v-if="error" role="alert">{{ error }}</p><p v-if="message" role="status">{{ message }}</p>
    <div v-if="preview && candidates.length" class="previews">
      <figure><figcaption>Project orthophoto</figcaption><svg :viewBox="`0 0 ${preview.localWidth} ${preview.localHeight}`">
        <image :href="preview.localUrl" :width="preview.localWidth" :height="preview.localHeight" />
        <g v-for="(c, i) in candidates" :key="i" :transform="`translate(${c.local[0]},${c.local[1]})`"><circle r="7" fill="none" stroke="yellow" stroke-width="2" /><text x="9" fill="yellow" font-size="24">{{ i + 1 }}</text></g>
      </svg></figure>
      <figure><figcaption>Reference band</figcaption><svg :viewBox="`0 0 ${preview.referenceWidth} ${preview.referenceHeight}`">
        <image :href="preview.referencePreview" :width="preview.referenceWidth" :height="preview.referenceHeight" />
        <g v-for="(c, i) in candidates" :key="i" :transform="`translate(${c.reference[0]},${c.reference[1]})`"><circle r="7" fill="none" stroke="yellow" stroke-width="2" /><text x="9" fill="yellow" font-size="24">{{ i + 1 }}</text></g>
      </svg></figure>
    </div>
    <fieldset v-if="active && preview" :disabled="busy">
      <legend>Review candidate {{ activeIndex + 1 }} · coordinates in {{ projects.currentCrs }}</legend>
      <div class="previews">
        <figure v-for="side in ['local', 'reference']" :key="side"><figcaption>{{ side === 'local' ? 'Project close-up' : 'Reference close-up' }}</figcaption>
          <svg :viewBox="closeup(active[side])" aria-label="Candidate close-up">
            <image :href="side === 'local' ? preview.localUrl : preview.referencePreview" :width="side === 'local' ? preview.localWidth : preview.referenceWidth" :height="side === 'local' ? preview.localHeight : preview.referenceHeight" />
            <path :d="`M${active[side][0]-5},${active[side][1]}h10 M${active[side][0]},${active[side][1]-5}v10`" stroke="yellow" stroke-width="0.5" />
          </svg>
        </figure>
      </div>
      <div v-if="photoPreviews.length" class="previews">
        <figure v-for="photo in photoPreviews" :key="photo.imageName"><figcaption>{{ photo.imageName }} · measured photo mark</figcaption>
          <svg :viewBox="closeup([photo.px, photo.py])"><image :href="photo.url" :width="photo.width" :height="photo.height" />
            <circle :cx="photo.px" :cy="photo.py" r="2" stroke="yellow" stroke-width="0.5" fill="none" />
          </svg>
        </figure>
      </div>
      <label>Role <select v-model="active.role"><option value="control">Control point</option><option value="check">Checkpoint (excluded from fit)</option></select></label>
      <label>Elevation <input v-model.number="active.z" type="number" step="any" placeholder="Unknown" /></label>
      <label v-for="axis in ['X', 'Y', 'Z']" :key="axis">σ {{ axis }} (project units, 1σ) <input v-model.number="active['accuracy' + axis]" type="number" min="0" step="any" placeholder="Unknown" /></label>
      <label>Vertical datum <input v-model="active.verticalDatum" /></label>
    </fieldset>
    <div v-if="candidates.length">
      <label>Reference DEM <select v-model="demId" :disabled="busy"><option value="">Choose DEM</option><option v-for="r in dems" :key="r.id" :value="r.id">{{ r.name }}</option></select></label>
      <button :disabled="busy || !demId || !reviewed.length" @click="fillHeights">Fill selected heights</button>
    </div>
    <table v-if="candidates.length"><thead><tr><th>Accept</th><th>Review</th><th>X</th><th>Y</th><th>Photo observations</th><th>Offset (working px)</th></tr></thead>
      <tbody><tr v-for="(c, i) in candidates" :key="i"><td><label><input v-model="c.selected" type="checkbox" :disabled="busy" /> {{ i + 1 }}</label></td><td><button :disabled="busy" @click="activeIndex = i">Review {{ i + 1 }}</button> {{ c.role }}{{ c.z == null ? ' · no Z' : '' }}</td><td>{{ c.x.toFixed(3) }}</td><td>{{ c.y.toFixed(3) }}</td><td>{{ c.observations.length }}</td><td>{{ c.offsetPx.toFixed(2) }}</td></tr></tbody>
    </table>
    <p v-if="invalid" role="alert">Enter a finite elevation and positive accuracies, or leave unknown values blank.</p>
    <template #footer><button class="btn" @click="emit('close')">Close</button>
      <button class="btn" :disabled="!ready || busy || !Number.isInteger(band) || band < 1 || band > (reference?.bands || 1)" @click="find">Find candidates</button>
      <button class="btn btn-primary" :disabled="busy || !reviewed.length || invalid" @click="add">Add {{ reviewed.length }} reviewed candidates</button>
    </template>
  </ModalShell>
</template>
<style scoped src="./ui/modal.css"></style>
<style scoped>
.previews { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
figure { margin: 0; min-width: 0; } figure svg { width: 100%; max-height: 300px; background: #111; }
table { width: 100%; font-size: 12px; } td, th { text-align: left; padding: 4px; }
</style>
