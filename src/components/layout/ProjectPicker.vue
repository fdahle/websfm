<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { isFolderProject, folderLabel } from '../../core/io/folderProject.js'
import Icon from '../Icon.vue'

const props = defineProps({
  projects: { type: Array, required: true },
  currentProjectId: { type: String, default: null },
  // When false (e.g. on startup with no project open), the picker cannot be
  // dismissed — the user must select or create a project.
  dismissible: { type: Boolean, default: true },
  // Chromium-only (showDirectoryPicker). Hidden rather than disabled elsewhere.
  folderSupported: { type: Boolean, default: false },
})

const emit = defineEmits([
  'switch', 'rename', 'delete', 'new', 'open-file', 'open-folder', 'close',
  'settings', 'save-copy', 'move-to-folder', 'move-to-browser',
])

// Per-project actions live in one row menu rather than a row of icon buttons:
// this is the single home for project-scoped commands (the ribbon keeps only
// "Save a copy…"). Saving and migrating storage read/write the whole project
// tree, which needs the project's root registered — so they are offered on the
// *open* project only, with the reason spelled out rather than hidden.
const menu = ref(null)   // { id, name, x, y } | null

function openMenu(e, project) {
  e.preventDefault()
  e.stopPropagation()
  const rect = e.currentTarget.getBoundingClientRect()
  menu.value = {
    id: project.id,
    project,
    x: Math.min(rect.left, window.innerWidth - 210),
    y: Math.min(rect.bottom + 2, window.innerHeight - 230),
  }
}
function closeMenu() { menu.value = null }
// Run the action BEFORE clearing the menu: every callback reads `menu` lazily
// (menu.id / menu.project), so closing first would null it out and the action
// would throw on `null.project` — leaving every item dead.
function runMenu(fn) { fn(); closeMenu() }

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

// A folder project's files are on the user's own disk, so removing it here only
// forgets it — the wording has to say so, or "Delete" reads as a disk delete.
function confirmDelete(project) {
  const message = isFolderProject(project)
    ? `Remove "${project.name}" from websfm? Its folder on disk is left untouched.`
    : `Delete "${project.name}"? This cannot be undone.`
  if (confirm(message)) emit('delete', project.id)
}

// A short, glanceable summary line for each project: scene type, then CRS (aerial
// only — object-capture projects have none), then when it was last touched.
function projectMeta(project) {
  const parts = [project.sceneType === 'object' ? 'Object capture' : 'Aerial']
  if (isFolderProject(project)) parts.push(folderLabel(project))
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
    if (menu.value) closeMenu()
    else if (renamingId.value) cancelRename()
    else if (props.dismissible) emit('close')
  }
}

function onOutsideClick(e) {
  const inMenu = !!e.target.closest('.row-menu')
  if (menu.value && !inMenu) closeMenu()
  if (!props.dismissible) return
  // The row menu is teleported to <body>, so it is outside .project-picker —
  // clicking it must not dismiss the picker underneath it.
  if (!inMenu && !e.target.closest('.project-picker')) emit('close')
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
        @contextmenu="openMenu($event, project)"
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
          <button type="button" class="project-main" @click="emit('switch', project.id)">
            <div class="project-name-row">
              <span class="scene-badge">{{ project.sceneType === 'aerial' ? '✈' : '◼' }}</span>
              <span v-if="isFolderProject(project)" class="storage-badge" title="Stored in a folder on disk">🗀</span>
              <span class="project-name">{{ project.name }}</span>
            </div>
            <span class="project-meta">{{ projectMeta(project) }}</span>
          </button>
          <button class="icon-btn" title="Project actions" @click.stop="openMenu($event, project)">⋯</button>
        </template>
      </li>
    </ul>

    <div class="picker-footer">
      <button class="primary-btn" @click="emit('new')">+ New project</button>

      <!-- File vs folder is the one thing users cannot infer from the labels, so
           each row states it: a .websfm file is *copied in*, a folder is edited
           in place. -->
      <div class="footer-label">Open existing</div>
      <button class="open-btn" @click="emit('open-file')">
        <span class="open-icon"><Icon name="file" /></span>
        <span class="open-text">
          <span class="open-title">Project file…</span>
          <span class="open-sub">A <code>.websfm</code> file, copied into this browser</span>
        </span>
      </button>
      <button v-if="folderSupported" class="open-btn" @click="emit('open-folder')">
        <span class="open-icon"><Icon name="folder-open" /></span>
        <span class="open-text">
          <span class="open-title">Project folder…</span>
          <span class="open-sub">A folder on your disk, edited in place</span>
        </span>
      </button>
    </div>

    <!-- Teleported: the picker clips (overflow:hidden) and, when centered, sits
         in a transformed ancestor — which would re-root `position: fixed`. -->
    <Teleport to="body">
    <div v-if="menu" class="row-menu" :style="{ left: menu.x + 'px', top: menu.y + 'px' }">
      <button
        class="menu-item"
        :disabled="menu.id !== currentProjectId"
        :title="menu.id !== currentProjectId ? 'Open this project first' : 'Edit this project’s properties and storage'"
        @click="runMenu(() => emit('settings', menu.id))"
      >Project settings…</button>
      <button class="menu-item" @click="runMenu(() => startRename(menu.project))">Rename…</button>
      <button
        class="menu-item"
        :disabled="menu.id !== currentProjectId"
        :title="menu.id !== currentProjectId ? 'Open this project first' : 'Write a portable .websfm file'"
        @click="runMenu(() => emit('save-copy', menu.id))"
      >Save a copy…</button>
      <template v-if="folderSupported">
        <div class="menu-sep"></div>
        <button
          v-if="!isFolderProject(menu.project)"
          class="menu-item"
          :disabled="menu.id !== currentProjectId"
          :title="menu.id !== currentProjectId ? 'Open this project first' : 'Move out of browser storage into a folder on disk'"
          @click="runMenu(() => emit('move-to-folder', menu.id))"
        >Move to folder…</button>
        <button
          v-else
          class="menu-item"
          :disabled="menu.id !== currentProjectId"
          :title="menu.id !== currentProjectId ? 'Open this project first' : 'Copy into browser storage; the folder on disk is left in place'"
          @click="runMenu(() => emit('move-to-browser', menu.id))"
        >Move to browser storage</button>
      </template>
      <div class="menu-sep"></div>
      <button class="menu-item danger" @click="runMenu(() => confirmDelete(menu.project))">
        {{ isFolderProject(menu.project) ? 'Remove from websfm…' : 'Delete…' }}
      </button>
    </div>
    </Teleport>
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
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
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

.storage-badge {
  font-size: 11px;
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
  padding: 10px 10px 8px;
}

.primary-btn {
  width: 100%;
  background: var(--accent);
  border: 1px solid var(--accent);
  border-radius: 5px;
  color: #fff;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  padding: 8px 10px;
  cursor: pointer;
}

.primary-btn:hover {
  filter: brightness(1.12);
}

.footer-label {
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-dim);
  padding: 12px 2px 4px;
}

.open-btn {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  width: 100%;
  background: none;
  border: 1px solid transparent;
  border-radius: 5px;
  color: var(--text);
  font: inherit;
  padding: 7px 8px;
  text-align: left;
  cursor: pointer;
}

.open-btn:hover {
  background: var(--hover-bg);
  border-color: var(--panel-border);
}

.open-icon {
  width: 18px;
  height: 18px;
  color: var(--accent);
  flex-shrink: 0;
}

.open-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.open-title {
  font-size: 13px;
  color: var(--accent);
}

.open-sub {
  font-size: 11px;
  color: var(--text-dim);
  line-height: 1.35;
}

.open-sub code {
  font-size: 10.5px;
}

.row-menu {
  position: fixed;
  z-index: 400;
  min-width: 200px;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4);
  padding: 4px 0;
}

.menu-item {
  display: block;
  width: 100%;
  background: none;
  border: none;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  padding: 6px 12px;
  text-align: left;
  cursor: pointer;
}

.menu-item:hover:not(:disabled) {
  background: var(--hover-bg);
}

.menu-item:disabled {
  color: var(--text-dim);
  opacity: 0.5;
  cursor: default;
}

.menu-item.danger:hover {
  background: rgba(220, 50, 50, 0.15);
  color: #e55;
}

.menu-sep {
  height: 1px;
  margin: 4px 0;
  background: var(--panel-border);
}
</style>
