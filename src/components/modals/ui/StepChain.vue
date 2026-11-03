<script setup>
import { nextTick, ref } from 'vue'
import { useStepLayout } from '../../../composables/useStepLayout.js'

// The run at a glance (dev/planning/plan-dialog-layout.md): one chip per step, in run
// order, with the step's short fact ("1,500 px · 8 views"); an inactive step dims. A
// chip opens its step in place (useStepLayout) and scrolls to it; its tooltip is the
// step's long effect.
//   steps: [{ step, title, short, long, inactive }]
defineProps({ steps: { type: Array, required: true } })
const root = ref(null)
const layout = useStepLayout()

async function show(step) {
  layout?.open(step)
  await nextTick()
  root.value
    ?.closest('[role="dialog"]')
    ?.querySelector(`[data-step-id="${step}"]`)
    ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
}
</script>

<template>
  <div ref="root" class="step-chain" role="group" aria-label="What the run does">
    <template v-for="(s, i) in steps" :key="s.step">
      <span v-if="i" class="chain-arrow" aria-hidden="true">→</span>
      <button
        type="button"
        class="chain-chip"
        :class="{ dim: s.inactive }"
        :title="`${s.title}: ${s.long}`"
        :aria-label="`Step ${s.step}, ${s.title}: ${s.short}`"
        @click="show(s.step)"
      >
        <span class="chain-n">{{ s.step }}</span
        >{{ s.short }}
      </button>
    </template>
  </div>
</template>

<style scoped>
.step-chain {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
.chain-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border: 1px solid var(--panel-border);
  border-radius: 12px;
  background: none;
  font: inherit;
  font-size: 11px;
  color: var(--text);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  cursor: pointer;
}
.chain-chip:hover {
  border-color: var(--accent);
}
.chain-chip.dim {
  color: var(--text-dim);
  border-style: dashed;
}
.chain-n {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 9px;
  font-weight: 700;
  color: #fff;
  background: var(--accent);
}
.chain-chip.dim .chain-n {
  background: var(--text-dim);
}
.chain-arrow {
  font-size: 11px;
  color: var(--text-dim);
}
</style>
