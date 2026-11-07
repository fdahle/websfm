<script setup>
import { computed } from 'vue'
import { experimentalTitle } from '../../core/help/experimental.js'

// "Experimental" beside a feature whose results are not yet checked on enough real data
// (core/help/experimental.js says which, and what is still open).
const props = defineProps({ id: { type: String, required: true } })
const title = computed(() => experimentalTitle(props.id))
</script>

<template>
  <span v-if="title" class="experimental-badge" :title="title">Experimental</span>
</template>

<style scoped>
.experimental-badge {
  display: inline-block;
  margin-left: 6px;
  padding: 0 5px;
  border: 1px solid rgba(230, 160, 30, 0.7);
  border-radius: 3px;
  color: rgb(214, 140, 20);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  line-height: 1.5;
  text-transform: uppercase;
  vertical-align: middle;
  white-space: nowrap;
  cursor: default;
}
</style>
