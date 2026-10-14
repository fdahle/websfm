<script setup>
import { linearCrsUnit } from '../../core/crs.js'
import { computed, ref } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import SettingsField from './ui/SettingsField.vue'
import WarnBox from './ui/WarnBox.vue'
import FrameCrsField from './ui/FrameCrsField.vue'
import GlossaryTerm from '../glossary/GlossaryTerm.vue'
import { ORTHO_DEFAULTS } from '../../core/defaults.user.js'
import { useComputeSettings } from '../../composables/useComputeSettings.js'
import { checkNumberFields } from '../../utils/numberFields.js'

// Build Orthophoto. Reprojects each cell of a SURFACE through the cached depth
// maps (occlusion via their depth planes, colour from their RGB planes). The
// surface supplies the height per ground cell — a DEM is one option, not a
// requirement (core/products/surface.js). Defaults are the single source of truth
// in core/defaults.user.js; run() transforms depthTolRel (%) and maxCost (0 ⇒ ∞).
//
// `surfaces` is the store's `orthoSurfaces` getter — the same list generateOrtho()
// consumes, so what's offered here and what runs can't disagree.
const props = defineProps({
  surfaces: { type: Array, default: () => [] },
  canGeoreference: { type: Boolean, default: false },
  hasScale: { type: Boolean, default: false },
  demUnit: { type: String, default: null },
  projectCrs: { type: String, default: null },
  // Why the project-CRS option is off ('geographic' | 'evidence' | null) and, for a
  // geographic CRS, the projected one the camera positions suggest (store getters).
  georeferenceBlocker: { type: String, default: null },
  crsSuggestion: { type: Object, default: null },
})

const emit = defineEmits(['close', 'run', 'apply-crs-suggestion'])

// A georeferenced project defaults to the project CRS: a local-frame product has no
// map position (core/products/productLayers.js), so 'local' there would be a trap.
// Read once at open — a fact about the project, never re-applied over the user's pick.
// <FrameCrsField> keeps it valid afterwards (back to local when the georeference goes).
const settings = ref({ ...ORTHO_DEFAULTS, crs: props.canGeoreference ? 'project' : ORTHO_DEFAULTS.crs })

// Open on the first available surface rather than a dead default: with a mesh
// built and no DEM, 'dem' would greet the user disabled.
const firstAvailable = props.surfaces.find((s) => s.available)
if (firstAvailable) settings.value.surface = firstAvailable.id

const chosen = computed(() => props.surfaces.find((s) => s.id === settings.value.surface) ?? null)
// A DEM surface carries the frame it was built in; only mesh/plane pick one here.
const framePicked = computed(() => settings.value.surface !== 'dem')
const canRun = computed(() => !!chosen.value?.available)
const outputUnit = computed(() => {
  if (!framePicked.value) return props.demUnit && props.demUnit !== 'model' ? `${props.demUnit}/px` : 'model units/px'
  return settings.value.crs === 'project' ? `${linearCrsUnit(props.projectCrs)}/px`
    : props.hasScale ? 'm/px' : 'model units/px'
})

const blendHint = computed(() => ({
  mosaic: 'Each area comes from the photo looking most straight down on it; seams are then evened out.',
  best: 'Per pixel, the view whose depth matched best. Sources can switch from pixel to pixel.',
  average: 'Blends every view that sees a pixel. Smooth, but small misalignments ghost.',
}[settings.value.blend] ?? ''))

// The machine-level memory budget (Settings ▸ Compute), injected at run() like
// Build DEM: it sizes the run's map/photo cache and gates its working set.
const { memBudgetBytes } = useComputeSettings()

// Run stays disabled while a field is blank or out of range (rules = the inputs'
// own min/max/step). 0 is a meaningful GSD / max cost; blank is not. Fields hidden
// by their blend / fill choice are not checked.
const numbers = computed(() => {
  const s = settings.value
  return checkNumberFields(s, {
    gsd: { label: 'Ground sample distance', min: 0 },
    seamWidth: { label: 'Seam blending width', min: 0, max: 5, when: s.blend === 'mosaic' },
    depthTolRel: { label: 'Occlusion tolerance', min: 0.5, max: 10 },
    maxCost: { label: 'Max match cost', min: 0, max: 2 },
    fillRadius: { label: 'Colour fill radius', min: 1, max: 16, integer: true, when: s.fillMethod !== 'none' },
  })
})

function run() {
  const { depthTolRel, maxCost, gsd, ...rest } = settings.value
  emit('run', {
    ...rest,
    memBudgetBytes: memBudgetBytes.value,
    // The surface is built at its own natural resolution and the ortho grid is
    // resampled to `gsd`; passing it through as the surface GSD too would make a
    // fine ortho pay for a needlessly fine mesh rasterisation.
    gsd: gsd > 0 ? gsd : 0,
    depthTolRel: depthTolRel / 100,
    maxCost: maxCost > 0 ? maxCost : Infinity,
  })
}
</script>

<template>
  <ModalShell title="Build Orthophoto" @close="emit('close')">
    <SettingsField label="Surface" label-for="ortho-surface"
      :hint="chosen?.hint ?? 'The height per ground cell that each pixel is reprojected onto.'">
      <select id="ortho-surface" v-model="settings.surface" class="field-input field-select">
        <option v-for="s in surfaces" :key="s.id" :value="s.id" :disabled="!s.available">
          {{ s.label }}{{ s.detail ? ` — ${s.detail}` : '' }}{{ s.available ? '' : ' — unavailable' }}
        </option>
      </select>
    </SettingsField>

    <WarnBox v-if="!canRun">
      No surface available yet. Build a <b>DEM</b> or a <b>mesh</b> first — an orthophoto
      needs a height for every ground cell to reproject the images onto.
    </WarnBox>

    <WarnBox v-else-if="settings.surface === 'dem'">
      The ortho can only cover cells where the DEM has a height, so DEM holes become
      transparent pixels. Use the <b>mesh</b> surface (watertight) or raise the DEM's
      hole-fill radius for a fuller image.
    </WarnBox>

    <!-- A DEM already fixes the frame; mesh/plane surfaces are built here, so
         they need the same choice Build DEM offers. v-show, not v-if: the field
         keeps the frame valid (and remembers an applied CRS suggestion) while a
         DEM surface hides it. -->
    <FrameCrsField v-show="framePicked" id="ortho-crs" v-model="settings.crs"
      :can-georeference="canGeoreference" :has-scale="hasScale" :project-crs="projectCrs"
      :georeference-blocker="georeferenceBlocker" :crs-suggestion="crsSuggestion"
      @apply-crs-suggestion="(s) => emit('apply-crs-suggestion', s)" />

    <!-- The raw min/max lets far background (an oblique capture sees almost to the
         horizon) set the raster size; the dense core keeps the site. The run logs
         how many points the core leaves out. -->
    <SettingsField v-if="framePicked" label="Extent" label-for="ortho-extent"
      hint="Dense core trims sparse far background (oblique views), and logs what it leaves out. All points uses the raw extent.">
      <select id="ortho-extent" v-model="settings.extent" class="field-input field-select">
        <option value="core">Dense core of the surface</option>
        <option value="all">All points</option>
      </select>
    </SettingsField>

    <SettingsField label-for="ortho-gsd"
      :unit="outputUnit"
      hint="Ortho cell size. 0 = the surface's own resolution. Finer than the surface is fine — down to the photos' own GSD. The stored GeoTIFF holds at most 4 GiB (~28,000 px square); the log says when a GSD was coarsened.">
      <template #label>
        <GlossaryTerm id="ground-sample-distance">Ground sample distance</GlossaryTerm>
      </template>
      <input id="ortho-gsd" v-model.number="settings.gsd" :aria-invalid="numbers.bad.gsd" type="number" min="0" step="0.01" class="field-input" />
    </SettingsField>

    <SettingsField label="View blending" label-for="ortho-blend" :hint="blendHint">
      <select id="ortho-blend" v-model="settings.blend" class="field-input field-select">
        <option value="mosaic">Mosaic (most nadir view, balanced seams)</option>
        <option value="best">Best match (lowest matching cost per pixel)</option>
        <option value="average">Average (all visible views)</option>
      </select>
    </SettingsField>

    <!-- Both act only on a mosaic: best/average have no regions to balance or feather. -->
    <template v-if="settings.blend === 'mosaic'">
      <SettingsField label="Colour balance" label-for="ortho-balance"
        hint="Evens out exposure between photos with one brightness gain per photo and colour, fitted where photos overlap.">
        <label class="checkbox-row">
          <input id="ortho-balance" v-model="settings.colourBalance" type="checkbox" class="checkbox" /> Enabled
        </label>
      </SettingsField>
      <SettingsField label="Seam blending width" label-for="ortho-seam" unit="%"
        hint="Width of the cross-fade at each seam, as a % of the orthophoto's shorter side (at most 128 px). 0 = hard seams.">
        <input id="ortho-seam" v-model.number="settings.seamWidth" :aria-invalid="numbers.bad.seamWidth" type="number" min="0" max="5" step="0.25" class="field-input" />
      </SettingsField>
    </template>

    <SettingsField label-for="ortho-tol" unit="%"
      hint="How closely a cell's depth must match a view's depth map to count as visible.">
      <template #label>
        <GlossaryTerm id="depth-map">Occlusion tolerance</GlossaryTerm>
      </template>
      <input id="ortho-tol" v-model.number="settings.depthTolRel" :aria-invalid="numbers.bad.depthTolRel" type="number" min="0.5" max="10" step="0.5" class="field-input" />
    </SettingsField>

    <SettingsField label-for="ortho-cost"
      hint="Never take colour where the depth map matched poorly (high cost), in every blending mode. 0 = keep all.">
      <template #label>
        Max <GlossaryTerm id="photometric-consistency">match cost</GlossaryTerm>
      </template>
      <input id="ortho-cost" v-model.number="settings.maxCost" :aria-invalid="numbers.bad.maxCost" type="number" min="0" max="2" step="0.1" class="field-input" />
    </SettingsField>

    <SettingsField label="Colour gap interpolation" label-for="ortho-fill-method"
      hint="Fills small transparent pixels from nearby successfully projected colours, but never outside the selected surface.">
      <select id="ortho-fill-method" v-model="settings.fillMethod" class="field-input field-select">
        <option value="idw">Inverse distance (smooth)</option>
        <option value="nearest">Nearest neighbour</option>
        <option value="none">None (keep transparent)</option>
      </select>
    </SettingsField>

    <SettingsField v-if="settings.fillMethod !== 'none'" label="Colour fill radius" label-for="ortho-fill" unit="px"
      hint="Maximum distance to an originally sampled colour. Small values close speckles without bridging large unseen areas.">
      <input id="ortho-fill" v-model.number="settings.fillRadius" :aria-invalid="numbers.bad.fillRadius" type="number" min="1" max="16" step="1" class="field-input" />
    </SettingsField>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!canRun || !numbers.valid" :title="numbers.reason" @click="run">Build Orthophoto</button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
<style scoped>
.field-select { width: 100%; }
</style>
