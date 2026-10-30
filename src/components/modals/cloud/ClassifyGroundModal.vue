<script setup>
import { ref, computed } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import SettingsField from '../ui/SettingsField.vue'
import SettingsGroup from '../ui/SettingsGroup.vue'
import SettingsStep from '../ui/SettingsStep.vue'
import AdvancedDisclosure from '../ui/AdvancedDisclosure.vue'
import NoSourceWarn from '../ui/NoSourceWarn.vue'
import SourcePicker from '../ui/SourcePicker.vue'
import WarnBox from '../ui/WarnBox.vue'
import FieldHelp from '../../guide/FieldHelp.vue'
import { useSourcePick, cloudOptionLabel } from '../../../composables/useSourcePick.js'
import { useComputeSettings } from '../../../composables/useComputeSettings.js'
import { GROUND_DEFAULTS, CLASSIFY_DEFAULTS } from '../../../core/defaults.user.js'
import { classifyGroundEffects } from '../../../core/stepEffects/classifyGround.js'
import { cloudUnits } from '../../../core/products/cloudUnits.js'
import { anyCloudBounds, isStreamed } from '../../../core/lod/streamed.js'
import { checkNumberFields } from '../../../utils/numberFields.js'

// Classify Points (Tools ▸ Point Cloud ▾ ▸ Attributes) — labels every point of a
// dense cloud ground / above ground / low noise with a cloth simulation
// (core/products/groundFilter.js), so Build DEM ▸ Points ▸ Ground only can make a
// DTM, then buildings and low / medium / high vegetation among the points above it
// (core/products/pointClasses.js). Adds a NEW cloud carrying a LAS `classification`
// attribute, coloured by it. The operation keeps its id, classify-ground.
// The lengths are metres along the product vertical: the run handler resolves the
// frame (useDialogRuns groundRequest); a computed cloud without real-world scale
// is refused there, and this dialog says so before Run.
const props = defineProps({
  clouds: { type: Array, default: () => [] },
  initialId: { type: String, default: null },
  // The store's currentFrameSignature: whether the project has metres at all.
  frameSignature: { type: Object, default: null },
})
const emit = defineEmits(['close', 'run'])

const settings = ref({ ...GROUND_DEFAULTS, ...CLASSIFY_DEFAULTS })
const { id: sourceId, item: source } = useSourcePick(() => props.clouds, { initialId: props.initialId })
// A streamed cloud's classes are in its octree's layout (it has no resident attributes).
const classified = (c) =>
  !!c?.attributes?.classification ||
  !!(c?.lod && !c.pos && c.lod.layout?.attributes?.some((a) => a.name === 'classification'))
const groundOptionLabel = (c) =>
  `${cloudOptionLabel(c)}${classified(c) ? ' · classified' : ''}${c.lod && !c.pos ? ' · streamed' : ''}`
const units = computed(() => cloudUnits(source.value, props.frameSignature))
const noScale = computed(() => units.value.unit === 'model')
const { memBudgetBytes } = useComputeSettings()

// Colour lets vegetation be found by being green (pointClasses.js); a streamed cloud
// says so in its octree's layout.
const colour = computed(() => !!source.value?.col || !!source.value?.lod?.layout?.colour)
const numbers = computed(() =>
  checkNumberFields(settings.value, {
    clothResolution: { label: 'Cloth resolution', min: 0.05, max: 50 },
    classThreshold: { label: 'Ground tolerance', min: 0.01, max: 10 },
    minBuildingHeight: { label: 'Minimum height', min: 0.5, max: 100, when: settings.value.buildings },
    minBuildingArea: { label: 'Minimum area', min: 1, max: 10000, when: settings.value.buildings },
    lowVegetationMax: { label: 'Low up to', min: 0.1, max: 50, when: settings.value.vegetation },
    mediumVegetationMax: {
      label: 'Medium up to',
      min: Math.max(0.2, settings.value.lowVegetationMax || 0),
      max: 100,
      when: settings.value.vegetation,
    },
  }),
)
// What each step does to this cloud (core/stepEffects/classifyGround.js).
// The cloth's size from the source's box: its two longest sides, in metres, as the
// horizontal (the product frame is resolved at Run; this is the cost, roughly).
const extent = computed(() => {
  const b = anyCloudBounds(source.value)
  if (!b || noScale.value) return null
  const sides = [b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ].sort((a, c) => c - a)
  return [sides[0] * units.value.scale, sides[1] * units.value.scale]
})
const effects = computed(() =>
  classifyGroundEffects(settings.value, {
    noScale: noScale.value,
    extent: extent.value,
    streamed: isStreamed(source.value),
    colour: colour.value,
  }),
)

function run() {
  const {
    vegetation,
    buildings,
    lowVegetationMax,
    mediumVegetationMax,
    minBuildingHeight,
    minBuildingArea,
    ...ground
  } = settings.value
  emit('run', {
    sourceIds: [sourceId.value],
    settings: {
      ...ground,
      aboveGround: { vegetation, buildings, lowVegetationMax, mediumVegetationMax, minBuildingHeight, minBuildingArea },
      memBudgetBytes: memBudgetBytes.value,
    },
    name: `${source.value?.name ?? 'Cloud'} (${vegetation || buildings ? 'classified' : 'ground'})`,
  })
}
</script>

<template>
  <ModalShell title="Classify Points" @close="emit('close')">
    <NoSourceWarn v-if="!clouds.length" kind="cloud" />
    <template v-else>
      <SettingsGroup title="Source">
        <SourcePicker
          id="gnd-src"
          v-model="sourceId"
          label="Cloud"
          :items="clouds"
          :option-label="groundOptionLabel"
          hint="Adds a new cloud with every point classified; this one is left untouched."
        />
        <WarnBox v-if="noScale">
          This model has no real-world scale, so lengths in metres mean nothing yet. Georeference it or add scale bars
          first.
        </WarnBox>
        <WarnBox v-else-if="classified(source)">
          This cloud is already classified. The new cloud replaces those classes.
        </WarnBox>
        <p v-if="source?.imported" class="field-hint">
          An imported cloud is classified in its own coordinates: its z must point up, and its units are taken as
          metres.
        </p>
      </SettingsGroup>
      <SettingsStep step="1" title="Drop the cloth" :effect="effects.cloth" :inactive="noScale">
        <SettingsField label-for="gnd-res" unit="m" hint="Coarser spans wider roofs; finer follows steeper ground.">
          <template #label>
            <FieldHelp
              op="classify-ground"
              param="clothResolution"
              :value="settings.clothResolution"
              :default-value="GROUND_DEFAULTS.clothResolution"
              >Cloth resolution</FieldHelp
            >
          </template>
          <input
            id="gnd-res"
            v-model.number="settings.clothResolution"
            :aria-invalid="numbers.bad.clothResolution"
            type="number"
            min="0.05"
            max="50"
            step="0.5"
            class="field-input"
          />
        </SettingsField>
        <SettingsField label-for="gnd-rigid" hint="How stiff the cloth is: steep ground needs a soft cloth.">
          <template #label><FieldHelp op="classify-ground" param="rigidness">Terrain</FieldHelp></template>
          <select id="gnd-rigid" v-model.number="settings.rigidness" class="field-input field-select">
            <option :value="1">Steep slopes (soft cloth)</option>
            <option :value="2">Rolling relief</option>
            <option :value="3">Flat (stiff cloth)</option>
          </select>
        </SettingsField>
        <SettingsField hint="Spread the cloth onto continuous steep ground it settled below.">
          <template #label>
            <FieldHelp
              op="classify-ground"
              param="slopeSmoothing"
              :value="settings.slopeSmoothing"
              :default-value="GROUND_DEFAULTS.slopeSmoothing"
              >Slope smoothing</FieldHelp
            >
          </template>
          <label class="checkbox-row"
            ><input v-model="settings.slopeSmoothing" type="checkbox" class="checkbox" /> Enabled</label
          >
        </SettingsField>
      </SettingsStep>
      <SettingsStep step="2" title="Label the points" :effect="effects.label" :inactive="noScale">
        <SettingsField label-for="gnd-thr" unit="m" hint="Points this close to the cloth are ground.">
          <template #label>
            <FieldHelp
              op="classify-ground"
              param="classThreshold"
              :value="settings.classThreshold"
              :default-value="GROUND_DEFAULTS.classThreshold"
              >Ground tolerance</FieldHelp
            >
          </template>
          <input
            id="gnd-thr"
            v-model.number="settings.classThreshold"
            :aria-invalid="numbers.bad.classThreshold"
            type="number"
            min="0.01"
            max="10"
            step="0.1"
            class="field-input"
          />
        </SettingsField>
        <SettingsField label-for="gnd-extent" hint="The same area a DEM covers by default.">
          <template #label><FieldHelp op="classify-ground" param="extent">Extent</FieldHelp></template>
          <select id="gnd-extent" v-model="settings.extent" class="field-input field-select">
            <option value="core">Dense core of the cloud</option>
            <option value="all">All points</option>
          </select>
        </SettingsField>
      </SettingsStep>
      <SettingsStep step="3" title="Buildings" :effect="effects.buildings" :inactive="noScale || !settings.buildings">
        <SettingsField hint="Roofs and walls large and high enough to be a building.">
          <template #label>
            <FieldHelp
              op="classify-ground"
              param="buildings"
              :value="settings.buildings"
              :default-value="CLASSIFY_DEFAULTS.buildings"
              >Find buildings</FieldHelp
            >
          </template>
          <label class="checkbox-row"
            ><input v-model="settings.buildings" type="checkbox" class="checkbox" /> Enabled</label
          >
        </SettingsField>
        <AdvancedDisclosure v-if="settings.buildings" label="3 · Buildings — advanced">
          <SettingsField label-for="cls-bh" unit="m" hint="Above the cloth, at the surface's highest point.">
            <template #label>
              <FieldHelp
                op="classify-ground"
                param="minBuildingHeight"
                :value="settings.minBuildingHeight"
                :default-value="CLASSIFY_DEFAULTS.minBuildingHeight"
                >Minimum height</FieldHelp
              >
            </template>
            <input
              id="cls-bh"
              v-model.number="settings.minBuildingHeight"
              :aria-invalid="numbers.bad.minBuildingHeight"
              type="number"
              min="0.5"
              max="100"
              step="0.5"
              class="field-input"
            />
          </SettingsField>
          <SettingsField label-for="cls-ba" unit="m²" hint="The surface of one roof or wall plane.">
            <template #label>
              <FieldHelp
                op="classify-ground"
                param="minBuildingArea"
                :value="settings.minBuildingArea"
                :default-value="CLASSIFY_DEFAULTS.minBuildingArea"
                >Minimum area</FieldHelp
              >
            </template>
            <input
              id="cls-ba"
              v-model.number="settings.minBuildingArea"
              :aria-invalid="numbers.bad.minBuildingArea"
              type="number"
              min="1"
              max="10000"
              step="5"
              class="field-input"
            />
          </SettingsField>
        </AdvancedDisclosure>
      </SettingsStep>
      <SettingsStep
        step="4"
        title="Vegetation"
        :effect="effects.vegetation"
        :inactive="noScale || !settings.vegetation"
      >
        <SettingsField hint="Trees, shrubs and low plants, by their height above the cloth.">
          <template #label>
            <FieldHelp
              op="classify-ground"
              param="vegetation"
              :value="settings.vegetation"
              :default-value="CLASSIFY_DEFAULTS.vegetation"
              >Find vegetation</FieldHelp
            >
          </template>
          <label class="checkbox-row"
            ><input v-model="settings.vegetation" type="checkbox" class="checkbox" /> Enabled</label
          >
        </SettingsField>
        <AdvancedDisclosure v-if="settings.vegetation" label="4 · Vegetation — advanced">
          <SettingsField label-for="cls-low" unit="m" hint="Low vegetation reaches at most this far above the cloth.">
            <template #label>
              <FieldHelp
                op="classify-ground"
                param="lowVegetationMax"
                :value="settings.lowVegetationMax"
                :default-value="CLASSIFY_DEFAULTS.lowVegetationMax"
                >Low up to</FieldHelp
              >
            </template>
            <input
              id="cls-low"
              v-model.number="settings.lowVegetationMax"
              :aria-invalid="numbers.bad.lowVegetationMax"
              type="number"
              min="0.1"
              max="50"
              step="0.5"
              class="field-input"
            />
          </SettingsField>
          <SettingsField label-for="cls-med" unit="m" hint="Medium vegetation up to this; higher is high vegetation.">
            <template #label>
              <FieldHelp
                op="classify-ground"
                param="mediumVegetationMax"
                :value="settings.mediumVegetationMax"
                :default-value="CLASSIFY_DEFAULTS.mediumVegetationMax"
                >Medium up to</FieldHelp
              >
            </template>
            <input
              id="cls-med"
              v-model.number="settings.mediumVegetationMax"
              :aria-invalid="numbers.bad.mediumVegetationMax"
              type="number"
              min="0.2"
              max="100"
              step="0.5"
              class="field-input"
            />
          </SettingsField>
        </AdvancedDisclosure>
      </SettingsStep>
    </template>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button
        class="btn btn-primary"
        :disabled="!source || noScale || !numbers.valid"
        :title="noScale ? 'Needs a georeference or scale bars' : numbers.reason"
        @click="run"
      >
        Classify
      </button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
