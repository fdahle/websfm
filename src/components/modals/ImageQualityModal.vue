<script setup>
import { ref, computed } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import SettingsField from './ui/SettingsField.vue'
import SettingsGroup from './ui/SettingsGroup.vue'
import WarnBox from './ui/WarnBox.vue'
import DataTable from './ui/DataTable.vue'
import GlossaryTerm from '../glossary/GlossaryTerm.vue'
import { IMAGE_QUALITY_DEFAULTS } from '../../core/defaults.user.js'
import { qualityVerdicts } from '../../core/features/imageQuality.js'

// Image Quality (Tools ▸ Images ▾) — sharpness and exposure per image, judged
// against THIS batch's median (an absolute Laplacian variance depends on the
// scene's texture, so only the ranking within a flight means anything). Blurry
// frames from a moving drone are a common silent cause of thin or failed
// reconstructions. Scores persist on the images; the verdicts are recomputed here.
//
// Two follow-ups, both through existing paths: put the flagged images in an image
// group (display only — reversible), or remove them from the project (the usual
// confirm-before-delete). There is deliberately no separate "excluded" flag that
// some pipeline stages would honour and others not.
const props = defineProps({
  images: { type: Array, default: () => [] },
})
const emit = defineEmits(['close', 'estimate', 'group', 'remove'])

const minRelative = ref(IMAGE_QUALITY_DEFAULTS.minRelative)
const scored = computed(() => props.images.filter((img) => img.quality?.sharpness != null))
const verdicts = computed(() => {
  const list = qualityVerdicts(scored.value.map((img) => ({ id: img.id, ...img.quality })), { minRelative: minRelative.value })
  return new Map(list.map((v) => [v.id, v]))
})
const rows = computed(() => props.images.map((img) => {
  const v = verdicts.value.get(img.id)
  const q = img.quality
  return {
    id: img.id, name: img.name,
    relative: v?.relative ?? null,
    sharpness: q?.sharpness ?? null,
    exposure: q ? `${Math.round((q.underexposed ?? 0) * 100)}% / ${Math.round((q.overexposed ?? 0) * 100)}%` : '—',
    flags: v ? (v.flags.length ? v.flags.join(', ') : 'ok') : 'not scored',
    ok: v?.ok ?? null,
  }
}))
const columns = [
  { key: 'name', label: 'Image' },
  { key: 'relative', label: 'Sharpness vs median', align: 'right' },
  { key: 'exposure', label: 'Dark / blown' },
  { key: 'flags', label: 'Verdict' },
]
const flagged = computed(() => rows.value.filter((r) => r.ok === false).map((r) => r.id))
const unscored = computed(() => props.images.length - scored.value.length)

// The store files them under ONE "Low image quality" group (reused on later clicks,
// stores/images/imageGroups.js). Say it worked, and rest the button until the
// flagged set changes (new threshold or rescore) so a second click is not a no-op.
const groupedKey = ref('')
const flaggedKey = computed(() => flagged.value.join('|'))
const grouped = computed(() => !!flagged.value.length && groupedKey.value === flaggedKey.value)
function groupFlagged() {
  emit('group', flagged.value)
  groupedKey.value = flaggedKey.value
}
</script>

<template>
  <ModalShell title="Image Quality" width="760px" @close="emit('close')">
    <WarnBox v-if="!images.length">Import images first.</WarnBox>
    <template v-else>
      <SettingsGroup title="Score">
        <SettingsField :hint="unscored ? `${unscored} of ${images.length} images not scored yet.` : 'All images scored. Rescore after changing masks.'">
          <button type="button" class="btn" @click="emit('estimate', null)">
            {{ scored.length ? 'Rescore all images' : 'Score all images' }}
          </button>
        </SettingsField>
        <SettingsField label-for="iq-min" unit="× median sharpness"
          hint="Relative to this batch: 0.5 flags images half as sharp as the typical one.">
          <template #label><GlossaryTerm id="image-sharpness">Blurry below</GlossaryTerm></template>
          <input id="iq-min" v-model.number="minRelative" type="number" min="0.05" max="1" step="0.05" class="field-input" />
        </SettingsField>
      </SettingsGroup>
      <DataTable v-if="scored.length" :rows="rows" :columns="columns" sort-key="relative" sort-dir="asc">
        <template #cell-relative="{ row }">{{ row.relative == null ? '—' : row.relative.toFixed(2) }}</template>
        <template #cell-flags="{ row }"><span :class="{ bad: row.ok === false }">{{ row.flags }}</span></template>
      </DataTable>
      <p v-if="scored.length" class="field-hint">
        {{ flagged.length }} of {{ scored.length }} scored image(s) flagged.
      </p>
    </template>
    <template #footer>
      <button class="btn" :disabled="!flagged.length || grouped"
        :title="grouped ? 'The flagged images are in the “Low image quality” image group'
          : 'Put the flagged images in the “Low image quality” image group (display only)'"
        @click="groupFlagged">{{ grouped ? 'Grouped ✓' : 'Group flagged' }}</button>
      <button class="btn btn-danger" :disabled="!flagged.length" @click="emit('remove', flagged)">Remove flagged…</button>
      <button class="btn btn-primary" @click="emit('close')">Close</button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
<style scoped>
.bad { color: var(--danger); }
</style>
