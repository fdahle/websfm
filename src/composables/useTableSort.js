import { ref, computed } from 'vue'

// Header-click sorting for a table — the one implementation behind DataTable,
// ImageTable, MetadataTable, CameraPoseTable and MatchList.
//
// `rowsGetter()` returns the current row array; `accessor(row, key)` returns the
// comparable value for a column key. Click a header to sort, click again to flip.
// Null / undefined / empty-string values always trail, regardless of direction.
// When no key is active the original order is preserved, and ties keep it too
// (Array#sort is stable).
//
// Options:
//   initialKey  column sorted on mount (default null: original order)
//   initialDir  its direction, 1 = ascending, -1 = descending (default 1)
//   firstDir    direction a newly clicked column starts in (default 1; DataTable's
//               error tables land worst-first with -1)
//   compare     (a, b) => number for two non-empty values, ascending (default
//               compareValues: numbers numerically, anything else as text)
// resetSort() returns to initialKey / initialDir.
export function useTableSort(rowsGetter, accessor, options = {}) {
  const { initialKey = null, initialDir = 1, firstDir = 1, compare = compareValues } = options
  const sortKey = ref(initialKey)
  const sortDir = ref(initialDir) // 1 = ascending, -1 = descending

  function toggleSort(key) {
    if (sortKey.value === key) sortDir.value *= -1
    else { sortKey.value = key; sortDir.value = firstDir }
  }
  function resetSort() { sortKey.value = initialKey; sortDir.value = initialDir }
  // '▲' / '▼' for the active column, '' otherwise (rendered next to the header).
  function sortArrow(key) {
    if (sortKey.value !== key) return ''
    return sortDir.value === 1 ? '▲' : '▼'
  }

  const sorted = computed(() => sortRows(rowsGetter() ?? [], sortKey.value, sortDir.value, accessor, compare))

  return { sortKey, sortDir, toggleSort, resetSort, sortArrow, sorted }
}

const isEmpty = (v) => v == null || v === ''

// Default comparison: two numbers numerically, anything else as text with numeric
// collation ("img2" before "img10").
export function compareValues(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b), undefined, { numeric: true })
}

// Plain code-unit ordering (`<` / `>`): no collation, so the fastest choice for
// very long lists whose keys are pre-normalised (MatchList's lower-cased names).
export function compareRaw(a, b) {
  return a < b ? -1 : a > b ? 1 : 0
}

// A sorted copy of `list` by `accessor(row, key)` in direction `dir` (1 / -1), empty
// values last in both directions; `list` itself when no key is given.
export function sortRows(list, key, dir, accessor, compare = compareValues) {
  if (!key) return list
  return [...list].sort((a, b) => {
    const va = accessor(a, key), vb = accessor(b, key)
    if (isEmpty(va) && isEmpty(vb)) return 0
    if (isEmpty(va)) return 1   // empties last, both directions
    if (isEmpty(vb)) return -1
    return compare(va, vb) * dir
  })
}
