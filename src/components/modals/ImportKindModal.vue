<script setup>
// Shown when a dropped file can't be classified automatically (typically a bare
// label + X/Y/Z list that is equally valid as GCPs or camera positions). The
// user picks how to interpret it; the choice opens the matching import modal.
defineProps({
  fileName: { type: String, default: 'file' },
})
const emit = defineEmits(['close', 'select'])

const OPTIONS = [
  { kind: 'gcp',    title: 'Ground Control Points', desc: 'Named survey points with absolute coordinates.' },
  { kind: 'pose',   title: 'Camera Positions',      desc: 'Per-image exterior orientation (position, optionally angles).' },
  { kind: 'sensor', title: 'Camera Intrinsics',     desc: 'Shared sensor parameters (focal length, distortion…).' },
  { kind: 'fiducialObs', title: 'Fiducial Observations', desc: 'Clicked fiducial-mark pixels per image (film scans).' },
]
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="modal" role="dialog" aria-modal="true" aria-label="Choose import type">
      <div class="modal-header">
        <span class="modal-title">What does this file contain?</span>
        <button class="modal-close" title="Close" @click="emit('close')">×</button>
      </div>

      <div class="modal-body">
        <div class="filename">{{ fileName }}</div>
        <p class="intro">The contents couldn't be identified automatically. Choose how to interpret it:</p>

        <div class="choices">
          <button v-for="o in OPTIONS" :key="o.kind" class="choice" @click="emit('select', o.kind)">
            <span class="choice-title">{{ o.title }}</span>
            <span class="choice-desc">{{ o.desc }}</span>
          </button>
        </div>
      </div>

      <div class="modal-footer">
        <button class="btn-secondary" @click="emit('close')">Cancel</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}

.modal {
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 8px;
  width: 460px;
  max-width: 94vw;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 13px 16px;
  border-bottom: 1px solid var(--panel-border);
}

.modal-title { font-size: 14px; font-weight: 600; color: var(--text); }

.modal-close {
  background: none; border: none; color: var(--text-dim);
  font-size: 20px; line-height: 1; cursor: pointer; padding: 1px 6px; border-radius: 4px;
}
.modal-close:hover { background: var(--hover-bg); color: var(--text); }

.modal-body { padding: 16px; }

.filename {
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 10px;
  font-family: monospace;
}

.intro { font-size: 13px; color: var(--text-dim); margin: 0 0 14px; }

.choices { display: flex; flex-direction: column; gap: 8px; }

.choice {
  display: flex;
  flex-direction: column;
  gap: 3px;
  text-align: left;
  background: var(--bg);
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  padding: 11px 13px;
  cursor: pointer;
}
.choice:hover { border-color: var(--accent); background: var(--hover-bg); }

.choice-title { font-size: 13px; font-weight: 600; color: var(--text); }
.choice-desc { font-size: 12px; color: var(--text-dim); }

.modal-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 12px 16px; border-top: 1px solid var(--panel-border);
}

.btn-secondary {
  background: none; border: 1px solid var(--panel-border); border-radius: 5px;
  color: var(--text-dim); font: inherit; font-size: 12px; padding: 6px 14px; cursor: pointer;
}
.btn-secondary:hover { background: var(--hover-bg); color: var(--text); }
</style>
