<script setup>
import { computed, useSlots } from 'vue'
import { useStepLayout } from '../../../composables/useStepLayout.js'

// One numbered stage of a pipeline modal: "① Resize → ② Tile → ③ Detect → ④ Keep".
// It says *where in the order of operations* its fields act and what they do to this
// project's data right now (`effect`, computed by the modal). `inactive` dims the step
// when nothing it holds can matter in the current configuration — the fields stay
// editable, but the user sees why they're inert instead of tuning a dead knob.
//
// In a dialog with a step layout (useStepLayout.js; dev/planning/plan-dialog-layout.md)
// the step appears once: drawn only when it has everyday fields (the default slot) or is
// open; its `tuning` slot unfolds in place behind "⚙ n more" (`more`: how many fields
// it holds; 0 hides the toggle), with the long effect at the top. `effect` may then be
// { short, long }: the StepChain shows `short`. Without a layout it is drawn as before.
const props = defineProps({
  step: { type: [Number, String], required: true },
  title: { type: String, required: true },
  effect: { type: [String, Object], default: '' },
  inactive: { type: Boolean, default: false },
  more: { type: Number, default: null },
})
const slots = useSlots()
const layout = useStepLayout()
const long = computed(() => (typeof props.effect === 'string' ? props.effect : (props.effect?.long ?? '')))
const open = computed(() => !!layout && layout.isOpen(props.step))
const drawn = computed(() => !layout || !!slots.default || open.value)
const hasToggle = computed(
  () => !!layout && !layout.showAll.value && (!!slots.tuning || !slots.default) && props.more !== 0,
)
const moreLabel = computed(() =>
  open.value ? 'Less' : props.more ? `${props.more} more` : slots.tuning ? 'More' : 'Details',
)
</script>

<template>
  <div v-if="drawn" class="settings-step" :class="{ inactive }" :data-step-id="step">
    <div class="step-head">
      <span class="step-num">{{ step }}</span>
      <span class="step-title">{{ title }}</span>
      <button
        v-if="hasToggle"
        type="button"
        class="step-more"
        :aria-expanded="open"
        :aria-label="`${title}: ${open ? 'fold the settings' : 'show more settings'}`"
        @click="layout.toggle(step)"
      >
        ⚙ {{ moreLabel }} {{ open ? '▾' : '▸' }}
      </button>
    </div>
    <div v-if="!layout && (long || $slots.effect)" class="step-effect">
      <slot name="effect">{{ long }}</slot>
    </div>
    <div v-if="$slots.default" class="step-fields"><slot /></div>
    <!-- In a step layout the long effect leads into the step's tuning, after its
         everyday fields. -->
    <div v-if="layout && open && (long || $slots.effect)" class="step-effect step-detail">
      <slot name="effect">{{ long }}</slot>
    </div>
    <div v-if="layout && open && $slots.tuning" class="step-fields step-tuning"><slot name="tuning" /></div>
  </div>
</template>

<style scoped src="./modal.css"></style>
<style scoped>
.settings-step {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-left: 12px;
  border-left: 2px solid var(--panel-border);
}
.step-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: -23px;
}
.step-num {
  width: 20px;
  height: 20px;
  flex: none;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  color: #fff;
  background: var(--accent);
}
.step-title {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-dim);
}
.step-effect {
  font-size: 11px;
  line-height: 1.45;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
.step-more {
  margin-left: auto;
  border: none;
  background: none;
  padding: 0 2px;
  font: inherit;
  font-size: 11px;
  color: var(--text-dim);
  cursor: pointer;
  white-space: nowrap;
}
.step-more:hover {
  color: var(--accent);
}
.step-detail {
  color: var(--text-dim);
}
.step-tuning {
  padding-left: 10px;
  border-left: 2px dashed var(--panel-border);
}
.step-fields {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.settings-step.inactive .step-num {
  background: var(--text-dim);
}
.settings-step.inactive .step-effect {
  color: var(--text-dim);
}
.settings-step.inactive .step-fields {
  opacity: 0.6;
}
</style>
