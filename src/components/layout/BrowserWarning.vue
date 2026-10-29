<script setup>
import { ref } from 'vue'
import { useBrowserWarning } from '../../composables/useBrowserWarning.js'

// What this browser lacks and what each gap costs (core/browserSupport.js), as a
// dismissible warning. Detection + the persisted dismissal flag live in the shared
// composable so the Settings ▸ Display toggle stays in sync.
const { shouldWarn, gaps, isChromium, dismiss } = useBrowserWarning()

// Session-local hide so closing without "don't show again" still dismisses now
// but reappears next reload.
const hidden = ref(false)
const dontShowAgain = ref(false)

function close() {
  if (dontShowAgain.value) dismiss()
  hidden.value = true
}
</script>

<template>
  <div v-if="shouldWarn && !hidden" class="browser-warning" role="alert">
    <div class="bw-icon">⚠️</div>
    <div class="bw-body">
      <div class="bw-title">In this browser</div>
      <ul class="bw-list">
        <li v-for="g in gaps" :key="g.id">{{ g.without }}</li>
      </ul>
      <p class="bw-text">
        {{
          isChromium
            ? 'Other ▸ System info shows what this browser offers.'
            : 'Chrome and Edge have all of these (WebGPU where the graphics driver allows it). Other ▸ System info shows what this browser offers.'
        }}
      </p>
      <label class="bw-check">
        <input type="checkbox" v-model="dontShowAgain" />
        Don't show this again
      </label>
    </div>
    <button class="bw-close" title="Dismiss" @click="close">✕</button>
  </div>
</template>

<style scoped>
.browser-warning {
  position: fixed;
  bottom: 16px;
  right: 16px;
  z-index: 9000;
  max-width: 360px;
  display: flex;
  gap: 10px;
  padding: 12px 14px;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-left: 3px solid #e0a000;
  border-radius: 6px;
  color: var(--text);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  font-size: 13px;
}
.bw-icon {
  font-size: 18px;
  line-height: 1.2;
}
.bw-body {
  flex: 1;
  min-width: 0;
}
.bw-title {
  font-weight: 600;
  margin-bottom: 4px;
}
.bw-list {
  margin: 0 0 8px;
  padding-left: 16px;
  color: var(--text-dim);
  line-height: 1.4;
}
.bw-list li + li {
  margin-top: 4px;
}
.bw-text {
  margin: 0 0 8px;
  color: var(--text-dim);
  line-height: 1.4;
}
.bw-check {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  color: var(--text-dim);
  user-select: none;
}
.bw-close {
  background: none;
  border: none;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 13px;
  align-self: flex-start;
  padding: 2px 4px;
  line-height: 1;
}
.bw-close:hover {
  color: var(--text);
}
</style>
