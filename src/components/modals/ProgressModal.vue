<script setup>
import { computed } from 'vue'

const props = defineProps({
  title:   { type: String, required: true },
  current: { type: Number, default: 0 },
  total:   { type: Number, default: 0 },
  label:   { type: String, default: '' },
})

const pct = computed(() =>
  props.total > 0 ? Math.round((props.current / props.total) * 100) : 0
)
</script>

<template>
  <div class="overlay">
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-title">{{ title }}</div>
      <div class="progress-row">
        <div class="progress-track">
          <div class="progress-fill" :style="{ width: pct + '%' }"></div>
        </div>
        <span class="progress-pct">{{ pct }}%</span>
      </div>
      <div class="progress-sub">
        <span class="progress-count">{{ current }} / {{ total }}</span>
        <span v-if="label" class="progress-label" :title="label">{{ label }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 300;
}

.modal {
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 10px;
  width: 340px;
  max-width: 90vw;
  padding: 22px 24px 20px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.modal-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.progress-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.progress-track {
  flex: 1;
  height: 6px;
  background: var(--hover-bg);
  border-radius: 3px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 3px;
  transition: width 0.2s ease;
}

.progress-pct {
  font-size: 12px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
  width: 34px;
  text-align: right;
  flex-shrink: 0;
}

.progress-sub {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.progress-count {
  font-size: 12px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

.progress-label {
  font-size: 12px;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 200px;
  text-align: right;
}
</style>
