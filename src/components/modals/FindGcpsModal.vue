<script setup>
import { computed, ref } from 'vue'
import ModalShell from './ui/ModalShell.vue'
import WarnBox from './ui/WarnBox.vue'

const props = defineProps({
  hasRelativeOrtho: { type: Boolean, default: false },
  referenceOrthos: { type: Array, default: () => [] },
})

const emit = defineEmits(['close'])
const selectedReferenceId = ref(props.referenceOrthos[0]?.id ?? '')
const ready = computed(() => props.hasRelativeOrtho && !!selectedReferenceId.value)
</script>

<template>
  <ModalShell title="Find GCPs" @close="emit('close')">
    <p class="intro">
      Match the relative orthophoto against a modern georeferenced orthophoto and
      create candidate ground-control points for review.
    </p>

    <label class="field">
      <span class="field-label">Relative orthophoto</span>
      <span class="source-value">{{ hasRelativeOrtho ? 'Current project orthophoto' : 'Not available' }}</span>
      <span class="field-hint">Build an orthophoto in the local frame first.</span>
    </label>

    <label class="field">
      <span class="field-label">Reference orthophoto</span>
      <select v-model="selectedReferenceId" class="field-input field-select" :disabled="!referenceOrthos.length">
        <option value="" disabled>Select a reference orthophoto</option>
        <option v-for="r in referenceOrthos" :key="r.id" :value="r.id">{{ r.name }}</option>
      </select>
      <span class="field-hint">Import a georeferenced modern orthophoto under Reference Data.</span>
    </label>

    <WarnBox>
      Automatic matching is a workflow mockup for now. No GCPs will be created yet.
      You can already import or mark GCPs manually, then use <b>Georeference</b>.
    </WarnBox>

    <template #footer>
      <button class="btn" @click="emit('close')">Close</button>
      <button class="btn btn-primary" disabled :title="ready ? 'Automatic matching is not implemented yet' : 'A relative and reference orthophoto are required'">
        Find candidates
      </button>
    </template>
  </ModalShell>
</template>

<style scoped src="./ui/modal.css"></style>
<style scoped>
.intro { margin: 0; font-size: 13px; line-height: 1.5; color: var(--text); }
.source-value {
  width: fit-content;
  min-width: 220px;
  padding: 5px 8px;
  border: 1px solid var(--panel-border);
  border-radius: 5px;
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
}
.btn:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
