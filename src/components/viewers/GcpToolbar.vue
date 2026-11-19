<script setup>
import { computed } from 'vue'
import FloatingToolbox from './FloatingToolbox.vue'
import { t } from '../../composables/useI18n.js'
import { pointGroups } from '../../core/gcpGroups.js'

// Floating point-editing toolbar shown over the image viewport while the tab is in
// point-edit mode — the click-to-mark counterpart of MaskToolbar. It also owns the
// *target selector*: the list lets you switch which point a click marks, or drop
// back to "new point" so you can keep adding — the owning ViewerImage implements
// the click-to-place action. The chrome (title, drag, ×) is the shared
// FloatingToolbox; its position sticks across images/tabs for the session.
//
// The create row is TWO explicit actions (control vs marker), never one action
// plus a role edit afterwards: a point created as control and re-roled keeps the
// coordinates it was born with (see useGcpsStore.addPoint / core/io/gcp.js).
//
// On the map or a reference raster a click sets a ground position, which a marker does
// not have: there the list leaves markers out (and says how many) and only a control
// point is new.
const props = defineProps({
  // Every point in the project [{ id, name, role, enabled }], for the target list.
  allGcps: { type: Array, default: () => [] },
  // Id of the currently-selected point (a click marks it), or null for "new".
  selectedId: { type: String, default: null },
  // Which kind the next "new" click creates ('control' | 'marker').
  newRole: { type: String, default: 'control' },
  // Ids of points already marked on this image (shown with a dot).
  markedIds: { type: Array, default: () => [] },
  // What a click acts on — 'image' (mark a pixel observation), or 'map' / 'raster'
  // (set the GCP's ground position, on the map or off a reference raster).
  noun: { type: String, default: 'image' },
})

const emit = defineEmits(['close', 'select', 'delete', 'select-new'])

// A ground view: the map or a reference raster (`onMap` for short).
const onMap = computed(() => props.noun !== 'image')
// The list in role groups (control, checkpoints, markers); on the map without markers.
const list = computed(() => pointGroups(props.allGcps, { onMap: onMap.value }))
const groups = computed(() => list.value.groups)
const hiddenMarkers = computed(() => list.value.hiddenMarkers)
const listed = computed(() => groups.value.reduce((n, grp) => n + grp.items.length, 0))

const selected = computed(() => props.allGcps.find((g) => g.id === props.selectedId) ?? null)
const instruction = computed(() => {
  if (selected.value)
    return onMap.value
      ? t('gcps.toolbox.placeGround', { where: props.noun, name: selected.value.name })
      : t('gcps.toolbox.markImage', { name: selected.value.name })
  return onMap.value
    ? t('gcps.toolbox.addGround', { where: props.noun })
    : t('gcps.toolbox.addImage', { role: props.newRole })
})
const isNew = (role) => props.selectedId == null && (onMap.value ? role === 'control' : props.newRole === role)

function dotTitle(g) {
  const on = props.markedIds.includes(g.id)
  if (onMap.value) return t(on ? 'gcps.toolbox.placed' : 'gcps.toolbox.unplaced')
  return t(on ? 'gcps.toolbox.markedImage' : 'gcps.toolbox.unmarkedImage')
}
const pickTitle = (g) => (g.enabled === false ? t('gcps.toolbox.disabled', { name: g.name }) : g.name)
</script>

<template>
  <FloatingToolbox
    :id="`points-${noun}`"
    :title="t('gcps.toolbox.title')"
    :width="200"
    :close-title="t('gcps.toolbox.close')"
    close-key="app.escape"
    @close="emit('close')"
  >
    <div>
      <div class="gt-line">{{ instruction }}</div>

      <!-- Drop back to create mode so you can keep adding after one is placed. -->
      <div class="gt-new-row">
        <button
          class="gt-new"
          :class="{ active: isNew('control') }"
          :title="t('gcps.toolbox.newControlTip')"
          @click="emit('select-new', 'control')"
        >
          {{ t('gcps.toolbox.newControl') }}
        </button>
        <button
          v-if="!onMap"
          class="gt-new"
          :class="{ active: isNew('marker') }"
          :title="t('gcps.toolbox.newMarkerTip')"
          @click="emit('select-new', 'marker')"
        >
          {{ t('gcps.toolbox.newMarker') }}
        </button>
      </div>

      <div class="gt-list">
        <template v-for="grp in groups" :key="grp.role">
          <div class="gt-group">{{ t(`gcps.toolbox.group.${grp.role}`, { n: grp.items.length }) }}</div>
          <div
            v-for="g in grp.items"
            :key="g.id"
            class="gt-item"
            :class="{ active: g.id === selectedId, off: g.enabled === false }"
          >
            <button class="gt-pick" :title="pickTitle(g)" @click="emit('select', g.id)">
              <span class="gt-dot" :class="{ on: markedIds.includes(g.id) }" :title="dotTitle(g)"></span>
              <span class="gt-name">{{ g.name }}</span>
            </button>
            <button class="gt-del" :title="t('gcps.toolbox.delete')" @click.stop="emit('delete', g.id)">×</button>
          </div>
        </template>

        <div v-if="!listed && !hiddenMarkers" class="gt-empty">{{ t('gcps.toolbox.empty') }}</div>
      </div>
      <div v-if="hiddenMarkers" class="gt-empty">{{ t('gcps.toolbox.markersHidden', { n: hiddenMarkers }) }}</div>
    </div>
  </FloatingToolbox>
</template>

<style scoped>
.gt-line {
  font-size: 12px;
  color: var(--text);
  margin-bottom: 6px;
}
.gt-new-row {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin-bottom: 4px;
}
/* Long lists scroll; the header and the ＋ rows stay in view. */
.gt-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-height: min(320px, 50vh);
  overflow-y: auto;
}
.gt-group {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--panel);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-dim);
  padding: 6px 6px 2px;
}
.gt-item.off .gt-name {
  opacity: 0.5;
  text-decoration: line-through;
}
.gt-item {
  display: flex;
  align-items: center;
  border-radius: 4px;
  color: var(--text);
}
.gt-item:hover {
  background: var(--hover-bg);
}
.gt-item.active {
  background: var(--accent);
  color: #fff;
}
.gt-pick {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  text-align: left;
  background: none;
  border: none;
  color: inherit;
  font-size: 12px;
  padding: 4px 6px;
  cursor: pointer;
}
.gt-del {
  flex: 0 0 auto;
  background: none;
  border: none;
  color: var(--text-dim);
  font-size: 14px;
  line-height: 1;
  padding: 2px 6px;
  border-radius: 4px;
  cursor: pointer;
  opacity: 0;
}
.gt-item:hover .gt-del {
  opacity: 1;
}
.gt-del:hover {
  color: #ff8a8a;
}
.gt-item.active .gt-del {
  color: rgba(255, 255, 255, 0.8);
  opacity: 1;
}
.gt-item.active .gt-del:hover {
  color: #fff;
}
/* The "＋ New …" rows are plain buttons, not the two-part item. */
.gt-new {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-dim);
  padding: 4px 6px;
  border-radius: 4px;
  cursor: pointer;
}
.gt-new:hover {
  background: var(--hover-bg);
}
.gt-new.active {
  background: var(--accent);
  color: #fff;
}
.gt-dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: transparent;
  border: 1px solid var(--text-dim);
}
.gt-dot.on {
  background: var(--accent);
  border-color: var(--accent);
}
.gt-item.active .gt-dot.on {
  background: #fff;
  border-color: #fff;
}
.gt-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gt-empty {
  font-size: 11px;
  color: var(--text-dim);
  padding: 4px 6px;
}
</style>
