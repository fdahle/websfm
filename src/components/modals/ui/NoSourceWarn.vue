<script setup>
// The "nothing to act on" notice of the cloud / mesh tool dialogs, worded once.
//   kind 'mesh'  — no mesh yet (Tools ▸ Mesh ▾)
//        'cloud' — no dense cloud yet (Tools ▸ Point Cloud ▾)
import WarnBox from './WarnBox.vue'
import I18nText from '../../I18nText.vue'

defineProps({ kind: { type: String, default: 'cloud' } })
</script>

<template>
  <WarnBox><I18nText :k="kind === 'mesh' ? 'dialog.noSource.mesh' : 'dialog.noSource.cloud'" /></WarnBox>
</template>
