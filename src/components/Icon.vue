<script setup>
import { computed } from 'vue'
import { icons } from '../utils/icons.js'

const props = defineProps({
  name: { type: String, required: true },
})

const inner = computed(() => icons[props.name] || '')
</script>

<template>
  <svg
    class="icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    v-html="inner"
  />
</template>

<style scoped>
.icon {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
