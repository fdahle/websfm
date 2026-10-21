<script setup>
import { computed } from 'vue'

// The "Import as" question of the delimited-text import dialogs (GcpImportModal,
// CameraImportModal): the same file can be ground control, camera positions or
// camera intrinsics. Emits `pick` with the chosen kind id — the dialog decides
// whether that is a mode switch inside it or a hand-off to the other importer.
//
//   active    'gcp' | 'pose' | 'sensor' — what the dialog is importing as now
//   declared  the user already said what the file is (useModalsStore
//             `importKindDeclared`), so instead of re-asking with three
//             equal-weight buttons this states the kind and offers the
//             correction as links. It never disappears: the declaration can be
//             wrong, and the dialog is the only place that mistake is visible.
const props = defineProps({
  active: { type: String, required: true },
  declared: { type: Boolean, default: false },
})
const emit = defineEmits(['pick'])

const KINDS = [
  { id: 'gcp', label: 'Ground Control Points' },
  { id: 'pose', label: 'Camera Positions' },
  { id: 'sensor', label: 'Camera Intrinsics' },
]
// Correction links list the camera kinds first: from one camera kind, the
// likelier slip is the other camera kind.
const CORRECTION_ORDER = ['pose', 'sensor', 'gcp']

const labelOf = (id) => KINDS.find((k) => k.id === id)?.label ?? id
const corrections = computed(() => CORRECTION_ORDER.filter((id) => id !== props.active))
</script>

<template>
  <template v-if="!declared">
    <label class="section-label kind-label">Import as</label>
    <div class="kind-toggle">
      <button
        v-for="k in KINDS"
        :key="k.id"
        class="kind-btn"
        :class="{ active: k.id === active }"
        @click="emit('pick', k.id)"
      >
        {{ k.label }}
      </button>
    </div>
  </template>
  <p v-else class="kind-note">
    Importing as <b>{{ labelOf(active) }}</b
    >. Not right? Import as
    <template v-for="(id, i) in corrections" :key="id"
      >{{ i ? ' or ' : '' }}<button class="kind-link" @click="emit('pick', id)">{{ labelOf(id) }}</button></template
    >.
  </p>
</template>

<style scoped src="./import-modal.css"></style>
<style scoped>
.kind-label {
  margin-bottom: 8px;
}
.kind-toggle {
  display: inline-flex;
  border: 1px solid var(--panel-border);
  border-radius: 6px;
  overflow: hidden;
  margin-bottom: 16px;
}

.kind-btn {
  background: var(--bg);
  border: none;
  color: var(--text-dim);
  font: inherit;
  font-size: 13px;
  padding: 7px 16px;
  cursor: pointer;
}
.kind-btn + .kind-btn {
  border-left: 1px solid var(--panel-border);
}
.kind-btn:hover {
  color: var(--text);
}
.kind-btn.active {
  background: var(--accent);
  color: #fff;
}

.kind-link {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  color: var(--accent);
  cursor: pointer;
  text-decoration: underline;
}
.kind-link:hover {
  filter: brightness(1.15);
}
</style>
