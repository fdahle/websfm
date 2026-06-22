<script setup>
import { ref, computed, watch } from 'vue'
import { CRS_CATALOG, ensureProjection } from '../../utils/crs.js'

const props = defineProps({
  modelValue: { type: String, default: 'EPSG:4326' },
})
const emit = defineEmits(['update:modelValue'])

const CUSTOM = '__custom__'

const inCatalog = computed(() => CRS_CATALOG.some((c) => c.code === props.modelValue))
const mode = ref(inCatalog.value ? props.modelValue : CUSTOM)
const customCode = ref(inCatalog.value ? '' : (props.modelValue.replace(/^EPSG:/, '')))
const error = ref('')

// Keep local mode in sync if the bound value changes from outside.
watch(() => props.modelValue, (v) => {
  if (CRS_CATALOG.some((c) => c.code === v)) { mode.value = v; error.value = '' }
  else { mode.value = CUSTOM; customCode.value = v.replace(/^EPSG:/, '') }
})

function onSelect(e) {
  const v = e.target.value
  mode.value = v
  error.value = ''
  if (v !== CUSTOM) emit('update:modelValue', v)
}

async function applyCustom() {
  const n = customCode.value.trim().replace(/^EPSG:/i, '')
  if (!/^\d+$/.test(n)) { error.value = 'Enter a numeric EPSG code'; return }
  const code = `EPSG:${n}`
  error.value = 'Resolving…'
  try {
    await ensureProjection(code)
    error.value = ''
    emit('update:modelValue', code)
  } catch (err) {
    error.value = err?.message || `Could not resolve ${code}`
  }
}
</script>

<template>
  <div class="crs-picker">
    <select class="crs-select" :value="mode" @change="onSelect">
      <option v-for="c in CRS_CATALOG" :key="c.code" :value="c.code">
        {{ c.name }} ({{ c.code }})
      </option>
      <option :value="CUSTOM">Custom EPSG code…</option>
    </select>

    <div v-if="mode === CUSTOM" class="crs-custom">
      <span class="crs-prefix">EPSG:</span>
      <input
        v-model="customCode"
        class="crs-input"
        type="text"
        inputmode="numeric"
        placeholder="32733"
        @keydown.enter="applyCustom"
        @blur="applyCustom"
      />
      <button class="crs-apply" @click="applyCustom">Set</button>
    </div>

    <p v-if="error" class="crs-error">{{ error }}</p>
  </div>
</template>

<style scoped>
.crs-picker {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}

.crs-select,
.crs-input {
  background: var(--bg);
  border: 1px solid var(--panel-border);
  border-radius: 5px;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  padding: 7px 10px;
  outline: none;
}

.crs-select { width: 100%; box-sizing: border-box; }
.crs-select:focus,
.crs-input:focus { border-color: var(--accent); }

.crs-custom {
  display: flex;
  align-items: center;
  gap: 6px;
}

.crs-prefix {
  font-size: 12px;
  color: var(--text-dim);
}

.crs-input {
  flex: 1;
  min-width: 0;
}

.crs-apply {
  background: none;
  border: 1px solid var(--panel-border);
  border-radius: 5px;
  color: var(--text-dim);
  font: inherit;
  font-size: 12px;
  padding: 6px 12px;
  cursor: pointer;
}
.crs-apply:hover { background: var(--hover-bg); color: var(--text); }

.crs-error {
  margin: 0;
  font-size: 11px;
  color: #e06c6c;
}
</style>
