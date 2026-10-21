<script setup>
import { roleSelectStyle } from './importRoles.js'

// The column-mapping preview of the delimited-text import dialogs (GcpImportModal,
// CameraImportModal): one role <select> per column, the header row (when the file
// has one), then the first data rows. Driven by composables/useDelimitedImport.js —
// bind its refs straight through and route `set-role` to its `setRole`.
//   roleOptions  [{ id, label }], 'ignore' first
defineProps({
  columnCount: { type: Number, required: true },
  columnRoles: { type: Array, required: true },
  roleOptions: { type: Array, required: true },
  hasHeader: { type: Boolean, default: true },
  headerCells: { type: Array, default: () => [] },
  previewRows: { type: Array, default: () => [] },
})
const emit = defineEmits(['set-role']) // (columnIndex, roleId)
</script>

<template>
  <div class="table-wrap">
    <table class="preview">
      <thead>
        <tr>
          <th v-for="i in columnCount" :key="'r' + i" class="role-cell">
            <select
              class="role-select"
              :style="roleSelectStyle(columnRoles[i - 1] || 'ignore', roleOptions)"
              :value="columnRoles[i - 1] || 'ignore'"
              @change="emit('set-role', i - 1, $event.target.value)"
            >
              <option v-for="o in roleOptions" :key="o.id" :value="o.id">{{ o.label }}</option>
            </select>
          </th>
        </tr>
        <tr v-if="hasHeader">
          <th v-for="i in columnCount" :key="'h' + i" class="header-cell">{{ headerCells[i - 1] ?? '' }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, ri) in previewRows" :key="ri">
          <td v-for="i in columnCount" :key="i">{{ row[i - 1] ?? '' }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped src="./import-modal.css"></style>
<style scoped>
.preview td {
  color: var(--text);
  font-family: monospace;
}

.role-cell {
  padding: 4px;
  background: var(--bg);
  position: sticky;
  top: 0;
  z-index: 1;
}

/* The per-column floor that keeps the selected role label readable lives in
   ./importRoles.js `roleSelectStyle` — the data cells are too narrow to size
   this column, and it depends on the chosen label. */
.role-select {
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 4px;
  color: var(--text);
  font: inherit;
  font-size: 11px;
  padding: 3px 6px;
  outline: none;
  width: 100%;
}
.role-select:focus {
  border-color: var(--accent);
}

.header-cell {
  background: var(--bg);
  color: var(--text-dim);
  font-weight: 600;
}
</style>
