<script setup>
// One numbered stage of a pipeline modal: "① Resize → ② Tile → ③ Detect → ④ Keep".
// A SettingsGroup that says *where in the order of operations* its fields act and
// what they do to this project's data right now (`effect`, a live one-liner computed
// by the modal). `inactive` dims the step when nothing it holds can matter in the
// current configuration — the fields stay editable, but the user sees why they're
// inert instead of tuning a dead knob.
defineProps({
  step: { type: [Number, String], required: true },
  title: { type: String, required: true },
  effect: { type: String, default: '' },
  inactive: { type: Boolean, default: false },
})
</script>

<template>
  <div class="settings-step" :class="{ inactive }">
    <div class="step-head">
      <span class="step-num">{{ step }}</span>
      <span class="step-title">{{ title }}</span>
    </div>
    <div v-if="effect || $slots.effect" class="step-effect"><slot name="effect">{{ effect }}</slot></div>
    <div v-if="$slots.default" class="step-fields"><slot /></div>
  </div>
</template>

<style scoped src="./modal.css"></style>
<style scoped>
.settings-step {
  display: flex; flex-direction: column; gap: 8px;
  padding-left: 12px; border-left: 2px solid var(--panel-border);
}
.step-head { display: flex; align-items: center; gap: 8px; margin-left: -23px; }
.step-num {
  width: 20px; height: 20px; flex: none; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700; color: #fff; background: var(--accent);
}
.step-title {
  font-size: 10px; font-weight: 700; letter-spacing: 0.06em;
  text-transform: uppercase; color: var(--text-dim);
}
.step-effect {
  font-size: 11px; line-height: 1.45; color: var(--text);
  font-variant-numeric: tabular-nums;
}
.step-fields { display: flex; flex-direction: column; gap: 12px; }
.settings-step.inactive .step-num { background: var(--text-dim); }
.settings-step.inactive .step-effect { color: var(--text-dim); }
.settings-step.inactive .step-fields { opacity: 0.6; }
</style>
