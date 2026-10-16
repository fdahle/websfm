<script setup>
import { ref, computed, onBeforeUnmount } from 'vue'
import { getParam } from '../../core/help/guide.js'
import { useGlossarySettings } from '../../composables/useGlossarySettings.js'
import { openHelp, leaveHelp, dropHelp, paramSpec } from '../../composables/useHelpStack.js'

// A modal field label that explains its setting: wrap the label text,
//   <FieldHelp op="match-features" param="maxNeighbors"
//     :value="settings.maxNeighbors" :default-value="MATCH_DEFAULTS.maxNeighbors">
//     Neighbours per image</FieldHelp>
// Hovering opens a pinnable popup (see useHelpStack.js) with the parameter's
// Guide section; the concepts that prose links (glossary `help:`, other operations
// `guide:`) open popups on top, so a label needs no separate GlossaryTerm.
// "Read more" opens the Guide modal scrolled to this parameter.
//
// `value` is the field's live value and `defaultValue` the code default (pass the
// *_DEFAULTS constant, not the markdown's), so the popup never drifts from the
// code. Leave both out for selects, whose raw values are ids, not labels; the
// Guide marker's default text shows instead. Missing entry or inline help off in
// Settings → plain label text.
const props = defineProps({
  op: { type: String, required: true },
  param: { type: String, required: true },
  value: { type: [String, Number, Boolean], default: null },
  defaultValue: { type: [String, Number, Boolean], default: null },
})

const { glossaryTermsEnabled } = useGlossarySettings()
const active = computed(() => glossaryTermsEnabled.value && !!getParam(props.op, props.param))
const anchorEl = ref(null)

function show() {
  if (!active.value) return
  openHelp(0, paramSpec(props.op, props.param, anchorEl.value,
    () => ({ value: props.value, defaultValue: props.defaultValue })))
}
function onLeave() { leaveHelp(anchorEl.value) }

onBeforeUnmount(() => dropHelp(anchorEl.value))
</script>

<template>
  <span
    ref="anchorEl"
    class="field-help"
    :class="{ 'field-help-plain': !active }"
    :tabindex="active ? 0 : undefined"
    @mouseenter="show"
    @mouseleave="onLeave"
    @focus="show"
    @blur="onLeave"
  ><slot /></span>
</template>

<style scoped>
/* Same affordance as GlossaryTerm: one dashed underline per hoverable label. */
.field-help {
  border-bottom: 1px dashed var(--text-dim);
  cursor: help;
}
.field-help:hover,
.field-help:focus-visible {
  color: var(--accent);
  border-color: var(--accent);
  outline: none;
}
.field-help-plain {
  border-bottom: none;
  cursor: inherit;
  color: inherit;
}
</style>
