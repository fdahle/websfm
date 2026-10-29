<script>
// Measured project sizes, by `${id}:${lastModified}`, for the session.
const sizeCache = new Map()
</script>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { isFolderProject } from '../../core/io/folderProject.js'
import { EXAMPLES } from '../../core/examples.js'
import { formatBytes } from '../../core/formatBytes.js'
import BetaBadge from './BetaBadge.vue'
import { version as appVersion } from '../../../package.json'
import Icon from '../Icon.vue'
import { useInlineRename } from '../../composables/useInlineRename.js'
import { confirmDialog, confirmOpen } from '../../composables/useConfirmations.js'
import { matches } from '../../core/help/shortcuts.js'
import * as opfs from '../../utils/opfs.js'

const props = defineProps({
  projects: { type: Array, required: true },
  currentProjectId: { type: String, default: null },
  // When false (e.g. on startup with no project open), the picker cannot be
  // dismissed — the user must select or create a project.
  dismissible: { type: Boolean, default: true },
  // Chromium-only (showDirectoryPicker). Hidden rather than disabled elsewhere.
  folderSupported: { type: Boolean, default: false },
})

// What each browser-stored project takes, and the browser storage as a whole: the
// numbers that say when a project is better off in a folder. A size is measured once
// per project version (id + lastModified), in the background — walking a large
// project's tree takes a moment, and the cache outlives the picker, which mounts each
// time it opens (the plain <script> block below). A folder project's size is its folder's business.
const sizes = ref(new Map())
async function measureSizes() {
  for (const p of props.projects) {
    if (isFolderProject(p)) continue
    const key = `${p.id}:${p.lastModified}`
    if (!sizeCache.has(key)) {
      try {
        const dir = await opfs.getOpfsProjectDir(p.id)
        sizeCache.set(key, (await opfs.measureTree(dir)).bytes)
      } catch {
        continue
      }
    }
    sizes.value = new Map(sizes.value).set(p.id, sizeCache.get(key))
  }
}
// { usage, durable } of this browser's storage for the whole site, or null.
const browserStorage = ref(null)
const durableNote = ref('')
async function readBrowserStorage() {
  try {
    const estimate = await opfs.getQuota()
    const durable = navigator.storage?.persisted ? await navigator.storage.persisted() : null
    browserStorage.value = { usage: estimate.usage ?? 0, durable }
  } catch {
    browserStorage.value = null
  }
}
// Chromium decides this silently from how the site is used; only Firefox asks.
async function keepStorage() {
  try {
    const granted = await opfs.requestDurable()
    browserStorage.value = { ...browserStorage.value, durable: granted }
    durableNote.value = granted
      ? ''
      : 'The browser declined for now. Browsers usually agree once a site is used regularly, bookmarked or installed as an app.'
  } catch (err) {
    durableNote.value = `Could not ask: ${err?.message ?? err}`
  }
}

const emit = defineEmits([
  'switch',
  'rename',
  'delete',
  'new',
  'open-file',
  'open-folder',
  'close',
  'settings',
  'save-copy',
  'move-to-folder',
  'move-to-browser',
  'example',
])

// Per-project actions live in one row menu rather than a row of icon buttons:
// this is the single home for project-scoped commands (the ribbon keeps only
// "Export Project"). Saving and migrating storage read/write the whole project
// tree, which needs the project's root registered — so they are offered on the
// *open* project only, with the reason spelled out rather than hidden.
const menu = ref(null) // { id, name, x, y } | null

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
function closeMenu() {
  menu.value = null
}
// Run the action BEFORE clearing the menu: every callback reads `menu` lazily
// (menu.id / menu.project), so closing first would null it out and the action
// would throw on `null.project` — leaving every item dead.
function runMenu(fn) {
  fn()
  closeMenu()
}

const {
  editingId: renamingId,
  editingName: renameValue,
  setInput: setRenameInput,
  start: startRename,
  commit: commitRename,
  cancel: cancelRename,
} = useInlineRename((id, name) => emit('rename', id, name))

// A folder project's files are on the user's own disk, so removing it here only
// forgets it — the wording has to say so, or "Delete" reads as a disk delete.
async function confirmDelete(project) {
  const folder = isFolderProject(project)
  const ok = await confirmDialog({
    title: folder ? 'Remove project?' : 'Delete project?',
    message: folder
      ? `Remove "${project.name}" from WebSfM? Its folder on disk is left untouched.`
      : `Delete "${project.name}"? This cannot be undone.`,
    confirmLabel: folder ? 'Remove' : 'Delete',
  })
  if (ok) emit('delete', project.id)
}

// A short, glanceable summary line for each project, after where it is stored (the
// folder icon and name, or "In this browser"): scene type, then CRS (aerial only —
// object-capture projects have none), then when it was last touched.
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

// Escape is consumed here: App's window handler would otherwise also close
// whatever modal sits under the picker (or exit the active tool mode).
function onKey(e) {
  // A confirm asked from here sits on top and answers its own Escape.
  if (!matches(e, 'app.escape') || confirmOpen.value) return
  if (menu.value) closeMenu()
  else if (renamingId.value) cancelRename()
  else if (props.dismissible) emit('close')
  else return
  e.stopPropagation()
}

function onOutsideClick(e) {
  if (confirmOpen.value) return
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
  measureSizes()
  readBrowserStorage()
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
            :ref="setRenameInput"
            v-model="renameValue"
            class="rename-input"
            maxlength="80"
            @keydown.enter="commitRename"
            @keydown.esc.stop="cancelRename"
            @blur="commitRename"
          />
        </template>
        <template v-else>
          <span class="check">{{ project.id === currentProjectId ? '✓' : '' }}</span>
          <button type="button" class="project-main" @click="emit('switch', project.id)">
            <div class="project-name-row">
              <span class="scene-badge" :title="project.sceneType === 'object' ? 'Object capture' : 'Aerial'">
                <Icon :name="project.sceneType === 'object' ? 'cube' : 'map-pin'" />
              </span>
              <span class="project-name">{{ project.name }}</span>
            </div>
            <span class="project-meta">
              <span
                v-if="isFolderProject(project)"
                class="storage-place"
                :title="`Stored in the folder ${project.folderName ?? ''} on disk`"
              >
                <span class="storage-icon"><Icon name="folder" /></span>{{ project.folderName ?? 'Folder' }}
              </span>
              <span v-else class="storage-place" title="Stored in this browser's private storage">In this browser</span>
              <template v-if="sizes.has(project.id)"> · {{ formatBytes(sizes.get(project.id)) }}</template>
              · {{ projectMeta(project) }}
            </span>
            <span
              class="project-version"
              :class="{ 'different-version': project.createdWithVersion && project.createdWithVersion !== appVersion }"
            >
              {{
                project.createdWithVersion
                  ? `Created with WebSfM v${project.createdWithVersion}`
                  : 'Creation version unknown'
              }}
            </span>
          </button>
          <button class="icon-btn" title="Project actions" @click.stop="openMenu($event, project)">⋯</button>
        </template>
      </li>
    </ul>

    <div class="picker-footer">
      <div class="app-version">Current WebSfM v{{ appVersion }} <BetaBadge /></div>
      <!-- The browser's own storage: how much WebSfM holds there, and whether the
           browser may clear it under disk pressure (best-effort storage). -->
      <div v-if="browserStorage" class="browser-storage">
        <span>WebSfM uses {{ formatBytes(browserStorage.usage) }} of this browser's storage.</span>
        <template v-if="browserStorage.durable === false">
          <span class="storage-warn">
            The browser may clear it when the disk runs low on space: keep a project file, or use a folder.
          </span>
          <button type="button" class="link-btn" @click="keepStorage">Ask the browser to keep it</button>
          <span v-if="durableNote" class="storage-note">{{ durableNote }}</span>
        </template>
      </div>
      <button class="primary-btn" @click="emit('new')">+ New project</button>

      <!-- File vs folder is the one thing users cannot infer from the labels, so
           each row states it: a .websfm file is *unpacked* (into this browser, or a
           folder where folders are possible: the open asks), a folder is edited in
           place. -->
      <div class="footer-label">Open existing</div>
      <button class="open-btn" @click="emit('open-file')">
        <span class="open-icon"><Icon name="file" /></span>
        <span class="open-text">
          <span class="open-title">Project file…</span>
          <span class="open-sub"
            >A <code>.websfm</code> file, unpacked into
            {{ folderSupported ? 'this browser or a folder you choose' : 'this browser' }}</span
          >
        </span>
      </button>
      <button v-if="folderSupported" class="open-btn" @click="emit('open-folder')">
        <span class="open-icon"><Icon name="folder-open" /></span>
        <span class="open-text">
          <span class="open-title">Project folder…</span>
          <span class="open-sub">A folder on your disk, edited in place</span>
        </span>
      </button>

      <!-- A ready-made set with a walkthrough (core/examples.js), for a first look
           at the whole pipeline without photos of one's own. -->
      <div class="footer-label">Try an example</div>
      <button v-for="(ex, id) in EXAMPLES" :key="id" class="open-btn" @click="emit('example', id)">
        <span class="open-icon"><Icon :name="ex.sceneType === 'aerial' ? 'map-pin' : 'cube'" /></span>
        <span class="open-text">
          <span class="open-title">{{ ex.title }}</span>
          <span class="open-sub"
            >{{ ex.summary }} Photos: {{ ex.credit }} ({{ ex.license }}).
            {{ formatBytes(ex.approxBytes) }} download.</span
          >
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
          :title="
            menu.id !== currentProjectId ? 'Open this project first' : 'Edit this project’s properties and storage'
          "
          @click="runMenu(() => emit('settings', menu.id))"
        >
          Project settings…
        </button>
        <button class="menu-item" @click="runMenu(() => startRename(menu.project.id, menu.project.name))">
          Rename
        </button>
        <button
          class="menu-item"
          :disabled="menu.id !== currentProjectId"
          :title="
            menu.id !== currentProjectId
              ? 'Open this project first'
              : 'Write the whole project into one .websfm file, to keep or to open elsewhere'
          "
          @click="runMenu(() => emit('save-copy', menu.id))"
        >
          Export project file…
        </button>
        <template v-if="folderSupported">
          <div class="menu-sep"></div>
          <button
            v-if="!isFolderProject(menu.project)"
            class="menu-item"
            :disabled="menu.id !== currentProjectId"
            :title="
              menu.id !== currentProjectId
                ? 'Open this project first'
                : 'Move out of browser storage into a folder on disk'
            "
            @click="runMenu(() => emit('move-to-folder', menu.id))"
          >
            Move to folder…
          </button>
          <button
            v-else
            class="menu-item"
            :disabled="menu.id !== currentProjectId"
            :title="
              menu.id !== currentProjectId
                ? 'Open this project first'
                : 'Copy into browser storage; the folder on disk is left in place'
            "
            @click="runMenu(() => emit('move-to-browser', menu.id))"
          >
            Move to browser storage
          </button>
        </template>
        <div class="menu-sep"></div>
        <button class="menu-item danger" @click="runMenu(() => confirmDelete(menu.project))">
          {{ isFolderProject(menu.project) ? 'Remove from WebSfM' : 'Delete' }}
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
  width: 13px;
  height: 13px;
  color: var(--text-dim);
  flex-shrink: 0;
}

/* Where the project lives, first on the meta line: a folder's icon and name. */
.storage-place {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  vertical-align: bottom;
}
.storage-icon {
  display: inline-block;
  width: 11px;
  height: 11px;
}

.project-meta {
  font-size: 11px;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.project-version,
.app-version {
  font-size: 11px;
  color: var(--text-dim);
}

.project-version {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.project-version.different-version {
  color: var(--accent);
}

.app-version {
  margin-bottom: 8px;
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

.browser-storage {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  margin-bottom: 8px;
  font-size: 11px;
  color: var(--text-dim);
}
.storage-warn {
  color: var(--warn, #d9a441);
}
.storage-note {
  font-size: 10px;
}
.link-btn {
  background: none;
  border: none;
  padding: 0;
  color: var(--accent);
  font: inherit;
  cursor: pointer;
}
.link-btn:hover {
  text-decoration: underline;
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
