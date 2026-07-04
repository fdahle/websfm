import { ref } from 'vue'
import { defineStore } from 'pinia'

// Stack of open glossary panels (CK3-style cascading info panels): clicking a
// GlossaryTerm or an in-panel link pushes an id, closing pops back to it.
// Deliberately separate from useModalsStore's action dialogs — content
// browsing shouldn't close whatever action modal the user opened it from.
// Pure UI state: not project-scoped, not persisted.
export const useHelpStore = defineStore('help', () => {
  const stack = ref([]) // help entry ids, oldest (bottom of stack) first

  function push(id) {
    const i = stack.value.indexOf(id)
    // Already open further back in the stack: bring it to the front instead
    // of opening a duplicate panel.
    stack.value = i !== -1 ? stack.value.slice(0, i + 1) : [...stack.value, id]
  }

  function popTo(index) {
    stack.value = stack.value.slice(0, index + 1)
  }

  function clear() {
    stack.value = []
  }

  return { stack, push, popTo, clear }
})
