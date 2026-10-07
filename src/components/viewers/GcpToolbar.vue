<script setup>
import FloatingToolbox from './FloatingToolbox.vue'

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
defineProps({
  // Every point in the project [{ id, name, role }], for the target list.
  allGcps:    { type: Array,  default: () => [] },
  // Id of the currently-selected point (a click marks it), or null for "new".
  selectedId: { type: String, default: null },
  // Which kind the next "new" click creates ('control' | 'marker').
  newRole:    { type: String, default: 'control' },
  // Ids of points already marked on this image (shown with a dot).
  markedIds:  { type: Array,  default: () => [] },
  // What a click acts on — 'image' (mark a pixel observation) or 'map' (set the
  // GCP's ground position). Only changes the instruction wording.
  noun:       { type: String, default: 'image' },
})

const emit = defineEmits(['close', 'select', 'delete', 'select-new'])
</script>

<template>
  <FloatingToolbox :id="`points-${noun}`" title="Points" :width="180" close-title="Exit point editing (Esc)" @close="emit('close')">
    <div>
      <div class="gt-line">
        {{ selectedId != null
          ? `Click the ${noun} to ${noun === 'map' ? 'set its position' : 'mark'}:`
          : `Click the ${noun} to add a new ${newRole === 'marker' ? 'marker' : 'control point'}` }}
      </div>

      <div class="gt-list">
        <!-- Drop back to create mode so you can keep adding after one is placed. -->
        <button
          class="gt-new"
          :class="{ active: selectedId == null && newRole === 'control' }"
          title="A surveyed point that constrains georeferencing"
          @click="emit('select-new', 'control')"
        >＋ New control</button>
        <button
          class="gt-new"
          :class="{ active: selectedId == null && newRole === 'marker' }"
          title="A scale-bar endpoint: image marks, no surveyed position"
          @click="emit('select-new', 'marker')"
        >＋ New marker</button>

        <div
          v-for="g in allGcps"
          :key="g.id"
          class="gt-item"
          :class="{ active: g.id === selectedId }"
        >
          <button class="gt-pick" :title="g.name" @click="emit('select', g.id)">
            <span class="gt-dot" :class="{ on: markedIds.includes(g.id) }"></span>
            <span class="gt-name">{{ g.name }}</span>
          </button>
          <button class="gt-del" title="Delete this point" @click.stop="emit('delete', g.id)">×</button>
        </div>

        <div v-if="!allGcps.length" class="gt-empty">No points yet — click to add one.</div>
      </div>
    </div>
  </FloatingToolbox>
</template>

<style scoped>
.gt-line { font-size: 12px; color: var(--text); margin-bottom: 6px; }
.gt-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-height: 220px;
  overflow-y: auto;
}
.gt-item {
  display: flex;
  align-items: center;
  border-radius: 4px;
  color: var(--text);
}
.gt-item:hover { background: var(--hover-bg); }
.gt-item.active { background: var(--accent); color: #fff; }
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
.gt-item:hover .gt-del { opacity: 1; }
.gt-del:hover { color: #ff8a8a; }
.gt-item.active .gt-del { color: rgba(255, 255, 255, 0.8); opacity: 1; }
.gt-item.active .gt-del:hover { color: #fff; }
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
.gt-new:hover { background: var(--hover-bg); }
.gt-new.active { background: var(--accent); color: #fff; }
.gt-dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: transparent;
  border: 1px solid var(--text-dim);
}
.gt-dot.on { background: var(--accent); border-color: var(--accent); }
.gt-item.active .gt-dot.on { background: #fff; border-color: #fff; }
.gt-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gt-empty { font-size: 11px; color: var(--text-dim); padding: 4px 6px; }
</style>
