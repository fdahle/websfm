import { ref } from 'vue'

// Which rows of a list show their detail card. Ids only, so the state survives
// the list being rebuilt; `clear` is for a list that is replaced wholesale.
export function useExpandedSet() {
  const expanded = ref(new Set())
  const isExpanded = (id) => expanded.value.has(id)
  function toggle(id) {
    if (expanded.value.has(id)) expanded.value.delete(id)
    else expanded.value.add(id)
  }
  function clear() { expanded.value.clear() }
  return { expanded, isExpanded, toggle, clear }
}
