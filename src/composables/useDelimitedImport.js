import { ref, computed, watch, unref, toValue } from 'vue'
import { sniffDelimiter, parseRows } from '../core/io/gcp.js'

// The delimited-text half of the tabular import dialogs (GcpImportModal,
// CameraImportModal): parse the file with a chosen delimiter, split off an optional
// header row, keep one role per column (guessed, then user-edited) and turn the
// roles into the `{ role: columnIndex | null }` mapping the core/io builders take.
//
//   rawText       string | ref | getter — the file's text
//   guessMapping  (headerCells, columnCount, hasHeader) => { role: index | null }
//                 (core/io/{gcp,pose,sensor}.js). A ref/computed when it varies
//                 (the camera dialog's pose/sensor mode): a new guesser re-guesses.
//   roles         string[] | ref — the role ids the dialog offers ('ignore' aside);
//                 they are exactly the keys of `mapping`.
//
// The roles are re-guessed on start and whenever the delimiter, the header toggle
// or the guesser changes — which discards manual edits, by design: the columns
// they referred to may no longer be the same columns.

/** Data rows shown under the column-mapping header. */
export const PREVIEW_ROW_COUNT = 8

/** `{ role: index | null }` → one role id per column ('ignore' where unassigned). */
export function rolesFromMapping(mapping, columnCount) {
  const roles = new Array(columnCount).fill('ignore')
  for (const [role, idx] of Object.entries(mapping)) if (idx != null) roles[idx] = role
  return roles
}

/** Set `role` on column `colIdx`; each role is used at most once, so the column
 *  that held it before falls back to 'ignore'. Returns a new array. */
export function assignRole(columnRoles, colIdx, role) {
  const roles = [...columnRoles]
  if (role !== 'ignore') {
    const prev = roles.indexOf(role)
    if (prev !== -1 && prev !== colIdx) roles[prev] = 'ignore'
  }
  roles[colIdx] = role
  return roles
}

/** One role id per column → `{ role: index | null }` over `roleIds`; the first
 *  column carrying a role wins. */
export function mappingFromRoles(columnRoles, roleIds) {
  const m = Object.fromEntries(roleIds.map((r) => [r, null]))
  columnRoles.forEach((role, i) => { if (role !== 'ignore' && m[role] == null) m[role] = i })
  return m
}

export function useDelimitedImport({ rawText, guessMapping, roles }) {
  const delimiter = ref(sniffDelimiter(toValue(rawText)))
  const hasHeader = ref(true)
  const columnRoles = ref([])   // index → role id

  const rows = computed(() => parseRows(toValue(rawText), delimiter.value))
  const columnCount = computed(() => rows.value.reduce((m, r) => Math.max(m, r.length), 0))
  const headerCells = computed(() => (hasHeader.value ? (rows.value[0] || []) : []))
  const dataRows = computed(() => (hasHeader.value ? rows.value.slice(1) : rows.value))
  const previewRows = computed(() => dataRows.value.slice(0, PREVIEW_ROW_COUNT))

  function reguess() {
    const m = unref(guessMapping)(headerCells.value, columnCount.value, hasHeader.value)
    columnRoles.value = rolesFromMapping(m, columnCount.value)
  }

  reguess()
  watch([delimiter, hasHeader, () => unref(guessMapping)], reguess)

  function setRole(colIdx, role) {
    columnRoles.value = assignRole(columnRoles.value, colIdx, role)
  }

  const mapping = computed(() => mappingFromRoles(columnRoles.value, unref(roles)))

  return { delimiter, hasHeader, columnRoles, rows, columnCount, headerCells, dataRows, previewRows, reguess, setRole, mapping }
}
