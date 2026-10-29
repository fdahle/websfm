<script setup>
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import {
  discardAllPersistenceFailures,
  pendingPersistence,
  persistenceFailures,
  retryPersistence,
} from '../../utils/persistence.js'
import { isStorageFull } from '../../utils/opfs.js'
import { clearStorageFullDecline } from '../../utils/storageFull.js'
import { isFolderProject } from '../../core/io/folderProject.js'
import { useProjectsStore } from '../../stores/useProjectsStore.js'
import { confirmDialog } from '../../composables/useConfirmations.js'
import { pluralize } from '../../core/textFormat.js'

// Saves that failed (utils/persistence.js), until they succeed or are dismissed. A
// full browser storage says so and offers the way out — a folder on disk, where the
// saves are retried (useProjectLifecycle moveCurrentProjectToFolder ▸ reopenMoved) —
// or, without folders (Firefox, Safari), what frees space. A save that cannot
// succeed (its file is gone) would otherwise keep the card up for good: Dismiss.
const props = defineProps({
  // () => the move (useProjectLifecycle moveCurrentProjectToFolder).
  moveToFolder: { type: Function, required: true },
  // () => opens Project settings, where recomputable data can be cleared.
  openProjectSettings: { type: Function, required: true },
})

const projects = useProjectsStore()
const { currentProject, folderSupported } = storeToRefs(projects)

const full = computed(() => persistenceFailures.value.some((f) => isStorageFull(f.error)))
const canMove = computed(() => full.value && folderSupported.value && !isFolderProject(currentProject.value))
const count = computed(() => persistenceFailures.value.length)

function move() {
  clearStorageFullDecline()
  props.moveToFolder()
}

async function dismiss() {
  const ok = await confirmDialog({
    title: 'Dismiss the unsaved changes?',
    message:
      `${pluralize(count.value, 'change')} could not be saved. They stay in this session, and are lost when ` +
      'the page closes or the project is switched.',
    confirmLabel: 'Dismiss',
  })
  if (ok) discardAllPersistenceFailures()
}
</script>

<template>
  <div v-if="count" role="alert" class="persistence-error">
    <template v-if="full">
      <span class="persistence-title">Browser storage is full</span>
      <span class="persistence-detail">
        {{ pluralize(count, 'change') }} could not be saved.
        <template v-if="canMove">Move the project to a folder on your disk, and they are saved there.</template>
        <template v-else-if="!isFolderProject(currentProject)">
          Free space, then retry: delete another project, or clear the recomputable data in Project settings.
        </template>
        <template v-else>The disk holding the project folder is full: free space on it, then retry.</template>
      </span>
    </template>
    <template v-else>
      <span class="persistence-title">Unsaved changes</span>
      <span class="persistence-detail">{{ persistenceFailures[0].error?.message || 'Storage write failed' }}</span>
    </template>
    <div class="persistence-actions">
      <button v-if="canMove" class="btn btn-primary" :disabled="pendingPersistence > 0" @click="move">
        Move to folder…
      </button>
      <button v-else-if="full && !isFolderProject(currentProject)" class="btn" @click="openProjectSettings">
        Project settings…
      </button>
      <button class="btn" :disabled="pendingPersistence > 0" @click="retryPersistence().catch(() => {})">
        Retry saving
      </button>
      <button class="btn" @click="dismiss">Dismiss</button>
    </div>
  </div>
</template>

<style scoped>
/* Styled as an error toast (layout/ToastStack.vue), but it stays until the writes
   succeed, and sits bottom-left so the toasts on the right stay readable. */
.persistence-error {
  position: fixed;
  bottom: 16px;
  left: 16px;
  z-index: 500;
  max-width: 440px;
  padding: 9px 12px;
  border-radius: 6px;
  border: 1px solid #c05252;
  background: color-mix(in srgb, #c05252 16%, var(--panel));
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
  font-size: 12px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
}
.persistence-title {
  font-weight: 600;
  color: var(--text);
}
.persistence-detail {
  color: var(--text-dim);
}
.persistence-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
}
.persistence-actions .btn {
  font-size: 12px;
  padding: 3px 12px;
}
</style>
