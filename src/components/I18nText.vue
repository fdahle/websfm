<script setup>
// A message with inline tags (<strong>Reconstruct ▸ Dense Model</strong>), drawn as
// elements in the user's language: <I18nText k="filterCloud.noCloud" />, or
// <I18nText :msg="m" /> for a message from core. Only core/i18n's RICH_TAGS are drawn
// as elements; the catalogue text is never parsed as HTML.
//
// A tag named like one of this component's slots is drawn by that slot, with the tag's
// text as `text`: a button or a link inside a sentence whose word order the language
// decides.
//   <I18nText k="dialog.importKind.declared" :params="…">
//     <template #pose="{ text }"><button @click="…">{{ text }}</button></template>
//   </I18nText>
import { h, useSlots } from 'vue'
import { msg as message } from '../core/i18n/index.js'
import { txRich } from '../composables/useI18n.js'

const props = defineProps({
  k: { type: String, default: '' },
  params: { type: Object, default: null },
  msg: { type: [Object, String], default: null },
})
const slots = useSlots()

const draw = (parts) =>
  parts.map((p) => {
    if (!p || typeof p !== 'object') return String(p)
    if (slots[p.tag]) return slots[p.tag]({ text: p.children.map(String).join('') })
    return h(p.tag, draw(p.children))
  })
const Parts = () => draw(txRich(props.msg ?? message(props.k, props.params), Object.keys(slots)))
</script>

<template>
  <Parts />
</template>
