<script setup>
// The toolbox of View ▸ Camera ▸ Views, over the 3D view (Viewer3D.vue): save where the
// camera stands under a name, go back to a saved view, rename or remove one. The list
// is the reconstruction store's (frameState.js), kept with the project; `saveCurrent`
// and `go` are the viewer's, which owns the camera.
import { computed, ref } from 'vue'
import FloatingToolbox from './FloatingToolbox.vue'
import { nextViewName } from '../../core/savedViews.js'
import { useI18n } from '../../composables/useI18n.js'
import { useReconstructionStore } from '../../stores/useReconstructionStore.js'

const props = defineProps({
  saveCurrent: { type: Function, required: true },
  go: { type: Function, required: true },
})
const emit = defineEmits(['close'])
const { t } = useI18n()
const recon = useReconstructionStore()

const newName = ref('')
const placeholder = computed(() => nextViewName(recon.savedViews))
function save() {
  if (props.saveCurrent(newName.value)) newName.value = ''
}

// The view being renamed: { id, name, error }, or null.
const renaming = ref(null)
function commitRename() {
  const r = renaming.value
  if (!r) return
  const error = recon.renameSavedView(r.id, r.name)
  if (error) renaming.value = { ...r, error }
  else renaming.value = null
}
</script>

<template>
  <FloatingToolbox
    id="views-3d"
    :title="t('view3d.views.title')"
    :width="260"
    :close-title="t('view3d.views.close')"
    @close="emit('close')"
  >
    <div class="tb-row">
      <input
        v-model="newName"
        class="tb-input views-name"
        :placeholder="placeholder"
        :aria-label="t('view3d.views.nameLabel')"
        @keydown.enter.prevent="save"
      />
      <button class="tb-textbtn" :title="t('view3d.views.saveTitle')" @click="save">
        {{ t('view3d.views.save') }}
      </button>
    </div>
    <div v-if="!recon.savedViews.length" class="tb-hint">{{ t('view3d.views.none') }}</div>
    <div v-for="v in recon.savedViews" :key="v.id" class="view-row">
      <template v-if="renaming?.id === v.id">
        <input
          v-model="renaming.name"
          class="tb-input views-name"
          :aria-label="t('view3d.views.renameLabel')"
          @keydown.enter.prevent="commitRename"
          @keydown.esc.stop.prevent="renaming = null"
        />
        <button class="tb-textbtn" @click="commitRename">{{ t('view3d.views.ok') }}</button>
        <div v-if="renaming.error" class="tb-hint warn">{{ t(`view3d.views.error.${renaming.error}`) }}</div>
      </template>
      <template v-else>
        <button
          class="tb-textbtn view-go"
          :class="{ stale: recon.savedViewStale(v) }"
          :title="t(recon.savedViewStale(v) ? 'view3d.views.staleTitle' : 'view3d.views.goTitle', { name: v.name })"
          @click="go(v.id)"
        >
          {{ v.name }}<span v-if="v.ortho" class="view-tag">{{ t('view3d.views.orthoTag') }}</span>
        </button>
        <button
          class="tb-textbtn"
          :title="t('view3d.views.renameTitle')"
          @click="renaming = { id: v.id, name: v.name, error: null }"
        >
          {{ t('view3d.views.rename') }}
        </button>
        <button
          class="tb-textbtn danger"
          :aria-label="t('view3d.views.remove', { name: v.name })"
          :title="t('view3d.views.remove', { name: v.name })"
          @click="recon.removeSavedView(v.id)"
        >
          ×
        </button>
      </template>
    </div>
  </FloatingToolbox>
</template>

<style scoped src="./toolbox.css"></style>
<style scoped>
.views-name {
  flex: 1;
  width: auto;
  min-width: 0;
}
.view-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
}
.view-go {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}
.view-go.stale {
  opacity: 0.6;
  font-style: italic;
}
.view-tag {
  margin-left: 6px;
  font-size: 10px;
  color: var(--text-dim);
}
.tb-hint.warn {
  width: 100%;
  color: #e0a040;
}
</style>
