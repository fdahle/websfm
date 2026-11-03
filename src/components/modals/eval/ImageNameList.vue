<script setup>
import { computed, ref } from 'vue'

// A list of images in the Quality Report (a match component, the images an extension
// added, the ones not registered): each name a link that opens the image, in tidy
// columns; with a note (why it was not registered), one image per line. A long list
// shows its first `limit` names and a button for the rest.
//
// items: [{ key, name, imageId?, note? }]; an item without an imageId is plain text.
const props = defineProps({
  items: { type: Array, default: () => [] },
  limit: { type: Number, default: 48 },
})
const emit = defineEmits(['open-image'])

const all = ref(false)
const shown = computed(() => (all.value ? props.items : props.items.slice(0, props.limit)))
const hiddenCount = computed(() => props.items.length - shown.value.length)
const withNotes = computed(() => props.items.some((it) => it.note))
</script>

<template>
  <ul class="img-names" :class="{ 'with-notes': withNotes }">
    <li v-for="it in shown" :key="it.key ?? it.name" class="img-name">
      <button
        v-if="it.imageId != null"
        type="button"
        class="img-link"
        :title="`Open ${it.name}`"
        @click="emit('open-image', it.imageId)"
      >
        {{ it.name }}
      </button>
      <span v-else class="img-plain">{{ it.name }}</span>
      <span v-if="it.note" class="img-note">{{ it.note }}</span>
    </li>
  </ul>
  <button v-if="hiddenCount > 0" type="button" class="img-more" @click="all = true">
    Show all {{ items.length.toLocaleString() }}
  </button>
</template>

<style scoped>
.img-names {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 2px 12px;
  font-size: 12px;
}
.img-names.with-notes {
  grid-template-columns: 1fr;
}
.img-name {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.img-link,
.img-plain {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.img-link {
  border: none;
  background: none;
  padding: 1px 0;
  font: inherit;
  color: var(--accent);
  cursor: pointer;
  text-align: left;
}
.img-link:hover {
  text-decoration: underline;
}
.img-link:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
  border-radius: 2px;
}
.img-plain {
  color: var(--text);
}
.img-note {
  color: var(--text-dim);
}
.img-more {
  align-self: flex-start;
  margin-top: 6px;
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  font-size: 11px;
  color: var(--accent);
  cursor: pointer;
}
.img-more:hover {
  text-decoration: underline;
}
</style>
