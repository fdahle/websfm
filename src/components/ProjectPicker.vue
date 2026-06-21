<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'

const props = defineProps({
  projects: { type: Array, required: true },
  currentProjectId: { type: String, default: null },
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

function onKey(e) {
  if (e.key === 'Escape') {
    if (renamingId.value) cancelRename()
    else emit('close')
  }
}

function onOutsideClick(e) {
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
  <div class="project-picker">
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
          <span class="project-name" @click="emit('switch', project.id)">{{ project.name }}</span>
          <span class="scene-badge">{{ project.sceneType === 'aerial' ? '✈' : '◼' }}</span>
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
  min-width: 240px;
  max-width: 320px;
  overflow: hidden;
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
  gap: 4px;
  padding: 0 6px;
  height: 32px;
}

.project-item.current {
  background: rgba(14, 99, 156, 0.12);
}

.check {
  width: 16px;
  font-size: 11px;
  color: var(--accent);
  flex-shrink: 0;
  text-align: center;
}

.project-name {
  flex: 1;
  font-size: 13px;
  color: var(--text);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.project-name:hover {
  color: var(--accent);
}

.scene-badge {
  font-size: 11px;
  color: var(--text-dim);
  flex-shrink: 0;
}

.icon-btn {
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 11px;
  padding: 3px 5px;
  cursor: pointer;
  border-radius: 3px;
  flex-shrink: 0;
  line-height: 1;
  opacity: 0;
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
  font-size: 12px;
  padding: 7px 22px;
  text-align: left;
  cursor: pointer;
}

.new-btn:hover {
  background: var(--hover-bg);
}
</style>
