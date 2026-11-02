<script setup>
import { ref, computed, watch } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import SettingsField from '../ui/SettingsField.vue'
import SettingsGroup from '../ui/SettingsGroup.vue'
import SettingsStep from '../ui/SettingsStep.vue'
import SegmentedControl from '../ui/SegmentedControl.vue'
import WarnBox from '../ui/WarnBox.vue'
import FieldHelp from '../../guide/FieldHelp.vue'
import { COREG_DEFAULTS } from '../../../core/defaults.user.js'
import { coregisterEffects } from '../../../core/stepEffects/coregister.js'
import { fetchCopernicusDem } from '../../../composables/useCopernicusDem.js'
import { useLog } from '../../../composables/useLog.js'

// Co-register DEM (Tools ▸ Products ▾): a DEM against a reference DEM on stable ground,
// the steps xDEM chains — Nuth & Kääb's horizontal shift, the vertical shift, a tilt —
// applied to a copy of the DEM or to the georeference (core/products/demCoregistration.js,
// composables/useDemCoregistration.js). Quality Report ▸ DEM vs reference opens it with
// its reference and stable ground.
const props = defineProps({
  // DEM products, the main one first; references: imported reference DEMs.
  dems: { type: Array, default: () => [] },
  references: { type: Array, default: () => [] },
  // Polygon layers (useFootprintsStore sets) that can mark stable ground.
  layers: { type: Array, default: () => [] },
  initial: { type: Object, default: null }, // { demId, referenceId, stableSetId }
  georefCrs: { type: String, default: null },
  current: { type: Object, default: null }, // the store's coregistration
  builtIn: { type: Function, default: () => 'fit' }, // dem → 'moved' | 'fit' | null (useDemCoregistration)
})
const emit = defineEmits(['close', 'run', 'remove'])

const demId = ref(props.initial?.demId ?? props.dems[0]?.id ?? null)
const referenceId = ref(props.initial?.referenceId ?? props.references[0]?.id ?? null)
const stableSetId = ref(props.initial?.stableSetId ?? '')
const settings = ref({ ...COREG_DEFAULTS })
watch(
  () => props.references,
  (list) => {
    if (!list.some((r) => r.id === referenceId.value)) referenceId.value = list[0]?.id ?? null
  },
)

const dem = computed(() => props.dems.find((d) => d.id === demId.value) ?? null)
const reference = computed(() => props.references.find((r) => r.id === referenceId.value) ?? null)
const stable = computed(() => props.layers.find((l) => l.id === stableSetId.value) ?? null)
const georef = computed(() => settings.value.applyTo === 'georeference')
const applyOptions = [
  { id: 'dem', label: 'The DEM' },
  { id: 'georeference', label: 'The georeference' },
]

// What each step does with this DEM and reference (core/stepEffects/coregister.js).
const effects = computed(() =>
  coregisterEffects(settings.value, {
    demName: dem.value?.name ?? 'DEM',
    demInCrs: !!dem.value?.crs && dem.value.crs !== 'local',
    demTiled: !!dem.value?.cog,
    demCrs: dem.value?.crs ?? null,
    referenceName: reference.value?.name ?? null,
    stableName: stable.value?.name ?? null,
    georefCrs: props.georefCrs,
    current: props.current,
    builtIn: dem.value ? props.builtIn(dem.value) : 'fit',
  }),
)

// Without a reference DEM of one's own: the Copernicus DEM over this DEM, fetched and
// imported as one (composables/useCopernicusDem.js), then chosen here.
const { log } = useLog()
const fetching = ref(false),
  fetchError = ref('')
const demInCrs = computed(() => !!dem.value?.crs && dem.value.crs !== 'local')
async function fetchCopDem() {
  fetching.value = true
  fetchError.value = ''
  try {
    const meta = await fetchCopernicusDem(dem.value, { onLog: log })
    referenceId.value = meta.id
  } catch (err) {
    fetchError.value = err.message
  } finally {
    fetching.value = false
  }
}

function run() {
  emit('run', {
    demId: demId.value,
    referenceId: referenceId.value,
    stableSetId: stableSetId.value || null,
    ...settings.value,
  })
}
</script>

<template>
  <ModalShell title="Co-register DEM" @close="emit('close')">
    <WarnBox v-if="!dems.length">Build a DEM first (<strong>Reconstruct ▸ DEM</strong>).</WarnBox>
    <template v-else>
      <div v-if="effects.current" class="current-row">
        <span class="field-hint">{{ effects.current }}</span>
        <button class="btn" type="button" @click="emit('remove')">Remove</button>
      </div>
      <SettingsGroup title="Source">
        <SettingsField label="DEM" label-for="coreg-dem">
          <select id="coreg-dem" v-model="demId" class="field-select">
            <option v-for="d in dems" :key="d.id" :value="d.id">{{ d.name }}</option>
          </select>
        </SettingsField>
        <SettingsField label-for="coreg-ref">
          <template #label><FieldHelp op="coregister-dem" param="reference">Reference DEM</FieldHelp></template>
          <select id="coreg-ref" v-model="referenceId" class="field-select" :disabled="!references.length">
            <option v-if="!references.length" :value="null">None imported</option>
            <option v-for="r in references" :key="r.id" :value="r.id">{{ r.name }}</option>
          </select>
        </SettingsField>
        <SettingsField
          :hint="
            demInCrs
              ? 'Or fetch the free global Copernicus DEM (from TanDEM-X) over this DEM and use it as the reference.'
              : 'The DEM has no coordinate system, so no global DEM can be fetched for it.'
          "
        >
          <button class="btn" type="button" :disabled="!demInCrs || fetching" @click="fetchCopDem">
            {{ fetching ? 'Fetching the Copernicus DEM…' : 'Copernicus DEM (30 m)' }}
          </button>
        </SettingsField>
        <p v-if="fetchError" class="coreg-error" role="alert">{{ fetchError }}</p>
      </SettingsGroup>

      <SettingsStep step="1" title="Stable ground" :effect="effects.stable">
        <SettingsField label-for="coreg-stable">
          <template #label><FieldHelp op="coregister-dem" param="stableArea">Stable ground</FieldHelp></template>
          <select id="coreg-stable" v-model="stableSetId" class="field-select">
            <option value="">All cells</option>
            <option v-for="l in layers" :key="l.id" :value="l.id">{{ l.name }}</option>
          </select>
        </SettingsField>
      </SettingsStep>

      <SettingsStep step="2" title="Horizontal shift" :effect="effects.horizontal">
        <SettingsField>
          <label class="checkbox-row"
            ><input v-model="settings.horizontal" type="checkbox" class="checkbox" />
            <FieldHelp
              op="coregister-dem"
              param="horizontal"
              :value="settings.horizontal"
              :default-value="COREG_DEFAULTS.horizontal"
              >Shift east and north</FieldHelp
            ></label
          >
        </SettingsField>
      </SettingsStep>

      <SettingsStep step="3" title="Vertical shift" :effect="effects.vertical">
        <SettingsField>
          <label class="checkbox-row"
            ><input v-model="settings.vertical" type="checkbox" class="checkbox" />
            <FieldHelp
              op="coregister-dem"
              param="vertical"
              :value="settings.vertical"
              :default-value="COREG_DEFAULTS.vertical"
              >Remove the height offset</FieldHelp
            ></label
          >
        </SettingsField>
      </SettingsStep>

      <SettingsStep step="4" title="Tilt" :effect="effects.tilt">
        <SettingsField label-for="coreg-tilt">
          <template #label><FieldHelp op="coregister-dem" param="tilt">Tilt</FieldHelp></template>
          <select id="coreg-tilt" v-model="settings.tilt" class="field-select">
            <option value="off">Off</option>
            <option value="plane">Plane</option>
            <option value="quadratic" :disabled="georef">Quadratic surface</option>
          </select>
        </SettingsField>
      </SettingsStep>

      <SettingsStep step="5" title="Apply" :effect="effects.apply">
        <SettingsField>
          <template #label><FieldHelp op="coregister-dem" param="applyTo">Apply to</FieldHelp></template>
          <SegmentedControl v-model="settings.applyTo" :options="applyOptions" />
        </SettingsField>
      </SettingsStep>

      <WarnBox v-if="effects.blocked">{{ effects.blocked }}</WarnBox>
    </template>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!dems.length || !!effects.blocked || fetching" @click="run">
        Co-register
      </button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
<style scoped>
.coreg-error {
  margin: 0;
  font-size: 12px;
  color: var(--danger);
}
.current-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
</style>
