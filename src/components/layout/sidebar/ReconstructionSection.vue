<script setup>
import { storeToRefs } from 'pinia'
import { useReconstructionStore } from '../../../stores/useReconstructionStore.js'
import CloudRows from './CloudRows.vue'

// The *model* — sparse clouds, computed or COLMAP-imported. It gets its own
// section (rather than being filed under Products as "just another output")
// because `mainSparseCloud` is a first-class role with a set-as-main action, and
// it's the layer you spend all your time inspecting.
defineProps({
  open: { type: Boolean, default: true },
  clouds: { type: Array, default: () => [] }, // kind:'sparse' only
})
const emit = defineEmits(['toggle'])
// Last run: 'idle'|'running'|'done'|'error'
const { reconStatus } = storeToRefs(useReconstructionStore())
</script>

<template>
  <div class="section">
    <button class="section-hd" @click="emit('toggle')">
      <span class="chevron">{{ open ? '▾' : '▸' }}</span>
      <span class="section-name">Reconstruction</span>
      <span v-if="reconStatus === 'running'" class="status-dot running"></span>
      <span v-else-if="reconStatus === 'error'" class="status-dot error"></span>
      <span v-else-if="clouds.length" class="badge">{{ clouds.length }}</span>
    </button>
    <ul v-if="open" class="item-list">
      <CloudRows :clouds="clouds" />
      <li v-if="reconStatus === 'running' && !clouds.length" class="empty">Reconstructing…</li>
      <li v-else-if="!clouds.length" class="empty">No sparse model yet</li>
    </ul>
  </div>
</template>

<style scoped src="./sidebar-sections.css"></style>
