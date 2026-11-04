<script setup>
// The dialog header's Presets ▾ (composables/useDialogSettings.js): apply or delete a
// saved preset, save the current settings as one, or reset to the defaults.
import { computed, ref, nextTick, onBeforeUnmount } from 'vue'

// `dialog`: what useDialogSettings returned.
const props = defineProps({ dialog: { type: Object, required: true } })
const presets = computed(() => props.dialog.presets.value)
const source = computed(() => props.dialog.source.value)
const emit = (ev, arg) =>
  ({
    apply: props.dialog.applyPreset,
    save: props.dialog.savePreset,
    delete: props.dialog.deletePreset,
    reset: props.dialog.reset,
  })[ev](arg)

const open = ref(false)
const name = ref('')
const root = ref(null)
const input = ref(null)

function toggle() {
  open.value = !open.value
  if (open.value) nextTick(() => input.value?.focus())
}
function onDoc(e) {
  if (open.value && root.value && !root.value.contains(e.target)) open.value = false
}
document.addEventListener('pointerdown', onDoc, true)
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDoc, true))

function save() {
  if (!name.value.trim()) return
  emit('save', name.value)
  name.value = ''
  open.value = false
}
</script>

<template>
  <div ref="root" class="presets" @keydown.esc.stop="open = false">
    <button
      class="presets-button"
      type="button"
      :aria-expanded="open"
      :title="
        source === 'last'
          ? 'Opened on the settings of the last run in this project'
          : source
            ? `Preset ${source}`
            : 'Save these settings, or bring back a saved set'
      "
      @click="toggle"
    >
      Presets{{ source === 'last' ? ' · last run' : source ? ` · ${source}` : '' }} ▾
    </button>
    <div v-if="open" class="presets-panel" role="menu">
      <ul v-if="presets.length" class="presets-list">
        <li v-for="p in presets" :key="p.name">
          <button
            type="button"
            role="menuitem"
            class="presets-item"
            @click="
              () => {
                emit('apply', p.name)
                open = false
              }
            "
          >
            {{ p.name }}
          </button>
          <button type="button" class="presets-delete" :title="`Delete ${p.name}`" @click="emit('delete', p.name)">
            ×
          </button>
        </li>
      </ul>
      <p v-else class="presets-empty">No saved presets for this dialog yet.</p>
      <form class="presets-save" @submit.prevent="save">
        <input ref="input" v-model="name" type="text" maxlength="60" placeholder="Name these settings" />
        <button type="submit" class="btn" :disabled="!name.trim()" :title="name.trim() ? null : 'Type a name first'">
          Save
        </button>
      </form>
      <button
        type="button"
        role="menuitem"
        class="presets-item"
        @click="
          () => {
            emit('reset')
            open = false
          }
        "
      >
        Reset to defaults
      </button>
    </div>
  </div>
</template>

<style scoped>
.presets {
  position: relative;
  margin-left: auto;
  margin-right: 8px;
}
.presets-button {
  font-size: 12px;
  padding: 3px 8px;
  border: 1px solid var(--panel-border);
  border-radius: 4px;
  background: var(--panel);
  color: var(--text-dim);
  cursor: pointer;
  white-space: nowrap;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.presets-button:hover {
  color: var(--text);
  border-color: var(--accent);
}
.presets-panel {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  z-index: 20;
  width: 240px;
  padding: 6px;
  background: var(--panel);
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  box-shadow: 0 6px 18px rgb(0 0 0 / 0.18);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.presets-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 180px;
  overflow: auto;
}
.presets-list li {
  display: flex;
  align-items: center;
}
.presets-item {
  flex: 1;
  text-align: left;
  font-size: 13px;
  padding: 4px 6px;
  border: none;
  background: none;
  color: var(--text);
  cursor: pointer;
  border-radius: 4px;
}
.presets-item:hover {
  background: var(--hover-bg);
}
.presets-delete {
  border: none;
  background: none;
  color: var(--text-dim);
  cursor: pointer;
  font-size: 14px;
  padding: 0 6px;
}
.presets-empty {
  margin: 2px 6px;
  font-size: 12px;
  color: var(--text-dim);
}
.presets-save {
  display: flex;
  gap: 6px;
}
.presets-save input {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  padding: 3px 6px;
  border: 1px solid var(--panel-border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text);
}
</style>
