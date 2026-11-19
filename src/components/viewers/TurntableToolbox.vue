<script setup>
// The toolbox of View ▸ Camera ▸ Turntable, over the 3D view (Viewer3D.vue): its speed,
// and one turn recorded as a video. `tt` is the turntable's state and actions
// (useTurntable.js), as one reactive object.
import FloatingToolbox from './FloatingToolbox.vue'
import FieldHelp from '../guide/FieldHelp.vue'
import { TURNTABLE_DEFAULTS } from '../../core/defaults.user.js'
import { TURNTABLE_TUNING } from '../../core/tuning.js'
import { useI18n } from '../../composables/useI18n.js'

defineProps({ tt: { type: Object, required: true } })
const { t, tx } = useI18n()
</script>

<template>
  <FloatingToolbox
    id="turntable-3d"
    :title="t('view3d.turntable.title')"
    :width="236"
    :close-title="t('view3d.turntable.close')"
    @close="tt.setTurntable(false)"
  >
    <label :title="tt.recording ? t('view3d.turntable.stopRecordingFirst') : null" class="tb-field turn-field">
      <FieldHelp
        op="3d-view"
        param="secondsPerTurn"
        :value="tt.turntableSeconds"
        :default-value="TURNTABLE_DEFAULTS.secondsPerTurn"
        >{{ t('view3d.turntable.seconds') }}</FieldHelp
      >
      <input
        type="number"
        class="tb-input"
        :min="TURNTABLE_TUNING.minSecondsPerTurn"
        :max="TURNTABLE_TUNING.maxSecondsPerTurn"
        step="1"
        :value="tt.turntableSeconds"
        :disabled="tt.recording"
        :title="tt.recording ? t('view3d.turntable.stopRecordingFirst') : null"
        @change="(e) => tt.setTurntableSeconds(e.target.value)"
      />
    </label>
    <div class="tb-row">
      <button
        v-if="!tt.recording"
        class="tb-textbtn"
        :title="t('view3d.turntable.recordTitle')"
        @click="tt.recordTurn()"
      >
        {{ t('view3d.turntable.record') }}
      </button>
      <template v-else>
        <span class="tb-count">{{
          t('view3d.turntable.recordingProgress', { p: Math.round(tt.recordProgress * 100) })
        }}</span>
        <button class="tb-textbtn" :title="t('view3d.turntable.cancelTitle')" @click="tt.stopRecording(false)">
          {{ t('view3d.turntable.cancel') }}
        </button>
      </template>
    </div>
    <div v-if="tt.recordError" class="tb-hint warn">{{ tx(tt.recordError) }}</div>
    <div v-else class="tb-hint tb-row">
      {{ t(tt.recording ? 'view3d.turntable.locked' : 'view3d.turntable.steer') }}
    </div>
  </FloatingToolbox>
</template>

<style scoped src="./toolbox.css"></style>
<style scoped>
.turn-field {
  grid-template-columns: 1fr 64px;
}
.tb-hint.warn {
  color: #e0a040;
  margin-top: 4px;
}
</style>
