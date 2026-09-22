<script setup>
import { linearCrsUnit } from '../../core/crs.js'
import { computed, ref } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import SettingsField from './ui/SettingsField.vue'
import WarnBox from './ui/WarnBox.vue'
import GlossaryTerm from '../glossary/GlossaryTerm.vue'
import { DEM_DEFAULTS } from '../../core/defaults.user.js'

// Build DEM (Digital Surface Model). Rasterises the point cloud into a height
// grid in the chosen frame. Defaults are the single source of truth in
// core/defaults.user.js (core/products/dem.js keeps matching defensive fallbacks).
// `canGeoreference` / `projectCrs` come from the reconstruction store.
// `source` is the store's `demSource` getter — the cloud generateDem() will
// actually rasterise. Shown read-only: the pick is the store's, this only makes
// it visible. A sparse source is a legitimate (if coarse) run, so it warns and
// never gates the button.
const props = defineProps({
  canGeoreference: { type: Boolean, default: false },
  hasScale: { type: Boolean, default: false },
  projectCrs: { type: String, default: null },
  source: { type: Object, default: null },
})

const isSparseSource = computed(() => props.source?.kind === 'sparse')
const localUnit = computed(() => props.hasScale ? 'm/px' : 'model units/px')

const sourceLabel = computed(() => {
  const s = props.source
  if (!s) return 'No point cloud yet'
  const kind = s.kind === 'dense' ? 'Dense cloud' : 'Sparse cloud'
  return `${kind}${s.name ? ` · ${s.name}` : ''} · ${s.count.toLocaleString()} points`
})

const emit = defineEmits(['close', 'run'])

const settings = ref({ ...DEM_DEFAULTS })

function run() {
  // Pass gsd only when set (0 ⇒ let the worker auto-suggest).
  const { gsd, ...rest } = settings.value
  emit('run', gsd > 0 ? { ...rest, gsd } : rest)
}
</script>

<template>
  <ModalShell title="Build DEM" @close="emit('close')">
    <!-- Read-only: which cloud the run will rasterise. The pick lives in the
         store's demSource getter; showing it here is what makes a sparse-source
         DEM a visible choice instead of a silent fallback. -->
    <div class="source-row">
      <span class="field-label">Source</span>
      <span class="field-hint source-value">{{ sourceLabel }}</span>
    </div>

    <WarnBox v-if="isSparseSource">
      Building from the <b>sparse</b> cloud — cells are interpolated from tie points,
      so the surface is approximate. Run <b>Depth maps → Densify</b> for a true DSM.
    </WarnBox>

    <SettingsField label-for="dem-crs"
      :hint="hasScale
        ? 'Local uses a camera-estimated orientation and the current highest-ranked scale evidence, so coordinates are metric but have no CRS.'
        : 'Local uses a camera-estimated up-vector (up-to-scale); the project CRS fits a similarity to imported poses for real-world heights & GSD.'">
      <template #label>
        <GlossaryTerm id="coordinate-reference-system">Coordinate frame</GlossaryTerm>
      </template>
      <select id="dem-crs" v-model="settings.crs" class="field-input field-select">
        <option value="local">{{ hasScale ? 'Local (metres, no CRS)' : 'Local (model units)' }}</option>
        <option value="project" :disabled="!canGeoreference">
          {{ projectCrs || 'Project CRS' }}{{ canGeoreference ? '' : ' — needs camera poses' }}
        </option>
      </select>
    </SettingsField>

    <SettingsField label-for="dem-gsd"
      :unit="settings.crs === 'project' ? `${linearCrsUnit(projectCrs)}/px` : localUnit"
      hint="Cell size. 0 = auto (≈ one point per cell). Smaller = finer & slower.">
      <template #label>
        <GlossaryTerm id="ground-sample-distance">Ground sample distance</GlossaryTerm>
      </template>
      <input id="dem-gsd" v-model.number="settings.gsd" type="number" min="0" step="0.1" class="field-input" />
    </SettingsField>

    <SettingsField label="Surface aggregation" label-for="dem-agg"
      hint="How multiple points in one cell collapse to a single height.">
      <select id="dem-agg" v-model="settings.aggregate" class="field-input field-select">
        <option value="max">Max (DSM — top surface)</option>
        <option value="median">Median (robust)</option>
        <option value="mean">Mean</option>
        <option value="min">Min (ground-ish)</option>
      </select>
    </SettingsField>

    <SettingsField label="Gap interpolation" label-for="dem-fill-method"
      hint="IDW blends nearby heights smoothly; nearest neighbour preserves steps. Disable to keep nodata gaps.">
      <select id="dem-fill-method" v-model="settings.fillMethod" class="field-input field-select">
        <option value="idw">Inverse distance (smooth)</option>
        <option value="nearest">Nearest neighbour</option>
        <option value="none">None (keep gaps)</option>
      </select>
    </SettingsField>

    <!-- The radius never expands the raster extent; it only fills cells with a
         measured neighbour inside this search distance. -->
    <SettingsField v-if="settings.fillMethod !== 'none'" label="Interpolation radius" label-for="dem-fill" unit="px"
      :hint="isSparseSource
        ? 'Fill empty cells with measured neighbours inside this radius. On a sparse source, a large radius invents surface between distant tie points.'
        : 'Fill empty cells only when an original measured cell lies within this radius.'">
      <input id="dem-fill" v-model.number="settings.fillRadius" type="number" min="1" max="32" step="1" class="field-input" />
    </SettingsField>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" @click="run">Build DEM</button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
<style scoped>
/* DEM/aggregation selects read better full-width. */
.field-select { width: 100%; }
/* Source is a read-only statement, not a field: label and value on one line. */
.source-row { display: flex; align-items: baseline; gap: 8px; }
.source-value { color: var(--text); }
</style>
