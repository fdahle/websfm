<script>
// Module scope (not <script setup>, which is per instance): only one ribbon menu
// is open at a time, so opening one closes whichever was open.
let closeOpenMenu = null
</script>

<script setup>
import { ref, nextTick, onBeforeUnmount } from 'vue'
import Icon from '../Icon.vue'

// A ribbon dropdown (PowerPoint's "Shapes ▾"): one button per object family, a
// menu of that family's tools. Rows are pre-resolved by Ribbon.vue so the gating
// stays in one place: { id, label, icon, blurb, reason } or { section }.
//
// The popover is TELEPORTED to <body>: `.ribbon-body` scrolls horizontally, and
// `overflow-x: auto` forces `overflow-y` to auto too, so an absolutely positioned
// child would be clipped at the ribbon's bottom edge.
const props = defineProps({
  label:  { type: String, required: true },
  icon:   { type: String, required: true },
  rows:   { type: Array,  required: true },
  // Non-empty ⇒ every row is blocked; the button greys with this reason.
  reason: { type: String, default: '' },
})
const emit = defineEmits(['run'])

const open = ref(false)
const btn = ref(null)
const menuEl = ref(null)
const pos = ref({ left: 0, top: 0 })
const MENU_WIDTH = 300

function place() {
  const r = btn.value.getBoundingClientRect()
  const left = Math.max(8, Math.min(r.left, window.innerWidth - MENU_WIDTH - 8))
  pos.value = { left, top: r.bottom + 2 }
}

function onOutside(e) {
  if (btn.value?.contains(e.target) || menuEl.value?.contains(e.target)) return
  close()
}
function onViewportChange() { close() }

function show() {
  if (closeOpenMenu && closeOpenMenu !== close) closeOpenMenu()
  closeOpenMenu = close
  place()
  open.value = true
  window.addEventListener('mousedown', onOutside, true)
  window.addEventListener('resize', onViewportChange)
  window.addEventListener('scroll', onViewportChange, true)
  nextTick(() => focusRow(0))
}

function close(returnFocus = false) {
  if (!open.value) return
  open.value = false
  if (closeOpenMenu === close) closeOpenMenu = null
  window.removeEventListener('mousedown', onOutside, true)
  window.removeEventListener('resize', onViewportChange)
  window.removeEventListener('scroll', onViewportChange, true)
  if (returnFocus) btn.value?.focus()
}

function toggle() {
  if (props.reason) return
  if (open.value) close()
  else show()
}

function rowButtons() {
  return [...(menuEl.value?.querySelectorAll('.rm-row') ?? [])]
}
function focusRow(i) {
  const rows = rowButtons()
  if (!rows.length) return
  rows[(i + rows.length) % rows.length].focus()
}

function onMenuKey(e) {
  const rows = rowButtons()
  const i = rows.indexOf(document.activeElement)
  if (e.key === 'ArrowDown') { e.preventDefault(); focusRow(i + 1) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); focusRow(i - 1) }
  else if (e.key === 'Home') { e.preventDefault(); focusRow(0) }
  else if (e.key === 'End') { e.preventDefault(); focusRow(rows.length - 1) }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true) }
  else if (e.key === 'Tab') close()
}

function onButtonKey(e) {
  if (e.key === 'ArrowDown' && !open.value) { e.preventDefault(); toggle() }
}

function run(row) {
  if (row.reason) return
  close()
  emit('run', row.id)
}

onBeforeUnmount(() => close())
</script>

<template>
  <button
    ref="btn"
    class="cmd rm-button"
    :class="{ active: open, disabled: !!reason }"
    :aria-disabled="!!reason"
    aria-haspopup="menu"
    :aria-expanded="open"
    :title="reason"
    @click="toggle"
    @keydown="onButtonKey"
  >
    <Icon :name="icon" class="cmd-icon" />
    <span class="cmd-label">{{ label }}</span>
    <span class="rm-caret" aria-hidden="true">▾</span>
  </button>

  <Teleport to="body">
    <div
      v-if="open"
      ref="menuEl"
      class="rm-menu"
      role="menu"
      :aria-label="label.replace('\n', ' ')"
      :style="{ left: pos.left + 'px', top: pos.top + 'px', width: MENU_WIDTH + 'px' }"
      @keydown="onMenuKey"
    >
      <template v-for="(row, i) in rows" :key="row.id ?? `s-${i}`">
        <div v-if="row.section" class="rm-section" role="presentation">{{ row.section }}</div>
        <button
          v-else
          class="rm-row"
          :class="{ disabled: !!row.reason }"
          role="menuitem"
          :aria-disabled="!!row.reason"
          @click="run(row)"
        >
          <Icon :name="row.icon" class="rm-icon" />
          <span class="rm-text">
            <span class="rm-label">{{ row.label }}</span>
            <span class="rm-blurb">{{ row.reason || row.blurb }}</span>
          </span>
        </button>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
/* The button reuses Ribbon's .cmd look; scoped styles don't cross components, so
   the few rules it needs are restated here (values identical to Ribbon.vue). */
.cmd {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  min-width: 50px;
  padding: 5px 8px;
  background: none;
  border: 1px solid transparent;
  border-radius: 5px;
  color: var(--text);
  cursor: pointer;
  font: inherit;
}
.cmd:hover:not(.disabled) {
  background: var(--hover-bg);
  border-color: var(--panel-border);
}
.cmd.active {
  background: rgba(14, 99, 156, 0.25);
  border-color: var(--accent);
}
.cmd.disabled {
  opacity: 0.4;
  cursor: default;
}
.cmd-icon {
  width: 18px;
  height: 18px;
}
.cmd-label {
  font-size: 10px;
  line-height: 1.2;
  min-height: 24px;
  text-align: center;
  white-space: pre-line;
}
.rm-caret {
  position: absolute;
  right: 3px;
  top: 3px;
  font-size: 8px;
  color: var(--text-dim);
}

.rm-menu {
  position: fixed;
  z-index: 1000;
  max-height: calc(100vh - 120px);
  overflow-y: auto;
  padding: 4px;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  user-select: none;
}
.rm-section {
  padding: 6px 8px 2px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--text-dim);
}
.rm-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  padding: 6px 8px;
  background: none;
  border: none;
  border-radius: 4px;
  color: var(--text);
  text-align: left;
  font: inherit;
  cursor: pointer;
}
.rm-row:hover:not(.disabled),
.rm-row:focus-visible:not(.disabled) {
  background: var(--hover-bg);
  outline: none;
}
.rm-row:focus-visible { outline: 1px solid var(--accent); }
.rm-row.disabled { cursor: default; }
.rm-row.disabled .rm-icon,
.rm-row.disabled .rm-label { opacity: 0.45; }
.rm-icon {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  margin-top: 1px;
}
.rm-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.rm-label { font-size: 12px; }
.rm-blurb {
  font-size: 11px;
  color: var(--text-dim);
}
</style>
