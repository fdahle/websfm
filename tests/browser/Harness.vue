<script setup>
import { ref } from 'vue'
import ConfirmModal from '/src/components/modals/ConfirmModal.vue'
import ModalShell from '/src/components/modals/ui/ModalShell.vue'
const open = ref(false), nested = ref(false), confirmed = ref(false)
</script>
<template>
  <button id="launch" @click="open = true">Open dialog</button>
  <output id="confirmed">{{ confirmed }}</output>
  <ModalShell v-if="open" title="Outer dialog" @close="open = false">
    <input aria-label="Visible field" />
    <input style="display:none" aria-label="Hidden field" />
    <button id="delete" @click="nested = true">Delete project</button>
    <template #footer><button @click="open = false">Close outer</button></template>
  </ModalShell>
  <ConfirmModal v-if="nested" title="Delete project?" danger @cancel="nested = false"
    @confirm="confirmed = true; nested = false" />
</template>
