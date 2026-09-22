import { ref, computed, onBeforeUnmount } from 'vue'
import { getGlossaryEntry, renderHelpMarkdown } from '../core/help/glossary.js'
import { getGuideDoc, renderGuide } from '../core/help/guide.js'

// Delegated hover preview for help links rendered through v-html. Markdown-created
// anchors cannot own Vue hover state, so their modal forwards mouseover/mouseout
// here. The interaction matches GlossaryTerm and FieldHelp: hover for 700 ms to
// pin, then dismiss with click-outside or Escape.
export function useHelpLinkPreview({ openGlossary, openGuide }) {
  const RING_MS = 700
  const anchor = ref(null)
  const kind = ref(null)
  const id = ref(null)
  const visible = ref(false)
  const pinned = ref(false)
  const tooltipRef = ref(null)
  let ringTimer = null

  const entry = computed(() => {
    if (kind.value === 'glossary') return getGlossaryEntry(id.value)
    if (kind.value === 'guide') return getGuideDoc(id.value)
    return null
  })
  const title = computed(() => entry.value?.title ?? '')
  const summaryHtml = computed(() => {
    const summary = entry.value?.summary ?? ''
    return kind.value === 'glossary'
      ? renderHelpMarkdown(summary, { selfId: id.value })
      : renderGuide(summary)
  })

  function linkFrom(target) {
    return target?.closest?.('a[data-help-id], a[data-guide-id]') ?? null
  }

  function show(link) {
    if (visible.value && anchor.value === link) return
    const nextKind = link.dataset.helpId ? 'glossary' : 'guide'
    const nextId = link.dataset.helpId ?? link.dataset.guideId
    hide()
    anchor.value = link
    kind.value = nextKind
    id.value = nextId
    if (!entry.value) { anchor.value = null; return }
    visible.value = true
    ringTimer = setTimeout(pin, RING_MS)
  }

  function pin() {
    if (!visible.value) return
    pinned.value = true
    document.addEventListener('mousedown', onDocumentMouseDown, true)
    document.addEventListener('keydown', onKeydown, true)
  }

  function hide() {
    clearTimeout(ringTimer)
    visible.value = false
    pinned.value = false
    anchor.value = null
    kind.value = null
    id.value = null
    document.removeEventListener('mousedown', onDocumentMouseDown, true)
    document.removeEventListener('keydown', onKeydown, true)
  }

  function onMouseOver(event) {
    const link = linkFrom(event.target)
    if (link) show(link)
  }

  function onMouseOut(event) {
    const link = linkFrom(event.target)
    if (!link || link.contains(event.relatedTarget)) return
    if (!pinned.value) hide()
  }

  function onDocumentMouseDown(event) {
    if (anchor.value?.contains(event.target)) return
    if (tooltipRef.value?.rootEl?.contains(event.target)) return
    hide()
  }

  function onKeydown(event) { if (event.key === 'Escape') hide() }

  function readMore() {
    const targetKind = kind.value
    const targetId = id.value
    hide()
    if (targetKind === 'glossary') openGlossary(targetId)
    else if (targetKind === 'guide') openGuide(targetId)
  }

  function followGlossary(targetId) { hide(); openGlossary(targetId) }
  function followGuide(targetId) { hide(); openGuide(targetId) }

  onBeforeUnmount(hide)

  return {
    RING_MS, anchor, visible, pinned, tooltipRef, title, summaryHtml,
    onMouseOver, onMouseOut, hide, readMore, followGlossary, followGuide,
  }
}
