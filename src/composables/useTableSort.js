import { ref, computed } from 'vue'

// Header-click sorting for a table. `rowsGetter()` returns the current row array;
// `accessor(row, key)` returns the comparable value for a column key (number or
// string). Click a header to sort ascending, click again to flip. Null / undefined
// / empty values always trail, regardless of direction. When no key is active the
// original order is preserved.
export function useTableSort(rowsGetter, accessor) {
  const sortKey = ref(null)
  const sortDir = ref(1) // 1 = ascending, -1 = descending

  function toggleSort(key) {
    if (sortKey.value === key) sortDir.value *= -1
    else { sortKey.value = key; sortDir.value = 1 }
  }
  function resetSort() { sortKey.value = null; sortDir.value = 1 }
  // '▲' / '▼' for the active column, '' otherwise (rendered next to the header).
  function sortArrow(key) {
    if (sortKey.value !== key) return ''
    return sortDir.value === 1 ? '▲' : '▼'
  }

  const isEmpty = (v) => v == null || v === ''

  const sorted = computed(() => {
    const list = rowsGetter() ?? []
    const key = sortKey.value
    if (!key) return list
    const dir = sortDir.value
    return [...list].sort((a, b) => {
      const va = accessor(a, key), vb = accessor(b, key)
      if (isEmpty(va) && isEmpty(vb)) return 0
      if (isEmpty(va)) return 1   // nulls last
      if (isEmpty(vb)) return -1
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir
      return String(va).localeCompare(String(vb), undefined, { numeric: true }) * dir
    })
  })

  return { sortKey, sortDir, toggleSort, resetSort, sortArrow, sorted }
}
