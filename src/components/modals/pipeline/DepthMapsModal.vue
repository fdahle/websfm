<script setup>
import { computed, ref } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import SettingsField from '../ui/SettingsField.vue'
import SettingsStep from '../ui/SettingsStep.vue'
import AdvancedDisclosure from '../ui/AdvancedDisclosure.vue'
import PresetCards from '../ui/PresetCards.vue'
import FieldHelp from '../../guide/FieldHelp.vue'
import { useComputeSettings } from '../../../composables/useComputeSettings.js'
import { useDatasetRecommendations } from '../../../composables/useDatasetRecommendations.js'
import { DEPTHMAP_DEFAULTS, DEPTHMAP_QUALITY_META } from '../../../core/defaults.user.js'
import { badgePreset } from '../../../core/recommendUi.js'
import { checkNumberFields } from '../../../utils/numberFields.js'
import { depthMapEffects } from '../../../core/stepEffects/depthMaps.js'

const props = defineProps({
  // Every image (the largest original sets what Quality means) and how many have a
  // pose in the sparse model (one depth map each), for the steps' effect lines.
  images: { type: Array, default: () => [] },
  registered: { type: Number, default: 0 },
  // The project's scene type: what a blank "Consistent views" (auto) resolves to.
  sceneType: { type: String, default: null },
})
const emit = defineEmits(['close', 'run'])

// Memory budget + GPU are machine-level (Settings ▸ Compute); read here, apply on run.
const { memBudgetBytes, useGpu } = useComputeSettings()
const { recommendations } = useDatasetRecommendations()

// Stage A — Build Depth Maps (PatchMatch MVS). Quality is the primary control
// (Metashape-style relative preset → the store resolves it to a working maxDim
// from the largest native image dimension). Advanced overrides are optional:
// maxDim (null ⇒ derive from quality) and bestK (null ⇒ auto per image).
// Defaults are the single source of truth in core/defaults.user.js; run() below
// transforms filterRelTol (%) and drops null overrides before dispatch.
const settings = ref({ ...DEPTHMAP_DEFAULTS })
// Run stays disabled while a field is blank or out of range (rules = the inputs'
// own min/max/step). The two overrides may be blank (= auto); fields hidden by
// their toggle are not checked.
const numbers = computed(() => {
  const s = settings.value
  return checkNumberFields(s, {
    filterRelTol: { label: 'Speckle tolerance', min: 1, max: 50, integer: true, when: s.speckleFilter },
    maxGeomCost: { label: 'Agreement tolerance', min: 0.1, max: 10, when: s.geomConsistency },
    minConsistent: {
      label: 'Consistent views',
      min: 1,
      max: 8,
      integer: true,
      optional: true,
      when: s.geomConsistency,
    },
    minGeomAngleDeg: { label: 'Minimum parallax', min: 0, max: 20, when: s.geomConsistency },
    minNcc: { label: 'Minimum NCC', min: 0, max: 0.9, when: s.geomConsistency },
    maxDim: { label: 'Working resolution override', min: 200, integer: true, optional: true },
    maxSources: { label: 'Source views per image', min: 1, max: 16, integer: true },
    bestK: { label: 'Sources aggregated (best-K)', min: 1, max: 16, integer: true, optional: true },
    window: { label: 'Patch window radius', min: 1, max: 5, integer: true },
    iterations: { label: 'Iterations (per level)', min: 1, max: 8, integer: true },
  })
})

// Quality is a first-class field whose values ARE the cards, so the dataset
// recommendation marks the card it points at instead of adding a second one that
// would offer the same setting twice. Marking is inert — the user still picks.
const qualityRec = computed(() => recommendations.value.depthmap?.quality ?? null)
const qualityCards = computed(() =>
  badgePreset(DEPTHMAP_QUALITY_META, qualityRec.value?.value, { title: qualityRec.value?.reason }),
)
// A working-resolution override (Advanced) replaces what Quality would derive —
// the store only maps quality → maxDim when no override is set — so say that on
// the cards rather than leave a selected card that does nothing.
const resolutionOverridden = computed(() => settings.value.maxDim > 0)
function selectQuality(id) {
  settings.value.quality = id
  // Picking a card IS a resolution choice; drop the override that would mask it.
  settings.value.maxDim = null
}
const qualityNote = computed(() => {
  if (resolutionOverridden.value) {
    return `Overridden: the working resolution is fixed at ${settings.value.maxDim} px under Advanced. Pick a card to use Quality again.`
  }
  const rec = qualityRec.value
  if (!rec) return ''
  const label = DEPTHMAP_QUALITY_META.find((p) => p.id === rec.value)?.label ?? rec.value
  return `Recommended: ${label} — ${rec.reason}`
})

// What each step does to this project (core/stepEffects/depthMaps.js).
const nativeLong = computed(() =>
  props.images.reduce((m, im) => Math.max(m, im.meta?.width || 0, im.meta?.height || 0), 0),
)
const effects = computed(() =>
  depthMapEffects(settings.value, {
    registered: props.registered,
    nativeLong: nativeLong.value,
    sceneType: props.sceneType,
    gpu: useGpu.value,
  }),
)

function run() {
  const { filterRelTol, maxDim, bestK, ...rest } = settings.value
  const out = {
    ...rest,
    filterRelTol: filterRelTol / 100,
    useGpu: useGpu.value,
    memBudgetBytes: memBudgetBytes.value,
  }
  // Only forward the numeric overrides when actually set — otherwise let the
  // store/worker derive them (maxDim from quality, bestK per image).
  if (maxDim > 0) out.maxDim = maxDim
  if (bestK > 0) out.bestK = bestK
  emit('run', out)
}
</script>

<template>
  <ModalShell title="Build Depth Maps" @close="emit('close')">
    <!-- Cards, not a select: no value/default on the FieldHelp (the Guide marker's default shows). -->
    <div class="field-label"><FieldHelp op="depth-maps" param="quality">Quality</FieldHelp></div>
    <PresetCards
      :model-value="settings.quality"
      :base-id="settings.quality"
      :presets="qualityCards"
      :note="qualityNote"
      @select="selectQuality"
    />

    <AdvancedDisclosure label="Advanced settings">
      <SettingsStep step="1" title="Working resolution and source views" :effect="effects.resolution">
        <SettingsField
          label-for="maxDim"
          unit="px"
          hint="Leave blank to derive from Quality. A memory pre-flight guards very large values."
        >
          <template #label
            ><FieldHelp
              op="depth-maps"
              param="maxDim"
              :value="settings.maxDim || 'auto'"
              :default-value="DEPTHMAP_DEFAULTS.maxDim || 'auto'"
              >Working resolution override</FieldHelp
            ></template
          >
          <input
            id="maxDim"
            v-model.number="settings.maxDim"
            :aria-invalid="numbers.bad.maxDim"
            type="number"
            min="200"
            step="100"
            placeholder="auto"
            class="field-input"
          />
        </SettingsField>

        <SettingsField
          label-for="maxSources"
          hint="Neighbouring images compared against each reference (chosen by shared tie-points)."
        >
          <template #label
            ><FieldHelp
              op="depth-maps"
              param="maxSources"
              :value="settings.maxSources"
              :default-value="DEPTHMAP_DEFAULTS.maxSources"
              >Source views per image</FieldHelp
            ></template
          >
          <input
            id="maxSources"
            v-model.number="settings.maxSources"
            :aria-invalid="numbers.bad.maxSources"
            type="number"
            min="1"
            max="16"
            step="1"
            class="field-input"
          />
        </SettingsField>

        <SettingsField
          label-for="bestK"
          hint="Average the K best-matching sources per pixel. Blank = auto (≈half the sources, 1–4)."
        >
          <template #label
            ><FieldHelp
              op="depth-maps"
              param="bestK"
              :value="settings.bestK || 'auto'"
              :default-value="DEPTHMAP_DEFAULTS.bestK || 'auto'"
              >Sources aggregated (best-K)</FieldHelp
            ></template
          >
          <input
            id="bestK"
            v-model.number="settings.bestK"
            :aria-invalid="numbers.bad.bestK"
            type="number"
            min="1"
            max="16"
            step="1"
            placeholder="auto"
            class="field-input"
          />
        </SettingsField>
      </SettingsStep>

      <SettingsStep step="2" title="PatchMatch" :effect="effects.patchMatch">
        <SettingsField
          label-for="viewSelection"
          hint="Which neighbouring views score each pixel. ACMH is more accurate and complete, but slower — several times so without a GPU."
        >
          <template #label>
            <FieldHelp op="depth-maps" param="viewSelection">View selection</FieldHelp>
          </template>
          <select id="viewSelection" v-model="settings.viewSelection" class="field-select">
            <option value="auto">Auto (ACMH on the GPU, best-K without one)</option>
            <option value="acmh">ACMH</option>
            <option value="bestk">Best-K</option>
          </select>
        </SettingsField>

        <SettingsField
          label-for="window"
          unit="px"
          hint="Half-size of the correlation window (1–5 ⇒ 3×3…11×11). Larger helps low-texture surfaces."
        >
          <template #label>
            <FieldHelp op="depth-maps" param="window" :value="settings.window" :default-value="DEPTHMAP_DEFAULTS.window"
              >Patch window radius</FieldHelp
            >
          </template>
          <input
            id="window"
            v-model.number="settings.window"
            :aria-invalid="numbers.bad.window"
            type="number"
            min="1"
            max="5"
            step="1"
            class="field-input"
          />
        </SettingsField>

        <SettingsField
          label-for="iterations"
          hint="Propagation/refinement sweeps at the finest pyramid level (coarser levels get more)."
        >
          <template #label
            ><FieldHelp
              op="depth-maps"
              param="iterations"
              :value="settings.iterations"
              :default-value="DEPTHMAP_DEFAULTS.iterations"
              >Iterations (per level)</FieldHelp
            ></template
          >
          <input
            id="iterations"
            v-model.number="settings.iterations"
            :aria-invalid="numbers.bad.iterations"
            type="number"
            min="1"
            max="8"
            step="1"
            class="field-input"
          />
        </SettingsField>
      </SettingsStep>

      <SettingsStep step="3" title="Clean each depth map" :effect="effects.speckle" :inactive="!settings.speckleFilter">
        <SettingsField
          hint="Cleans per-image depth noise (drops flying pixels, smooths to the local median) before fusion."
        >
          <template #label
            ><FieldHelp
              op="depth-maps"
              param="speckleFilter"
              :value="settings.speckleFilter"
              :default-value="DEPTHMAP_DEFAULTS.speckleFilter"
              >Speckle / median filter</FieldHelp
            ></template
          >
          <label class="checkbox-row"
            ><input v-model="settings.speckleFilter" type="checkbox" class="checkbox" /> Enabled</label
          >
        </SettingsField>

        <SettingsField
          v-if="settings.speckleFilter"
          label-for="filterRelTol"
          unit="%"
          hint="Drop a pixel whose depth differs from its 3×3 median by more than this. Lower = more aggressive."
        >
          <template #label
            ><FieldHelp
              op="depth-maps"
              param="filterRelTol"
              :value="settings.filterRelTol"
              :default-value="DEPTHMAP_DEFAULTS.filterRelTol"
              >Speckle tolerance</FieldHelp
            ></template
          >
          <input
            id="filterRelTol"
            v-model.number="settings.filterRelTol"
            :aria-invalid="numbers.bad.filterRelTol"
            type="number"
            min="1"
            max="50"
            step="1"
            class="field-input"
          />
        </SettingsField>
      </SettingsStep>

      <SettingsStep
        step="4"
        title="Check across views"
        :effect="effects.crossView"
        :inactive="!settings.geomConsistency"
      >
        <SettingsField
          hint="Keeps only pixels whose depth other views independently agree with. Removes sky and vegetation, which no photometric gate can catch."
        >
          <template #label
            ><FieldHelp
              op="depth-maps"
              param="geomConsistency"
              :value="settings.geomConsistency"
              :default-value="DEPTHMAP_DEFAULTS.geomConsistency"
              >Cross-view consistency</FieldHelp
            ></template
          >
          <label class="checkbox-row"
            ><input v-model="settings.geomConsistency" type="checkbox" class="checkbox" /> Enabled</label
          >
        </SettingsField>

        <SettingsField
          v-if="settings.geomConsistency"
          label-for="maxGeomCost"
          unit="px"
          hint="How closely another view's own depth must round-trip back to this pixel. Lower = stricter."
        >
          <template #label
            ><FieldHelp
              op="depth-maps"
              param="maxGeomCost"
              :value="settings.maxGeomCost"
              :default-value="DEPTHMAP_DEFAULTS.maxGeomCost"
              >Agreement tolerance</FieldHelp
            ></template
          >
          <input
            id="maxGeomCost"
            v-model.number="settings.maxGeomCost"
            :aria-invalid="numbers.bad.maxGeomCost"
            type="number"
            min="0.1"
            max="10"
            step="0.1"
            class="field-input"
          />
        </SettingsField>

        <SettingsField
          v-if="settings.geomConsistency"
          label-for="minConsistent"
          hint="Minimum other views that must agree. Blank = auto: 1 for object capture, 2 for aerial / mapping."
        >
          <template #label
            ><FieldHelp
              op="depth-maps"
              param="minConsistent"
              :value="settings.minConsistent || 'auto'"
              :default-value="DEPTHMAP_DEFAULTS.minConsistent || 'auto'"
              >Consistent views</FieldHelp
            ></template
          >
          <input
            id="minConsistent"
            v-model.number="settings.minConsistent"
            :aria-invalid="numbers.bad.minConsistent"
            type="number"
            min="1"
            max="8"
            step="1"
            placeholder="auto"
            class="field-input"
          />
        </SettingsField>

        <SettingsField
          v-if="settings.geomConsistency"
          label-for="minGeomAngleDeg"
          unit="°"
          hint="A view only counts if it sees the point from at least this angle apart. 0 disables."
        >
          <template #label
            ><FieldHelp
              op="depth-maps"
              param="minGeomAngleDeg"
              :value="settings.minGeomAngleDeg"
              :default-value="DEPTHMAP_DEFAULTS.minGeomAngleDeg"
              >Minimum parallax</FieldHelp
            ></template
          >
          <input
            id="minGeomAngleDeg"
            v-model.number="settings.minGeomAngleDeg"
            :aria-invalid="numbers.bad.minGeomAngleDeg"
            type="number"
            min="0"
            max="20"
            step="0.5"
            class="field-input"
          />
        </SettingsField>

        <SettingsField
          v-if="settings.geomConsistency"
          label-for="minNcc"
          hint="Absolute photometric floor per pixel (0–1). The dense cloud's cost gate is only a loose backstop above it."
        >
          <template #label
            ><FieldHelp
              op="depth-maps"
              param="minNcc"
              :value="settings.minNcc"
              :default-value="DEPTHMAP_DEFAULTS.minNcc"
              >Minimum NCC</FieldHelp
            ></template
          >
          <input
            id="minNcc"
            v-model.number="settings.minNcc"
            :aria-invalid="numbers.bad.minNcc"
            type="number"
            min="0"
            max="0.9"
            step="0.05"
            class="field-input"
          />
        </SettingsField>
      </SettingsStep>
    </AdvancedDisclosure>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!numbers.valid" :title="numbers.reason" @click="run">
        Build Depth Maps
      </button>
    </template>
  </ModalShell>
</template>

<style scoped src="../ui/modal.css"></style>
