<script setup>
import { computed, ref, watch } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import WarnBox from '../ui/WarnBox.vue'
import SettingsField from '../ui/SettingsField.vue'
import SettingsStep from '../ui/SettingsStep.vue'
import SettingsGroup from '../ui/SettingsGroup.vue'
import ChoiceCards from '../ui/ChoiceCards.vue'
import FieldHelp from '../../guide/FieldHelp.vue'
import { DEM_HOLD_DEFAULTS } from '../../../core/defaults.user.js'
import { demHoldEffects } from '../../../core/stepEffects/demHold.js'
import {
  georeferenceMethods,
  georeferenceSource,
  georeferenceFitEffect,
} from '../../../core/stepEffects/georeference.js'
import { crsInfo, ensureProjection, isGeographic, transform } from '../../../core/crs.js'
import { fetchCopernicusDemAround } from '../../../composables/useCopernicusDem.js'
import { useLog } from '../../../composables/useLog.js'

// Georeference (Reconstruct ▸ Georeference…): adjust the reconstruction with GCPs, hold
// it to a reference DEM (F13: both re-run the reconstruction through the Reconstruct
// dialog, useDialogRuns.js), or only transform it.
const props = defineProps({
  canAdjustWithGcps: { type: Boolean, default: false },
  canTransform: { type: Boolean, default: false },
  hasMatches: { type: Boolean, default: false },
  // Enabled ground control with coordinates (the frame of a DEM hold).
  controlCount: { type: Number, default: 0 },
  poseCount: { type: Number, default: 0 },
  projectCrs: { type: String, default: '' },
  // Imported reference DEMs, polygon layers for stable ground, and the camera
  // positions and GCPs as [x, y] in the project CRS (where to fetch a Copernicus DEM).
  references: { type: Array, default: () => [] },
  layers: { type: Array, default: () => [] },
  places: { type: Array, default: () => [] },
})

const emit = defineEmits(['close', 'run'])

// Hold to a reference DEM: the reference, its height uncertainty (its declared vertical
// accuracy, else the default), the stable ground.
const referenceId = ref(props.references[0]?.id ?? null)
const reference = computed(() => props.references.find((r) => r.id === referenceId.value) ?? null)
const declaredSigma = computed(() => (reference.value?.verticalAccuracy > 0 ? reference.value.verticalAccuracy : null))
const sigma = ref(declaredSigma.value ?? DEM_HOLD_DEFAULTS.sigma)
watch(referenceId, () => (sigma.value = declaredSigma.value ?? DEM_HOLD_DEFAULTS.sigma))
watch(
  () => props.references,
  (list) => {
    if (!list.some((r) => r.id === referenceId.value)) referenceId.value = list[0]?.id ?? null
  },
)
const stableSetId = ref('')
const stable = computed(() => props.layers.find((l) => l.id === stableSetId.value) ?? null)
const geographic = computed(() => isGeographic(props.projectCrs))

// The three methods, each disabled with its reason (core/stepEffects/georeference.js).
const project = computed(() => ({
  crs: props.projectCrs,
  crsName: props.projectCrs ? crsInfo(props.projectCrs).name : '',
  geographic: geographic.value,
  hasMatches: props.hasMatches,
  gcps: props.controlCount,
  poses: props.poseCount,
  adjustReady: props.canAdjustWithGcps,
  transformReady: props.canTransform,
}))
const methods = computed(() => georeferenceMethods(project.value))
const source = computed(() => georeferenceSource(project.value))
// Start on the first method that can run: Adjust with GCPs when there is control.
const mode = ref(methods.value.find((m) => !m.disabled)?.id ?? 'transform')
const fitEffect = computed(() => georeferenceFitEffect(mode.value, project.value))
const hold = computed(() =>
  demHoldEffects(
    { sigma: sigma.value },
    {
      referenceName: reference.value?.name ?? null,
      referenceSigma: declaredSigma.value,
      stableName: stable.value?.name ?? null,
      gcps: props.controlCount,
      poses: props.poseCount,
      geographic: geographic.value,
      hasMatches: props.hasMatches,
    },
  ),
)

// Without a reference DEM of one's own: the Copernicus DEM around the camera positions
// and GCPs (composables/useCopernicusDem.js), then chosen here.
const { log } = useLog()
const fetching = ref(false),
  fetchError = ref('')
async function fetchCopDem() {
  fetching.value = true
  fetchError.value = ''
  try {
    const crs = props.projectCrs
    if (crs !== 'EPSG:4326') await ensureProjection(crs)
    const lonLats = props.places.map((p) => (crs === 'EPSG:4326' ? p : transform(p, crs, 'EPSG:4326')))
    const meta = await fetchCopernicusDemAround(lonLats, 'camera positions', { onLog: log })
    referenceId.value = meta.id
  } catch (err) {
    fetchError.value = err.message
  } finally {
    fetching.value = false
  }
}

const fetchReason = computed(() =>
  fetching.value
    ? 'Fetching…'
    : geographic.value
      ? 'The project CRS is in degrees: choose a projected CRS in Project Settings.'
      : !props.places.length
        ? 'Needs camera positions or GCPs to know where to fetch.'
        : null,
)

// Why the chosen method cannot run, or null.
const blocked = computed(() =>
  mode.value === 'dem' ? hold.value.blocked : (methods.value.find((m) => m.id === mode.value)?.reason ?? null),
)
const canRun = computed(() => !blocked.value)
function run() {
  if (mode.value !== 'dem') return emit('run', { mode: mode.value })
  emit('run', {
    mode: 'dem',
    demHold: { referenceId: referenceId.value, stableSetId: stableSetId.value || null, sigma: sigma.value },
  })
}
</script>

<template>
  <ModalShell title="Georeference" @close="emit('close')">
    <SettingsGroup title="Source">
      <SettingsField label="Coordinate system">
        <span class="readout">{{ source.crs }}</span>
        <template #hint>The model is fitted into this CRS. Change it in Project Settings.</template>
      </SettingsField>
      <SettingsField label="Control">
        <span class="readout">{{ source.control }}</span>
      </SettingsField>
    </SettingsGroup>

    <SettingsField>
      <template #label><FieldHelp op="georeferencing" param="method">Method</FieldHelp></template>
      <ChoiceCards v-model="mode" :options="methods" class="method-cards" aria-label="Method" />
    </SettingsField>

    <template v-if="mode === 'dem'">
      <SettingsStep step="1" title="Reference DEM" :effect="hold.reference" experimental="demHold">
        <SettingsField label-for="hold-ref">
          <template #label><FieldHelp op="georeferencing" param="holdReference">Reference DEM</FieldHelp></template>
          <select
            id="hold-ref"
            v-model="referenceId"
            class="field-select"
            :disabled="!references.length"
            :title="
              references.length
                ? null
                : 'Import a reference DEM (Import ▸ Reference DEM / Ortho), or fetch the Copernicus DEM below'
            "
          >
            <option v-if="!references.length" :value="null">None imported</option>
            <option v-for="r in references" :key="r.id" :value="r.id">{{ r.name }}</option>
          </select>
        </SettingsField>
        <SettingsField
          hint="Or fetch the free global Copernicus DEM (from TanDEM-X) around the camera positions and GCPs."
        >
          <button
            class="btn"
            type="button"
            :disabled="!places.length || geographic || fetching"
            :title="fetchReason"
            @click="fetchCopDem"
          >
            {{ fetching ? 'Fetching the Copernicus DEM…' : 'Copernicus DEM (30 m)' }}
          </button>
        </SettingsField>
        <p v-if="fetchError" class="hold-error" role="alert">{{ fetchError }}</p>
        <SettingsField label-for="hold-sigma">
          <template #label
            ><FieldHelp
              op="georeferencing"
              param="holdSigma"
              :value="sigma"
              :default-value="declaredSigma ?? DEM_HOLD_DEFAULTS.sigma"
              >Height uncertainty (m)</FieldHelp
            ></template
          >
          <input id="hold-sigma" v-model.number="sigma" type="number" min="0.05" step="0.1" class="field-input" />
        </SettingsField>
      </SettingsStep>
      <SettingsStep step="2" title="Stable ground" :effect="hold.stable">
        <SettingsField label-for="hold-stable">
          <template #label><FieldHelp op="georeferencing" param="holdStable">Stable ground</FieldHelp></template>
          <select id="hold-stable" v-model="stableSetId" class="field-select">
            <option value="">Everywhere</option>
            <option v-for="l in layers" :key="l.id" :value="l.id">{{ l.name }}</option>
          </select>
        </SettingsField>
      </SettingsStep>
    </template>
    <SettingsStep v-else step="1" :title="mode === 'adjust' ? 'Adjust and fit' : 'Fit'" :effect="fitEffect" />

    <WarnBox v-if="blocked">{{ blocked }}</WarnBox>
    <WarnBox v-else-if="mode !== 'transform'">
      The adjusted sparse model replaces the current one. Depth maps, the computed dense model, DEM, orthophoto and mesh
      will need to be rebuilt.
    </WarnBox>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!canRun" :title="blocked" @click="run">
        {{ mode === 'transform' ? 'Georeference' : 'Continue to adjustment' }}
      </button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
<style scoped>
.readout {
  font-size: 13px;
  color: var(--text);
}
.method-cards.choice-cards {
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
}
.hold-error {
  margin: 0;
  font-size: 12px;
  color: var(--danger);
}
</style>
