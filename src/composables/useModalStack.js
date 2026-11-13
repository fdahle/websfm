import { onBeforeUnmount, onMounted, watch } from 'vue'

// Escape closes the top-most open modal. Each modal registers itself while it is open
// (ModalShell on mount, the glossary and guide while their store says open), so the
// newest one is on top and a new modal closes on Escape without being listed anywhere.
// A modal's close is the same as its × button: a blocking dialog (ModalShell
// `dismissible: false`, the Workflow Builder during a run) ignores it, and Escape stops
// there rather than closing the dialog underneath.
//
// ProgressModal does not register (a run is cancelled with its button, never by
// Escape), and the project picker answers Escape itself.

const stack = []

/** Put a modal on top of the stack; returns the function that takes it off again. */
export function pushModal(close) {
  const entry = { close }
  stack.push(entry)
  return () => {
    const i = stack.indexOf(entry)
    if (i >= 0) stack.splice(i, 1)
  }
}

/** Close the top-most modal. Returns whether there was one (Escape is then used up). */
export function closeTopModal() {
  const top = stack[stack.length - 1]
  if (!top) return false
  top.close()
  return true
}

/** How many modals are open (for tests). */
export const openModalCount = () => stack.length

/**
 * Register the calling component's modal: while it is mounted, or, with `open`, while
 * that ref or getter is true.
 */
export function useModalStackEntry(close, { open } = {}) {
  let remove = null
  const add = () => {
    if (!remove) remove = pushModal(close)
  }
  const drop = () => {
    remove?.()
    remove = null
  }
  if (open) watch(open, (v) => (v ? add() : drop()), { immediate: true })
  else onMounted(add)
  onBeforeUnmount(drop)
}
