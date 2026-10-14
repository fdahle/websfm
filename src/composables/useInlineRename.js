import { nextTick, ref } from 'vue'

// One row at a time renamed in place (sidebar rows, the project picker). The
// template binds the input with `:ref="setInput"` — a function ref, because a
// string ref inside v-for collects an array that has no focus() — plus
// `v-model="editingName"`, Enter → commit, Escape → cancel (stopped, so App's
// Escape handler does not also close a modal) and blur → commit.
//
// `onCommit(id, name)` receives the trimmed name, and only when it is non-empty;
// whether an unchanged name is a no-op is the store's call. Cancelling clears
// `editingId` first, so the blur that follows the input unmounting commits nothing.
export function useInlineRename(onCommit) {
  const editingId = ref(null)
  const editingName = ref('')
  let input = null

  function setInput(el) { if (el) input = el }

  function start(id, name) {
    editingId.value = id
    editingName.value = name ?? ''
    nextTick(() => { input?.focus(); input?.select() })
  }

  function commit() {
    const id = editingId.value
    if (id == null) return
    editingId.value = null
    const name = editingName.value.trim()
    if (name) onCommit(id, name)
  }

  function cancel() { editingId.value = null }

  return { editingId, editingName, setInput, start, commit, cancel }
}
