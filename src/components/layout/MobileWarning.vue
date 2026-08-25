<script setup>
import { useMobileWarning } from '../../composables/useMobileWarning.js'

// Blocking, up-front acknowledgement on phones/tablets. Deliberately NOT built on
// ModalShell: that shell closes on Escape and on a backdrop click, and this gate must
// be dismissed only by the explicit "I understand" button — an accidental tap outside
// would defeat the point. It also sits above every other layer (including the
// BrowserWarning toast at 9000), because it is the first thing the user should read.
// Detection + the persisted flag live in the shared composable so the
// Settings ▸ Display toggle stays in sync.
const { shouldWarn, acknowledge } = useMobileWarning()
</script>

<template>
  <div v-if="shouldWarn" class="mobile-gate" role="alertdialog" aria-modal="true" aria-labelledby="mobile-gate-title">
    <div class="mg-panel">
      <div class="mg-icon">📱</div>
      <h2 id="mobile-gate-title" class="mg-title">websfm is not designed for mobile</h2>
      <p class="mg-text">
        This is a desktop photogrammetry application. It runs feature detection,
        bundle adjustment and dense reconstruction directly in your browser, and it
        expects a large window, a mouse and plenty of memory.
      </p>
      <p class="mg-text">
        <strong>Mobile layout is not supported.</strong> On a phone or tablet the
        interface will be cramped or unusable, processing may be very slow, and
        larger projects are likely to run out of memory and fail.
      </p>
      <p class="mg-text">
        For real work, please open websfm on a desktop or laptop in a
        Chromium-based browser.
      </p>
      <button class="btn btn-primary mg-ok" type="button" autofocus @click="acknowledge">
        I understand — continue anyway
      </button>
    </div>
  </div>
</template>

<style scoped>
.mobile-gate {
  position: fixed;
  inset: 0;
  z-index: 9500;
  background: rgba(0, 0, 0, 0.72);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  overflow-y: auto;
}
.mg-panel {
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-top: 3px solid #e0a000;
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
  color: var(--text);
  width: 420px;
  max-width: 100%;
  padding: 20px;
  text-align: center;
}
.mg-icon { font-size: 30px; line-height: 1; }
.mg-title {
  margin: 10px 0 12px;
  font-size: 17px;
  font-weight: 600;
}
.mg-text {
  margin: 0 0 10px;
  font-size: 14px;
  line-height: 1.5;
  color: var(--text-dim);
  text-align: left;
}
.mg-ok {
  margin-top: 6px;
  width: 100%;
  padding: 11px 14px;
  font-size: 14px;
}
</style>
