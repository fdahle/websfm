<script setup>
// The image viewer's right-click menu (ViewerImage.vue). Two-stage: a general
// 'main' menu whose "Add control/marker here…" / "Mark fiducial…" entries switch
// the same popup to the 'gcp' / 'fiducial' chooser at the same anchor.
//
// The viewer owns the `menu` state (v-model:menu) — it opens it on right-click
// and closes it on a press elsewhere or a wheel zoom. This component switches
// modes, copies the pixel coordinates, and turns every other choice into an event
// carrying the clicked point; each choice closes the menu after acting.
import { copyToClipboard } from '../../composables/useToasts.js'

const props = defineProps({
  // { x, y (viewport, clamped for positioning), sx, sy (the clicked viewport
  //   point), px, py (native image pixel), mode: 'main' | 'gcp' | 'fiducial' } | null
  menu:             { type: Object,  default: null },
  // Full-res bitmap loaded: the marking entries are hidden until then, and the
  // guards below cover a menu opened just before a url swap.
  editable:         { type: Boolean, default: false },
  isFilm:           { type: Boolean, default: false },
  fiducialMarks:    { type: Array,   default: () => [] }, // [{ id, xMm, yMm }]
  markedFidIds:     { type: Set,     default: () => new Set() }, // ids placed on this image (✓)
  fidMarkPos:       { type: Map,     default: () => new Map() }, // id → "top-left"…
  allGcps:          { type: Array,   default: () => [] }, // [{ id, name }]
  // Which create action is listed first ('control' | 'marker').
  defaultPointRole: { type: String,  default: 'control' },
})

// add-gcp { px, py, role } · mark-gcp { gcpId, px, py } · mark-fiducial { fidId, px, py }
// copy-color { px, py } · zoom-in { sx, sy } (about the clicked point) · fit
const emit = defineEmits(['update:menu', 'add-gcp', 'mark-gcp', 'mark-fiducial', 'copy-color', 'zoom-in', 'fit'])

function close() { emit('update:menu', null) }
function setMode(mode) { if (props.menu) emit('update:menu', { ...props.menu, mode }) }

function newPoint(role) {
  if (props.menu && props.editable) emit('add-gcp', { px: props.menu.px, py: props.menu.py, role })
  close()
}
function assign(gcpId) {
  if (props.menu && props.editable) emit('mark-gcp', { gcpId, px: props.menu.px, py: props.menu.py })
  close()
}
function markFiducial(fidId) {
  if (props.menu && props.editable) emit('mark-fiducial', { fidId, px: props.menu.px, py: props.menu.py })
  close()
}
function copyCoords() {
  if (props.menu) copyToClipboard(`${Math.round(props.menu.px)}, ${Math.round(props.menu.py)}`, 'pixel')
  close()
}
function copyColor() {
  if (props.menu) emit('copy-color', { px: props.menu.px, py: props.menu.py })
  close()
}
// About the clicked point — menu.x/y is the menu's position, clamped to keep it on screen.
function zoomIn() {
  if (props.menu) emit('zoom-in', { sx: props.menu.sx, sy: props.menu.sy })
  close()
}
function fitView() { emit('fit'); close() }
</script>

<template>
  <div v-if="menu" class="ctx-menu" :style="{ left: menu.x + 'px', top: menu.y + 'px' }" @mousedown.stop @contextmenu.prevent>
    <template v-if="menu.mode === 'main'">
      <template v-if="editable">
        <button class="ctx-item add" @click="setMode('gcp')">Add control/marker here…</button>
        <button v-if="isFilm" class="ctx-item add" @click="setMode('fiducial')">Mark fiducial…</button>
        <div class="ctx-sep"></div>
      </template>
      <button class="ctx-item" @click="copyCoords">Copy pixel (X,&nbsp;Y)</button>
      <button class="ctx-item" @click="copyColor">Copy color (RGB)</button>
      <div class="ctx-sep"></div>
      <button class="ctx-item" @click="zoomIn">Zoom in here</button>
      <button class="ctx-item" @click="fitView">Fit to view</button>
    </template>
    <template v-else-if="menu.mode === 'fiducial'">
      <div class="ctx-hd">Mark fiducial here</div>
      <template v-if="fiducialMarks.length">
        <button
          v-for="m in fiducialMarks"
          :key="m.id"
          class="ctx-item"
          @click="markFiducial(m.id)"
        >{{ markedFidIds.has(m.id) ? '✓ ' : '' }}{{ m.id }}<span class="ctx-pos">{{ fidMarkPos.get(m.id) }}</span></button>
      </template>
      <div v-else class="ctx-sub">No marks defined — add them in the Sensor table.</div>
      <div class="ctx-sep"></div>
      <button class="ctx-item back" @click="setMode('main')">‹ Back</button>
    </template>
    <template v-else>
      <div class="ctx-hd">Add reference point</div>
      <!-- Two explicit actions, never one action plus a role edit afterwards:
           a control point born with coordinates and re-roled to marker is
           exactly the migration hazard core/io/gcp.js guards against. The
           scene type only decides the ORDER, so both stay one click away. -->
      <template v-if="defaultPointRole === 'marker'">
        <button class="ctx-item add" @click="newPoint('marker')">＋ New marker here</button>
        <button class="ctx-item add" @click="newPoint('control')">＋ New control point here</button>
      </template>
      <template v-else>
        <button class="ctx-item add" @click="newPoint('control')">＋ New control point here</button>
        <button class="ctx-item add" @click="newPoint('marker')">＋ New marker here</button>
      </template>
      <template v-if="allGcps.length">
        <div class="ctx-sub">Assign to existing</div>
        <button
          v-for="g in allGcps"
          :key="g.id"
          class="ctx-item"
          @click="assign(g.id)"
        >{{ g.name }}</button>
      </template>
      <div class="ctx-sep"></div>
      <button class="ctx-item back" @click="setMode('main')">‹ Back</button>
    </template>
  </div>
</template>

<style scoped>
.ctx-menu {
  position: absolute;
  z-index: 20;
  min-width: 180px;
  max-height: 70%;
  overflow-y: auto;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
  padding: 4px;
}

.ctx-hd {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-dim);
  padding: 4px 8px 2px;
}

.ctx-sub {
  font-size: 10px;
  color: var(--text-dim);
  padding: 6px 8px 2px;
}

.ctx-sep {
  height: 1px;
  background: var(--panel-border);
  margin: 4px 2px;
}

.ctx-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 5px 8px;
  background: none;
  border: none;
  border-radius: 4px;
  color: var(--text);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ctx-item:hover { background: var(--hover-bg); }
.ctx-item.add { color: var(--accent, #5cf); font-weight: 500; }
.ctx-item.back { color: var(--text-dim); }
.ctx-pos { float: right; margin-left: 12px; color: var(--text-dim); font-size: 11px; }
</style>
