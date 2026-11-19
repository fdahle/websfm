<script setup>
import { computed } from 'vue'
import ModalShell from '../ui/ModalShell.vue'
import SegmentedControl from '../ui/SegmentedControl.vue'
import { useI18n } from '../../../composables/useI18n.js'
// Import ▸ SfM Project: which tool the files come from, and where they are. COLMAP and
// Other SfM lead to InteropImportModal, Metashape to MetashapeImportModal; each shows
// what the files hold and asks what of it to import. `kind` is the format ('colmap',
// 'metashape', 'other'); emits `update:kind` when it changes and `choose` with the
// choice's id.
const props = defineProps({ kind: { type: String, default: 'colmap' } })
defineEmits(['close', 'choose', 'update:kind'])
const { t } = useI18n()
const FORMATS = ['colmap', 'metashape', 'other']
const CHOICES = { colmap: ['files', 'folder'], metashape: ['xml', 'psz', 'folder'], other: ['files', 'folder'] }
const format = computed(() => (FORMATS.includes(props.kind) ? props.kind : 'colmap'))
const formats = computed(() => FORMATS.map((id) => ({ id, label: t(`importSfm.format.${id}`) })))
const choices = computed(() =>
  CHOICES[format.value].map((id) => ({
    id,
    title: t(`importSfm.${format.value}.${id}Title`),
    text: t(`importSfm.${format.value}.${id}`),
  })),
)
</script>

<template>
  <ModalShell :title="t('importSfm.title')" @close="$emit('close')">
    <SegmentedControl
      class="formats"
      :model-value="format"
      :options="formats"
      @update:model-value="$emit('update:kind', $event)"
    />
    <p class="hint">{{ t(`importSfm.${format}.hint`) }}</p>
    <div class="choices" :style="{ gridTemplateColumns: `repeat(${choices.length}, 1fr)` }">
      <button v-for="c in choices" :key="c.id" class="choice" type="button" @click="$emit('choose', c.id)">
        <strong>{{ c.title }}</strong><span>{{ c.text }}</span>
      </button>
    </div>
    <template #footer
      ><button class="btn" @click="$emit('close')">{{ t('common.cancel') }}</button></template
    >
  </ModalShell>
</template>
<style scoped src="../ui/modal.css"></style>
<style scoped>
.formats {
  margin-bottom: 12px;
}
.hint {
  color: var(--text-dim);
  font-size: 13px;
  margin-top: 0;
}
.choices {
  display: grid;
  gap: 12px;
}
.choice {
  text-align: left;
  padding: 16px;
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  background: var(--panel);
  color: var(--text);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.choice:hover {
  border-color: var(--accent);
}
.choice span {
  color: var(--text-dim);
  font-size: 12px;
}
</style>
