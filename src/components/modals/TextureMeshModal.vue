<script setup>
import { ref, computed } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import SettingsField from './ui/SettingsField.vue'
import SettingsGroup from './ui/SettingsGroup.vue'
import AdvancedDisclosure from './ui/AdvancedDisclosure.vue'
import NoSourceWarn from './ui/NoSourceWarn.vue'
import SourcePicker from './ui/SourcePicker.vue'
import FieldHelp from '../guide/FieldHelp.vue'
import { useSourcePick, meshOptionLabel } from '../../composables/useSourcePick.js'
import { TEXTURE_DEFAULTS } from '../../core/defaults.user.js'
import { useComputeSettings } from '../../composables/useComputeSettings.js'

// Texture Mesh (Tools ▸ Mesh ▾): a photo texture from the registered cameras
// (core/products/texture/, dev/planning/plan-texture.md). Non-destructive: adds a NEW
// textured mesh.
const props = defineProps({
  meshes: { type: Array, default: () => [] },
  initialId: { type: String, default: null },
  cameraCount: { type: Number, default: 0 },
})
const emit = defineEmits(['close', 'run'])

const settings = ref({ ...TEXTURE_DEFAULTS })
// Settings ▸ Compute: the WebGPU depth pass and the memory gate the page count obeys.
const { useGpu, memBudgetBytes } = useComputeSettings()
const { id: sourceId, item: source } = useSourcePick(() => props.meshes, { initialId: props.initialId })
const PAGE_SIZES = [2048, 4096, 8192]
const UNSEEN = [{ value: 'colour', label: 'Flat colour' }, { value: 'remove', label: 'Remove' }]
const RESOLUTIONS = [{ value: 1, label: 'Native photo pixels' }, { value: 0.5, label: 'Half' }, { value: 0.25, label: 'Quarter' }]
const valid = computed(() => source.value && props.cameraCount > 0 && settings.value.maxPages >= 1)
const textured = computed(() => !!source.value?.texture)

function run() {
  const s = settings.value
  emit('run', {
    sourceId: sourceId.value,
    settings: {
      pageSize: s.pageSize, maxPages: Math.max(1, Math.round(s.maxPages)), maxScale: s.maxScale,
      smoothness: Math.max(0, s.smoothness), levelColours: !!s.levelColours, useMasks: !!s.useMasks, unseen: s.unseen,
      photoConsistency: !!s.photoConsistency,
      useGpu: !!useGpu.value, memBudgetBytes: memBudgetBytes.value,
    },
    name: `${source.value?.name ?? 'Mesh'} (textured)`,
  })
}
</script>

<template>
  <ModalShell title="Texture Mesh" @close="emit('close')">
    <NoSourceWarn v-if="!meshes.length" kind="mesh" />
    <template v-else>
      <SettingsGroup title="Source">
        <SourcePicker id="tex-src" v-model="sourceId" label="Mesh" :items="meshes" :option-label="meshOptionLabel"
          hint="The result is a new textured mesh; this one is left untouched." />
        <p v-if="textured" class="field-hint">This mesh is already textured; texturing it again starts from its geometry.</p>
        <p v-if="!cameraCount" class="warn-box">Texturing needs registered cameras: build the sparse model first.</p>
      </SettingsGroup>
      <SettingsGroup title="Atlas">
        <SettingsField label-for="tex-res">
          <template #label><FieldHelp op="texture-mesh" param="maxScale">Texture resolution</FieldHelp></template>
          <select id="tex-res" v-model.number="settings.maxScale" class="field-input field-select">
            <option v-for="r in RESOLUTIONS" :key="r.value" :value="r.value">{{ r.label }}</option>
          </select>
        </SettingsField>
        <SettingsField label-for="tex-page" unit="px">
          <template #label><FieldHelp op="texture-mesh" param="pageSize">Page size</FieldHelp></template>
          <select id="tex-page" v-model.number="settings.pageSize" class="field-input field-select">
            <option v-for="p in PAGE_SIZES" :key="p" :value="p">{{ p }} × {{ p }}</option>
          </select>
        </SettingsField>
        <SettingsField label-for="tex-pages" unit="pages">
          <template #label><FieldHelp op="texture-mesh" param="maxPages" :value="settings.maxPages" :default-value="TEXTURE_DEFAULTS.maxPages">Maximum pages</FieldHelp></template>
          <input id="tex-pages" v-model.number="settings.maxPages" type="number" min="1" max="64" step="1" class="field-input" />
        </SettingsField>
      </SettingsGroup>
      <SettingsGroup title="Colour">
        <SettingsField hint="Matches the exposure and white balance of neighbouring photos.">
          <template #label><FieldHelp op="texture-mesh" param="levelColours" :value="settings.levelColours" :default-value="TEXTURE_DEFAULTS.levelColours">Level colours</FieldHelp></template>
          <label class="checkbox-row"><input v-model="settings.levelColours" type="checkbox" class="checkbox" /> Balance the photos</label>
        </SettingsField>
        <SettingsField hint="Masked pixels (people, sky, the drone's legs) are never used.">
          <template #label><FieldHelp op="texture-mesh" param="useMasks" :value="settings.useMasks" :default-value="TEXTURE_DEFAULTS.useMasks">Use masks</FieldHelp></template>
          <label class="checkbox-row"><input v-model="settings.useMasks" type="checkbox" class="checkbox" /> Leave masked pixels out</label>
        </SettingsField>
        <SettingsField hint="For people, vehicles or anything else that moved between photos.">
          <template #label><FieldHelp op="texture-mesh" param="photoConsistency" :value="settings.photoConsistency" :default-value="TEXTURE_DEFAULTS.photoConsistency">Ignore what only some photos see</FieldHelp></template>
          <label class="checkbox-row"><input v-model="settings.photoConsistency" type="checkbox" class="checkbox" /> Check each face's photos against each other</label>
        </SettingsField>
        <SettingsField label-for="tex-unseen">
          <template #label><FieldHelp op="texture-mesh" param="unseen">Faces no photo sees</FieldHelp></template>
          <select id="tex-unseen" v-model="settings.unseen" class="field-input field-select">
            <option v-for="u in UNSEEN" :key="u.value" :value="u.value">{{ u.label }}</option>
          </select>
        </SettingsField>
      </SettingsGroup>
      <AdvancedDisclosure label="Advanced settings">
        <SettingsGroup>
          <SettingsField label-for="tex-smooth">
            <template #label><FieldHelp op="texture-mesh" param="smoothness" :value="settings.smoothness" :default-value="TEXTURE_DEFAULTS.smoothness">Seam penalty</FieldHelp></template>
            <input id="tex-smooth" v-model.number="settings.smoothness" type="number" min="0" max="5" step="0.1" class="field-input" />
          </SettingsField>
        </SettingsGroup>
      </AdvancedDisclosure>
      <p v-if="source" class="field-hint">
        {{ source.count.toLocaleString() }} triangles from {{ cameraCount }} cameras.
        A mesh of a few hundred thousand triangles textures best: decimate a large mesh first.
      </p>
    </template>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!valid" @click="run">Texture</button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
