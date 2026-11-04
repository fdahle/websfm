<script setup>
import { computed, ref, watch } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import WarnBox from '../ui/WarnBox.vue'
import SettingsField from '../ui/SettingsField.vue'
import SettingsStep from '../ui/SettingsStep.vue'
import GlossaryTerm from '../../glossary/GlossaryTerm.vue'
import FieldHelp from '../../guide/FieldHelp.vue'
import { DEM_HOLD_DEFAULTS } from '../../../core/defaults.user.js'
import { demHoldEffects } from '../../../core/stepEffects/demHold.js'
import { ensureProjection, isGeographic, transform } from '../../../core/crs.js'
import { fetchCopernicusDemAround } from '../../../composables/useCopernicusDem.js'
import { useLog } from '../../../composables/useLog.js'

// Georeference (Reconstruct ▸ Georeference…): adjust the reconstruction with GCPs, hold
// it to a reference DEM (F13: both re-run the reconstruction through the Reconstruct
// dialog, useDialogRuns.js), or only transform it.
const props = defineProps({
  canAdjustWithGcps: { type: Boolean, default: false },
  canTransform: { type: Boolean, default: false },
  hasMatches: { type: Boolean, default: false },
  gcpCount: { type: Number, default: 0 },
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
const mode = ref(props.canAdjustWithGcps && props.hasMatches ? 'adjust' : 'transform')

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
const canHold = computed(
  () => props.hasMatches && !geographic.value && (props.controlCount >= 3 || props.poseCount >= 3),
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

const canRun = computed(() =>
  mode.value === 'adjust'
    ? props.canAdjustWithGcps && props.hasMatches
    : mode.value === 'dem'
      ? !hold.value.blocked
      : props.canTransform,
)
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
    <p class="intro">
      Place the relative reconstruction in
      <b
        ><GlossaryTerm id="coordinate-reference-system">{{ projectCrs || 'the project CRS' }}</GlossaryTerm></b
      >
      using existing ground control or registered camera positions.
    </p>

    <div class="mode-list">
      <label class="mode-card" :class="{ active: mode === 'adjust', disabled: !canAdjustWithGcps || !hasMatches }">
        <input v-model="mode" type="radio" value="adjust" :disabled="!canAdjustWithGcps || !hasMatches" />
        <span>
          <b>Adjust reconstruction with <GlossaryTerm id="ground-control-point">GCPs</GlossaryTerm></b>
          <small
            >Rebuild the sparse model with GCP-constrained bundle adjustment, then fit it to the project CRS.
            Recommended after adding control.</small
          >
        </span>
      </label>
      <label class="mode-card" :class="{ active: mode === 'dem', disabled: !canHold }">
        <input v-model="mode" type="radio" value="dem" :disabled="!canHold" />
        <span>
          <b>Hold to a reference DEM</b>
          <small
            >Rebuild the sparse model with its tie points held to a reference DEM, so a block with only drone GPS or a
            few GCPs cannot bend, then fit it to the project CRS.</small
          >
        </span>
      </label>
      <label class="mode-card" :class="{ active: mode === 'transform', disabled: !canTransform }">
        <input v-model="mode" type="radio" value="transform" :disabled="!canTransform" />
        <span>
          <b>Transform current reconstruction only</b>
          <small>Fit scale, rotation and translation without changing camera or point geometry.</small>
        </span>
      </label>
    </div>

    <template v-if="mode === 'dem'">
      <SettingsStep step="1" title="Reference DEM" :effect="hold.reference">
        <SettingsField label-for="hold-ref">
          <template #label><FieldHelp op="georeferencing" param="holdReference">Reference DEM</FieldHelp></template>
          <select id="hold-ref" v-model="referenceId" class="field-select" :disabled="!references.length">
            <option v-if="!references.length" :value="null">None imported</option>
            <option v-for="r in references" :key="r.id" :value="r.id">{{ r.name }}</option>
          </select>
        </SettingsField>
        <SettingsField
          hint="Or fetch the free global Copernicus DEM (from TanDEM-X) around the camera positions and GCPs."
        >
          <button class="btn" type="button" :disabled="!places.length || geographic || fetching" @click="fetchCopDem">
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

    <p class="summary">
      {{ gcpCount }} GCP{{ gcpCount === 1 ? '' : 's' }} · {{ poseCount }} camera position{{
        poseCount === 1 ? '' : 's'
      }}
    </p>

    <WarnBox v-if="mode === 'dem' && hold.blocked">{{ hold.blocked }}</WarnBox>
    <WarnBox v-else-if="!canRun">
      <template v-if="mode === 'adjust'">
        Adjustment needs feature matches and at least three enabled 3D control points, each marked in two registered
        images.
      </template>
      <template v-else> Georeferencing needs at least three eligible GCPs or registered 3D camera positions. </template>
    </WarnBox>
    <WarnBox v-else-if="mode !== 'transform'">
      The adjusted sparse model replaces the current one. Depth maps, the computed dense model, DEM, orthophoto and mesh
      will need to be rebuilt.
    </WarnBox>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!canRun" @click="run">
        {{ mode === 'transform' ? 'Georeference' : 'Continue to adjustment' }}
      </button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
<style scoped>
.intro,
.summary {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text);
}
.summary {
  color: var(--text-dim);
}
.mode-list {
  display: grid;
  gap: 8px;
}
.mode-card {
  display: flex;
  gap: 9px;
  padding: 10px;
  border: 1px solid var(--panel-border);
  border-radius: 7px;
  background: var(--bg);
  cursor: pointer;
}
.mode-card.active {
  border-color: var(--accent);
  box-shadow: inset 0 0 0 1px var(--accent);
}
.mode-card.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.mode-card input {
  margin-top: 2px;
  accent-color: var(--accent);
}
.mode-card span {
  display: grid;
  gap: 3px;
}
.mode-card b {
  font-size: 13px;
  color: var(--text);
}
.mode-card small {
  font-size: 11px;
  line-height: 1.4;
  color: var(--text-dim);
}
.hold-error {
  margin: 0;
  font-size: 12px;
  color: var(--danger);
}
.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
