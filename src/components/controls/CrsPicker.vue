<script setup>
import { ref, computed, watch, useId } from 'vue'
import { CRS_CATALOG, ensureProjection } from '../../core/crs.js'
import { loadCrsRegistry, searchCrsRecords } from '../../core/crsRegistry.js'

const props = defineProps({
  modelValue: { type: String, default: 'EPSG:4326' },
  disabled: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue'])
const listboxId = `crs-results-${useId()}`

const presets = CRS_CATALOG.map((c) => ({ ...c, area: c.worldExtent ? '' : 'Common coordinate reference system' }))
const registry = ref([])
const selectedLabel = ref(labelFor(props.modelValue))
const query = ref(selectedLabel.value)
const open = ref(false)
const loading = ref(false)
const applying = ref(false)
const error = ref('')
const activeIndex = ref(-1)

function labelFor(code) {
  const known = [...presets, ...registry.value].find((c) => c.code === code)
  return known ? `${known.code} — ${known.name}` : code
}

const numericCode = computed(() => {
  const value = query.value.trim().replace(/^EPSG\s*:\s*/i, '')
  return /^\d+$/.test(value) ? `EPSG:${value}` : ''
})

const results = computed(() => {
  const source = registry.value.length ? registry.value : presets
  const found = searchCrsRecords(source, query.value === selectedLabel.value ? '' : query.value)
  if (numericCode.value && !found.some((c) => c.code === numericCode.value)) {
    found.unshift({ code: numericCode.value, name: 'Resolve EPSG code', area: 'Definition will be looked up when selected' })
  }
  return found.slice(0, 12)
})

watch(() => props.modelValue, (value) => {
  selectedLabel.value = labelFor(value)
  if (!open.value) query.value = selectedLabel.value
})

async function ensureRegistry() {
  if (registry.value.length || loading.value) return
  loading.value = true
  try {
    registry.value = await loadCrsRegistry()
    selectedLabel.value = labelFor(props.modelValue)
    if (!open.value || query.value === props.modelValue) query.value = selectedLabel.value
  } catch (err) {
    error.value = err?.message || 'Could not load the EPSG registry'
  } finally {
    loading.value = false
  }
}

function onFocus(event) {
  open.value = true
  activeIndex.value = -1
  event.target.select()
  ensureRegistry()
}

function onInput(event) {
  query.value = event.target.value
  error.value = ''
  open.value = true
  activeIndex.value = 0
  ensureRegistry()
}

async function choose(record) {
  applying.value = true
  error.value = 'Validating coordinate system…'
  try {
    await ensureProjection(record.code, record.def ? record : null)
    emit('update:modelValue', record.code)
    selectedLabel.value = `${record.code} — ${record.name}`
    query.value = selectedLabel.value
    error.value = ''
    open.value = false
  } catch (err) {
    error.value = err?.message || `Could not resolve ${record.code}`
  } finally {
    applying.value = false
  }
}

function onKeydown(event) {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    open.value = true
    activeIndex.value = Math.min(activeIndex.value + 1, results.value.length - 1)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    activeIndex.value = Math.max(activeIndex.value - 1, 0)
  } else if (event.key === 'Enter' && open.value && results.value.length) {
    event.preventDefault()
    choose(results.value[Math.max(0, activeIndex.value)])
  } else if (event.key === 'Escape') {
    open.value = false
    query.value = selectedLabel.value
  }
}

function onFocusout(event) {
  if (event.currentTarget.contains(event.relatedTarget)) return
  open.value = false
  query.value = selectedLabel.value
}
</script>

<template>
  <div class="crs-picker" :class="{ disabled }" @focusout="onFocusout">
    <div class="crs-combobox">
      <span class="search-icon" aria-hidden="true">⌕</span>
      <input
        class="crs-input"
        role="combobox"
        aria-label="Coordinate reference system"
        aria-autocomplete="list"
        :aria-expanded="open"
        :aria-controls="listboxId"
        :aria-activedescendant="activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined"
        :value="query"
        :disabled="disabled || applying"
        placeholder="Search by EPSG code, name, or area…"
        autocomplete="off"
        spellcheck="false"
        @focus="onFocus"
        @input="onInput"
        @keydown="onKeydown"
      />
      <span v-if="loading || applying" class="crs-spinner" aria-hidden="true"></span>

      <div v-if="open && !disabled" :id="listboxId" class="crs-results" role="listbox">
        <button
          v-for="(record, index) in results"
          :id="`${listboxId}-option-${index}`"
          :key="record.code"
          type="button"
          role="option"
          class="crs-option"
          :class="{ active: index === activeIndex, selected: record.code === modelValue }"
          :aria-selected="record.code === modelValue"
          @mousedown.prevent="choose(record)"
          @mouseenter="activeIndex = index"
        >
          <span class="option-main">
            <strong>{{ record.code }}</strong>
            <span>{{ record.name }}</span>
          </span>
          <span v-if="record.area || record.unit" class="option-meta">
            {{ [record.area, record.unit].filter(Boolean).join(' · ') }}
          </span>
        </button>
        <p v-if="!results.length && !loading" class="crs-empty">
          No matching horizontal CRS. You can also enter an EPSG code directly.
        </p>
        <p v-if="loading" class="crs-empty">Loading EPSG coordinate systems…</p>
      </div>
    </div>

    <p class="crs-hint">Search by code, CRS name, country, or region.</p>
    <p v-if="error" class="crs-error" aria-live="polite">{{ error }}</p>
  </div>
</template>

<style scoped>
.crs-picker {
  display: flex;
  flex-direction: column;
  gap: 5px;
  width: 100%;
}

.crs-picker.disabled { opacity: 0.5; }
.crs-combobox { position: relative; }

.crs-input {
  width: 100%;
  box-sizing: border-box;
  background: var(--bg);
  border: 1px solid var(--panel-border);
  border-radius: 5px;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  padding: 8px 32px 8px 31px;
  outline: none;
}

.crs-input:focus { border-color: var(--accent); }
.crs-input:disabled { cursor: not-allowed; }

.search-icon {
  position: absolute;
  z-index: 1;
  left: 10px;
  top: 7px;
  color: var(--text-dim);
  font-size: 16px;
  pointer-events: none;
}

.crs-spinner {
  position: absolute;
  right: 11px;
  top: 10px;
  width: 12px;
  height: 12px;
  border: 2px solid var(--panel-border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: crs-spin 0.7s linear infinite;
}

@keyframes crs-spin { to { transform: rotate(360deg); } }

.crs-results {
  position: absolute;
  z-index: 50;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  max-height: 310px;
  overflow-y: auto;
  background: var(--panel-bg, var(--bg));
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  box-shadow: 0 8px 24px rgb(0 0 0 / 28%);
  padding: 4px;
}

.crs-option {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  padding: 7px 8px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.crs-option:hover,
.crs-option.active { background: var(--hover-bg); }
.crs-option.selected { box-shadow: inset 2px 0 var(--accent); }

.option-main {
  display: flex;
  gap: 8px;
  align-items: baseline;
  font-size: 12px;
}

.option-main strong {
  flex: 0 0 auto;
  color: var(--accent);
  font-size: 11px;
}

.option-meta {
  overflow: hidden;
  color: var(--text-dim);
  font-size: 10px;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.crs-hint,
.crs-error,
.crs-empty {
  margin: 0;
  font-size: 11px;
}

.crs-hint { color: var(--text-dim); }
.crs-error { color: #e06c6c; }
.crs-empty { padding: 10px 8px; color: var(--text-dim); }
</style>
