<script setup>
import { storeToRefs } from 'pinia'
import { useHelpStore } from '../../stores/useHelpStore.js'
import HelpPanel from './HelpPanel.vue'

// Mounted once (see App.vue), renders nothing when the stack is empty.
const { stack } = storeToRefs(useHelpStore())
</script>

<template>
  <HelpPanel
    v-for="(id, index) in stack"
    :key="`${index}-${id}`"
    :id="id"
    :index="index"
    :depth-from-top="stack.length - 1 - index"
  />
</template>
