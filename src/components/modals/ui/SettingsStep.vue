<script setup>
import { computed, onMounted, onUpdated, ref, useSlots } from 'vue'
import { useStepLayout } from '../../../composables/useStepLayout.js'

// One numbered stage of a pipeline modal: "① Resize → ② Tile → ③ Detect → ④ Keep".
// It says *where in the order of operations* its fields act and what they do to this
// project's data right now (`effect`, computed by the modal). `inactive` marks a step
// that cannot matter in the current configuration.
//
// In a dialog with a step layout (useStepLayout.js; dev/planning/plan-dialog-layout.md)
// every step is a group: its header (number · title · short fact, `effect` = { short,
// long }) opens and closes it. Open, it shows the long effect, its everyday fields (the
// default slot) and, while the footer's Show advanced settings is on, its advanced
// fields (the `tuning` slot, counted as they render: a field its own v-if leaves out
// is not counted; `more` 0 drops the slot). With the switch off, a gray note says how
// many are hidden (a note, not a link: the footer switch shows them). A step that is
// inactive dims only its fact: its fields stay as usable as any other. A step with
// everyday fields starts open. Without a layout it is drawn as before: always open, the
// effect line under the title, an inactive step dimmed.
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
const short = computed(() => (typeof props.effect === 'object' ? (props.effect?.short ?? '') : ''))
if (layout && slots.default) layout.startOpen(props.step)
const open = computed(() => !!layout && layout.isOpen(props.step))
const hasAdvanced = computed(() => !!slots.tuning && props.more !== 0)
// The advanced fields that render now: the part is kept in the page (hidden while Show
// advanced settings is off) so its fields can be counted.
const advancedEl = ref(null)
const advancedCount = ref(0)
const countAdvanced = () => {
  const n = advancedEl.value?.children.length ?? 0
  if (n !== advancedCount.value) advancedCount.value = n
}
onMounted(countAdvanced)
onUpdated(countAdvanced)
</script>

<template>
  <div v-if="!layout" class="settings-step" :class="{ inactive }">
    <div class="step-head">
      <span class="step-num">{{ step }}</span>
      <span class="step-title">{{ title }}</span>
    </div>
    <div v-if="long || $slots.effect" class="step-effect">
      <slot name="effect">{{ long }}</slot>
    </div>
    <div v-if="$slots.default" class="step-fields"><slot /></div>
  </div>

  <div v-else class="settings-step group" :class="{ open, off: inactive }" :data-step-id="step">
    <button
      type="button"
      class="step-head step-toggle"
      :aria-expanded="open"
      :aria-label="`${step}. ${title}${short ? `: ${short}` : ''}`"
      @click="layout.toggle(step)"
    >
      <span class="step-num">{{ step }}</span>
      <span class="step-title">{{ title }}</span>
      <span v-if="short" class="step-fact">{{ short }}</span>
      <span class="step-chevron" aria-hidden="true">{{ open ? '▾' : '▸' }}</span>
    </button>
    <template v-if="open">
      <div v-if="long || $slots.effect" class="step-effect step-detail">
        <slot name="effect">{{ long }}</slot>
      </div>
      <div v-if="$slots.default" class="step-fields"><slot /></div>
      <div v-if="hasAdvanced" v-show="layout.showAdvanced.value && advancedCount" class="step-advanced">
        <div class="step-advanced-label">Advanced</div>
        <div ref="advancedEl" class="step-fields"><slot name="tuning" /></div>
      </div>
      <div v-if="hasAdvanced && advancedCount && !layout.showAdvanced.value" class="step-advanced-hidden">
        {{ advancedCount }} advanced setting{{ advancedCount === 1 ? '' : 's' }} hidden
      </div>
    </template>
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
  white-space: nowrap;
}
.step-effect {
  font-size: 11px;
  line-height: 1.45;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
.step-fields {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
/* Without a layout: an inactive step is dimmed as a whole. */
.settings-step.inactive .step-num {
  background: var(--text-dim);
}
.settings-step.inactive .step-effect {
  color: var(--text-dim);
}
.settings-step.inactive .step-fields {
  opacity: 0.6;
}

/* In a step layout: the header is the group's toggle. */
.step-toggle {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  width: calc(100% + 23px);
}
.step-toggle:hover .step-title,
.step-toggle:hover .step-chevron {
  color: var(--accent);
}
.step-toggle:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 4px;
}
.step-fact {
  font-size: 11px;
  color: var(--text);
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.group.off .step-fact {
  color: var(--text-dim);
  font-style: italic;
}
.step-chevron {
  margin-left: auto;
  padding-left: 8px;
  font-size: 11px;
  color: var(--text-dim);
}
.group:not(.open) {
  border-left-color: transparent;
}
.step-detail {
  color: var(--text-dim);
}
.step-advanced {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--panel-border);
}
.step-advanced-label {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-dim);
}
.step-advanced-hidden {
  font-size: 10px;
  color: var(--text-dim);
}
</style>
