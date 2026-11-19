<script setup>
// The toolbox of the point selection (Tools ▸ Point Cloud ▾ ▸ Select), over the 3D view
// (Viewer3D.vue): what is selected and what to do with it, and undo / redo of the
// edits made. `sel` is the selection's state and actions (useCloudSelection.js) as one
// reactive object; undo and redo are the reconstruction store's (cloudEdits.js).
import FloatingToolbox from './FloatingToolbox.vue'
import I18nText from '../I18nText.vue'
import { keyLabel } from '../../utils/shortcutLabels.js'
import { useI18n } from '../../composables/useI18n.js'
import { useReconstructionStore } from '../../stores/useReconstructionStore.js'

defineProps({ sel: { type: Object, required: true } })
const { t, tx } = useI18n()
const recon = useReconstructionStore()
</script>

<template>
  <FloatingToolbox
    id="select-3d"
    :title="t('view3d.select.title')"
    anchor="top-center"
    :width="260"
    :close-title="t('view3d.select.close')"
    close-key="select3d.clear"
    @close="sel.exitSelection()"
  >
    <template v-if="sel.selectionCount">
      <div class="tb-line">
        <I18nText k="view3d.select.selected" :params="{ n: sel.selectionCount }">
          <template #count="{ text }">
            <span class="tb-count">{{ text }}</span>
          </template> </I18nText
        ><template v-if="sel.selectionClouds > 1">{{
          t('view3d.select.inClouds', { n: sel.selectionClouds })
        }}</template>
      </div>
      <div v-if="sel.selectionStreamed" class="tb-hint tb-row">{{ t('view3d.select.streamed') }}</div>
      <div class="tb-row">
        <button
          class="tb-textbtn danger"
          :title="t('view3d.select.deleteTitle', { key: keyLabel('select3d.delete') })"
          @click="sel.commitSelection(false)"
        >
          {{ t('view3d.select.delete') }}
        </button>
        <button class="tb-textbtn" :title="t('view3d.select.keepTitle')" @click="sel.commitSelection(true)">
          {{ t('view3d.select.keep') }}
        </button>
        <button
          class="tb-textbtn"
          :title="t('view3d.select.clearTitle', { key: keyLabel('select3d.clear') })"
          @click="sel.clearSelection()"
        >
          {{ t('view3d.select.clear') }}
        </button>
      </div>
      <div class="tb-row">
        <select
          class="tb-input assign-class"
          :aria-label="t('view3d.select.classLabel')"
          :value="sel.assignClass"
          @change="(e) => sel.setAssignClass(Number(e.target.value))"
        >
          <option v-for="c in sel.ASSIGN_CLASSES" :key="c" :value="c">
            {{ c }} · {{ t(`view3d.select.class.${c}`) }}
          </option>
        </select>
        <button
          class="tb-textbtn"
          :title="t('view3d.select.assignTitle')"
          @click="sel.commitSelection(false, sel.assignClass)"
        >
          {{ t('view3d.select.assign') }}
        </button>
      </div>
    </template>
    <div v-if="recon.cloudHistory.undo || recon.cloudHistory.redo" class="tb-row">
      <button
        class="tb-textbtn"
        :disabled="!recon.cloudHistory.undo"
        :title="
          recon.cloudHistory.undo
            ? t('view3d.select.undoTitle', { what: tx(recon.cloudHistory.undo), key: keyLabel('view3d.undo') })
            : t('view3d.select.nothingToUndo')
        "
        @click="recon.undoCloudEdit()"
      >
        {{ t('view3d.select.undo') }}
      </button>
      <button
        class="tb-textbtn"
        :disabled="!recon.cloudHistory.redo"
        :title="
          recon.cloudHistory.redo
            ? t('view3d.select.redoTitle', { what: tx(recon.cloudHistory.redo), key: keyLabel('view3d.redo') })
            : t('view3d.select.nothingToRedo')
        "
        @click="recon.redoCloudEdit()"
      >
        {{ t('view3d.select.redo') }}
      </button>
    </div>
    <div v-if="!sel.selectionCount" class="tb-hint">
      {{
        sel.selectableLayers().length
          ? t('view3d.select.hint', {
              shape: sel.selectTool === 'lasso' ? 'lasso' : 'rectangle',
              add: keyLabel('select3d.add'),
              subtract: keyLabel('select3d.subtract'),
              clear: keyLabel('select3d.clear'),
            })
          : t('view3d.select.noCloud')
      }}
    </div>
  </FloatingToolbox>
</template>

<style scoped src="./toolbox.css"></style>
<style scoped>
.assign-class {
  flex: 1;
  width: auto;
}
</style>
