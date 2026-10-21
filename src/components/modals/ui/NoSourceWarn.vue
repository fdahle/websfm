<script setup>
// The "nothing to act on" notice of the cloud / mesh tool dialogs, worded once.
//   kind 'mesh'  — no mesh yet (Tools ▸ Mesh ▾)
//        'cloud' — no dense cloud yet (Tools ▸ Point Cloud ▾)
import WarnBox from './WarnBox.vue'

defineProps({ kind: { type: String, default: 'cloud' } })
</script>

<template>
  <WarnBox v-if="kind === 'mesh'"
    >No mesh yet. Build one with <strong>Reconstruct ▸ Mesh</strong> or import one.</WarnBox
  >
  <WarnBox v-else>No dense cloud yet. Build one with <strong>Dense Model</strong> or import one.</WarnBox>
</template>
