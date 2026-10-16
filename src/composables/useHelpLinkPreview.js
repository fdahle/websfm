import { onBeforeUnmount } from 'vue'
import { openHelp, leaveHelp, closeHelp, helpLinkFrom, linkSpec } from './useHelpStack.js'

// Delegated hover preview for help links rendered through v-html. Markdown-created
// anchors cannot own Vue hover state, so the Glossary/Guide modal forwards
// mouseover/mouseout from its body here. A link in the body is a word on the
// page, so it opens level 0 of the shared help stack (useHelpStack.js), with the
// same ring/pin/nesting behaviour as GlossaryTerm and FieldHelp.
export function useHelpLinkPreview() {
  function onMouseOver(event) {
    const link = helpLinkFrom(event.target)
    if (link) openHelp(0, linkSpec(link))
  }

  function onMouseOut(event) {
    const link = helpLinkFrom(event.target)
    if (link && !link.contains(event.relatedTarget)) leaveHelp(link)
  }

  // The body's anchors go away with the modal (or its tab content).
  onBeforeUnmount(closeHelp)

  return { onMouseOver, onMouseOut }
}
