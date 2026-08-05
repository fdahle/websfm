<script setup>
import { computed, ref } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import SettingsField from './ui/SettingsField.vue'
import SettingsGroup from './ui/SettingsGroup.vue'
import AdvancedDisclosure from './ui/AdvancedDisclosure.vue'
import PresetCards from './ui/PresetCards.vue'
import GlossaryTerm from '../glossary/GlossaryTerm.vue'
import { useComputeSettings } from '../../composables/useComputeSettings.js'
import { useDatasetRecommendations } from '../../composables/useDatasetRecommendations.js'
import { DEPTHMAP_DEFAULTS, DEPTHMAP_QUALITY_META } from '../../core/defaults.user.js'
import { badgePreset } from '../../core/recommendUi.js'

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

// Quality is a first-class field whose values ARE the cards, so the dataset
// recommendation marks the card it points at instead of adding a second one that
// would offer the same setting twice. Marking is inert — the user still picks.
const qualityRec = computed(() => recommendations.value.depthmap?.quality ?? null)
const qualityCards = computed(
  () => badgePreset(DEPTHMAP_QUALITY_META, qualityRec.value?.value, { title: qualityRec.value?.reason }),
)
const qualityNote = computed(() => {
  const rec = qualityRec.value
  if (!rec) return ''
  const label = DEPTHMAP_QUALITY_META.find((p) => p.id === rec.value)?.label ?? rec.value
  return `Recommended: ${label} — ${rec.reason}`
})

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
    <PresetCards
      :model-value="settings.quality"
      :base-id="settings.quality"
      :presets="qualityCards"
      :note="qualityNote"
      @select="(id) => (settings.quality = id)"
    />

    <AdvancedDisclosure label="Advanced settings">
      <SettingsGroup title="Filtering">
        <SettingsField
          hint="Cleans per-image depth noise (drops flying pixels, smooths to the local median) before fusion.">
          <template #label>Speckle / median filter</template>
          <label class="checkbox-row"><input v-model="settings.speckleFilter" type="checkbox" class="checkbox" /> Enabled</label>
        </SettingsField>

        <SettingsField v-if="settings.speckleFilter" label="Speckle tolerance" label-for="filterRelTol" unit="%"
          hint="Drop a pixel whose depth differs from its 3×3 median by more than this. Lower = more aggressive.">
          <input id="filterRelTol" v-model.number="settings.filterRelTol" type="number" min="1" max="50" step="1" class="field-input" />
        </SettingsField>

        <SettingsField
          hint="Keeps only pixels whose depth other views independently agree with. Removes sky and vegetation, which no photometric gate can catch.">
          <template #label><GlossaryTerm id="depth-map">Cross-view consistency</GlossaryTerm></template>
          <label class="checkbox-row"><input v-model="settings.geomConsistency" type="checkbox" class="checkbox" /> Enabled</label>
        </SettingsField>

        <SettingsField v-if="settings.geomConsistency" label="Agreement tolerance" label-for="maxGeomCost" unit="px"
          hint="How closely another view's own depth must round-trip back to this pixel. Lower = stricter.">
          <input id="maxGeomCost" v-model.number="settings.maxGeomCost" type="number" min="0.1" max="10" step="0.1" class="field-input" />
        </SettingsField>

        <SettingsField v-if="settings.geomConsistency" label="Consistent views" label-for="minConsistent"
          hint="Minimum other views that must agree. Raise for cleaner but sparser clouds.">
          <input id="minConsistent" v-model.number="settings.minConsistent" type="number" min="1" max="8" step="1" class="field-input" />
        </SettingsField>

        <SettingsField v-if="settings.geomConsistency" label-for="minNcc"
          hint="Absolute photometric floor per pixel (0–1). Unlike the fusion gate this does not adapt to the data.">
          <template #label>
            Minimum <GlossaryTerm id="photometric-consistency">NCC</GlossaryTerm>
          </template>
          <input id="minNcc" v-model.number="settings.minNcc" type="number" min="0" max="0.9" step="0.05" class="field-input" />
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="Resolution & sources">
        <SettingsField label="Working resolution override" label-for="maxDim" unit="px"
          hint="Leave blank to derive from Quality. A memory pre-flight guards very large values.">
          <input id="maxDim" v-model.number="settings.maxDim" type="number" min="200" step="100" placeholder="auto" class="field-input" />
        </SettingsField>

        <SettingsField label="Source views per image" label-for="maxSources"
          hint="Neighbouring images compared against each reference (chosen by shared tie-points).">
          <input id="maxSources" v-model.number="settings.maxSources" type="number" min="1" max="16" step="1" class="field-input" />
        </SettingsField>

        <SettingsField label="Sources aggregated (best-K)" label-for="bestK"
          hint="Average the K best-matching sources per pixel. Blank = auto (≈half the sources, 1–4).">
          <input id="bestK" v-model.number="settings.bestK" type="number" min="1" max="16" step="1" placeholder="auto" class="field-input" />
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title="PatchMatch">
        <SettingsField label-for="window" unit="px"
          hint="Half-size of the correlation window (1–5 ⇒ 3×3…11×11). Larger helps low-texture surfaces.">
          <template #label>
            <GlossaryTerm id="patchmatch">Patch window radius</GlossaryTerm>
          </template>
          <input id="window" v-model.number="settings.window" type="number" min="1" max="5" step="1" class="field-input" />
        </SettingsField>

        <SettingsField label="Iterations (per level)" label-for="iterations"
          hint="Propagation/refinement sweeps at the finest pyramid level (coarser levels get more).">
          <input id="iterations" v-model.number="settings.iterations" type="number" min="1" max="8" step="1" class="field-input" />
        </SettingsField>
      </SettingsGroup>
    </AdvancedDisclosure>

    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" @click="run">Build Depth Maps</button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
