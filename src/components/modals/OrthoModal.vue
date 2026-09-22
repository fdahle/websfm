<script setup>
import { linearCrsUnit } from '../../core/crs.js'
import { computed, ref, watch } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import SettingsField from './ui/SettingsField.vue'
import WarnBox from './ui/WarnBox.vue'
import GlossaryTerm from '../glossary/GlossaryTerm.vue'
import { ORTHO_DEFAULTS } from '../../core/defaults.user.js'

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
})

const emit = defineEmits(['close', 'run'])

const settings = ref({ ...ORTHO_DEFAULTS })

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

// The project frame can't be chosen without a georeference — don't leave a stale
// selection that would silently fall back to local at run time.
watch(() => props.canGeoreference, (ok) => {
  if (!ok && settings.value.crs === 'project') settings.value.crs = 'local'
})

function run() {
  const { depthTolRel, maxCost, gsd, ...rest } = settings.value
  emit('run', {
    ...rest,
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
         they need the same choice Build DEM offers. -->
    <SettingsField v-if="framePicked" label-for="ortho-crs"
      :hint="hasScale
        ? 'Local uses a camera-estimated orientation and the current highest-ranked scale evidence, so coordinates are metric but have no CRS.'
        : 'Local uses a camera-estimated up-vector (up-to-scale); the project CRS fits a similarity to imported poses for real-world coordinates & GSD.'">
      <template #label>
        <GlossaryTerm id="coordinate-reference-system">Coordinate frame</GlossaryTerm>
      </template>
      <select id="ortho-crs" v-model="settings.crs" class="field-input field-select">
        <option value="local">{{ hasScale ? 'Local (metres, no CRS)' : 'Local (model units)' }}</option>
        <option value="project" :disabled="!canGeoreference">
          {{ projectCrs || 'Project CRS' }}{{ canGeoreference ? '' : ' — needs camera poses' }}
        </option>
      </select>
    </SettingsField>

    <SettingsField label-for="ortho-gsd"
      :unit="outputUnit"
      hint="Ortho cell size. 0 = the surface's own resolution. The ortho can be finer than the surface — a coarse surface is enough to reproject onto.">
      <template #label>
        <GlossaryTerm id="ground-sample-distance">Ground sample distance</GlossaryTerm>
      </template>
      <input id="ortho-gsd" v-model.number="settings.gsd" type="number" min="0" step="0.01" class="field-input" />
    </SettingsField>

    <SettingsField label="View blending" label-for="ortho-blend"
      hint="Best picks the lowest-cost view per cell; average blends all visible views.">
      <select id="ortho-blend" v-model="settings.blend" class="field-input field-select">
        <option value="best">Best view (sharpest)</option>
        <option value="average">Average (smoother seams)</option>
      </select>
    </SettingsField>

    <SettingsField label-for="ortho-tol" unit="%"
      hint="How closely a cell's depth must match a view's depth map to count as visible.">
      <template #label>
        <GlossaryTerm id="depth-map">Occlusion tolerance</GlossaryTerm>
      </template>
      <input id="ortho-tol" v-model.number="settings.depthTolRel" type="number" min="0.5" max="10" step="0.5" class="field-input" />
    </SettingsField>

    <SettingsField label-for="ortho-cost"
      hint="Drop colours from poorly-matched (high-cost) pixels. 0 = keep all.">
      <template #label>
        Max <GlossaryTerm id="photometric-consistency">match cost</GlossaryTerm>
      </template>
      <input id="ortho-cost" v-model.number="settings.maxCost" type="number" min="0" max="2" step="0.1" class="field-input" />
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
      <input id="ortho-fill" v-model.number="settings.fillRadius" type="number" min="1" max="16" step="1" class="field-input" />
    </SettingsField>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!canRun" @click="run">Build Orthophoto</button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
<style scoped>
.field-select { width: 100%; }
</style>
