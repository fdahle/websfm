<script setup>
// A message with inline tags (<strong>Reconstruct ▸ Dense Model</strong>), drawn as
// elements in the user's language: <I18nText k="filterCloud.noCloud" />, or
// <I18nText :msg="m" /> for a message from core. Only core/i18n's RICH_TAGS are drawn;
// the catalogue text is never parsed as HTML.
import { h } from 'vue'
import { msg as message } from '../core/i18n/index.js'
import { txRich } from '../composables/useI18n.js'

const props = defineProps({
  k: { type: String, default: '' },
  params: { type: Object, default: null },
  msg: { type: [Object, String], default: null },
})

const draw = (parts) => parts.map((p) => (p && typeof p === 'object' ? h(p.tag, draw(p.children)) : String(p)))
const Parts = () => draw(txRich(props.msg ?? message(props.k, props.params)))
</script>

<template>
  <Parts />
</template>
