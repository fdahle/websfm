<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'

const props = defineProps({
  projects: { type: Array, required: true },
  currentProjectId: { type: String, default: null },
  // When false (e.g. on startup with no project open), the picker cannot be
  // dismissed — the user must select or create a project.
  dismissible: { type: Boolean, default: true },
})

const emit = defineEmits(['switch', 'rename', 'delete', 'new', 'close'])

const renamingId = ref(null)
const renameValue = ref('')
const renameInput = ref(null)

function startRename(project) {
  renamingId.value = project.id
  renameValue.value = project.name
  setTimeout(() => renameInput.value?.focus(), 0)
}

function commitRename(id) {
  const trimmed = renameValue.value.trim()
  if (trimmed) emit('rename', id, trimmed)
  renamingId.value = null
}

function cancelRename() {
  renamingId.value = null
}

function confirmDelete(project) {
  if (confirm(`Delete "${project.name}"? This cannot be undone.`)) {
    emit('delete', project.id)
  }
}

// A short, glanceable summary line for each project: scene type, then CRS (aerial
// only — object-capture projects have none), then when it was last touched.
function projectMeta(project) {
  const parts = [project.sceneType === 'object' ? 'Object capture' : 'Aerial']
  if (project.sceneType !== 'object' && project.crs) parts.push(project.crs)
  const edited = formatDate(project.lastModified)
  if (edited) parts.push(`edited ${edited}`)
  return parts.join(' · ')
}

function formatDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

function onKey(e) {
  if (e.key === 'Escape') {
    if (renamingId.value) cancelRename()
    else if (props.dismissible) emit('close')
  }
}

function onOutsideClick(e) {
  if (!props.dismissible) return
  if (!e.target.closest('.project-picker')) emit('close')
}

onMounted(() => {
  document.addEventListener('mousedown', onOutsideClick)
  document.addEventListener('keydown', onKey)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onOutsideClick)
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div class="project-picker" :class="{ centered: !dismissible }">
    <ul class="project-list">
      <li
        v-for="project in projects"
        :key="project.id"
        class="project-item"
        :class="{ current: project.id === currentProjectId }"
      >
        <template v-if="renamingId === project.id">
          <input
            ref="renameInput"
            v-model="renameValue"
            class="rename-input"
            maxlength="80"
            @keydown.enter="commitRename(project.id)"
            @keydown.esc="cancelRename"
            @blur="commitRename(project.id)"
          />
        </template>
        <template v-else>
          <span class="check">{{ project.id === currentProjectId ? '✓' : '' }}</span>
          <div class="project-main" @click="emit('switch', project.id)">
            <div class="project-name-row">
              <span class="scene-badge">{{ project.sceneType === 'aerial' ? '✈' : '◼' }}</span>
              <span class="project-name">{{ project.name }}</span>
            </div>
            <span class="project-meta">{{ projectMeta(project) }}</span>
          </div>
          <button class="icon-btn" title="Rename" @click.stop="startRename(project)">✏</button>
          <button class="icon-btn danger" title="Delete" @click.stop="confirmDelete(project)">✕</button>
        </template>
      </li>
    </ul>

    <div class="picker-footer">
      <button class="new-btn" @click="emit('new')">+ New project</button>
    </div>
  </div>
</template>

<style scoped>
.project-picker {
  position: fixed;
  top: 34px;
  left: 10px;
  z-index: 300;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 7px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35);
  min-width: 280px;
  max-width: 360px;
  overflow: hidden;
}

.project-picker.centered {
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
}

.project-list {
  list-style: none;
  margin: 0;
  padding: 4px 0;
  max-height: 260px;
  overflow-y: auto;
}

.project-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 8px;
}

.project-item + .project-item {
  border-top: 1px solid var(--panel-border);
}

.project-item.current {
  background: rgba(14, 99, 156, 0.12);
}

.check {
  width: 14px;
  font-size: 11px;
  color: var(--accent);
  flex-shrink: 0;
  text-align: center;
  align-self: flex-start;
  margin-top: 2px;
}

.project-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  cursor: pointer;
}

.project-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.project-name {
  font-size: 13px;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.project-main:hover .project-name {
  color: var(--accent);
}

.scene-badge {
  font-size: 12px;
  color: var(--text-dim);
  flex-shrink: 0;
}

.project-meta {
  font-size: 11px;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.icon-btn {
  background: none;
  border: 1px solid transparent;
  color: var(--text-dim);
  font-size: 14px;
  padding: 6px 8px;
  cursor: pointer;
  border-radius: 5px;
  flex-shrink: 0;
  line-height: 1;
  opacity: 0.65;
}

.project-item:hover .icon-btn {
  opacity: 1;
}

.icon-btn:hover {
  background: var(--hover-bg);
  color: var(--text);
}

.icon-btn.danger:hover {
  background: rgba(220, 50, 50, 0.15);
  color: #e55;
}

.rename-input {
  flex: 1;
  background: var(--bg);
  border: 1px solid var(--accent);
  border-radius: 4px;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  padding: 3px 6px;
  outline: none;
}

.picker-footer {
  border-top: 1px solid var(--panel-border);
  padding: 4px 0;
}

.new-btn {
  width: 100%;
  background: none;
  border: none;
  color: var(--accent);
  font: inherit;
  font-size: 13px;
  padding: 10px 14px;
  text-align: left;
  cursor: pointer;
}

.new-btn:hover {
  background: var(--hover-bg);
}
</style>
