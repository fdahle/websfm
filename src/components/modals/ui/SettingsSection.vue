<script setup>
// A group of fields preceded by a separator (WS5). Replaces the loose `.section-sep`
// divs sprinkled between fields; renders the divider then its slotted fields.
defineProps({
  divider: { type: Boolean, default: true },
})
</script>

<template>
  <div v-if="divider" class="section-sep"></div>
  <slot />
</template>

<style scoped src="./modal.css"></style>
