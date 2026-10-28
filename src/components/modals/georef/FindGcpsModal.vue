<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import WarnBox from '../ui/WarnBox.vue'
import SettingsField from '../ui/SettingsField.vue'
import SettingsGroup from '../ui/SettingsGroup.vue'
import SettingsStep from '../ui/SettingsStep.vue'
import SegmentedControl from '../ui/SegmentedControl.vue'
import StatTiles from '../ui/StatTiles.vue'
import DataTable from '../ui/DataTable.vue'
import Sentinel2Modal from './Sentinel2Modal.vue'
import { useExternalStore } from '../../../stores/useExternalStore.js'
import { useReconstructionStore } from '../../../stores/useReconstructionStore.js'
import { useImagesStore } from '../../../stores/useImagesStore.js'
import { useGcpsStore } from '../../../stores/useGcpsStore.js'
import { useProjectsStore } from '../../../stores/useProjectsStore.js'
import { useLog } from '../../../composables/useLog.js'
import FieldHelp from '../../guide/FieldHelp.vue'
import { candidateCoverage } from '../../../core/sfm/referenceGcps.js'
import { findGcpCandidates, searchAreaPlan, stableAreaLayers } from '../../../composables/useFindGcps.js'
import { FIND_GCPS_DEFAULTS } from '../../../core/defaults.user.js'
import { findGcpsEffects } from '../../../core/stepEffects/findGcps.js'
import { checkNumberFields } from '../../../utils/numberFields.js'
import { isGeographic, linearCrsUnit } from '../../../core/crs.js'

// Reconstruct ▸ Find GCPs: match the orthophoto to a georeferenced reference (or fit
// the sparse cloud to a reference DEM), propose sparse tracks near the matches as
// control, and review them before they are added (composables/useFindGcps.js).

const props = defineProps({ hasRelativeOrtho: Boolean, referenceOrthos: { type: Array, default: () => [] } })
// compute-footprints: open Compute footprints over this dialog (PipelineModals).
const emit = defineEmits(['close', 'compute-footprints'])
const external = useExternalStore(),
  recon = useReconstructionStore(),
  images = useImagesStore()
const gcps = useGcpsStore(),
  projects = useProjectsStore()
const { log } = useLog()
const selectedReferenceId = ref(props.referenceOrthos[0]?.id ?? ''),
  band = ref(1),
  matcher = ref(FIND_GCPS_DEFAULTS.matcher),
  candidateLimit = ref(FIND_GCPS_DEFAULTS.candidates),
  stableSetId = ref(''),
  searchSetId = ref('')
const stableLayers = computed(() => stableAreaLayers())
const s2Open = ref(false)
// Where the reference will be searched, and what is known about where the photos are.
const plan = computed(() => searchAreaPlan(searchSetId.value || null))
const reference = computed(() => external.rasterById(selectedReferenceId.value))
// A reference with three or more bands is read as their mean (RGB → gray), as film is.
const bandCount = computed(() => reference.value?.bands || 1)
watch(
  selectedReferenceId,
  () => {
    band.value = bandCount.value >= 3 ? 'rgb' : 1
  },
  { immediate: true },
)
const bandValid = computed(
  () => (band.value === 'rgb' && bandCount.value >= 3) || (band.value >= 1 && band.value <= bandCount.value),
)
const ready = computed(
  () =>
    props.hasRelativeOrtho &&
    (matcher.value === 'terrain' || (reference.value?.crs && !reference.value.crsUnresolved)) &&
    recon.mainSparseCloud &&
    !recon.productFrameStatus(recon.ortho).stale,
)
// Why Find candidates is unavailable, in the order the user has to fix it.
const notReady = computed(() => {
  if (ready.value) return ''
  if (!props.hasRelativeOrtho) return 'Build an orthophoto first: Find GCPs matches it to the reference.'
  if (!recon.mainSparseCloud) return 'Find GCPs needs a sparse model.'
  if (recon.productFrameStatus(recon.ortho).stale) return 'The orthophoto is out of date with the model: rebuild it.'
  return 'Choose a reference orthophoto with a resolved CRS: import one, or fetch Sentinel-2.'
})
const busy = ref(false),
  error = ref(''),
  message = ref(''),
  summary = ref(null),
  candidates = ref([]),
  preview = ref(null)
const activeIndex = ref(0),
  demId = ref('')
const active = computed(() => candidates.value[activeIndex.value])
const dems = computed(() => external.rasters.filter((r) => r.kind === 'dem' && !r.crsUnresolved))
const photoPreviews = computed(() =>
  (active.value?.observations || []).flatMap((obs) => {
    const im = images.images.find((im) => im.name === obs.imageName)
    const width = im?.meta?.width,
      height = im?.meta?.height
    return im?.url && width && height ? [{ ...obs, url: im.url, width, height }] : []
  }),
)
const reviewed = computed(() => candidates.value.filter((c) => c.selected))
const invalid = computed(() =>
  reviewed.value.some(
    (c) =>
      (c.z != null && c.z !== '' && !Number.isFinite(c.z)) ||
      ['accuracyX', 'accuracyY', 'accuracyZ'].some(
        (k) => c[k] != null && c[k] !== '' && !(Number.isFinite(c[k]) && c[k] > 0),
      ),
  ),
)
let generation = 0,
  tileUrls = []
function dropTileUrls() {
  for (const u of tileUrls) URL.revokeObjectURL(u)
  tileUrls = []
}
function reset() {
  generation++
  candidates.value = []
  preview.value = null
  error.value = ''
  message.value = ''
  summary.value = null
  busy.value = false
  dropTileUrls()
}
// Candidates hold project-CRS coordinates from find time, so a CRS change invalidates them.
watch(
  [
    selectedReferenceId,
    band,
    matcher,
    candidateLimit,
    stableSetId,
    searchSetId,
    () => recon.ortho,
    () => recon.mainSparseCloud,
    () => projects.currentProjectId,
    () => projects.currentCrs,
  ],
  reset,
)
onBeforeUnmount(() => {
  generation++
  dropTileUrls()
})

async function find() {
  const token = ++generation
  busy.value = true
  error.value = ''
  message.value = ''
  summary.value = null
  candidates.value = []
  dropTileUrls()
  try {
    const {
      candidates: found,
      result,
      area,
      stable,
    } = await findGcpCandidates({
      referenceId: selectedReferenceId.value,
      band: band.value,
      matcher: matcher.value,
      demId: demId.value || null,
      stableSetId: stableSetId.value || null,
      searchSetId: searchSetId.value || null,
      limit: candidateLimit.value,
      onLog: (m, level, ctx) => log(m, level, ctx),
    })
    if (token !== generation) return
    const ortho = recon.ortho
    candidates.value = found
    const tiles = result.tiles.map((t) =>
      t.localImage
        ? {
            local: { ...t.localImage, url: URL.createObjectURL(t.localImage.blob) },
            reference: { ...t.referenceImage, url: URL.createObjectURL(t.referenceImage.blob) },
          }
        : null,
    )
    tileUrls = tiles.flatMap((t) => (t ? [t.local.url, t.reference.url] : []))
    activeIndex.value = 0
    preview.value = {
      localUrl: ortho.previewUrl,
      localWidth: ortho.width,
      localHeight: ortho.height,
      reference: result.referencePreview,
      tiles,
      kl: result.kl,
      kr: result.kr,
    }
    const cover = candidateCoverage(candidates.value, ortho.width, ortho.height)
    const pct = (f) => (100 * f).toFixed(0)
    const stats = result.terrain
      ? [
          { label: 'ICP RMS', value: result.terrain.rms.toFixed(1), unit: 'm' },
          { label: 'Sparse points in range', value: pct(result.terrain.inlierFraction), unit: '%' },
        ]
      : [
          { label: 'Verified matches', value: result.matches.length.toLocaleString('en-US') },
          result.refined
            ? { label: 'Fine tiles', value: result.tiles.length, hint: `p95 ${result.fine.p95.toFixed(2)} working px` }
            : { label: 'Fine tiles', value: '—', hint: 'coarse alignment only', tone: 'warn' },
        ]
    stats.push(
      { label: 'Candidates', value: candidates.value.length, tone: candidates.value.length ? undefined : 'bad' },
      {
        label: 'Block covered',
        value: `${cover.cells}/${cover.of}`,
        unit: 'cells',
        hint: `hull ${pct(cover.hull)} %`,
        tone: cover.cells < 4 ? 'warn' : undefined,
      },
    )
    const notes = []
    if (area.source) notes.push(`Searched around ${area.source}.`)
    if (!result.terrain && !result.refined && ortho.cog) notes.push('No fine tile aligned.')
    if (stable) notes.push(`${stable.rejected} matches off the stable ground of "${stable.name}" left out.`)
    if (!candidates.value.length)
      notes.push('No nearby sparse tracks were suitable; try another reference band or mark control manually.')
    else if (cover.cells < 4) notes.push('The candidates are bunched: control there fits that area only.')
    summary.value = { tiles: stats, notes }
  } catch (err) {
    if (token === generation) error.value = err.message
  } finally {
    if (token === generation) busy.value = false
  }
}
function selectConfident() {
  for (const c of candidates.value) c.selected = c.confidence >= 0.5
}
function selectNone() {
  for (const c of candidates.value) c.selected = false
}
function step(d) {
  const n = candidates.value.length
  if (n) activeIndex.value = (activeIndex.value + d + n) % n
}
async function fillHeights() {
  const token = generation
  busy.value = true
  error.value = ''
  let filled = 0
  try {
    for (const c of reviewed.value) {
      const hit = await external.sampleReferenceDem(c.x, c.y, { rasterId: demId.value })
      if (token !== generation) return
      if (!hit || !(hit.accuracy > 0)) continue
      c.z = hit.z
      c.accuracyZ = hit.accuracy
      c.verticalDatum = hit.datum
      filled++
    }
    message.value = `Filled ${filled} ${filled === 1 ? 'height' : 'heights'}. Points outside the DEM, on nodata, or without declared DEM accuracy were left unchanged.`
  } catch (err) {
    if (token === generation) error.value = err.message
  } finally {
    if (token === generation) busy.value = false
  }
}
async function add() {
  const token = generation,
    selected = reviewed.value.slice(),
    crs = projects.currentCrs
  const prefix = `Auto-${reference.value.id}-${recon.mainSparseCloud.createdAt}`
  busy.value = true
  error.value = ''
  try {
    // One call: one log line and one save for the batch, each row carrying its
    // own datum, and the CSV dialog's remembered settings left alone.
    const count = await gcps.addGcps(
      selected.map((c) => ({ ...c, name: `${prefix}-${c.pointIndex}`, z: c.z === '' ? null : c.z })),
      crs,
      {},
      { rememberDefaults: false },
    )
    if (token !== generation) return
    message.value = `Added ${count} ${count === 1 ? 'point' : 'points'}. Checkpoints are excluded from fitting; incomplete control points still need elevation and accuracy before use.`
    candidates.value = []
    preview.value = null
    summary.value = null
    dropTileUrls()
  } catch (err) {
    if (token === generation) error.value = err.message
  } finally {
    if (token === generation) busy.value = false
  }
}
// Close-ups in native pixels, 32 working px either side; from the candidate's own
// fine tile when it has one (full detail), else from the overview images.
function closeup(point, k) {
  const h = 32 * k
  return `${point[0] - h} ${point[1] - h} ${2 * h} ${2 * h}`
}
function closeupImage(side) {
  const tile = preview.value.tiles[active.value.tile]
  if (tile) return tile[side]
  return side === 'local'
    ? { url: preview.value.localUrl, x: 0, y: 0, width: preview.value.localWidth, height: preview.value.localHeight }
    : preview.value.reference
}
const overviewBox = (p) => `${p.x} ${p.y} ${p.width} ${p.height}`
const markR = (p) => Math.max(p.width, p.height) / 120
const localBox = () => ({ width: preview.value.localWidth, height: preview.value.localHeight })
// Native pixels per working pixel on each side of the close-ups.
const k = (side) => (side === 'local' ? preview.value.kl : preview.value.kr)
const numbers = computed(() =>
  checkNumberFields(
    { candidateLimit: candidateLimit.value },
    {
      candidateLimit: { label: 'Candidates', min: 4, max: 300, integer: true },
    },
  ),
)
const canFind = computed(
  () =>
    ready.value &&
    !busy.value &&
    numbers.value.valid &&
    (matcher.value === 'terrain' ? !!demId.value : bandValid.value),
)
const hasZ = (c) => c.z != null && c.z !== ''
// What each step does (core/stepEffects/findGcps.js).
const effects = computed(() => {
  const stable = stableLayers.value.find((s) => s.id === stableSetId.value)
  const sel = reviewed.value
  return findGcpsEffects(
    { matcher: matcher.value, band: band.value, candidates: candidateLimit.value },
    {
      referenceName: reference.value?.name,
      bandCount: bandCount.value,
      demName: dems.value.find((r) => r.id === demId.value)?.name,
      sparsePoints: recon.mainSparseCloud?.points.length ?? 0,
      stableName: stable?.name,
      stablePolygons: stable?.footprints?.length ?? 0,
      area: {
        source: plan.value.source,
        name: plan.value.set?.name,
        polygons: plan.value.set?.footprints?.length ?? 0,
        footprintImages: plan.value.footprintImages,
        gpsImages: plan.value.gpsImages,
        poses: plan.value.poses,
      },
      found: summary.value && {
        total: candidates.value.length,
        selected: sel.length,
        control: sel.filter((c) => c.role !== 'check').length,
        check: sel.filter((c) => c.role === 'check').length,
        withoutZ: sel.filter((c) => !hasZ(c)).length,
      },
    },
  )
})
// Footprints narrow the search and give the learned matchers their rotation: offer to
// compute them when the search would otherwise rest on GPS alone, or on nothing.
const areaUnknown = computed(() => matcher.value !== 'terrain' && !plan.value.source)
const offerFootprints = computed(
  () => matcher.value !== 'terrain' && plan.value.poses > 0 && [null, 'gps'].includes(plan.value.source),
)
const ROLES = [
  { id: 'control', label: 'Control point' },
  { id: 'check', label: 'Checkpoint' },
]
const COLUMNS = [
  { key: 'selected', label: '', sortable: false },
  { key: 'n', label: '#', align: 'right' },
  { key: 'confidence', label: 'Confidence', align: 'right', format: (v) => `${(100 * v).toFixed(0)} %` },
  { key: 'residual', label: 'Residual (px)', align: 'right', format: (v) => v.toFixed(2) },
  { key: 'accuracyX', label: 'σ XY', align: 'right', format: (v) => (v == null || v === '' ? '—' : String(v)) },
  { key: 'photos', label: 'Photos', align: 'right' },
  { key: 'role', label: 'Role', format: (v) => (v === 'check' ? 'Checkpoint' : 'Control') },
  { key: 'z', label: 'Height', align: 'right', format: (v) => (v == null || v === '' ? '—' : Number(v).toFixed(2)) },
]
const rows = computed(() =>
  candidates.value.map((c, i) => ({
    id: i,
    n: i + 1,
    selected: c.selected,
    confidence: c.confidence,
    residual: c.residual,
    accuracyX: c.accuracyX,
    photos: c.observations.length,
    role: c.role,
    z: c.z,
  })),
)
const rowClass = (row) => ({ 'fg-active': row.id === activeIndex.value })
// Heights and accuracies are in the project CRS's unit (feet in a US-feet CRS).
const unit = computed(() => {
  const crs = projects.currentCrs
  return crs && crs !== 'local' && !isGeographic(crs) ? linearCrsUnit(crs) : 'project units'
})
const fmtXY = (v) => v.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 })
</script>

<template>
  <ModalShell title="Find GCPs" width="880px" @close="emit('close')">
    <p class="fg-intro">
      Match the orthophoto to a georeferenced reference, then review the sparse tracks found next to the matches. Only
      the candidates you select are added as control.
    </p>
    <WarnBox v-if="notReady">{{ notReady }}</WarnBox>

    <SettingsGroup title="Source">
      <SettingsField label="Reference orthophoto" label-for="fg-ref">
        <div class="fg-ref">
          <select id="fg-ref" v-model="selectedReferenceId" class="field-select" :disabled="busy">
            <option value="" disabled>Select a reference</option>
            <option v-for="r in referenceOrthos" :key="r.id" :value="r.id">{{ r.name }}</option>
          </select>
          <button class="btn" :disabled="busy || matcher === 'terrain'" @click="s2Open = true">Sentinel-2…</button>
        </div>
        <template #hint
          >A georeferenced raster of the same ground: an imported satellite image or older orthophoto, or a Sentinel-2
          image of the search area fetched online.</template
        >
      </SettingsField>
      <SettingsField label-for="fg-area">
        <template #label><FieldHelp op="georeferencing" param="searchArea">Search area</FieldHelp></template>
        <select id="fg-area" v-model="searchSetId" class="field-select" :disabled="busy || matcher === 'terrain'">
          <option value="">Auto</option>
          <option v-for="s in stableLayers" :key="s.id" :value="s.id">{{ s.name }}</option>
        </select>
        <template v-if="!areaUnknown" #hint
          >{{ effects.area }}
          <button
            v-if="offerFootprints"
            class="link-btn fg-footprints"
            :disabled="busy"
            @click="emit('compute-footprints')"
          >
            Compute footprints…
          </button></template
        >
      </SettingsField>
      <WarnBox v-if="areaUnknown"
        >{{ effects.area }}
        <button
          v-if="offerFootprints"
          class="link-btn fg-footprints"
          :disabled="busy"
          @click="emit('compute-footprints')"
        >
          Compute footprints…
        </button></WarnBox
      >
    </SettingsGroup>

    <SettingsStep step="1" title="Match" :effect="effects.match">
      <SettingsField label-for="fg-matcher">
        <template #label><FieldHelp op="georeferencing" param="coarseMatcher">Coarse matcher</FieldHelp></template>
        <select id="fg-matcher" v-model="matcher" class="field-select" :disabled="busy">
          <option value="auto">Auto (SuperPoint if installed, else DISK)</option>
          <option value="disk">DISK + LightGlue</option>
          <option value="superpoint">SuperPoint + LightGlue</option>
          <option value="sift">SIFT</option>
          <option value="terrain">Terrain (reference DEM, ICP)</option>
        </select>
      </SettingsField>
      <SettingsField v-if="matcher === 'terrain'" label="Reference DEM" label-for="fg-dem-fit">
        <select id="fg-dem-fit" v-model="demId" class="field-select" :disabled="busy">
          <option value="">Choose DEM</option>
          <option v-for="r in dems" :key="r.id" :value="r.id">{{ r.name }}</option>
        </select>
      </SettingsField>
      <SettingsField v-else-if="bandCount > 1" label-for="fg-band">
        <template #label><FieldHelp op="georeferencing" param="referenceBand">Reference band</FieldHelp></template>
        <select id="fg-band" v-model="band" class="field-select" :disabled="busy">
          <option v-if="bandCount >= 3" value="rgb">Mean of bands 1–3 (RGB)</option>
          <option v-for="b in bandCount" :key="b" :value="b">Band {{ b }}</option>
        </select>
      </SettingsField>
    </SettingsStep>

    <SettingsStep step="2" title="Pick candidates" :effect="effects.pick">
      <div class="fg-row">
        <SettingsField label-for="fg-n">
          <template #label
            ><FieldHelp
              op="georeferencing"
              param="candidates"
              :value="candidateLimit"
              :default-value="FIND_GCPS_DEFAULTS.candidates"
              >Candidates</FieldHelp
            ></template
          >
          <input
            id="fg-n"
            v-model.number="candidateLimit"
            :aria-invalid="numbers.bad.candidateLimit"
            class="field-input"
            type="number"
            min="4"
            max="300"
            step="1"
            :disabled="busy"
          />
        </SettingsField>
        <SettingsField label-for="fg-stable">
          <template #label><FieldHelp op="georeferencing" param="stableArea">Stable ground</FieldHelp></template>
          <select id="fg-stable" v-model="stableSetId" class="field-select" :disabled="busy">
            <option value="">Anywhere</option>
            <option v-for="s in stableLayers" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
        </SettingsField>
      </div>
    </SettingsStep>

    <SettingsStep step="3" title="Review" :effect="effects.review" :inactive="!candidates.length">
      <p v-if="busy" class="fg-status" role="status">
        <span class="fg-spinner busy-motion" aria-hidden="true"></span>Matching the reference… Closing this dialog
        discards the results.
      </p>
      <p v-if="error" class="fg-error" role="alert">{{ error }}</p>
      <template v-if="summary">
        <StatTiles :tiles="summary.tiles" />
        <p v-if="summary.notes.length" class="fg-notes">{{ summary.notes.join(' ') }}</p>
      </template>

      <div v-if="preview && candidates.length" class="fg-pair fg-overview">
        <figure>
          <figcaption>Project orthophoto</figcaption>
          <svg :viewBox="`0 0 ${preview.localWidth} ${preview.localHeight}`">
            <image
              :href="preview.localUrl"
              :width="preview.localWidth"
              :height="preview.localHeight"
              preserveAspectRatio="none"
            />
            <g
              v-for="(c, i) in candidates"
              :key="i"
              class="fg-mark"
              :class="{ selected: c.selected, active: i === activeIndex }"
              :transform="`translate(${c.local[0]},${c.local[1]})`"
              @click="activeIndex = i"
            >
              <circle :r="markR(localBox())" vector-effect="non-scaling-stroke" />
              <text :x="markR(localBox()) * 1.3" :font-size="markR(localBox()) * 3">{{ i + 1 }}</text>
            </g>
          </svg>
        </figure>
        <figure>
          <figcaption>Reference</figcaption>
          <svg :viewBox="overviewBox(preview.reference)">
            <image
              :href="preview.reference.url"
              v-bind="{
                x: preview.reference.x,
                y: preview.reference.y,
                width: preview.reference.width,
                height: preview.reference.height,
              }"
              preserveAspectRatio="none"
            />
            <g
              v-for="(c, i) in candidates"
              :key="i"
              class="fg-mark"
              :class="{ selected: c.selected, active: i === activeIndex }"
              :transform="`translate(${c.reference[0]},${c.reference[1]})`"
              @click="activeIndex = i"
            >
              <circle :r="markR(preview.reference)" vector-effect="non-scaling-stroke" />
              <text :x="markR(preview.reference) * 1.3" :font-size="markR(preview.reference) * 3">{{ i + 1 }}</text>
            </g>
          </svg>
        </figure>
      </div>

      <template v-if="candidates.length">
        <div class="fg-toolbar">
          <button class="link-btn" :disabled="busy" @click="selectConfident">Select confidence ≥ 50 %</button>
          <button class="link-btn" :disabled="busy || !reviewed.length" @click="selectNone">Select none</button>
        </div>
        <DataTable
          class="fg-table"
          :columns="COLUMNS"
          :rows="rows"
          :row-class="rowClass"
          @row-click="(row) => (activeIndex = row.id)"
        >
          <template #cell-selected="{ row }">
            <input
              v-model="candidates[row.id].selected"
              type="checkbox"
              class="checkbox"
              :aria-label="`Select candidate ${row.n}`"
              :disabled="busy"
              @click.stop
            />
          </template>
        </DataTable>
      </template>

      <section v-if="active && preview" class="fg-review" :aria-busy="busy">
        <header class="fg-review-head">
          <button class="btn fg-nav" :disabled="busy" aria-label="Previous candidate" @click="step(-1)">‹</button>
          <div class="fg-review-title">
            <strong>Candidate {{ activeIndex + 1 }}</strong>
            <span>
              {{ (100 * active.confidence).toFixed(0) }} % confidence · E {{ fmtXY(active.x) }} · N
              {{ fmtXY(active.y) }} ({{ projects.currentCrs }})</span
            >
          </div>
          <label class="checkbox-row"
            ><input v-model="active.selected" type="checkbox" class="checkbox" :disabled="busy" /> Selected</label
          >
          <button class="btn fg-nav" :disabled="busy" aria-label="Next candidate" @click="step(1)">›</button>
        </header>
        <div class="fg-pair">
          <figure v-for="side in ['local', 'reference']" :key="side">
            <figcaption>{{ side === 'local' ? 'Project close-up' : 'Reference close-up' }}</figcaption>
            <svg :viewBox="closeup(active[side], k(side))" aria-label="Candidate close-up">
              <image
                :href="closeupImage(side).url"
                v-bind="{
                  x: closeupImage(side).x,
                  y: closeupImage(side).y,
                  width: closeupImage(side).width,
                  height: closeupImage(side).height,
                }"
                preserveAspectRatio="none"
              />
              <path
                class="fg-cross"
                :d="`M${active[side][0] - 5 * k(side)},${active[side][1]}h${10 * k(side)} M${active[side][0]},${active[side][1] - 5 * k(side)}v${10 * k(side)}`"
                vector-effect="non-scaling-stroke"
              />
            </svg>
          </figure>
        </div>
        <div v-if="photoPreviews.length" class="fg-photos">
          <figure v-for="photo in photoPreviews" :key="photo.imageName">
            <svg :viewBox="closeup([photo.px, photo.py], 1)">
              <image :href="photo.url" :width="photo.width" :height="photo.height" />
              <circle class="fg-cross" :cx="photo.px" :cy="photo.py" r="2" vector-effect="non-scaling-stroke" />
            </svg>
            <figcaption :title="photo.imageName">{{ photo.imageName }}</figcaption>
          </figure>
        </div>
        <p class="field-hint">
          Accept only a candidate that shows the same stable feature in both close-ups: change since the reference and
          relief make false matches. σ XY comes from the reference's pixel size; edit it if you know better.
        </p>
        <fieldset class="fg-fields" :disabled="busy">
          <SettingsField>
            <template #label><FieldHelp op="georeferencing" param="role">Role</FieldHelp></template>
            <SegmentedControl v-model="active.role" :options="ROLES" />
          </SettingsField>
          <div class="fg-row">
            <SettingsField label="Height" label-for="fg-z" :unit="unit">
              <input
                id="fg-z"
                v-model.number="active.z"
                class="field-input"
                type="number"
                step="any"
                placeholder="Unknown"
              />
            </SettingsField>
            <SettingsField
              v-for="axis in ['X', 'Y', 'Z']"
              :key="axis"
              :label="`σ ${axis} (1σ)`"
              :label-for="`fg-s${axis}`"
              :unit="unit"
            >
              <input
                :id="`fg-s${axis}`"
                v-model.number="active['accuracy' + axis]"
                class="field-input"
                type="number"
                min="0"
                step="any"
                placeholder="Unknown"
              />
            </SettingsField>
            <SettingsField label="Vertical datum" label-for="fg-datum">
              <input id="fg-datum" v-model="active.verticalDatum" class="field-input" placeholder="Unknown" />
            </SettingsField>
          </div>
        </fieldset>
      </section>
    </SettingsStep>

    <SettingsStep step="4" title="Heights" :effect="effects.heights" :inactive="!candidates.length">
      <div v-if="candidates.length" class="fg-row fg-fill">
        <SettingsField label="Reference DEM" label-for="fg-dem">
          <select id="fg-dem" v-model="demId" class="field-select" :disabled="busy">
            <option value="">Choose DEM</option>
            <option v-for="r in dems" :key="r.id" :value="r.id">{{ r.name }}</option>
          </select>
        </SettingsField>
        <button class="btn" :disabled="busy || !demId || !reviewed.length" @click="fillHeights">
          Fill selected heights
        </button>
      </div>
    </SettingsStep>

    <p v-if="message" class="fg-message" role="status">{{ message }}</p>
    <p v-if="invalid" class="fg-error" role="alert">
      Enter a finite height and positive accuracies, or leave unknown values blank.
    </p>

    <Teleport to="body">
      <Sentinel2Modal
        v-if="s2Open"
        :search-set-id="searchSetId"
        @close="s2Open = false"
        @fetched="
          (meta) => {
            s2Open = false
            selectedReferenceId = meta.id
          }
        "
      />
    </Teleport>

    <template #footer>
      <button class="btn" @click="emit('close')">Close</button>
      <button
        class="btn"
        :class="{ 'btn-primary': !candidates.length }"
        :disabled="!canFind"
        :title="numbers.reason"
        @click="find"
      >
        {{ candidates.length ? 'Find again' : 'Find candidates' }}
      </button>
      <button
        v-if="candidates.length"
        class="btn btn-primary"
        :disabled="busy || !reviewed.length || invalid"
        @click="add"
      >
        Add {{ reviewed.length }} {{ reviewed.length === 1 ? 'candidate' : 'candidates' }}
      </button>
    </template>
  </ModalShell>
</template>
<style scoped src="../ui/modal.css"></style>
<style scoped>
.fg-intro {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--text-dim);
}
.fg-ref {
  display: flex;
  gap: 8px;
  align-items: center;
}
.fg-footprints {
  margin-left: 6px;
}
.fg-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  align-items: flex-start;
}
.fg-fill {
  align-items: flex-end;
}
.fg-status,
.fg-notes,
.fg-message {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-dim);
}
.fg-status {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text);
}
.fg-spinner {
  width: 12px;
  height: 12px;
  flex: none;
  border: 2px solid var(--panel-border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: fg-spin 0.8s linear infinite;
}
@keyframes fg-spin {
  to {
    transform: rotate(360deg);
  }
}
.fg-error {
  margin: 0;
  font-size: 12px;
  color: var(--danger);
}

/* Two images side by side: the overviews, then the close-ups. */
.fg-pair {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
figure {
  margin: 0;
  min-width: 0;
}
figcaption {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-dim);
  margin-bottom: 4px;
}
figure svg {
  display: block;
  width: 100%;
  max-height: 300px;
  background: #111;
  border: 1px solid var(--panel-border);
  border-radius: 6px;
}
/* Close-ups are square crops; the overviews keep their rasters' shape. */
.fg-pair:not(.fg-overview) figure svg {
  aspect-ratio: 1;
}
.fg-mark {
  cursor: pointer;
}
.fg-mark circle {
  fill: none;
  stroke: #ffd400;
  stroke-width: 1.5;
}
.fg-mark text {
  fill: #ffd400;
  paint-order: stroke;
  stroke: rgba(0, 0, 0, 0.7);
  stroke-width: 0.15em;
}
.fg-mark.selected circle {
  fill: rgba(255, 212, 0, 0.35);
}
.fg-mark.active circle {
  stroke: #33d6ff;
  stroke-width: 3;
}
.fg-mark.active text {
  fill: #33d6ff;
}
.fg-cross {
  fill: none;
  stroke: #ffd400;
  stroke-width: 1.5;
}

.fg-toolbar {
  display: flex;
  gap: 16px;
}
/* DataTable's root is its .dt-wrap: scroll the rows under a sticky header. */
.fg-table {
  max-height: 240px;
  overflow: auto;
  border: 1px solid var(--panel-border);
  border-radius: 6px;
}
.fg-table :deep(.dt-row) {
  cursor: pointer;
}
.fg-table :deep(.dt-row.fg-active) {
  background: color-mix(in srgb, var(--accent) 16%, transparent);
}
.fg-table :deep(.dt tbody td) {
  padding: 5px 10px;
}

/* The candidate under review. */
.fg-review {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  background: var(--hover-bg);
}
.fg-review-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.fg-review-title {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  font-size: 13px;
}
.fg-review-title span {
  font-size: 11.5px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.fg-nav {
  padding: 2px 10px;
  font-size: 16px;
  line-height: 1.2;
}
.fg-photos {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
  gap: 8px;
}
.fg-photos svg {
  aspect-ratio: 1;
}
.fg-photos figcaption {
  margin: 3px 0 0;
  font-weight: 400;
  letter-spacing: 0;
  text-transform: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fg-fields {
  border: 0;
  margin: 0;
  padding: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.fg-fields .field-input {
  width: 110px;
}
</style>
