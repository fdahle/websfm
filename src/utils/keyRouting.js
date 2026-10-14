// One routing rule for keyboard shortcuts that several window/document keydown
// listeners would otherwise all answer. The viewers (3D selection, raster/map
// measuring) register before App's global handler (a child mounts before its
// parent), so on their own they cannot know whether a modal is up — and Escape /
// Delete / Backspace would act twice: close the dialog AND clear (or delete!) the
// 3D selection, reset a measurement AND leave GCP edit, abort a stroke AND leave
// the Orient tool.
//
// The rule:
//   • A viewer ignores every key while a modal dialog is open — the dialog owns the
//     keyboard (the same `[aria-modal]` definition the focus trap in modalFocus.js
//     uses, so "open" means the same to both), and while focus is in a text field.
//   • A viewer that acts on a key consumes it (`preventDefault`), and App's handler
//     skips consumed events, so one key press does one thing — the innermost first.
//
// The DOM is the source of truth rather than the modal stores on purpose: dialogs
// are opened from several stores, module state (the confirm dialog) and local
// component refs; every one of them renders `[role=dialog][aria-modal=true]`.

export const MODAL_SELECTOR = '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]'

// Rendered and laid out — a dialog kept in the DOM but hidden does not own keys.
const rendered = (el) => (typeof el.getClientRects === 'function' ? el.getClientRects().length > 0 : true)

export function isModalOpen(doc = globalThis.document) {
  if (!doc?.querySelectorAll) return false
  for (const el of doc.querySelectorAll(MODAL_SELECTOR)) if (rendered(el)) return true
  return false
}

// A key typed into a text field / select belongs to that control.
export function isTypingTarget(target) {
  return !!target && (!!target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
}

// Whether a viewer's keydown listener may act on `e` at all: not already consumed
// by a more specific handler, not typed into a field, and no modal dialog open.
export function viewerMayHandleKey(e, doc = globalThis.document) {
  return !e.defaultPrevented && !isTypingTarget(e.target) && !isModalOpen(doc)
}
