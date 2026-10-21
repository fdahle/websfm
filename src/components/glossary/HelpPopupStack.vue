<script setup>
import { shallowRef, computed, watch } from 'vue'
import {
  helpStack,
  RING_MS,
  openHelp,
  leaveHelp,
  helpLinkFrom,
  linkSpec,
  followLink,
  closeHelp,
} from '../../composables/useHelpStack.js'
import { loadHelpRenderer } from '../../composables/useHelpHtml.js'
import GlossaryTooltip from './GlossaryTooltip.vue'

// Renders every open help popup (see useHelpStack.js), mounted once in App.vue.
// Links inside a pinned popup open the next level on hover and their tab on click.

// The markdown/KaTeX renderer is a lazy chunk, fetched when the first popup opens
// (openHelp already reports a failed load).
const renderer = shallowRef(null)
watch(
  () => helpStack.length > 0,
  (open) => {
    if (open && !renderer.value)
      loadHelpRenderer().then(
        (module) => {
          renderer.value = module
        },
        () => {},
      )
  },
)
const htmls = computed(() => helpStack.map((e) => (renderer.value ? e.render(renderer.value) : '')))

function onLinkOver(level, event) {
  const link = helpLinkFrom(event.target)
  if (link) openHelp(level + 1, linkSpec(link))
}
function onLinkOut(event) {
  const link = helpLinkFrom(event.target)
  if (link && !link.contains(event.relatedTarget)) leaveHelp(link)
}
function onLinkClick(event) {
  const link = helpLinkFrom(event.target)
  if (!link) return
  event.preventDefault()
  followLink(link)
}
function readMore(entry) {
  closeHelp()
  entry.readMore()
}
</script>

<template>
  <Teleport to="body">
    <GlossaryTooltip
      v-for="(entry, level) in helpStack"
      :key="entry.uid"
      :anchor="entry.anchor"
      :level="level"
      :title="entry.title"
      :summary-html="htmls[level]"
      :pinned="entry.pinned"
      :ring-ms="RING_MS"
      @read-more="readMore(entry)"
      @body-over="onLinkOver(level, $event)"
      @body-out="onLinkOut"
      @body-click="onLinkClick"
    />
  </Teleport>
</template>
