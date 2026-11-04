<script setup>
import FloatingToolbox from './FloatingToolbox.vue'

// Shown over the workspace while Set Real-World Scale has handed a scale-bar point to
// the image view to be marked (useGcpEditing `scaleSetupMarkerId`). Marking itself is
// the image view's point editing; this says that a scale-bar point is being marked,
// how far it got, and leads back: Back to scale bars reopens the dialog, Stop (or ×)
// leaves marking. Once the point is marked in two photos the dialog reopens by itself.
const props = defineProps({
  // The point being marked.
  name: { type: String, required: true },
  // Names of the photos it is marked in so far.
  marked: { type: Array, default: () => [] },
  // Marks the dialog waits for before it reopens.
  needed: { type: Number, default: 2 },
  // Whether the open tab is a photo, where a click marks the point.
  onPhoto: { type: Boolean, default: false },
})
const emit = defineEmits(['back', 'stop'])
</script>

<template>
  <FloatingToolbox
    id="scale-bar-marking"
    title="Scale bar"
    anchor="top-center"
    :width="260"
    close-title="Stop marking"
    @close="emit('stop')"
  >
    <div class="tb-line">
      Marking <strong>{{ props.name }}</strong
      >: click the point in {{ needed }} photos.
    </div>
    <div class="tb-line sb-progress">
      <span v-for="i in needed" :key="i" class="sb-dot" :class="{ on: i <= marked.length }" />
      Marked in {{ Math.min(marked.length, needed) }} of {{ needed }}
      <span v-if="marked.length" class="sb-names" :title="marked.join(', ')">· {{ marked.join(', ') }}</span>
    </div>
    <div v-if="!onPhoto" class="tb-hint">Open a photo (sidebar ▸ Images) and click the point there.</div>
    <div class="tb-row">
      <button class="tb-textbtn" title="Reopen Set Real-World Scale; the marks so far stay" @click="emit('back')">
        Back to scale bars
      </button>
      <button class="tb-textbtn" title="Leave marking; the point and its marks stay" @click="emit('stop')">Stop</button>
    </div>
  </FloatingToolbox>
</template>

<style scoped src="./toolbox.css"></style>
<style scoped>
.sb-progress {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  color: var(--text-dim);
}
.sb-dot {
  width: 8px;
  height: 8px;
  flex: none;
  border-radius: 50%;
  border: 1px solid var(--text-dim);
}
.sb-dot.on {
  background: var(--accent);
  border-color: var(--accent);
}
.sb-names {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
